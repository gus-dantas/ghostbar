// The Settings window (⌘,): Ghostbar's settings, apart from the library.
import React from "react";
import ReactDOM from "react-dom/client";
import { platform } from "@tauri-apps/plugin-os";
import { installCompatShims } from "../lib/compat";
import { applyTheme, getStoredTheme, syncThemeFromSettings } from "../lib/utils/theme";
import "../i18n";
import { useModelStore } from "../stores/modelStore";
import { SettingsWindow } from "../components/SettingsWindow";

installCompatShims();
document.documentElement.dataset.platform = platform();
applyTheme(getStoredTheme());
syncThemeFromSettings();
useModelStore.getState().initialize();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>,
);
