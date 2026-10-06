// The voices Listen can speak through, and what each one needs. Mirrors
// TTS_KINDS and tts_default in src/speech_settings.rs.

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

export function ttsDefaults(kind) {
  if (kind === "mistral")
    return {
      host: "https://api.mistral.ai",
      port: "443",
      model: "voxtral-mini-tts-2603",
      voice: "en_paul_neutral",
    };
  if (kind === "network")
    return {
      host: "",
      port: "",
      model: "mistralai/Voxtral-4B-TTS-2603",
      voice: "casual_female",
    };
  if (kind === "kyutai")
    return {
      host: "http://localhost",
      port: "8000",
      model: "pocket-tts",
      voice: "alba",
    };
  return { host: "", port: "", model: "", voice: "" };
}

// Which fields a kind takes.
export function ttsFields(kind) {
  return {
    endpoint: kind === "network" || kind === "kyutai",
    model: kind === "mistral" || kind === "network",
    voice: kind !== "local",
    apiKey: kind === "mistral" || kind === "network",
  };
}
