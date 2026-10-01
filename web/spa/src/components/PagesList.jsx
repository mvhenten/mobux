import { u } from "../lib/base.js";

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

export function PagesError({ error }) {
  return (
    <div class="settings-row settings-row--hint" role="alert">
      Couldn't load pages: {error}
    </div>
  );
}

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
