import { UpdateRow, UpdateCard } from "../components/settings/Update.jsx";
import { NotificationsCard } from "../components/settings/Notifications.jsx";
import { RendererRow } from "../components/settings/Renderer.jsx";
import { ThemeRow } from "../components/settings/Theme.jsx";
import {
  ShellIntegrationRow,
  ShellIntegrationCard,
} from "../components/settings/ShellIntegration.jsx";
import { NodesRow, NodesCard } from "../components/settings/Nodes.jsx";
import { SttRow, SttCard } from "../components/settings/Stt.jsx";
import { ListenRow, ListenCard } from "../components/settings/Listen.jsx";
import { AboutRow, BuildInfoCard } from "../components/settings/BuildInfo.jsx";
import { PagesRow, PagesCard } from "../components/settings/Pages.jsx";
import { Group, NavRow } from "../components/settings/ui.jsx";

export const SUB_PAGES = {
  update: { title: "Software update", Page: UpdateCard },
  shell: { title: "Shell integration", Page: ShellIntegrationCard },
  nodes: { title: "Nodes", Page: NodesCard },
  pages: { title: "Pages", Page: PagesCard },
  stt: { title: "Speech to text", Page: SttCard },
  listen: { title: "Listen", Page: ListenCard },
  about: { title: "About", Page: BuildInfoCard },
};

export function SettingsPage() {
  return (
    <div class="settings-page" data-page="settings">
      <Group id="install-app" title="App">
        <UpdateRow />
        <NavRow
          row="install"
          to="/install"
          label="Install app"
          secondary="Certificate and Android package"
        />
      </Group>
      <NotificationsCard />
      <Group title="Terminal">
        <RendererRow />
        <ThemeRow />
        <ShellIntegrationRow />
      </Group>
      <Group title="Hosts">
        <NodesRow />
        <PagesRow />
      </Group>
      <Group title="Voice">
        <SttRow />
        <ListenRow />
      </Group>
      <Group>
        <AboutRow />
      </Group>
    </div>
  );
}

export function SettingsSubPage({ section }) {
  const sub = SUB_PAGES[section];
  if (!sub) {
    return (
      <div class="settings-page">
        <p class="settings-lede">No settings page named “{section}”.</p>
      </div>
    );
  }
  const { Page } = sub;
  return (
    <div class="settings-page settings-subpage" data-page={section}>
      <Page />
    </div>
  );
}
