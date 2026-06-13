# whisper.cpp STT endpoint

A self-hosted, OpenAI-compatible speech-to-text endpoint (whisper.cpp behind nginx).

## Stand up

```sh
sudo ./install.sh
```

Idempotent — safe to re-run.

## Endpoint

```
http://<host>.<tailnet>.ts.net:8081/v1/audio/transcriptions
```

POST multipart form-data with `file=@audio`, `model=whisper-1`, `response_format=json`.
The proxy rewrites this OpenAI path onto whisper.cpp's native `/inference` route.

No auth — reachable on the tailnet only. Do not expose to the public internet.

## Backend: GPU (Vulkan)

The live deployment runs on the **GPU via Vulkan**. On `lab` (AMD RX 5700 / RADV
NAVI10) the server picks the Vulkan device and transcribes the ~11s jfk sample in
~0.3s, versus ~3-4s on CPU. `install.sh` defaults to `GGML_VULKAN=1`.

The catch is the build, not the runtime: compiling the Vulkan shaders is
memory-hungry and gets OOM-killed on the GPU host's ~8 GB RAM. So the Vulkan
binary is **built on a separate, roomier host** (same x86_64 / Ubuntu 24.04 ABI)
and the binary plus its co-located `libggml*.so` / `libwhisper.so` are copied onto
the GPU host. The GPU host needs only the runtime Vulkan stack (`libvulkan1` + the
RADV driver) — the same one ollama already uses. The exact build-and-copy steps are
documented at the top of `install.sh`.

Because that build is a shared-lib build whose RUNPATH points at the build host,
the systemd unit sets `LD_LIBRARY_PATH` to the `build/bin` directory so the `.so`
resolve. That env line is load-bearing — if those libs move, the service breaks.

To run CPU-only instead (built in place, no separate host needed), set
`GGML_VULKAN=0` at the top of `install.sh`.

## Footprint

Model `small.en` (~488 MB on disk, ~487 MB resident, loaded into VRAM under
Vulkan). Alongside ollama it uses ~3.15 GiB of the 8 GiB VRAM, leaving headroom.
For lower memory at some accuracy cost, switch `MODEL` to `base.en`.
