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

## Backend: CPU

The live deployment runs on **CPU**. On this host (AMD RX 5700 / RADV) the Vulkan
build did not produce a working GPU backend — the binary reports `no GPU found` and
falls back to CPU. `install.sh` builds CPU by default (`GGML_VULKAN=0`).

To attempt GPU: set `GGML_VULKAN=1` at the top of `install.sh` on a host with a
working Vulkan/RADV stack (`vulkaninfo` lists your GPU and a real driver). It also
adds `libvulkan-dev` to the build deps. There is no guarantee it will pick up the
GPU; CPU is the reliable fallback.

## Footprint

Model `small.en` (~488 MB on disk). Loaded resident size ~487 MB RAM. CPU
transcription of a ~11s clip on this 4-core host completes in a few seconds.
For lower memory/latency at some accuracy cost, switch `MODEL` to `base.en`.
