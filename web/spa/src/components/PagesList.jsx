import { u } from "../lib/base.js";
import { openOutside } from "../lib/externalLink.js";

const KINDS = [
  { key: "files", mount: "/files/", label: "files" },
  { key: "proxies", mount: "/proxy/", label: "proxy" },
];

export function pageCount(info) {
  return {
    files: info?.files?.length ?? 0,
    proxies: info?.proxies?.length ?? 0,
  };
}

export function hasPages(info) {
  const { files, proxies } = pageCount(info);
  return files + proxies > 0;
}

// One row per file root and proxy target, each opening its page outside the
// app shell so it gets the whole phone screen.
export function PageRows({ info }) {
  return KINDS.flatMap(({ key, mount, label }) =>
    (info?.[key] || []).map((name) => (
      <a
        key={`${key}:${name}`}
        class="settings-row settings-row--nav"
        data-page-kind={label}
        data-page-name={name}
        href={u(`${mount}${encodeURIComponent(name)}/`)}
        target="_blank"
        rel="noopener"
        onClick={openOutside}
      >
        <span class="settings-label">
          <span class="settings-title">{name}</span>
          <small>{label}</small>
        </span>
        <span class="settings-trail">
          <span class="settings-chevron" aria-hidden="true">
            ›
          </span>
        </span>
      </a>
    )),
  );
}
