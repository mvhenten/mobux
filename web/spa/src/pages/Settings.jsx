import { Link } from "wouter-preact";
import { UpdateCard } from "../components/settings/Update.jsx";
import { NotificationsCard } from "../components/settings/Notifications.jsx";
import { RendererCard } from "../components/settings/Renderer.jsx";
import { ThemeCard } from "../components/settings/Theme.jsx";
import { ShellIntegrationCard } from "../components/settings/ShellIntegration.jsx";
import { NodesCard } from "../components/settings/Nodes.jsx";
import { SttCard } from "../components/settings/Stt.jsx";
import { ListenCard } from "../components/settings/Listen.jsx";
import { BuildInfoCard } from "../components/settings/BuildInfo.jsx";

// Settings page. Composes the ported cards in the same order as the
// Rust-rendered /settings page (settings_page in src/main.rs): software update,
// install-app link, notifications, terminal renderer, theme, shell integration,
// nodes, speech-to-text, listen, build info.

export function SettingsPage() {
  return (
    <main class="settings-page">
      <UpdateCard />

      <section class="settings-card" id="install-app">
        <h2>Install app</h2>
        <p class="settings-lede">
          Add Mobux to your home screen as a standalone Android app. The install
          page has the CA certificate and APK with step-by-step instructions.
        </p>
        <Link href="/install" class="settings-link-btn">
          Open install page →
        </Link>
      </section>

      <NotificationsCard />
      <RendererCard />
      <ThemeCard />
      <ShellIntegrationCard />
      <NodesCard />
      <SttCard />
      <ListenCard />
      <BuildInfoCard />
    </main>
  );
}
