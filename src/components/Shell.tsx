import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pickVpn, useVpn, vpnBusy, vpnLabel } from "./home/macTools";
import { Home as House, LayoutGrid, Video, Image as ImageIcon, Film, AudioLines, Settings, Star } from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import { formatShortcut } from "../lib/utils/keyboard";
import { SECTIONS_CONFIG, type SidebarSection } from "./Sidebar";
import { useCaptures, type CaptureFile } from "./home/captures";
import { useFavourites } from "./home/libraryModel";
import { useDictations } from "./home/dictations";

export type Page = "home" | "library" | SidebarSection;
export type LibraryFilter = "all" | "video" | "image" | "gif" | "dictation" | "fav";

const SETTINGS: { id: SidebarSection; label: string }[] = [
  { id: "advanced", label: "General" },
  { id: "models", label: "Speech models" },
  { id: "postprocessing", label: "Post-processing" },
  { id: "debug", label: "Debug" },
  { id: "about", label: "About" },
];
export const isSettings = (p: Page) => SETTINGS.some((s) => s.id === p);

const LIBRARY: { id: LibraryFilter; label: string; icon: React.ReactNode }[] = [
  { id: "all", label: "All", icon: <LayoutGrid size={15} /> },
  { id: "video", label: "Casts and videos", icon: <Video size={15} /> },
  { id: "image", label: "Screenshots", icon: <ImageIcon size={15} /> },
  { id: "gif", label: "GIFs", icon: <Film size={15} /> },
  { id: "dictation", label: "Dictations", icon: <AudioLines size={15} /> },
  { id: "fav", label: "Favourites", icon: <Star size={15} /> },
];

export const countOf = (files: CaptureFile[], f: LibraryFilter, favs: Set<string> = new Set()) =>
  files.filter((x) => f === "all" || (f === "fav" ? favs.has(x.path) : x.kind === f)).length;

export function pageTitle(page: Page, filter: LibraryFilter): string {
  if (page === "home") return "Today";
  if (page === "library") return LIBRARY.find((l) => l.id === filter)?.label ?? "Library";
  if (page === "general") return "Dictation";
  if (page === "history") return "Dictations";
  return "Settings";
}

interface SideProps {
  page: Page;
  filter: LibraryFilter;
  onPage: (p: Page) => void;
  onFilter: (f: LibraryFilter) => void;
}

/** The VPN, beside Dictation and Chrome: where the Mac exits, and a click to
 * pick a country or turn it off (the same control as the menu bar's). */
const VpnStatus: React.FC = () => {
  const vpn = useVpn();
  if (!vpn) return null;
  const busy = vpnBusy(vpn);
  return (
    <button
      className="gus-vpn"
      onClick={() => void pickVpn(vpn)}
      title={vpn.phase === "failed" && vpn.reason ? vpn.reason : "Where the Mac's internet exits. Click to pick a country or turn it off."}
    >
      <i className={vpn.phase === "on" ? "ok" : busy ? "busy" : vpn.phase === "failed" ? "bad" : ""} />
      <span>VPN {vpnLabel(vpn)}</span>
    </button>
  );
};

/** The window's sidebar: places on the left, like Finder and Photos. */
export const Sidebar: React.FC<SideProps> = ({ page, filter, onPage, onFilter }) => {
  const { files } = useCaptures();
  const favourites = useFavourites();
  const { entries: dictations } = useDictations();
  const { settings } = useSettings();
  const [chrome, setChrome] = useState(0);
  const bindings = (settings?.bindings || {}) as Record<string, { current_binding: string }>;

  useEffect(() => {
    invoke<number>("extension_connections").then(setChrome).catch(() => {});
    const off = listen<number>("extension-connections", (e) => setChrome(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, []);

  const item = (key: string, on: boolean, icon: React.ReactNode, label: string, onClick: () => void, count?: number) => (
    <button key={key} className="gus-side-item" aria-current={on} onClick={onClick}>
      {icon}
      <span className="l">{label}</span>
      {count !== undefined && <span className="n">{count}</span>}
    </button>
  );

  return (
    <aside className="gus-side">
      <div className="gus-side-drag" data-tauri-drag-region />
      <nav className="gus-side-nav">
        {item("home", page === "home", <House size={15} />, "Today", () => onPage("home"))}
        <div className="gus-side-h">Library</div>
        {LIBRARY.map((l) =>
          item(l.id, page === "library" && filter === l.id, l.icon, l.label, () => {
            onFilter(l.id);
            onPage("library");
          }, l.id === "dictation" ? dictations.length : countOf(files, l.id, favourites)),
        )}
      </nav>
      <div className="gus-side-foot">
        {item("settings", false, <Settings size={15} />, "Settings", () => void invoke("open_settings_window", { page: null }))}
        <div className="gus-side-status">
          <span title="Dictation shortcut">
            <i className="ok" />
            Dictation <kbd>{formatShortcut(bindings.transcribe?.current_binding) || "off"}</kbd>
          </span>
          <span title={chrome ? "The Chrome extension is connected" : "Open Chrome with the Ghostbar extension"}>
            <i className={chrome ? "ok" : ""} />
            Chrome {chrome ? "connected" : "not connected"}
          </span>
          <VpnStatus />
        </div>
      </div>
    </aside>
  );
};

/** The title row above every page; the window is dragged from here. */
export const Toolbar: React.FC<{ title: string; page: Page; onPage: (p: Page) => void; children?: React.ReactNode }> = ({ title, page, onPage, children }) => {
  const { settings } = useSettings();
  const settingsPages = useMemo(() => SETTINGS.filter((s) => SECTIONS_CONFIG[s.id]?.enabled(settings)), [settings]);
  return (
    <header className="gus-toolbar" data-tauri-drag-region>
      <h1 data-tauri-drag-region>{title}</h1>
      {isSettings(page) && (
        <div className="gus-seg">
          {settingsPages.map((s) => (
            <button key={s.id} aria-checked={page === s.id} onClick={() => onPage(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      <span className="flex-1" data-tauri-drag-region />
      <div id="gus-toolbar-slot" className="gus-toolbar-slot" />
      {children}
    </header>
  );
};
