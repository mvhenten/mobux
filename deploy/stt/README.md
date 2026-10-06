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

## Voxtral on vLLM (`network` kind)

Mistral's Voxtral Mini 3B served by vLLM answers the same OpenAI
`/v1/audio/transcriptions` route, so mobux reaches it through the `network`
kind. It needs a GPU with about 9.5 GB free in bf16.

```sh
uv venv && . .venv/bin/activate
uv pip install -U "vllm[audio]"
vllm serve mistralai/Voxtral-Mini-3B-2507 \
  --tokenizer_mode mistral --config_format mistral --load_format mistral \
  --host "$(tailscale ip -4)" --port 8000
```

In Settings → Speech to text pick **Network**, host `http://<host>.<tailnet>.ts.net`,
port `8000`, model `mistralai/Voxtral-Mini-3B-2507`. Bind the tailnet address
only; vLLM has no auth here.

The hosted service needs no recipe: pick **Mistral Voxtral** and paste the API
key from console.mistral.ai.

## Kyutai STT on moshi-server (`kyutai` kind)

Kyutai's speech-to-text models are served only by `moshi-server` (Rust, CUDA),
over a websocket at `/api/asr-streaming`. mobux streams the recorded clip to it
and joins the words it answers.

```sh
cargo install --features cuda moshi-server
git clone https://github.com/kyutai-labs/delayed-streams-modeling
cd delayed-streams-modeling
# stt-1b-en_fr (English and French, 0.5 s delay); use
# configs/config-stt-en-hf.toml for stt-2.6b-en.
moshi-server worker --config configs/config-stt-en_fr-hf.toml \
  --addr "$(tailscale ip -4)" --port 8080
```

The config's `authorized_ids` lists the keys the server accepts;
`public_token` is the default and what mobux sends when no key is set. Put your
own value there and in the API key field for anything beyond a single-user
tailnet.

In Settings → Speech to text pick **Kyutai (moshi-server)**, host
`ws://<host>.<tailnet>.ts.net`, port `8080`. The model field is a label; the
server's config decides which checkpoint runs. Keep the server off the public
internet: it binds `0.0.0.0` unless `--addr` says otherwise.
