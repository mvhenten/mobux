import { useEffect } from "preact/hooks";
import {
  buildInfo,
  buildInfoError,
  loadBuildInfo,
} from "../../lib/buildInfo.js";
import { PageRows, PagesError, hasPages, pageCount } from "../PagesList.jsx";
import { Group, Lede, NavRow } from "./ui.jsx";

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

function PagesBody({ info, error }) {
  if (error) return <PagesError error={error} />;
  if (hasPages(info)) return <PageRows info={info} />;
  return (
    <div class="settings-row settings-row--hint">
      {info ? "Nothing configured" : "Loading…"}
    </div>
  );
}

export function PagesCard() {
  useEffect(() => {
    loadBuildInfo();
  }, []);
  return (
    <div id="pages-settings">
      <Lede>
        Set file roots and proxy targets in <code>config.json</code>, or with{" "}
        <code>MOBUX_FILES</code> and <code>MOBUX_PROXY</code>.
      </Lede>
      <Group title="Pages">
        <PagesBody info={buildInfo.value} error={buildInfoError.value} />
      </Group>
    </div>
  );
}
