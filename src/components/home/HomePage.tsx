import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Camera, AppWindow, Monitor, Video, Chrome, ScanText, Copy } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useSettings } from "../../hooks/useSettings";
import { CaptureCard, captureTitle, formatWhen, useCaptures } from "./captures";
import { shortApp, useCaptureMeta, windowTitle } from "./libraryModel";
import { countWords, dictationText, dictationTime, useDictations } from "./dictations";
import { MacToggles } from "./macTools";
import { formatShortcut } from "../../lib/utils/keyboard";

const pretty = (binding?: string) => formatShortcut(binding);

const isToday = (ms: number) => new Date(ms).toDateString() === new Date().toDateString();

export const HomePage: React.FC<{ onOpenLibrary: () => void; onOpenDictation: (id: number | null) => void }> = ({
  onOpenLibrary,
  onOpenDictation,
}) => {
  const { files, refresh } = useCaptures();
  const meta = useCaptureMeta();
  const { entries: dictations } = useDictations();
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const { settings } = useSettings();
  const [chrome, setChrome] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const startedHere = useRef(false);
  const bindings = (settings?.bindings || {}) as Record<string, { current_binding: string }>;

  useEffect(() => {
    invoke<number>("extension_connections").then(setChrome).catch(() => {});
    const off = listen<number>("extension-connections", (e) => setChrome(e.payload));
    const back = () => {
      if (!startedHere.current) return;
      startedHere.current = false;
      getCurrentWindow().show();
    };
    const offSaved = listen("capture-saved", back);
    const offText = listen("text-grab-done", back);
    return () => {
      off.then((f) => f());
      offSaved.then((f) => f());
      offText.then((f) => f());
    };
  }, []);

  // The window steps aside so it isn't in the picture.
  const shoot = async (mode: "area" | "window" | "screen" | "text") => {
    setError(null);
    startedHere.current = true;
    await getCurrentWindow().hide();
    setTimeout(() => invoke("take_screenshot", { mode }).catch((e) => setError(String(e))), 250);
    // Back if the capture is cancelled (Escape leaves no file).
    setTimeout(() => {
      if (startedHere.current) {
        startedHere.current = false;
        getCurrentWindow().show();
      }
    }, mode === "screen" ? 2000 : 20000);
  };
  const record = () => invoke("cast_open").catch((e) => setError(String(e)));
  const recordTab = () => invoke("extension_record_tab").catch((e) => setError(String(e)));

  const actions = [
    { key: "record", icon: <Video size={18} />, title: "Cast", sub: "Screen and face, 16:9 or 9:16", keys: pretty(bindings.record_screen?.current_binding), onClick: record, primary: true },
    { key: "area", icon: <Camera size={18} />, title: "Area", sub: "Screenshot", keys: pretty(bindings.screenshot_area?.current_binding), onClick: () => shoot("area") },
    { key: "window", icon: <AppWindow size={18} />, title: "Window", sub: "Screenshot", keys: pretty(bindings.screenshot_window?.current_binding), onClick: () => shoot("window") },
    { key: "screen", icon: <Monitor size={18} />, title: "Screen", sub: "Screenshot", keys: pretty(bindings.screenshot_screen?.current_binding), onClick: () => shoot("screen") },
    { key: "text", icon: <ScanText size={18} />, title: "Text", sub: "Copy text or a table", keys: pretty(bindings.screenshot_text?.current_binding), onClick: () => shoot("text") },
    { key: "tab", icon: <Chrome size={18} />, title: "Chrome tab", sub: chrome ? "Record in the extension" : "Open Chrome first", keys: "", onClick: recordTab, disabled: !chrome },
  ];

  const capturedToday = files.filter((f) => isToday(f.modified)).length;
  const dictatedToday = dictations.filter((d) => isToday(dictationTime(d)));
  const todayWords = dictatedToday.reduce((n, d) => n + countWords(dictationText(d)), 0);
  const recentDictations = (dictatedToday.length ? dictatedToday : dictations).slice(0, 5);

  return (
    <div className="gus-page">
      <section className="gus-actions-grid">
        {actions.map((a) => (
          <button key={a.key} className={`gus-action${a.primary ? " primary" : ""}`} onClick={a.onClick} disabled={a.disabled}>
            <span className="ic">{a.icon}</span>
            <span className="t">{a.title}</span>
            <span className="s">{a.sub}</span>
            {a.keys && <span className="k">{a.keys}</span>}
          </button>
        ))}
      </section>
      {error && <p className="gus-error">{error}</p>}
      <MacToggles />


      <div className="gus-sec-head">
        <h2>{capturedToday ? "Captured today" : "Recent captures"}</h2>
        {capturedToday > 0 && <span className="gus-count">{capturedToday}</span>}
        <span className="flex-1" />
        <button className="gus-link" onClick={onOpenLibrary}>
          All in the library
        </button>
      </div>
      {files.length === 0 ? (
        <p className="gus-empty">Nothing yet. Record or take a screenshot and it shows up here.</p>
      ) : (
        <div className="gus-grid">
          {files.slice(0, capturedToday ? Math.min(capturedToday, 8) : 4).map((f) => {
            const m = meta[f.path];
            const named = windowTitle(m);
            const app = shortApp(m?.app);
            return (
              <CaptureCard
                key={f.path}
                file={f}
                onChange={refresh}
                title={named ?? undefined}
                sub={named || app ? [captureTitle(f), app, formatWhen(f.modified)].filter(Boolean).join(" · ") : undefined}
              />
            );
          })}
        </div>
      )}

      <div className="gus-sec-head">
        <h2>{dictatedToday.length ? "Dictated today" : "Recent dictations"}</h2>
        {dictatedToday.length > 0 && (
          <span className="gus-count">
            {dictatedToday.length} · {todayWords.toLocaleString()} words
          </span>
        )}
        <span className="flex-1" />
        <button className="gus-link" onClick={() => onOpenDictation(null)}>
          All dictations
        </button>
      </div>
      {recentDictations.length === 0 ? (
        <p className="gus-empty">Nothing dictated yet. Hold {pretty(bindings.transcribe?.current_binding) || "the dictation key"} in any app and talk.</p>
      ) : (
        <div className="dict-today">
          {recentDictations.map((d) => {
            const text = dictationText(d);
            return (
              <div key={d.id} className="dict-row" role="button" tabIndex={0} onClick={() => onOpenDictation(d.id)}>
                <span className="t">
                  {new Date(dictationTime(d)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </span>
                <span className="x">{text}</span>
                <button
                  className="dict-copy"
                  title="Copy"
                  onClick={(e) => {
                    e.stopPropagation();
                    void writeText(text).then(() => setCopiedId(d.id));
                  }}
                >
                  {copiedId === d.id ? "Copied" : <Copy size={13} />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
