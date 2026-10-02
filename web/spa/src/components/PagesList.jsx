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

// One served page as a link that opens it in a new tab, so the page gets the
// whole phone screen. Home and Settings → Pages both list pages through it.
export function PageLink({
  kind,
  name,
  detail,
  class: cls,
  detailClass,
  children,
}) {
  const { mount, label } = KINDS.find((k) => k.label === kind);
  return (
    <a
      class={cls}
      data-page-kind={label}
      data-page-name={name}
      href={u(`${mount}${encodeURIComponent(name)}/`)}
      target="_blank"
      rel="noopener"
    >
      <span class="settings-label">
        <span class="settings-title">{name}</span>
        <small class={detailClass}>{detail}</small>
      </span>
      {children}
    </a>
  );
}

export function PageRows({ info }) {
  return KINDS.flatMap(({ key, label }) =>
    (info?.[key] || []).map((name) => (
      <PageLink
        key={`${key}:${name}`}
        class="settings-row settings-row--nav"
        kind={label}
        name={name}
        detail={label}
      >
        <span class="settings-trail">
          <span class="settings-chevron" aria-hidden="true">
            ›
          </span>
        </span>
      </PageLink>
    )),
  );
}
