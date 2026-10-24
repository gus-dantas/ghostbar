import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);
  const startedHere = useRef(false);
  const bindings = (settings?.bindings || {}) as Record<string, { current_binding: string }>;

  useEffect(() => {
    const back = () => {
      if (!startedHere.current) return;
      startedHere.current = false;
      getCurrentWindow().show();
    };
    const offSaved = listen("capture-saved", back);
    const offText = listen("text-grab-done", back);
    return () => {
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

  // Each key shows its shortcut: the window teaches the keys that make it unnecessary.
  const keys = [
    { key: "record", title: "Cast", sub: "Screen and face", keys: pretty(bindings.record_screen?.current_binding), onClick: record, cast: true },
    { key: "area", title: "Area", sub: "Screenshot", keys: pretty(bindings.screenshot_area?.current_binding), onClick: () => shoot("area") },
    { key: "window", title: "Window", sub: "Screenshot", keys: pretty(bindings.screenshot_window?.current_binding), onClick: () => shoot("window") },
    { key: "screen", title: "Screen", sub: "Screenshot", keys: pretty(bindings.screenshot_screen?.current_binding), onClick: () => shoot("screen") },
    { key: "text", title: "Text", sub: "Copy text or a table", keys: pretty(bindings.screenshot_text?.current_binding), onClick: () => shoot("text") },
  ];

  const capturedToday = files.filter((f) => isToday(f.modified)).length;
  const dictatedToday = dictations.filter((d) => isToday(dictationTime(d)));
  const todayWords = dictatedToday.reduce((n, d) => n + countWords(dictationText(d)), 0);
  const recentDictations = (dictatedToday.length ? dictatedToday : dictations).slice(0, 5);

  return (
    <div className="gus-page">
      <p className="today-sum">
        {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · {capturedToday}{" "}
        {capturedToday === 1 ? "capture" : "captures"} · {dictatedToday.length} {dictatedToday.length === 1 ? "dictation" : "dictations"} ·{" "}
        {todayWords.toLocaleString()} words
      </p>
      <MacToggles />

      <div className="gus-sec-head">
        <h2>{dictatedToday.length ? "Dictated today" : "Recent dictations"}</h2>
        {dictatedToday.length > 0 && (
          <span className="gus-count">
            {dictatedToday.length} · {todayWords.toLocaleString()} words
          </span>
        )}
        <span className="flex-1" />
        <button className="gus-link" onClick={() => onOpenDictation(null)}>
          Dictations
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
      <div className="gus-sec-head">
        <h2>{capturedToday ? "Captured today" : "Recent captures"}</h2>
        {capturedToday > 0 && <span className="gus-count">{capturedToday}</span>}
        <span className="flex-1" />
        <button className="gus-link" onClick={onOpenLibrary}>
          Library
        </button>
      </div>
      <section className="keys compact" aria-label="Capture">
        {keys.map((k) => (
          <button key={k.key} className={`key${k.cast ? " cast" : ""}`} onClick={k.onClick} title={`${k.title}: ${k.sub}${k.keys ? ` (${k.keys})` : ""}`}>
            <span className="k">{k.keys}</span>
            <span className="t">{k.title}</span>
          </button>
        ))}
      </section>
      {error && <p className="gus-error">{error}</p>}
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

    </div>
  );
};
