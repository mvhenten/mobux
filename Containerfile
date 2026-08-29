# Container image for isolated test runs. Each container has its own
# tmux server, so playwright tests can create/kill sessions without
# touching the host's tmux. See `make podman-test`.
#
# Not a production image: TLS is off, basic-auth uses static creds
# passed via `make podman-test`. For a real deployment use `make start`
# / `make twa` against the host.

# ---- web bundle (node-only) ----------------------------------------------
FROM docker.io/library/node:20-bookworm-slim AS web
WORKDIR /src
RUN apt-get update \
 && apt-get install -y --no-install-recommends patch \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY patches ./patches
COPY web ./web
RUN npm install --no-audit --no-fund

# ---- rust build ----------------------------------------------------------
FROM docker.io/library/rust:1.95-bookworm AS build
WORKDIR /src
# `cmake` is required: sherpa-rs-sys builds sherpa-onnx (and fetches a prebuilt
# onnxruntime) via cmake for the local CPU speech-to-text endpoint.
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake \
 && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY --from=web /src/web ./web
RUN cargo build --release

# ---- runtime -------------------------------------------------------------
# Trixie ships tmux 3.5a. Bookworm's tmux 3.3a mangles non-printable
# bytes in `-F` format strings, which breaks `tmux list-sessions -F`
# parsing — see tmux.rs::list_sessions, which splits on TAB.
FROM docker.io/library/debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/mobux /usr/local/bin/mobux
# sherpa-rs emits the onnxruntime + sherpa-onnx shared libs next to the binary
# in the build stage; the runtime needs them on the library path. `libstdc++` /
# `libgomp` from the build toolchain are also required by onnxruntime.
COPY --from=build /src/target/release/*.so /opt/mobux/lib/
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=web /src/web /opt/mobux/web
COPY scripts/podman-entrypoint.sh /usr/local/bin/podman-entrypoint.sh
RUN chmod +x /usr/local/bin/podman-entrypoint.sh

WORKDIR /opt/mobux
# tmux's `-F` output mangles non-printable bytes (including the TAB
# separator mobux uses to parse `list-sessions`) under the default
# POSIX/C locale. A UTF-8 locale fixes it.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    MOBUX_TLS=0 \
    MOBUX_PORT=8080 \
    MOBUX_DATA_DIR=/data \
    LD_LIBRARY_PATH=/opt/mobux/lib
RUN mkdir -p /data
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/podman-entrypoint.sh"]
