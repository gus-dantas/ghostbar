import React, { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Toaster } from "sonner";
import { Cpu, FlaskConical, Info, Mic, Settings2, Sparkles } from "lucide-react";
import "../App.css";
import "../styles/gus.css";
import { useSettings } from "../hooks/useSettings";
import { useSettingsStore } from "../stores/settingsStore";
import { AboutSettings, AdvancedSettings, DebugSettings, GeneralSettings, ModelsSettings, PostProcessingSettings } from "./settings";

type Tab = "general" | "dictation" | "models" | "postprocessing" | "debug" | "about";

const NOOP = () => {};

const TABS: { id: Tab; label: string; icon: React.ReactNode; body: React.ReactNode; shown?: (s: any) => boolean }[] = [
  { id: "general", label: "General", icon: <Settings2 size={20} />, body: <AdvancedSettings /> },
  { id: "dictation", label: "Dictation", icon: <Mic size={20} />, body: <GeneralSettings /> },
  { id: "models", label: "Speech models", icon: <Cpu size={20} />, body: <ModelsSettings /> },
  { id: "postprocessing", label: "Post-processing", icon: <Sparkles size={20} />, body: <PostProcessingSettings />, shown: (s) => s?.post_process_enabled ?? false },
  { id: "debug", label: "Debug", icon: <FlaskConical size={20} />, body: <DebugSettings onPreviewOnboarding={NOOP} />, shown: (s) => s?.debug_mode ?? false },
  { id: "about", label: "About", icon: <Info size={20} />, body: <AboutSettings /> },
];

const isTab = (v: unknown): v is Tab => TABS.some((t) => t.id === v);

/** A Mac settings window: a row of tabs in the toolbar, one pane below. */
export const SettingsWindow: React.FC = () => {
  const { settings } = useSettings();
  const first = new URLSearchParams(location.search).get("page");
  const [tab, setTab] = useState<Tab>(isTab(first) ? first : "general");
  const tabs = useMemo(() => TABS.filter((t) => !t.shown || t.shown(settings)), [settings]);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];

  useEffect(() => {
    void getCurrentWindow().setTitle(current.label);
  }, [current.label]);

  useEffect(() => {
    const off = listen<string>("settings-page", (e) => isTab(e.payload) && setTab(e.payload));
    // Settings changed from the main window show up when this one comes back.
    const onFocus = () => void useSettingsStore.getState().refreshSettings();
    window.addEventListener("focus", onFocus);
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        void getCurrentWindow().close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      off.then((f) => f());
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="set-window">
      <Toaster theme="system" />
      <header className="set-toolbar" data-tauri-drag-region>
        <h1 data-tauri-drag-region>{current.label}</h1>
        <nav className="set-tabs" data-tauri-drag-region>
          {tabs.map((t) => (
            <button key={t.id} aria-current={t.id === current.id} onClick={() => setTab(t.id)}>
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      </header>
      <main className="set-pane">
        <div className="max-w-3xl w-full mx-auto px-6 py-5">{current.body}</div>
      </main>
    </div>
  );
};
