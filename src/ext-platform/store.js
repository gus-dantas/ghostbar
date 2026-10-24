// Ghostbar's version of the extension's lib/store.js: the same calls the
// editor and video pages make, backed by files in Downloads › Ghostbar
// instead of Chrome's IndexedDB and downloads. A capture's id is its path.
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { BaseDirectory, exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';

export const KEEP_DAYS = 7;
const FOLDER = 'Ghostbar';

// The few Chrome calls the shared pages make.
globalThis.chrome = globalThis.chrome || {
  tabs: { create: ({ url }) => invoke('open_external_url', { url }) },
  runtime: { getURL: (p) => p },
};
// "Library" links go to the main window's library.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href="library.html"]');
  if (!a) return;
  e.preventDefault();
  invoke('show_page', { page: 'library' });
});

// The pages close themselves the way a Chrome tab does (after Discard); here
// that's this window, and the main window comes back so there's somewhere to be.
window.close = () => {
  invoke('show_page', { page: 'library' }).finally(() => getCurrentWindow().close());
};

// A way back to the main window from the editor and video pages.
function addHome() {
  const lib = document.querySelector('a[href="library.html"]');
  if (!lib || document.getElementById('gus-home')) return;
  const home = document.createElement('a');
  home.id = 'gus-home';
  home.className = lib.className;
  home.href = '#';
  home.textContent = 'Home';
  home.title = 'Back to Ghostbar';
  home.addEventListener('click', (e) => {
    e.preventDefault();
    invoke('show_page', { page: 'home' });
  });
  lib.before(home);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addHome);
else addHome();

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const putCapture = async () => {};
export const listCaptures = async () => [];
export const pruneCaptures = async () => {};

const isVideo = (p) => /\.(mp4|mov|m4v|webm)$/i.test(p);
const mimeOf = (p) => (/\.webm$/i.test(p) ? 'video/webm' : /\.mov$/i.test(p) ? 'video/quicktime' : 'video/mp4');

// "Screen recording 2026-10-19 at 23.10.05" → its date; the title is the part before.
function parseName(path) {
  const name = path.split('/').pop().replace(/\.[^.]+$/, '');
  const m = name.match(/^(.*?)\s*(\d{4})-(\d{2})-(\d{2}) at (\d{2})\.(\d{2})\.(\d{2})/);
  if (!m) return { title: name, createdAt: Date.now() };
  const [, title, y, mo, d, h, mi, s] = m;
  return { title: title || name, createdAt: new Date(+y, mo - 1, +d, +h, +mi, +s).getTime() };
}

function durationOf(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = URL.createObjectURL(blob);
    v.onloadedmetadata = () => { resolve(Number.isFinite(v.duration) ? v.duration * 1000 : 0); URL.revokeObjectURL(v.src); };
    v.onerror = () => resolve(0);
  });
}

export async function getCapture(path) {
  if (!path) return null;
  const res = await fetch(convertFileSrc(path));
  if (!res.ok) return null;
  const blob = await res.blob();
  const { title, createdAt } = parseName(path);
  if (isVideo(path)) {
    const mime = mimeOf(path);
    const typed = blob.type ? blob : new Blob([blob], { type: mime });
    let sidecar = {};
    try {
      const r = await fetch(convertFileSrc(path.replace(/\.[^.]+$/, '.marks.json')));
      if (r.ok) sidecar = await r.json();
    } catch { /* no prompter marks */ }
    return { id: path, kind: 'video', blob: typed, mime, title, createdAt, duration: await durationOf(typed), onDisk: true, ...sidecar };
  }
  // A screenshot from macOS is at the screen's pixel density; the editor sizes its pens from it.
  const bm = await createImageBitmap(blob);
  const scale = Math.max(1, Math.round(devicePixelRatio || 2));
  const w = bm.width / scale, h = bm.height / scale;
  bm.close();
  return {
    id: path, kind: 'image', title, createdAt, width: w, height: h,
    parts: [{ blob, view: { w, h }, src: { x: 0, y: 0, w, h }, dst: { x: 0, y: 0 } }],
  };
}

export async function deleteCapture(path) {
  await invoke('trash_capture', { path });
}

// "Page title 2026-10-14 at 15.42.10" — safe as a macOS file name.
export function fileStem(title, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} at ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
  const clean = (title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70).trim();
  return `${clean || 'Screenshot'} ${stamp}`;
}

export async function makeThumb(source, width = 480) {
  const bm = await createImageBitmap(source);
  const scale = Math.min(1, width / bm.width);
  const c = new OffscreenCanvas(Math.max(1, Math.round(bm.width * scale)), Math.max(1, Math.round(bm.height * scale)));
  c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
  bm.close();
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
}

// Saves into Downloads › Ghostbar (or where Save As points) and tells the app.
export async function saveBlob(blob, name, saveAs = false) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let fullPath;
  if (saveAs) {
    fullPath = await saveDialog({ defaultPath: name });
    if (!fullPath) return null;
    await writeFile(fullPath, bytes);
  } else {
    await mkdir(FOLDER, { baseDir: BaseDirectory.Download, recursive: true }).catch(() => {});
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    let rel = `${FOLDER}/${name}`;
    for (let n = 2; await exists(rel, { baseDir: BaseDirectory.Download }); n++) rel = `${FOLDER}/${stem} (${n})${ext}`;
    await writeFile(rel, bytes, { baseDir: BaseDirectory.Download });
    fullPath = rel;
  }
  invoke('notify_capture_saved', { path: fullPath }).catch(() => {});
  return fullPath;
}
