#!/usr/bin/env bash
#
# Idempotent provisioning for a whisper.cpp OpenAI-compatible STT endpoint.
# Reproduces the deployment running on `lab` from scratch on a fresh Ubuntu host.
# Safe to run twice. Run with: sudo ./install.sh
#
set -euo pipefail

# --- configuration -----------------------------------------------------------
PORT=8081                                   # public nginx port (the endpoint)
WHISPER_PORT=8082                           # internal whisper-server port
BIND_ADDR=127.0.0.1                         # whisper-server bind (proxy-only)
MODEL=small.en                              # whisper model (small.en / base.en)
INSTALL_DIR=/home/ubuntu/whisper.cpp        # whisper.cpp checkout
RUN_USER=ubuntu

# Build backend. Defaults to Vulkan/GPU: on `lab` (AMD RX 5700, RADV NAVI10) the
# server picks the Vulkan device and transcribes on the GPU (~0.3s for the jfk
# sample vs ~3-4s on CPU). Set to 0 to force a CPU-only build in place.
GGML_VULKAN=1

REPO_URL=https://github.com/ggml-org/whisper.cpp.git
MODEL_BIN="${INSTALL_DIR}/models/ggml-${MODEL}.bin"

# === IMPORTANT: build the Vulkan binary on a SEPARATE host with enough RAM =====
#
# The Vulkan shader compile is memory-hungry and gets OOM-killed on the lab's
# ~8 GB box. So we do NOT build Vulkan in place here. Instead:
#
#   1. On a build host with adequate RAM (>=16 GB) that shares this host's ABI
#      (Ubuntu 24.04 / glibc 2.39 / x86_64), check out the SAME commit and build:
#
#        sudo apt-get install -y build-essential cmake git libvulkan-dev glslang-tools
#        git clone https://github.com/ggml-org/whisper.cpp.git
#        cd whisper.cpp && git checkout <commit-this-GPU-host-runs>
#        cmake -B build -DGGML_VULKAN=1
#        cmake --build build -j8 --config Release
#
#   2. This is a shared-lib build. whisper-server loads libwhisper.so.* and
#      libggml*.so (including the ~46 MB libggml-vulkan.so) at runtime. Copy the
#      binary AND those .so onto this GPU host, co-located in build/bin/:
#
#        scp build/bin/whisper-server                          GPUHOST:.../build/bin/
#        scp build/src/libwhisper.so.*                         GPUHOST:.../build/bin/libwhisper.so.1
#        scp build/ggml/src/libggml.so.*                       GPUHOST:.../build/bin/libggml.so.0
#        scp build/ggml/src/libggml-base.so.*                  GPUHOST:.../build/bin/libggml-base.so.0
#        scp build/ggml/src/libggml-cpu.so.*                   GPUHOST:.../build/bin/libggml-cpu.so.0
#        scp build/ggml/src/ggml-vulkan/libggml-vulkan.so.*    GPUHOST:.../build/bin/libggml-vulkan.so.0
#      (name each .so as its soname, i.e. the name `ldd whisper-server` prints.)
#
#   3. The GPU host needs only the RUNTIME Vulkan stack (libvulkan1 + the RADV
#      ICD), which ships with mesa/ollama and is already present on lab. The
#      systemd unit sets LD_LIBRARY_PATH=build/bin so the co-located .so resolve
#      (the binary's RUNPATH points at the build host's paths).
#
# This install.sh assumes that copy has already happened (or that you flip
# GGML_VULKAN=0 to build CPU in place). It then wires up the model, unit, nginx.
# ==============================================================================

# --- packages ----------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update
# build-essential cmake git ffmpeg nginx are required (CPU in-place build + ffmpeg
# for --convert). vulkan-tools is handy for GPU diagnostics (vulkaninfo).
# For a Vulkan build, install libvulkan-dev + glslang-tools ON THE BUILD HOST
# (see the block above); the GPU host needs only the runtime libvulkan1/RADV.
PKGS="build-essential cmake git ffmpeg nginx vulkan-tools glslang-tools"
if [ "${GGML_VULKAN}" = "1" ]; then
  PKGS="${PKGS} libvulkan-dev"
fi
# shellcheck disable=SC2086
apt-get install -y ${PKGS}

# --- source ------------------------------------------------------------------
if [ ! -d "${INSTALL_DIR}/.git" ]; then
  git clone "${REPO_URL}" "${INSTALL_DIR}"
else
  git -C "${INSTALL_DIR}" pull --ff-only || true
fi
chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}"

# --- build -------------------------------------------------------------------
# Vulkan (default): the binary is built on a separate host and copied in (see
# the block above) — skip the in-place build if it is already present.
# CPU (GGML_VULKAN=0): build in place here.
if [ "${GGML_VULKAN}" = "1" ]; then
  if [ ! -x "${INSTALL_DIR}/build/bin/whisper-server" ]; then
    echo "ERROR: GGML_VULKAN=1 but ${INSTALL_DIR}/build/bin/whisper-server is missing." >&2
    echo "Build it on a higher-RAM host and copy it (+ libggml*.so) in. See header." >&2
    exit 1
  fi
  echo "Using pre-built Vulkan whisper-server at ${INSTALL_DIR}/build/bin/whisper-server"
else
  sudo -u "${RUN_USER}" bash -c "
    set -e
    cd '${INSTALL_DIR}'
    cmake -B build -DGGML_VULKAN=0
    cmake --build build -j2 --config Release
  "
fi

# --- model -------------------------------------------------------------------
if [ ! -f "${MODEL_BIN}" ]; then
  sudo -u "${RUN_USER}" bash -c "cd '${INSTALL_DIR}' && bash ./models/download-ggml-model.sh '${MODEL}'"
fi

# --- systemd unit ------------------------------------------------------------
cat > /etc/systemd/system/whisper-server.service <<EOF
[Unit]
Description=Whisper.cpp OpenAI-compatible speech-to-text server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
# Vulkan is a shared-lib build whose RUNPATH points at the build host; make the
# co-located libwhisper.so / libggml*.so findable. Harmless for a CPU build.
Environment=LD_LIBRARY_PATH=${INSTALL_DIR}/build/bin
ExecStart=${INSTALL_DIR}/build/bin/whisper-server -m ${MODEL_BIN} --host ${BIND_ADDR} --port ${WHISPER_PORT} --convert
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now whisper-server.service

# --- nginx reverse proxy -----------------------------------------------------
# whisper-server's native route is /inference; the OpenAI-compatible path
# /v1/audio/transcriptions is rewritten onto it.
cat > /etc/nginx/sites-available/whisper <<EOF
server {
    listen ${PORT};
    server_name _;

    client_max_body_size 100M;

    location = /v1/audio/transcriptions {
        rewrite ^ /inference break;
        proxy_pass http://${BIND_ADDR}:${WHISPER_PORT};
        proxy_read_timeout 300s;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://${BIND_ADDR}:${WHISPER_PORT};
        proxy_read_timeout 300s;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/whisper /etc/nginx/sites-enabled/whisper
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx
systemctl enable --now nginx

echo
echo "Done. Endpoint: http://<host>.<tailnet>.ts.net:${PORT}/v1/audio/transcriptions"
