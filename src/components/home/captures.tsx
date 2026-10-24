import React, { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Film, Image as ImageIcon, Scissors, PenLine, FolderOpen, Trash2 } from "lucide-react";

export interface CaptureFile {
  path: string;
  name: string;
  kind: "image" | "gif" | "video";
  size: number;
  modified: number;
}

/** Everything in Downloads › Gus Assistant (and the old Gus Screenshot folder), newest first. */
export function useCaptures() {
  const [files, setFiles] = useState<CaptureFile[]>([]);
  const refresh = useCallback(async () => {
    try {
      setFiles(await invoke<CaptureFile[]>("list_captures"));
    } catch {
      /* keep the last list */
    }
  }, []);
  useEffect(() => {
    refresh();
    const off = listen("capture-saved", () => refresh());
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      off.then((f) => f());
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  return { files, refresh };
}

export const formatSize = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const formatWhen = (ms: number) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? `Today, ${time}`
    : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
};

/** What a person would call it: "Cast", "Screenshot", "GIF", rather than the file name. */
export const captureTitle = (f: CaptureFile) => {
  const n = f.name.toLowerCase();
  if (n.startsWith("cast")) return n.includes("vertical") ? "Cast, 9:16" : "Cast";
  if (f.kind === "gif") return "GIF";
  if (f.kind === "video") return n.includes("vertical") ? "Screen recording, 9:16" : "Screen recording";
  return n.startsWith("full page") || n.includes("full") ? "Full page" : "Screenshot";
};

const kindLabel = (f: CaptureFile) =>
  f.kind === "video" ? (f.name.split(".").pop() || "mp4").toUpperCase() : f.kind === "gif" ? "GIF" : "PNG";

/** A video's still, made once by Quick Look and cached by the app. */
export function useVideoThumb(file: CaptureFile) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (file.kind !== "video") return;
    let live = true;
    invoke<string | null>("capture_thumbnail", { path: file.path })
      .then((p) => { if (live && p) setSrc(convertFileSrc(p)); })
      .catch(() => {});
    return () => { live = false; };
  }, [file.path, file.modified, file.kind]);
  return src;
}

/** One capture, drawn like the extension's library cards. */
export const CaptureCard: React.FC<{ file: CaptureFile; onChange: () => void; title?: string; sub?: string }> = ({ file, onChange, title, sub }) => {
  const still = useVideoThumb(file);
  const open = () => invoke("open_capture_page", { path: file.path });
  const run = (command: string) => invoke(command, { path: file.path }).then(onChange).catch(() => onChange());
  const editable = file.kind !== "gif";
  return (
    <article
      className="gus-card"
      draggable
      onMouseEnter={() => void invoke("capture_drag_icon", { path: file.path }).catch(() => {})}
      onDragStart={(e) => {
        e.preventDefault();
        void import("./LibraryPage").then((m) => m.dragOut([file.path]));
      }}
    >
      <button className="gus-thumb" onClick={editable ? open : () => run("open_capture")} title={editable ? "Open" : "Open in Preview"}>
        {file.kind === "video" ? (
          still ? <img src={still} alt="" loading="lazy" /> : null
        ) : (
          <img src={convertFileSrc(file.path)} alt="" loading="lazy" />
        )}
        <span className="gus-chip">
          {file.kind === "video" ? <Film size={11} /> : <ImageIcon size={11} />} {kindLabel(file)}
        </span>
      </button>
      <div className="gus-info">
        <h3 title={file.name}>{title ?? captureTitle(file)}</h3>
        <p>{sub ?? `${formatWhen(file.modified)} · ${formatSize(file.size)}`}</p>
      </div>
      <div className="gus-actions">
        {editable && (
          <button onClick={open} title={file.kind === "video" ? "Trim or make a GIF" : "Annotate"}>
            {file.kind === "video" ? <Scissors size={14} /> : <PenLine size={14} />}
          </button>
        )}
        <button onClick={() => run("reveal_capture")} title="Show in Finder">
          <FolderOpen size={14} />
        </button>
        <button className="del" onClick={() => run("trash_capture")} title="Move to Bin">
          <Trash2 size={14} />
        </button>
      </div>
    </article>
  );
};
