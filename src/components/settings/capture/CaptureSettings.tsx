import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Camera,
  AppWindow,
  Monitor,
  Circle,
  Square,
  FolderOpen,
  Film,
  Image as ImageIcon,
} from "lucide-react";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { ShortcutInput } from "../ShortcutInput";
import { Button } from "../../ui/Button";

interface CaptureFile {
  path: string;
  name: string;
  kind: "image" | "gif" | "video";
  size: number;
  modified: number;
}

interface RecordingState {
  recording: boolean;
  started_ms: number | null;
}

type Filter = "all" | "video" | "gif" | "image";

const formatSize = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const formatWhen = (ms: number) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? `Today, ${time}`
    : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
};

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const CaptureSettings: React.FC = () => {
  const { t } = useTranslation();
  const [files, setFiles] = useState<CaptureFile[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [rec, setRec] = useState<RecordingState>({ recording: false, started_ms: null });
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const startedHere = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setFiles(await invoke<CaptureFile[]>("list_captures"));
      setRec(await invoke<RecordingState>("get_screen_recording_state"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const offs = [
      listen<string>("capture-saved", async () => {
        if (startedHere.current) {
          startedHere.current = false;
          await getCurrentWindow().show();
        }
        refresh();
      }),
      listen<boolean>("screen-recording", () => refresh()),
    ];
    const tick = setInterval(() => setNow(Date.now()), 500);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      offs.forEach((p) => p.then((off) => off()));
      clearInterval(tick);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  // The window steps aside so it isn't in the picture.
  const shoot = async (mode: "area" | "window" | "screen") => {
    setError(null);
    startedHere.current = true;
    await getCurrentWindow().hide();
    setTimeout(() => {
      invoke("take_screenshot", { mode }).catch((e) => setError(String(e)));
      // Bring the window back if the capture is cancelled.
      setTimeout(() => {
        if (startedHere.current) { startedHere.current = false; getCurrentWindow().show(); }
      }, mode === "screen" ? 1500 : 15000);
    }, 250);
  };

  const toggleRecording = async () => {
    setError(null);
    try {
      const recording = await invoke<boolean>("toggle_screen_recording");
      if (recording) await getCurrentWindow().hide();
      else startedHere.current = true; // show the window again when the movie is saved
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const act = (command: string, path: string) =>
    invoke(command, { path }).then(refresh).catch((e) => setError(String(e)));

  const shown = useMemo(
    () => files.filter((f) => filter === "all" || f.kind === filter),
    [files, filter],
  );
  const counts = useMemo(
    () => ({
      all: files.length,
      video: files.filter((f) => f.kind === "video").length,
      gif: files.filter((f) => f.kind === "gif").length,
      image: files.filter((f) => f.kind === "image").length,
    }),
    [files],
  );

  const actions: { mode: "area" | "window" | "screen"; icon: React.ReactNode; label: string; keys: string }[] = [
    { mode: "area", icon: <Camera size={20} />, label: t("capture.area"), keys: "⌥⇧4" },
    { mode: "window", icon: <AppWindow size={20} />, label: t("capture.window"), keys: "⌥⇧5" },
    { mode: "screen", icon: <Monitor size={20} />, label: t("capture.screen"), keys: "⌥⇧3" },
  ];

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("capture.title")} description={t("capture.description")}>
        <div className="grid grid-cols-4 gap-2 p-3">
          {actions.map((a) => (
            <button
              key={a.mode}
              onClick={() => shoot(a.mode)}
              className="flex flex-col items-center gap-1.5 rounded-lg border border-mid-gray/20 bg-mid-gray/5 px-2 py-3 text-sm font-medium hover:border-logo-primary hover:bg-logo-primary/10 transition-colors cursor-pointer"
            >
              {a.icon}
              <span>{a.label}</span>
              <span className="text-xs text-mid-gray">{a.keys}</span>
            </button>
          ))}
          <button
            onClick={toggleRecording}
            className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-sm font-medium transition-colors cursor-pointer ${
              rec.recording
                ? "border-red-500 bg-red-500/15 text-red-400"
                : "border-mid-gray/20 bg-mid-gray/5 hover:border-logo-primary hover:bg-logo-primary/10"
            }`}
          >
            {rec.recording ? <Square size={20} /> : <Circle size={20} className="text-red-500" />}
            <span>{rec.recording ? t("capture.stop") : t("capture.record")}</span>
            <span className="text-xs text-mid-gray">
              {rec.recording && rec.started_ms ? clock(now - rec.started_ms) : "⌥⇧6"}
            </span>
          </button>
        </div>
        {error && <p className="px-4 pb-3 text-xs text-red-400">{error}</p>}
      </SettingsGroup>

      <SettingsGroup title={t("capture.shortcuts")}>
        <ShortcutInput shortcutId="screenshot_area" grouped={true} />
        <ShortcutInput shortcutId="screenshot_window" grouped={true} />
        <ShortcutInput shortcutId="screenshot_screen" grouped={true} />
        <ShortcutInput shortcutId="record_screen" grouped={true} />
      </SettingsGroup>

      <SettingsGroup title={t("capture.library")} description={t("capture.libraryDescription")}>
        <div className="flex items-center gap-1.5 px-3 pt-3">
          {(["all", "video", "gif", "image"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium cursor-pointer ${
                filter === f ? "border-logo-primary bg-logo-primary/80" : "border-mid-gray/20 bg-mid-gray/5 hover:bg-mid-gray/15"
              }`}
            >
              {t(`capture.filters.${f}`)} <span className="opacity-60">{counts[f]}</span>
            </button>
          ))}
          <span className="flex-1" />
          <Button variant="secondary" size="sm" onClick={() => invoke("open_capture_folder")}>
            <span className="inline-flex items-center gap-1.5">
              <FolderOpen size={14} /> {t("capture.showFolder")}
            </span>
          </Button>
        </div>
        {shown.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-mid-gray">{t("capture.empty")}</p>
        ) : (
          <div className="grid grid-cols-3 gap-3 p-3">
            {shown.slice(0, 60).map((f) => (
              <div key={f.path} className="flex flex-col overflow-hidden rounded-lg border border-mid-gray/20 bg-mid-gray/5">
                <button
                  className="relative aspect-[16/10] bg-black/60 cursor-pointer"
                  onClick={() => act("open_capture", f.path)}
                  title={t("capture.open")}
                >
                  {f.kind === "video" ? (
                    <video src={`${convertFileSrc(f.path)}#t=0.5`} preload="metadata" muted className="h-full w-full object-contain" />
                  ) : (
                    <img src={convertFileSrc(f.path)} alt="" loading="lazy" className="h-full w-full object-contain" />
                  )}
                  <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    {f.kind === "video" ? <Film size={10} /> : <ImageIcon size={10} />}
                    {f.kind === "video" ? f.name.split(".").pop()?.toUpperCase() : f.kind === "gif" ? "GIF" : "PNG"}
                  </span>
                </button>
                <div className="px-2.5 pt-2">
                  <p className="truncate text-xs font-semibold" title={f.path}>{f.name}</p>
                  <p className="text-[11px] text-mid-gray">
                    {formatWhen(f.modified)} · {formatSize(f.size)}
                  </p>
                </div>
                <div className="mt-auto flex items-center gap-1 px-1.5 pb-1.5 pt-1">
                  <Button variant="ghost" size="sm" onClick={() => act("open_capture", f.path)}>{t("capture.open")}</Button>
                  <Button variant="ghost" size="sm" onClick={() => act("reveal_capture", f.path)}>{t("capture.reveal")}</Button>
                  <span className="flex-1" />
                  <Button variant="danger-ghost" size="sm" onClick={() => act("trash_capture", f.path)}>{t("capture.trash")}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsGroup>
    </div>
  );
};
