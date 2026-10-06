# Self-hosted voices for Listen

Listen mode reads the terminal through the voice picked in Settings → Listen.
Two voices can run on a box on your tailnet. Both are reachable on the tailnet
only and take no auth of their own; do not expose them to the public internet.

## Kyutai Pocket TTS (`kyutai` kind, CPU)

Pocket TTS is a 100M-parameter model that runs faster than real time on a CPU,
with English, French, German, Spanish, Italian, Portuguese and Dutch voices. Its
server answers `POST /tts` (form fields `text` and `voice_url`) with WAV.

```sh
python3 -m venv ~/.local/pocket-tts
~/.local/pocket-tts/bin/pip install pocket-tts \
  --extra-index-url https://download.pytorch.org/whl/cpu
~/.local/pocket-tts/bin/pocket-tts serve --host "$(tailscale ip -4)" --port 8000
```

As a systemd user unit, `~/.config/systemd/user/pocket-tts.service`:

```ini
[Unit]
Description=Kyutai Pocket TTS for mobux Listen
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
# Bind the tailnet address only; the server has no auth.
ExecStart=/bin/sh -c 'exec %h/.local/pocket-tts/bin/pocket-tts serve --host "$(tailscale ip -4)" --port 8000'
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now pocket-tts
loginctl enable-linger "$USER"   # keep it running without a login session
```

In Settings → Listen pick **Kyutai Pocket TTS**, host
`http://<host>.<tailnet>.ts.net`, port `8000`. Voice is a preset name (`alba`,
`marius`, `javert`, `jean`, `fantine`, `cosette`, `eponine`, `azelma`, …) or an
`hf://` / `https://` URL of a voice clip. The first run downloads the weights
from Hugging Face.

## Voxtral 4B TTS on vLLM-Omni (`network` kind, GPU)

vLLM-Omni serves Mistral's open-weight Voxtral-4B-TTS-2603 on the OpenAI
`/v1/audio/speech` route, which mobux reaches through the `network` kind.

```sh
uv venv && . .venv/bin/activate
uv pip install git+https://github.com/vllm-project/vllm-omni.git
uv pip install -U "mistral_common>=1.10.0"
vllm serve mistralai/Voxtral-4B-TTS-2603 --omni \
  --host "$(tailscale ip -4)" --port 8000
```

In Settings → Listen pick **Network (self-hosted)**, host
`http://<host>.<tailnet>.ts.net`, port `8000`, model
`mistralai/Voxtral-4B-TTS-2603`, voice a preset such as `casual_female`,
`neutral_male`, `fr_female` or `nl_male`.

The hosted voice needs no recipe: pick **Mistral Voxtral** and paste the API key
from console.mistral.ai.
