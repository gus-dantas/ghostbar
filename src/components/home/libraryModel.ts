// The library's plain logic: favourites, grouping by day, search. No React here
// except the favourites hook, so it is easy to test.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CaptureFile } from "./captures";

// ---------- favourites (this Mac only, kept with the window) ----------

const FAV_KEY = "gus-favourites";
const FAV_EVENT = "gus-favourites-changed";

// Captures moved from the old folders into Downloads › Ghostbar at launch.
const OLD_FOLDERS = /\/Downloads\/(Gus Assistant|Gus Screenshot)\//;

export function readFavourites(): Set<string> {
  try {
    const saved: string[] = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return new Set(saved.map((p) => p.replace(OLD_FOLDERS, "/Downloads/Ghostbar/")));
  } catch {
    return new Set();
  }
}

export function setFavourite(paths: string[], on: boolean) {
  const favs = readFavourites();
  for (const p of paths) {
    if (on) favs.add(p);
    else favs.delete(p);
  }
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  } catch {
    /* the star just won't stick */
  }
  window.dispatchEvent(new Event(FAV_EVENT));
}

export function useFavourites(): Set<string> {
  const [favs, setFavs] = useState(readFavourites);
  useEffect(() => {
    const update = () => setFavs(readFavourites());
    window.addEventListener(FAV_EVENT, update);
    return () => window.removeEventListener(FAV_EVENT, update);
  }, []);
  return favs;
}

// ---------- days ----------

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", a weekday within the week, then "Mon 13 Oct". */
export function dayLabel(ms: number, now = Date.now()): { title: string; sub: string } {
  const d = new Date(ms);
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  if (days === 0) return { title: "Today", sub: date };
  if (days === 1) return { title: "Yesterday", sub: date };
  if (days > 1 && days < 7) return { title: d.toLocaleDateString(undefined, { weekday: "long" }), sub: date.replace(/^\w+,?\s*/, "") };
  return { title: date, sub: "" };
}

export interface DayGroup {
  key: number;
  title: string;
  sub: string;
  files: CaptureFile[];
}

/** Newest first, one group per calendar day. */
export function groupByDay(files: CaptureFile[], now = Date.now()): DayGroup[] {
  const groups = new Map<number, DayGroup>();
  for (const f of [...files].sort((a, b) => b.modified - a.modified)) {
    const key = startOfDay(f.modified);
    if (!groups.has(key)) groups.set(key, { key, ...dayLabel(f.modified, now), files: [] });
    groups.get(key)!.files.push(f);
  }
  return [...groups.values()];
}

// ---------- where a capture came from, and the text in it ----------

export interface CaptureMeta {
  app?: string;
  window?: string;
  text?: string;
}

const META_EVENT = "capture-meta";

/** The app and window each capture came from and the text Vision read in it. */
export function useCaptureMeta(): Record<string, CaptureMeta> {
  const [meta, setMeta] = useState<Record<string, CaptureMeta>>({});
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => invoke<Record<string, CaptureMeta>>("capture_meta").then(setMeta).catch(() => {});
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 300);
    };
    load();
    const offs = [listen(META_EVENT, soon), listen("capture-saved", soon)];
    return () => {
      clearTimeout(timer);
      offs.forEach((p) => p.then((f) => f()));
    };
  }, []);
  return meta;
}

/** "Google Chrome" → "Chrome", "Microsoft PowerPoint" → "PowerPoint". */
export const shortApp = (app?: string) => (app || "").replace(/^(Google|Microsoft|Apple)\s+/, "").trim();

/** The window's title without the app's name on the end:
 * "Weekly report - Google Chrome - Work" → "Weekly report". */
export function windowTitle(meta?: CaptureMeta): string | null {
  let title = meta?.window?.trim() || "";
  if (!title) return null;
  const names = [meta?.app, shortApp(meta?.app)].filter(Boolean) as string[];
  for (const name of names) {
    for (const sep of [" - ", " — ", " – ", " | "]) {
      const at = title.toLowerCase().indexOf(`${sep}${name}`.toLowerCase());
      if (at > 0) title = title.slice(0, at);
    }
  }
  // A document's name reads better without its extension.
  title = title.trim().replace(/\.(pptx?|xlsx?|docx?|pdf|key|numbers|pages|csv|txt)$/i, "");
  return title.length >= 2 && title.toLowerCase() !== (meta?.app || "").toLowerCase() ? title : null;
}

// ---------- search ----------

/** Every word must appear in the title, the file name, the kind, the day, the
 * app it came from or the text in it. */
export function matches(f: CaptureFile, title: string, query: string, meta?: CaptureMeta): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const day = dayLabel(f.modified);
  const hay = `${title} ${f.name} ${f.kind} ${day.title} ${day.sub} ${meta?.app ?? ""} ${meta?.window ?? ""} ${meta?.text ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const formatBytes = (bytes: number) =>
  bytes >= 1_073_741_824 ? `${(bytes / 1_073_741_824).toFixed(1)} GB` : bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
