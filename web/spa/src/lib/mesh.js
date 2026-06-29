// Shared bootstrap for mesh-client.js.
//
// Ensures the script is loaded at most once per page, deduplicating the load
// promise between HostPicker (which mounts the script) and HomePage (which
// must not fetch /api/sessions before MobuxMesh is available). Both import
// ensureMeshClient from here so they share the same promise object and the
// first /api/sessions call always happens after window.MobuxMesh is set.

let meshLoaded = false;
let meshLoadPromise = null;

export function ensureMeshClient() {
  if (meshLoaded) return Promise.resolve();
  if (meshLoadPromise) return meshLoadPromise;
  meshLoadPromise = new Promise((resolve, reject) => {
    if (window.MobuxMesh) {
      meshLoaded = true;
      return resolve();
    }
    const s = document.createElement("script");
    s.src = "/static/mesh-client.js";
    s.async = false;
    s.onload = () => {
      meshLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error("Failed to load mesh-client.js"));
    document.body.appendChild(s);
  });
  return meshLoadPromise;
}
