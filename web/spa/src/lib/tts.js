// The voices Listen can speak through, and the fields each one takes. The
// defaults come filled from GET /api/settings/tts.

export const TTS_KINDS = [
  { value: "local", label: "On this machine" },
  { value: "mistral", label: "Mistral Voxtral" },
  { value: "network", label: "Network (self-hosted)" },
  { value: "kyutai", label: "Kyutai Pocket TTS" },
];

export const TTS_KIND_SHORT = {
  local: "Host voice",
  mistral: "Mistral",
  network: "Network",
  kyutai: "Kyutai",
};

// Which fields a kind takes.
export function ttsFields(kind) {
  return {
    endpoint: kind === "network" || kind === "kyutai",
    model: kind === "mistral" || kind === "network",
    voice: kind !== "local",
    apiKey: kind === "mistral" || kind === "network",
  };
}
