import { useEffect } from "preact/hooks";
import { buildInfo, loadBuildInfo } from "../../lib/buildInfo.js";
import { PageRows, hasPages, pageCount } from "../PagesList.jsx";
import { Group, Lede, NavRow } from "./ui.jsx";

function summary(info) {
  if (!info) return "…";
  if (!hasPages(info)) return "none";
  const { files, proxies } = pageCount(info);
  return `${files} files, ${proxies} proxies`;
}

export function PagesRow() {
  useEffect(loadBuildInfo, []);
  return (
    <NavRow
      row="pages"
      to="/settings/pages"
      label="Pages"
      value={summary(buildInfo.value)}
    />
  );
}

export function PagesCard() {
  useEffect(loadBuildInfo, []);
  const info = buildInfo.value;
  return (
    <div id="pages-settings">
      <Lede>
        Set file roots and proxy targets in <code>config.json</code>, or with{" "}
        <code>MOBUX_FILES</code> and <code>MOBUX_PROXY</code>.
      </Lede>
      <Group title="Pages">
        {hasPages(info) ? (
          <PageRows info={info} />
        ) : (
          <div class="settings-row settings-row--hint">
            {info ? "Nothing configured" : "Loading…"}
          </div>
        )}
      </Group>
    </div>
  );
}
