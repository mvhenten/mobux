import { signal } from "@preact/signals";
import { localGet } from "./api.js";

// GET /api/build-info, shared by the About page and the Pages listing. null
// until the server answers.
export const buildInfo = signal(null);

export function loadBuildInfo() {
  localGet("/api/build-info")
    .then((d) => (buildInfo.value = d))
    .catch(() => {});
}
