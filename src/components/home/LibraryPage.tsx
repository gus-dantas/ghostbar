import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import {
  Copy, Eye, FolderOpen, PanelRight, PenLine, Scissors, Search, Star, Trash2, X, Film,
} from "lucide-react";
import { captureTitle, useCaptures, useVideoThumb, type CaptureFile } from "./captures";
import {
  formatBytes, groupByDay, matches, setFavourite, shortApp, useCaptureMeta, useFavourites, windowTitle, type CaptureMeta,
} from "./libraryModel";
import type { LibraryFilter } from "../Shell";

const EMPTY: Record<Exclude<LibraryFilter, "dictation">, string> = {
  all: "Nothing yet. Take a screenshot or start a Cast and it shows up here.",
  video: "No videos yet. Start a Cast with ⌃2.",
  image: "No screenshots yet.",
  gif: "No GIFs yet. Open a video and choose Create GIF.",
  fav: "No favourites yet. Select a capture and press the full stop key.",
};

const pref = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
};
const keep = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* fine */
  }
};

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
};

// Small pictures for dragging, fetched on hover so they are ready when a drag starts.
const dragIcons = new Map<string, string>();
const prepareDragIcon = (path: string) => {
  if (dragIcons.has(path)) return;
  dragIcons.set(path, "");
  invoke<string | null>("capture_drag_icon", { path })
    .then((icon) => icon && dragIcons.set(path, icon))
    .catch(() => dragIcons.delete(path));
};

/** Drags the files out of the window, into Finder, Teams, Outlook or a deck. */
export const dragOut = async (paths: string[]) => {
  let icon = dragIcons.get(paths[0]);
  if (!icon) icon = (await invoke<string | null>("capture_drag_icon", { path: paths[0] }).catch(() => null)) ?? undefined;
  if (!icon) return;
  await startDrag({ item: paths, icon }).catch(() => {});
};

/** What it shows ("Weekly report"), else what it is ("Screenshot"). */
export const titleOf = (f: CaptureFile, meta?: CaptureMeta) => windowTitle(meta) ?? captureTitle(f);

const openEditor = (f: CaptureFile) =>
  f.kind === "gif" ? invoke("open_capture", { path: f.path }) : invoke("open_capture_page", { path: f.path });

// ---------- a tile ----------

const Tile: React.FC<{
  file: CaptureFile;
  meta?: CaptureMeta;
  selected: boolean;
  favourite: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onMenu: (e: React.MouseEvent) => void;
  dragPaths: () => string[];
}> = ({ file, meta, selected, favourite, onSelect, onOpen, onMenu, dragPaths }) => {
  const still = useVideoThumb(file);
  const src = file.kind === "video" ? still : convertFileSrc(file.path);
  const time = new Date(file.modified).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const named = windowTitle(meta);
  const app = shortApp(meta?.app);
  const sub = named || app ? [captureTitle(file), app, time].filter(Boolean).join(" · ") : `${time} · ${formatBytes(file.size)}`;
  return (
    <button
      className="lib-tile"
      data-path={file.path}
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onMenu}
      onMouseEnter={() => prepareDragIcon(file.path)}
      draggable
      onDragStart={(e) => {
        e.preventDefault();
        void dragOut(dragPaths());
      }}
      title={file.name}
    >
      <span className="lib-thumb">
        {src ? <img src={src} alt="" loading="lazy" draggable={false} /> : null}
        {file.kind !== "image" && <span className="lib-badge">{file.kind === "gif" ? "GIF" : <Film size={11} />}</span>}
        {favourite && <Star className="lib-star" size={13} fill="currentColor" />}
      </span>
      <span className="lib-name">{named ?? captureTitle(file)}</span>
      <span className="lib-sub">{sub}</span>
    </button>
  );
};

// ---------- the inspector ----------

const ManyThumb: React.FC<{ file: CaptureFile }> = ({ file }) => {
  const still = useVideoThumb(file);
  const src = file.kind === "video" ? still : convertFileSrc(file.path);
  return <span className="lib-thumb">{src ? <img src={src} alt="" /> : null}</span>;
};

const Inspector: React.FC<{
  files: CaptureFile[];
  meta: Record<string, CaptureMeta>;
  favourites: Set<string>;
  onClear: () => void;
  onChange: () => void;
}> = ({ files, meta, favourites, onClear, onChange }) => {
  const [dims, setDims] = useState("");
  const [textCopied, setTextCopied] = useState(false);
  const one = files.length === 1 ? files[0] : null;
  useEffect(() => {
    setDims("");
    setTextCopied(false);
  }, [one?.path]);

  if (!files.length) {
    return (
      <aside className="lib-inspector empty">
        <p>Select a capture to see it here.</p>
        <ul>
          <li><kbd>Space</kbd> Quick Look</li>
          <li><kbd>↵</kbd> Annotate or trim</li>
          <li><kbd>⌘C</kbd> Copy, to paste anywhere</li>
          <li><kbd>.</kbd> Favourite</li>
          <li><kbd>⌘⌫</kbd> Move to Bin</li>
          <li><kbd>⌘F</kbd> Search</li>
        </ul>
      </aside>
    );
  }
  const paths = files.map((f) => f.path);
  const allFav = files.every((f) => favourites.has(f.path));
  const actions = (
    <div className="lib-actions">
      {one && (
        <button className="primary" onClick={() => openEditor(one)}>
          {one.kind === "video" ? <Scissors size={14} /> : <PenLine size={14} />}
          {one.kind === "video" ? "Trim · GIF" : one.kind === "gif" ? "Open" : "Annotate"}
        </button>
      )}
      <button onClick={() => invoke("copy_captures", { paths })}>
        <Copy size={14} /> Copy
      </button>
      <button onClick={() => invoke("quick_look_captures", { paths })}>
        <Eye size={14} /> Quick Look
      </button>
      <button onClick={() => invoke("reveal_capture", { path: paths[0] })}>
        <FolderOpen size={14} /> Show in Finder
      </button>
      <button onClick={() => setFavourite(paths, !allFav)}>
        <Star size={14} fill={allFav ? "currentColor" : "none"} /> {allFav ? "Unfavourite" : "Favourite"}
      </button>
      <button
        className="danger"
        onClick={() =>
          invoke("trash_captures", { paths }).then(() => {
            onClear();
            onChange();
          })
        }
      >
        <Trash2 size={14} /> Move to Bin
      </button>
    </div>
  );
  if (!one) {
    const total = files.reduce((n, f) => n + f.size, 0);
    return (
      <aside className="lib-inspector">
        <div className="lib-many">
          {files.slice(0, 4).map((f) => (
            <ManyThumb key={f.path} file={f} />
          ))}
        </div>
        <h3>{files.length} selected</h3>
        <p className="lib-muted">{formatBytes(total)}</p>
        {actions}
        <button className="lib-link" onClick={onClear}>
          <X size={13} /> Clear the selection
        </button>
      </aside>
    );
  }
  const made = new Date(one.modified);
  const m = meta[one.path];
  const text = m?.text?.trim();
  return (
    <aside className="lib-inspector">
      <div
        className="lib-preview"
        draggable
        onMouseEnter={() => prepareDragIcon(one.path)}
        onDragStart={(e) => {
          e.preventDefault();
          void dragOut([one.path]);
        }}
        title="Drag into another app"
      >
        {one.kind === "video" ? (
          <video
            key={one.path}
            src={convertFileSrc(one.path)}
            controls
            preload="metadata"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              const s = Math.round(v.duration);
              setDims(`${v.videoWidth} × ${v.videoHeight} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
            }}
          />
        ) : (
          <img
            key={one.path}
            src={convertFileSrc(one.path)}
            alt=""
            onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
          />
        )}
      </div>
      <h3>{titleOf(one, m)}</h3>
      <dl className="lib-kv">
        {m?.app && (
          <>
            <dt>From</dt>
            <dd>{[shortApp(m.app), windowTitle(m) ? null : m.window].filter(Boolean).join(" · ")}</dd>
          </>
        )}
        <dt>Made</dt>
        <dd>{made.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</dd>
        <dt>Size</dt>
        <dd>
          {formatBytes(one.size)}
          {dims ? ` · ${dims}` : ""}
        </dd>
        <dt>File</dt>
        <dd className="lib-file">{one.name}</dd>
      </dl>
      {actions}
      {text && (
        <section className="lib-text">
          <header>
            <span>Text in it</span>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(text).catch(() => {});
                setTextCopied(true);
              }}
            >
              {textCopied ? "Copied" : "Copy text"}
            </button>
          </header>
          <p>{text}</p>
        </section>
      )}
    </aside>
  );
};

// ---------- the page ----------

/** Everything in Downloads › Gus Assistant, grouped by day, like Photos. */
export const LibraryPage: React.FC<{ filter: LibraryFilter }> = ({ filter }) => {
  const { files, refresh } = useCaptures();
  const favourites = useFavourites();
  const meta = useCaptureMeta();
  const [query, setQuery] = useState("");
  const [size, setSize] = useState<number>(() => pref("lib-size", 160));
  const [inspector, setInspector] = useState<boolean>(() => pref("lib-inspector", true));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSlot(document.getElementById("gus-toolbar-slot")), []);
  useEffect(() => keep("lib-size", size), [size]);
  useEffect(() => keep("lib-inspector", inspector), [inspector]);

  const shown = useMemo(
    () =>
      files.filter(
        (f) =>
          (filter === "all" || (filter === "fav" ? favourites.has(f.path) : f.kind === filter)) &&
          matches(f, titleOf(f, meta[f.path]), query, meta[f.path]),
      ),
    [files, filter, favourites, query, meta],
  );
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const order = useMemo(() => groups.flatMap((g) => g.files), [groups]);
  const picked = useMemo(() => order.filter((f) => selected.has(f.path)), [order, selected]);

  // Forget selected files that are gone or filtered out.
  useEffect(() => {
    setSelected((s) => {
      const still = new Set([...s].filter((p) => order.some((f) => f.path === p)));
      return still.size === s.size ? s : still;
    });
  }, [order]);

  const select = useCallback(
    (f: CaptureFile, e?: { metaKey?: boolean; shiftKey?: boolean }) => {
      if (e?.shiftKey && anchor) {
        const a = order.findIndex((x) => x.path === anchor);
        const b = order.findIndex((x) => x.path === f.path);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSelected(new Set(order.slice(lo, hi + 1).map((x) => x.path)));
          return;
        }
      }
      if (e?.metaKey) {
        setSelected((s) => {
          const n = new Set(s);
          if (n.has(f.path)) n.delete(f.path);
          else n.add(f.path);
          return n;
        });
      } else {
        setSelected(new Set([f.path]));
      }
      setAnchor(f.path);
      requestAnimationFrame(() =>
        gridRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(f.path)}"]`)?.scrollIntoView({ block: "nearest" }),
      );
    },
    [anchor, order],
  );

  const showMenu = useCallback(
    async (f: CaptureFile, e: React.MouseEvent) => {
      e.preventDefault();
      const targets = selected.has(f.path) ? picked : [f];
      if (!selected.has(f.path)) select(f);
      const paths = targets.map((t) => t.path);
      const fav = targets.every((t) => favourites.has(t.path));
      const many = targets.length > 1;
      const menu = await Menu.new({
        items: [
          ...(many ? [] : [{ id: "open", text: f.kind === "video" ? "Trim or make a GIF" : f.kind === "gif" ? "Open" : "Annotate", action: () => void openEditor(f) }]),
          { id: "ql", text: "Quick Look", action: () => void invoke("quick_look_captures", { paths }) },
          { id: "copy", text: many ? `Copy ${targets.length} items` : "Copy", action: () => void invoke("copy_captures", { paths }) },
          { id: "finder", text: "Show in Finder", action: () => void invoke("reveal_capture", { path: paths[0] }) },
          { item: "Separator" as const },
          { id: "fav", text: fav ? "Unfavourite" : "Favourite", action: () => setFavourite(paths, !fav) },
          { item: "Separator" as const },
          { id: "bin", text: many ? `Move ${targets.length} items to Bin` : "Move to Bin", action: () => void invoke("trash_captures", { paths }).then(refresh) },
        ],
      });
      await menu.popup();
    },
    [selected, picked, favourites, select, refresh],
  );

  // Keyboard, as in Photos and Finder.
  useEffect(() => {
    const move = (dir: "left" | "right" | "up" | "down") => {
      if (!order.length) return;
      const current = order.find((f) => f.path === anchor);
      if (!current) return select(order[0]);
      const i = order.indexOf(current);
      if (dir === "left") return select(order[Math.max(0, i - 1)]);
      if (dir === "right") return select(order[Math.min(order.length - 1, i + 1)]);
      // Up and down go to the tile drawn above or below, across day groups.
      const tiles = [...(gridRef.current?.querySelectorAll<HTMLElement>(".lib-tile") ?? [])];
      const here = tiles.find((t) => t.dataset.path === current.path)?.getBoundingClientRect();
      if (!here) return;
      const cx = here.left + here.width / 2;
      const candidates = tiles
        .map((t) => ({ t, r: t.getBoundingClientRect() }))
        .filter(({ r }) => (dir === "down" ? r.top > here.bottom - 2 : r.bottom < here.top + 2));
      if (!candidates.length) return;
      const row = dir === "down" ? Math.min(...candidates.map((c) => c.r.top)) : Math.max(...candidates.map((c) => c.r.top));
      const best = candidates
        .filter((c) => Math.abs(c.r.top - row) < 4)
        .sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx))[0];
      const next = order.find((x) => x.path === best.t.dataset.path);
      if (next) select(next);
    };
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
      const paths = picked.map((f) => f.path);
      if (e.metaKey) {
        const k = e.key.toLowerCase();
        const act = (fn: () => void) => {
          e.preventDefault();
          fn();
        };
        if (k === "a") return act(() => setSelected(new Set(order.map((f) => f.path))));
        if (k === "c" && paths.length) return act(() => void invoke("copy_captures", { paths }));
        if (k === "i") return act(() => setInspector((v) => !v));
        if (k === "backspace" && paths.length)
          return act(() => void invoke("trash_captures", { paths }).then(() => { setSelected(new Set()); refresh(); }));
        if (k === "=" || k === "+") return act(() => setSize((s) => Math.min(320, s + 30)));
        if (k === "-") return act(() => setSize((s) => Math.max(120, s - 30)));
        return;
      }
      const keys: Record<string, () => void> = {
        ArrowLeft: () => move("left"),
        ArrowRight: () => move("right"),
        ArrowUp: () => move("up"),
        ArrowDown: () => move("down"),
        " ": () => void (paths.length && invoke("quick_look_captures", { paths })),
        Enter: () => void (picked.length === 1 && openEditor(picked[0])),
        Escape: () => setSelected(new Set()),
        ".": () => paths.length && setFavourite(paths, !picked.every((f) => favourites.has(f.path))),
      };
      const run = keys[e.key];
      if (run) {
        e.preventDefault();
        run();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [order, anchor, picked, favourites, select, refresh]);

  const total = shown.reduce((n, f) => n + f.size, 0);
  const controls = (
    <div className="lib-controls">
      <input
        className="lib-size"
        type="range"
        min={120}
        max={320}
        step={10}
        value={size}
        onChange={(e) => setSize(+e.target.value)}
        title="Thumbnail size (⌘+ and ⌘−)"
        aria-label="Thumbnail size"
      />
      <label className="lib-search">
        <Search size={13} />
        <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search names, apps, text" aria-label="Search the library" />
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
    <div className={`lib${inspector ? " with-inspector" : ""}`} style={{ "--tile": `${size}px` } as React.CSSProperties}>
      {slot && createPortal(controls, slot)}
      <div
        className="lib-main"
        ref={gridRef}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(new Set());
        }}
      >
        {groups.length === 0 ? (
          <p className="gus-empty">{query ? `Nothing matches “${query}”.` : EMPTY[filter as Exclude<LibraryFilter, "dictation">]}</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="lib-day">
              <h2>
                {g.title} {g.sub && <small>{g.sub}</small>} <small className="n">{g.files.length}</small>
              </h2>
              <div className="lib-grid">
                {g.files.map((f) => (
                  <Tile
                    key={f.path}
                    file={f}
                    meta={meta[f.path]}
                    selected={selected.has(f.path)}
                    favourite={favourites.has(f.path)}
                    onSelect={(e) => select(f, e)}
                    onOpen={() => void openEditor(f)}
                    onMenu={(e) => void showMenu(f, e)}
                    dragPaths={() => (selected.has(f.path) ? picked.map((x) => x.path) : [f.path])}
                  />
                ))}
              </div>
            </section>
          ))
        )}
        <div className="lib-status">
          {shown.length} {shown.length === 1 ? "item" : "items"}
          {picked.length > 0 && ` · ${picked.length} selected`} · {formatBytes(total)}
        </div>
      </div>
      {inspector && (
        <Inspector files={picked} meta={meta} favourites={favourites} onClear={() => setSelected(new Set())} onChange={refresh} />
      )}
    </div>
  );
};
