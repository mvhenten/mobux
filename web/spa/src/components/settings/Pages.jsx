import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { apiSend, localGet } from "../../lib/api.js";
import { u } from "../../lib/base.js";
import {
  buildInfo,
  buildInfoError,
  loadBuildInfo,
  reloadBuildInfo,
} from "../../lib/buildInfo.js";
import { PagesError, hasPages, pageCount } from "../PagesList.jsx";
import {
  Actions,
  Button,
  ConfirmButton,
  FieldRow,
  Group,
  Lede,
  NavRow,
  Status,
} from "./ui.jsx";

// GET|PUT /api/settings/pages. The server writes `files.roots` and
// `proxy.targets` in config.json and swaps them into the live routes. A PUT
// carries the full list of one section; a section the environment sets is
// read-only and never sent.

const pages = signal(null); // null = loading or failed — never editable
const loadError = signal(null);
const status = signal(null);
const busy = signal(false);
const draft = {
  files: { name: signal(""), value: signal("") },
  proxies: { name: signal(""), value: signal("") },
};

const errorText = (e) => (e.body || e.message || String(e)).trim();

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function summary(info, error) {
  if (error) return "⚠";
  if (!info) return "…";
  if (!hasPages(info)) return "none";
  const { files, proxies } = pageCount(info);
  return `${plural(files, "file", "files")}, ${plural(proxies, "proxy", "proxies")}`;
}

export function PagesRow() {
  useEffect(() => {
    loadBuildInfo();
  }, []);
  return (
    <NavRow
      row="pages"
      to="/settings/pages"
      label="Pages"
      value={summary(buildInfo.value, buildInfoError.value)}
    />
  );
}

async function load() {
  pages.value = null;
  loadError.value = null;
  status.value = null;
  try {
    pages.value = await localGet("/api/settings/pages");
  } catch (e) {
    loadError.value = errorText(e);
  }
}

async function save(section, list) {
  busy.value = true;
  try {
    pages.value = await apiSend("/api/settings/pages", {
      method: "PUT",
      body: JSON.stringify({ [section]: list }),
    });
    status.value = { msg: "Saved ✓", kind: "ok" };
    reloadBuildInfo();
    return true;
  } catch (e) {
    status.value = { msg: errorText(e), kind: "error" };
    return false;
  } finally {
    busy.value = false;
  }
}

const SECTIONS = {
  files: {
    title: "File roots",
    addTitle: "Add a file root",
    kind: "files",
    mount: "/files/",
    field: "path",
    fieldLabel: "Path",
    placeholder: "/home/me/site",
    empty: "No file roots.",
    detail: (entry) => entry.path,
    parse: (text) => {
      const path = text.trim();
      if (!path.startsWith("/")) return { error: "Path must be absolute." };
      return { value: path };
    },
  },
  proxies: {
    title: "Proxy targets",
    addTitle: "Add a proxy target",
    kind: "proxy",
    mount: "/proxy/",
    field: "port",
    fieldLabel: "Port",
    placeholder: "5173",
    empty: "No proxy targets.",
    detail: (entry) => `127.0.0.1:${entry.port}`,
    parse: (text) => {
      const port = Number(text.trim());
      if (!/^\d+$/.test(text.trim()) || port < 1 || port > 65535)
        return { error: "Port must be a whole number from 1 to 65535." };
      return { value: port };
    },
  },
};

const NAME_RULE = /^[A-Za-z0-9_-]+$/;

function PageRow({ section, entry, editable }) {
  const s = SECTIONS[section];
  const remove = () =>
    save(
      section,
      pages.value[section].filter((x) => x.name !== entry.name),
    );
  return (
    <div class="settings-row page-row">
      <a
        class="page-link"
        data-page-kind={s.kind}
        data-page-name={entry.name}
        href={u(`${s.mount}${encodeURIComponent(entry.name)}/`)}
        target="_blank"
        rel="noopener"
      >
        <span class="settings-label">
          <span class="settings-title">{entry.name}</span>
          <small class="page-detail">{s.detail(entry)}</small>
        </span>
      </a>
      {editable && (
        <ConfirmButton
          class="btn--inline page-remove"
          aria-label={`Remove ${entry.name}`}
          label="Remove"
          confirmLabel="Remove?"
          variant="secondary"
          armedVariant="danger"
          disabled={busy.value}
          onConfirm={remove}
        />
      )}
    </div>
  );
}

function AddForm({ section }) {
  const s = SECTIONS[section];
  const { name, value } = draft[section];
  const add = async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!NAME_RULE.test(n)) {
      status.value = {
        msg: "Name must be letters, digits, - or _.",
        kind: "error",
      };
      return;
    }
    if (pages.value[section].some((x) => x.name === n)) {
      status.value = { msg: `'${n}' is already listed.`, kind: "error" };
      return;
    }
    const parsed = s.parse(value.value);
    if (parsed.error) {
      status.value = { msg: parsed.error, kind: "error" };
      return;
    }
    const entry = { name: n, [s.field]: parsed.value };
    if (await save(section, [...pages.value[section], entry])) {
      name.value = "";
      value.value = "";
    }
  };
  return (
    <section class="settings-group">
      <h2>{s.addTitle}</h2>
      <form
        class="settings-card page-add"
        data-section={section}
        onSubmit={add}
      >
        <FieldRow label="Name">
          <input
            class="settings-input page-add-name"
            placeholder="site"
            autocomplete="off"
            autocapitalize="off"
            value={name.value}
            onInput={(e) => (name.value = e.target.value)}
          />
        </FieldRow>
        <FieldRow label={s.fieldLabel}>
          <input
            class="settings-input page-add-value"
            placeholder={s.placeholder}
            autocomplete="off"
            autocapitalize="off"
            inputmode={section === "proxies" ? "numeric" : undefined}
            value={value.value}
            onInput={(e) => (value.value = e.target.value)}
          />
        </FieldRow>
        <Actions>
          <Button
            type="submit"
            class="page-add-btn"
            variant="primary"
            disabled={busy.value}
          >
            Add
          </Button>
        </Actions>
      </form>
    </section>
  );
}

function Section({ section, data }) {
  const s = SECTIONS[section];
  const note = data.managed_note[section];
  const list = data[section];
  return (
    <>
      <Group id={`pages-${section}`} title={s.title}>
        {list.map((entry) => (
          <PageRow
            key={entry.name}
            section={section}
            entry={entry}
            editable={!note}
          />
        ))}
        {list.length === 0 && (
          <div class="settings-row settings-row--hint">{s.empty}</div>
        )}
        {note && (
          <div class="settings-row settings-row--hint page-managed">{note}</div>
        )}
      </Group>
      {!note && <AddForm section={section} />}
    </>
  );
}

export function PagesCard() {
  useEffect(() => {
    load();
  }, []);
  const data = pages.value;
  return (
    <div id="pages-settings">
      <Lede>
        Folders on this host served at <code>/files/&lt;name&gt;/</code>, and
        local ports proxied at <code>/proxy/&lt;name&gt;/</code>. Changes apply
        at once and are saved to <code>config.json</code>;{" "}
        <code>MOBUX_FILES</code> and <code>MOBUX_PROXY</code> override it.
      </Lede>
      {loadError.value && (
        <Group title="Pages">
          <PagesError error={loadError.value} />
          <Actions>
            <Button id="pagesRetry" onClick={load}>
              Retry
            </Button>
          </Actions>
        </Group>
      )}
      {!data && !loadError.value && (
        <Group title="Pages">
          <div class="settings-row settings-row--hint">Loading…</div>
        </Group>
      )}
      {data && <Section section="files" data={data} />}
      {data && <Section section="proxies" data={data} />}
      <Status id="pagesStatus" status={status.value} />
    </div>
  );
}
