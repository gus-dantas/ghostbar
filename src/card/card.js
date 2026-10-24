// The after-capture card. Rust shows the panel and sends the capture
// ("card-show"); this page fills it in, runs the countdown (held while the
// pointer is on it) and does the one-click actions. Dragging the picture drops
// the file into whatever app it lands on.
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window';
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { ICONS } from '../ext/lib/icons.js';


const $ = (s) => document.querySelector(s);
const win = getCurrentWindow();
const card = $('#card');
const life = $('#life');
const EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="m14 6 4 4"/></svg>';
const TEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 6h14M5 11h14M5 16h9"/></svg>';
const X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

let item = null;     // { path, kind, title, size, shown_at }
let dragIcon = null; // a small still for the drag
let closing = false;
let watch = null;

const button = (el, icon, label) => { el.innerHTML = `${icon}${label ? `<span>${label}</span>` : ''}`; };

function formatBytes(b) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Text from the screen: the card shows what was read, so a misread is seen
// before it's pasted.
function fillText() {
  const read = $('#read');
  const rows = item.rows;
  const text = (item.text || '').trim();
  if (rows) {
    const shown = rows.slice(0, 8).map((r, i) => `<tr>${r.map((c) => `<${i ? 'td' : 'th'}>${esc(c)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('');
    read.innerHTML = `<table>${shown}</table>`;
  } else {
    read.textContent = text || 'No text found in that area.';
  }
  read.classList.toggle('empty', !rows && !text);
  read.hidden = false;
  $('#thumb').title = '';
  $('#hint').textContent = rows
    ? `Copied · ${rows.length} rows × ${rows[0]?.length || 0} columns`
    : text ? `Copied · ${text.length} characters` : 'Nothing copied';
  button($('#copy'), ICONS.copy, rows ? 'Copy table' : 'Copy');
  $('#copy').disabled = !rows && !text;
  if (rows) button($('#open'), TEXT, 'Copy text');
  $('#open').hidden = !rows;
  button($('#reveal'), ICONS.image, 'Save');
  $('#reveal').title = 'Keep the picture in the Library';
  $('#thumb').classList.add('text');
  $('#bin').hidden = true;
}

async function fill(next) {
  if (binning && binning.path !== next.path) commitBin();
  item = next;
  closing = false;
  dragIcon = null;
  const video = item.kind === 'video';
  const text = item.kind === 'text';
  const img = $('#img');
  img.removeAttribute('src');
  $('#read').hidden = true;
  $('#thumb').classList.remove('text');
  for (const id of ['#open', '#bin', '#copy', '#reveal']) { $(id).hidden = false; $(id).disabled = false; }
  $('#bin').classList.remove('undo');
  $('#bin').title = 'Move to the Bin';
  $('#thumb').title = 'Drag it into any app · click to preview';
  if (item.kind === 'image' || item.kind === 'gif') img.src = convertFileSrc(item.path);
  else if (video) invoke('capture_thumbnail', { path: item.path }).then((p) => { if (p && item?.path === next.path) img.src = convertFileSrc(p); }).catch(() => {});
  if (!text) invoke('capture_drag_icon', { path: item.path }).then((p) => { if (item?.path === next.path) dragIcon = p; }).catch(() => {});

  $('#tag').textContent = video ? (item.path.split('.').pop() || '').toUpperCase() : '';
  $('#title').textContent = item.title;
  $('#hint').textContent = item.kind === 'image' ? 'Copied · drag it anywhere' : `${formatBytes(item.size)} · drag it anywhere`;
  button($('#copy'), ICONS.copy, 'Copy');
  $('#copy').classList.remove('done');
  if (item.kind === 'image') button($('#open'), EDIT, 'Edit');
  else button($('#open'), ICONS.play, 'Open');
  button($('#reveal'), ICONS.folder, 'Show');
  $('#reveal').title = 'Show in Finder';
  button($('#bin'), ICONS.trash, '');
  $('#bin').classList.add('danger');
  $('#reveal').classList.remove('done');
  if (text) fillText();

  // Restart the entrance and the countdown.
  card.hidden = false;
  card.classList.remove('leaving');
  card.style.setProperty('--life', video ? '12s' : text ? '10s' : '7s');
  for (const el of [card, life]) {
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }
  startWatch();
}

function close() {
  if (closing) return;
  commitBin();
  closing = true;
  stopWatch();
  card.classList.add('leaving');
  setTimeout(() => {
    invoke('capture_card_close').catch(() => {});
    card.hidden = true;
    item = null;
  }, 170);
}

// The panel never becomes key, so hover is read from the pointer's position
// as well as from the page's own mouse events.
function setHover(on) { document.body.classList.toggle('hover', on); }
document.addEventListener('mouseenter', () => setHover(true));
document.addEventListener('mouseleave', () => setHover(false));
function startWatch() {
  stopWatch();
  watch = setInterval(async () => {
    try {
      const [c, p, s] = await Promise.all([cursorPosition(), win.outerPosition(), win.outerSize()]);
      setHover(c.x >= p.x && c.x <= p.x + s.width && c.y >= p.y && c.y <= p.y + s.height);
    } catch { /* keep the last state */ }
  }, 200);
}
function stopWatch() { clearInterval(watch); watch = null; setHover(false); }

life.addEventListener('animationend', close);
$('#close').innerHTML = X;
$('#close').addEventListener('click', (e) => { e.stopPropagation(); close(); });

function copied(el, icon) {
  for (const b of [$('#copy'), $('#open')]) b.classList.remove('done');
  button(el, icon, 'Copied');
  el.classList.add('done');
}
$('#copy').addEventListener('click', async () => {
  if (!item) return;
  try {
    if (item.kind === 'text') {
      await invoke('text_grab_copy', { asTable: !!item.rows });
      if (item.rows) button($('#open'), TEXT, 'Copy text');
    } else {
      await invoke('copy_captures', { paths: [item.path] });
    }
    copied($('#copy'), ICONS.copy);
  } catch (e) { $('#hint').textContent = String(e); }
});
$('#open').addEventListener('click', async () => {
  if (!item) return;
  if (item.kind === 'text') {
    try {
      await invoke('text_grab_copy', { asTable: false });
      button($('#copy'), ICONS.copy, 'Copy table');
      copied($('#open'), TEXT);
    } catch (e) { $('#hint').textContent = String(e); }
    return;
  }
  stopWatch();
  invoke('capture_card_open', { path: item.path }).catch(() => {});
  card.hidden = true;
  item = null;
});
$('#reveal').addEventListener('click', async () => {
  if (!item) return;
  if (item.kind === 'text') {
    try {
      await invoke('text_grab_save');
      button($('#reveal'), ICONS.image, 'Saved');
      $('#reveal').classList.add('done');
    } catch (e) { $('#hint').textContent = String(e); }
    return;
  }
  invoke('reveal_capture', { path: item.path }).catch(() => {});
  close();
});
// The bin waits a few seconds with an Undo, since a capture is often the only
// copy (a Cast went to the Bin by one stray click). It goes through if the
// card closes or the next capture arrives in the meantime.
let binning = null; // { path, timer }
function commitBin() {
  if (!binning) return;
  clearTimeout(binning.timer);
  const { path } = binning;
  binning = null;
  invoke('trash_capture', { path }).catch(() => {});
}
function undoBin() {
  if (!binning) return;
  clearTimeout(binning.timer);
  binning = null;
  $('#bin').classList.remove('undo');
  if (item) fill(item);
}
$('#bin').addEventListener('click', () => {
  if (!item) return;
  if (binning) return undoBin();
  const path = item.path;
  binning = { path, timer: setTimeout(() => { commitBin(); close(); }, 4000) };
  for (const id of ['#copy', '#open', '#reveal']) $(id).hidden = true;
  $('#bin').classList.add('undo');
  $('#bin').classList.remove('danger');
  $('#bin').innerHTML = '<span>Undo</span>';
  $('#bin').title = 'Keep it';
  $('#hint').textContent = 'Moving to the Bin…';
  // Hold the countdown so the Undo stays up for the full four seconds.
  card.style.setProperty('--life', '4s');
  life.style.animation = 'none';
  void life.offsetWidth;
  life.style.animation = '';
});

const thumb = $('#thumb');
thumb.addEventListener('click', (e) => {
  if (!item || item.kind === 'text' || e.target.closest('.x')) return;
  invoke('quick_look_captures', { paths: [item.path] }).catch(() => {});
});
thumb.addEventListener('dragstart', (e) => {
  e.preventDefault();
  if (!item || item.kind === 'text') return;
  const path = item.path;
  const icon = dragIcon || (item.kind === 'image' ? path : null);
  if (!icon) return;
  startDrag({ item: [path], icon }, (r) => { if (r.result === 'Dropped') close(); }).catch(() => {});
});

listen('card-show', (e) => fill(e.payload));
invoke('capture_card_current').then((c) => { if (c) fill(c); }).catch(() => {});
