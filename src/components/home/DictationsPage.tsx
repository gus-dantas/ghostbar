import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Menu } from "@tauri-apps/api/menu";
import { Copy, PanelRight, Search, Star, Trash2, X } from "lucide-react";
import { commands } from "@/bindings";
import { dayLabel } from "./libraryModel";
import { countWords, dictationText, dictationTime, matchesDictation, useDictations, type Dictation } from "./dictations";

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
};

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const timeOf = (d: Dictation) =>
  new Date(dictationTime(d)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const copy = (text: string) => void writeText(text).catch(() => {});

// ---------- the inspector ----------

const DictationInspector: React.FC<{ entry: Dictation | null; onDelete: (d: Dictation) => void }> = ({ entry, onDelete }) => {
  const [version, setVersion] = useState<"proofread" | "said">("proofread");
  const [audio, setAudio] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setVersion("proofread");
    setCopied(false);
    setAudio(null);
    if (!entry) return;
    let live = true;
    commands
      .getAudioFilePath(entry.file_name)
      .then((r) => live && r.status === "ok" && setAudio(convertFileSrc(r.data)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [entry?.id]);

  if (!entry) {
    return (
      <aside className="lib-inspector empty">
        <p>Select a dictation to read it all, hear it or copy it.</p>
        <ul>
          <li><kbd>⌘C</kbd> Copy the text</li>
          <li><kbd>.</kbd> Keep it (never cleared)</li>
          <li><kbd>⌘⌫</kbd> Delete</li>
          <li><kbd>⌘F</kbd> Search what you said</li>
        </ul>
      </aside>
    );
  }
  const proofread = entry.post_processed_text?.trim() || null;
  const shown = version === "proofread" && proofread ? proofread : entry.transcription_text;
  const made = new Date(dictationTime(entry));
  return (
    <aside className="lib-inspector">
      <h3>Dictation</h3>
      <p className="lib-muted">
        {made.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} ·{" "}
        {countWords(shown)} words
      </p>
      {proofread && (
        <div className="gus-seg small" role="radiogroup">
          <button aria-checked={version === "proofread"} onClick={() => setVersion("proofread")}>Proofread</button>
          <button aria-checked={version === "said"} onClick={() => setVersion("said")}>As said</button>
        </div>
      )}
      <div className="dict-full" tabIndex={0}>{shown}</div>
      {audio && <audio className="dict-audio" src={audio} controls preload="none" />}
      <div className="lib-actions">
        <button
          className="primary"
          onClick={() => {
            copy(shown);
            setCopied(true);
          }}
        >
          <Copy size={14} /> {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={() => void commands.toggleHistoryEntrySaved(entry.id)}>
          <Star size={14} fill={entry.saved ? "currentColor" : "none"} /> {entry.saved ? "Kept" : "Keep"}
        </button>
        <button className="danger" onClick={() => onDelete(entry)}>
          <Trash2 size={14} /> Delete
        </button>
      </div>
    </aside>
  );
};

// ---------- the page ----------

/** Everything dictated, grouped by day, searchable, like the captures. */
export const DictationsPage: React.FC<{ focus?: number | null }> = ({ focus }) => {
  const { entries, refresh } = useDictations();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(focus ?? null);
  const [inspector, setInspector] = useState(true);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSlot(document.getElementById("gus-toolbar-slot")), []);
  useEffect(() => {
    if (focus != null) setSelected(focus);
  }, [focus]);

  const shown = useMemo(() => entries.filter((d) => matchesDictation(d, query)), [entries, query]);
  const groups = useMemo(() => {
    const out: { key: number; title: string; sub: string; items: Dictation[] }[] = [];
    for (const d of shown) {
      const key = startOfDay(dictationTime(d));
      let g = out.find((x) => x.key === key);
      if (!g) {
        g = { key, ...dayLabel(dictationTime(d)), items: [] };
        out.push(g);
      }
      g.items.push(d);
    }
    return out;
  }, [shown]);
  const entry = shown.find((d) => d.id === selected) ?? null;

  const select = useCallback((d: Dictation) => {
    setSelected(d.id);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-id="${d.id}"]`)?.scrollIntoView({ block: "nearest" }));
  }, []);

  const remove = useCallback(
    async (d: Dictation) => {
      const i = shown.findIndex((x) => x.id === d.id);
      await commands.deleteHistoryEntry(d.id).catch(() => {});
      const next = shown[i + 1] ?? shown[i - 1];
      setSelected(next ? next.id : null);
      void refresh();
    },
    [shown, refresh],
  );

  const showMenu = useCallback(
    async (d: Dictation, e: React.MouseEvent) => {
      e.preventDefault();
      select(d);
      const proofread = d.post_processed_text?.trim();
      const menu = await Menu.new({
        items: [
          { id: "copy", text: "Copy", action: () => copy(dictationText(d)) },
          ...(proofread ? [{ id: "said", text: "Copy as said", action: () => copy(d.transcription_text) }] : []),
          { item: "Separator" as const },
          { id: "keep", text: d.saved ? "Don't keep" : "Keep", action: () => void commands.toggleHistoryEntrySaved(d.id) },
          { item: "Separator" as const },
          { id: "del", text: "Delete", action: () => void remove(d) },
        ],
      });
      await menu.popup();
    },
    [select, remove],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (isTyping(e)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      // Text selected inside the reading pane copies as usual.
      if (e.metaKey && e.key.toLowerCase() === "c" && window.getSelection()?.toString()) return;
      const i = shown.findIndex((d) => d.id === selected);
      const act = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "c" && entry) return act(() => copy(dictationText(entry)));
        if (k === "backspace" && entry) return act(() => void remove(entry));
        if (k === "i") return act(() => setInspector((v) => !v));
        return;
      }
      if (e.key === "ArrowDown" && shown.length) return act(() => select(shown[Math.min(shown.length - 1, i + 1)]));
      if (e.key === "ArrowUp" && shown.length) return act(() => select(shown[Math.max(0, i - 1)]));
      if (e.key === "Escape") return act(() => setSelected(null));
      if (e.key === "." && entry) return act(() => void commands.toggleHistoryEntrySaved(entry.id));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shown, selected, entry, select, remove]);

  const words = shown.reduce((n, d) => n + countWords(dictationText(d)), 0);
  const controls = (
    <div className="lib-controls">
      <label className="lib-search">
        <Search size={13} />
        <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search what you said" aria-label="Search dictations" />
        {query && (
          <button onClick={() => setQuery("")} aria-label="Clear the search">
            <X size={12} />
          </button>
        )}
      </label>
      <button className="lib-icon" aria-pressed={inspector} onClick={() => setInspector((v) => !v)} title="Inspector (⌘I)">
        <PanelRight size={16} />
      </button>
    </div>
  );

  return (
    <div className={`lib${inspector ? " with-inspector" : ""}`}>
      {slot && createPortal(controls, slot)}
      <div className="lib-main" ref={listRef} onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
        {groups.length === 0 ? (
          <p className="gus-empty">{query ? `Nothing you said matches “${query}”.` : "No dictations yet. Hold ⌥ and talk, in any app."}</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="lib-day">
              <h2>
                {g.title} {g.sub && <small>{g.sub}</small>} <small className="n">{g.items.length}</small>
              </h2>
              <div className="dict-list">
                {g.items.map((d) => {
                  const text = dictationText(d);
                  return (
                    <button
                      key={d.id}
                      data-id={d.id}
                      className="dict-row"
                      aria-selected={d.id === selected}
                      onClick={() => select(d)}
                      onDoubleClick={() => copy(text)}
                      onContextMenu={(e) => void showMenu(d, e)}
                    >
                      <span className="t">{timeOf(d)}</span>
                      <span className="x">{text}</span>
                      <span className="m">
                        {d.saved && <Star size={11} fill="currentColor" />}
                        {d.post_processed_text ? "Proofread · " : ""}
                        {countWords(text)} words
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
        <div className="lib-status">
          {shown.length} {shown.length === 1 ? "dictation" : "dictations"} · {words.toLocaleString()} words
        </div>
      </div>
      {inspector && <DictationInspector entry={entry} onDelete={(d) => void remove(d)} />}
    </div>
  );
};
