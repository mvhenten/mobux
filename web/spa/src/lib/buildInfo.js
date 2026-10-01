import { signal } from "@preact/signals";
import { localGet } from "./api.js";

export const buildInfo = signal(null);
export const buildInfoError = signal(null);

let request = null;

export function loadBuildInfo() {
  if (request) return request;
  request = localGet("/api/build-info").then(
    (d) => {
      buildInfo.value = d;
      buildInfoError.value = null;
    },
    (e) => {
      buildInfoError.value = String(e.message || e);
      request = null;
    },
  );
  return request;
}
