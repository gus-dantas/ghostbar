// Cast's panel: pick a screen or window, landscape or a 9:16 phone frame you
// steer, place the face bubble, prompter and countdown; then a compact bar
// (with the steering view in 9:16) while it records. The video is composited
// natively, so the previews here are what the file gets.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';
import { ICONS } from '../ext/lib/icons.js';
import { parseBlocks, SILVIA_BLOCKS } from '../ext/lib/prompter.js';

const $ = (s) => document.querySelector(s);
const win = getCurrentWindow();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pref = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* fine */ } };

const SIZES = [{ label: 'S', share: 0.16 }, { label: 'M', share: 0.22 }, { label: 'L', share: 0.3 }];
const PHONE = { w: 1080, h: 1920 };
const BAR = { w: 400, h: 60 };
const STEER = { w: 440, h: 320 };

let sources = [];
let source = null;
let kind = pref('cast-kind', 'display');
let format = pref('cast-format', 'landscape');
let size = pref('cast-size', 1);
const view = { cx: 0.75, cy: 0.5, zoom: 1.4, ...pref('cast-view', {}) };
const spots = { landscape: { x: 0.1, y: 0.82 }, vertical: { x: 0.18, y: 0.84 }, ...pref('cast-spots', {}) };
let phase = 'setup';
let poll = null;
let previewTimer = null;
let prepared = false;

// ---------- options ----------

$('#mic').checked = pref('cast-mic', true);
$('#sys').checked = pref('cast-sys', false);
$('#cam').checked = pref('cast-cam', true);
$('#prompt').checked = pref('cast-prompt', false);
$('#countdown').checked = pref('cast-countdown', true);
$('#blocks').value = pref('blocks', '') || SILVIA_BLOCKS;
$('#face').value = String(pref('facezoom', 1));
$('#stop').innerHTML = `${ICONS.stop}<span>Stop</span>`;
$('#discard').innerHTML = ICONS.trash;

for (const [id, key] of [['mic', 'cast-mic'], ['countdown', 'cast-countdown']]) {
  $(`#${id}`).addEventListener('change', (e) => keep(key, e.target.checked));
}
$('#sys').addEventListener('change', (e) => { keep('cast-sys', e.target.checked); prepare(); });
$('#cam').addEventListener('change', (e) => { keep('cast-cam', e.target.checked); syncOptions(); prepare(); });
$('#prompt').addEventListener('change', (e) => { keep('cast-prompt', e.target.checked); syncOptions(); });
$('#blocks').addEventListener('input', (e) => keep('blocks', e.target.value));
$('#silvia').addEventListener('click', () => { $('#blocks').value = SILVIA_BLOCKS; keep('blocks', SILVIA_BLOCKS); });
$('#face').addEventListener('input', (e) => { keep('facezoom', +e.target.value); sendBubble(); });
$('#close').addEventListener('click', () => invoke('cast_close'));

SIZES.forEach((s, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = s.label;
  b.addEventListener('click', () => { size = i; keep('cast-size', i); syncOptions(); sendBubble(); });
  $('#sizes').append(b);
});

function syncOptions() {
  $('#cam-opts').hidden = !$('#cam').checked;
  $('#prompt-opts').hidden = !$('#prompt').checked;
  [...$('#sizes').children].forEach((b, i) => b.setAttribute('aria-checked', String(i === size)));
  document.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.kind === kind)));
  document.querySelectorAll('[data-format]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.format === format)));
  $('#screens').hidden = kind !== 'display';
  $('#windows').hidden = kind !== 'window';
  $('#land').hidden = format !== 'landscape';
  $('#vert').hidden = format !== 'vertical';
  $('#place-tip').textContent = !$('#cam').checked
    ? ''
    : format === 'landscape'
      ? 'Drag your face on the screen (or here) to place it.'
      : 'Left: drag to choose what the phone shows, scroll to zoom. Right: drag your face.';
}

// ---------- the bubble and the phone frame ----------

function sendBubble() {
  const spot = spots[format];
  invoke('cast_bubble', {
    bubble: { x: spot.x, y: spot.y, size: SIZES[size].share, face_zoom: +$('#face').value, show: $('#cam').checked },
  });
}

function sendView() {
  invoke('cast_view', { vertical: format === 'vertical', cx: view.cx, cy: view.cy, zoom: view.zoom });
}

// The on-screen bubble was dragged: remember where (the video already follows).
listen('cast-bubble-moved', ({ payload }) => {
  if (format !== 'landscape') return;
  spots.landscape = { x: payload.x, y: payload.y };
  keep('cast-spots', spots);
});

function dragBubble(el) {
  const move = (e) => {
    const r = el.getBoundingClientRect();
    spots[format] = { x: clamp((e.clientX - r.left) / r.width, 0.05, 0.95), y: clamp((e.clientY - r.top) / r.height, 0.05, 0.95) };
    sendBubble();
  };
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); move(e); });
  el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) move(e); });
  el.addEventListener('pointerup', () => keep('cast-spots', spots));
}
dragBubble($('#land'));
dragBubble($('#phone-wrap'));

const aspect = () => (source ? source.w / source.h : 16 / 10);

// Where the phone frame sits on the source, as shares (same maths as the engine).
function cropRect(v) {
  const sw = aspect(), sh = 1;
  let h = sh / v.zoom, w = (h * PHONE.w) / PHONE.h;
  if (w > sw) { w = sw; h = (w * PHONE.h) / PHONE.w; }
  const x = clamp(v.cx * sw - w / 2, 0, sw - w), y = clamp(v.cy * sh - h / 2, 0, sh - h);
  return { x: x / sw, y, w: w / sw, h };
}

function keepViewInside() {
  const c = cropRect(view);
  view.cx = c.x + c.w / 2;
  view.cy = c.y + c.h / 2;
}

function drawCrop() {
  const c = cropRect(view);
  const st = $('#crop').style;
  st.left = `${c.x * 100}%`;
  st.top = `${c.y * 100}%`;
  st.width = `${c.w * 100}%`;
  st.height = `${c.h * 100}%`;
}

(() => {
  const wrap = $('#src-wrap');
  const moveTo = (e) => {
    const r = wrap.getBoundingClientRect();
    view.cx = clamp((e.clientX - r.left) / r.width, 0, 1);
    view.cy = clamp((e.clientY - r.top) / r.height, 0, 1);
    keepViewInside();
    drawCrop();
    sendView();
  };
  wrap.addEventListener('pointerdown', (e) => { wrap.setPointerCapture(e.pointerId); moveTo(e); });
  wrap.addEventListener('pointermove', (e) => { if (wrap.hasPointerCapture(e.pointerId)) moveTo(e); });
  wrap.addEventListener('pointerup', () => keep('cast-view', view));
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.zoom = clamp(view.zoom * (1 - e.deltaY * 0.0015), 1, 4);
    keepViewInside();
    drawCrop();
    sendView();
    keep('cast-view', view);
  }, { passive: false });
})();

function sizeSrcWrap() {
  // the source preview keeps the source's shape inside its box
  const wrap = $('#src-wrap');
  const box = wrap.parentElement.getBoundingClientRect();
  const phoneW = $('#phone-wrap').getBoundingClientRect().width;
  const room = box.width - phoneW - 8;
  const h = Math.min(box.height, room / aspect());
  wrap.style.flex = 'none';
  wrap.style.width = `${Math.round(h * aspect())}px`;
  wrap.style.height = `${Math.round(h)}px`;
  wrap.style.alignSelf = 'center';
}

document.querySelectorAll('[data-format]').forEach((b) => b.addEventListener('click', () => {
  format = b.dataset.format;
  keep('cast-format', format);
  syncOptions();
  sendView();
  sendBubble();
  if (format === 'vertical') requestAnimationFrame(sizeSrcWrap);
  drawCrop();
}));

// ---------- sources ----------

document.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
  kind = b.dataset.kind;
  keep('cast-kind', kind);
  syncOptions();
  const first = sources.find((s) => s.kind === kind);
  if (kind === 'window') loadThumbs();
  if (first && source?.kind !== kind) choose(kind === 'display' ? first : sources.find((s) => s.kind === 'window' && sameAs(s, pref('cast-window', null))) || first);
}));

const sameAs = (s, saved) => saved && s.kind === saved.kind && (s.id === saved.id || (s.app === saved.app && s.name === saved.name));

async function loadSources() {
  try {
    sources = await invoke('cast_sources');
  } catch (e) {
    showError(String(e));
    return;
  }
  const screens = $('#screens');
  screens.innerHTML = '';
  const displays = sources.filter((s) => s.kind === 'display');
  if (displays.length > 1) {
    for (const d of displays) {
      const b = document.createElement('button');
      b.className = 'chip-btn';
      b.textContent = d.name;
      b.dataset.key = `display:${d.id}`;
      b.addEventListener('click', () => choose(d));
      screens.append(b);
    }
  }
  const wins = $('#windows');
  wins.innerHTML = '';
  for (const w of sources.filter((s) => s.kind === 'window')) {
    const b = document.createElement('button');
    b.className = 'win';
    b.dataset.key = `window:${w.id}`;
    b.innerHTML = '<div class="thumb"></div><div class="t"></div><div class="s"></div>';
    b.querySelector('.t').textContent = w.app || 'Window';
    b.querySelector('.s').textContent = w.name || ' ';
    b.addEventListener('click', () => choose(w));
    wins.append(b);
  }
  const saved = pref('cast-source', null);
  const pick = sources.find((s) => s.kind === kind && sameAs(s, saved)) || displays[0];
  if (pick) {
    kind = pick.kind;
    syncOptions();
    if (kind === 'window') loadThumbs();
    choose(pick);
  }
}

let thumbsLoaded = false;
async function loadThumbs() {
  if (thumbsLoaded) return;
  thumbsLoaded = true;
  for (const el of document.querySelectorAll('.win')) {
    const [k, id] = el.dataset.key.split(':');
    const url = await invoke('cast_thumbnail', { kind: k, id: +id }).catch(() => null);
    if (url) el.querySelector('.thumb').style.backgroundImage = `url("${url}")`;
  }
}

function choose(s) {
  source = s;
  keep('cast-source', { kind: s.kind, id: s.id, app: s.app, name: s.name });
  if (s.kind === 'window') keep('cast-window', { kind: s.kind, id: s.id, app: s.app, name: s.name });
  document.querySelectorAll('[data-key]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.key === `${s.kind}:${s.id}`)));
  keepViewInside();
  drawCrop();
  if (format === 'vertical') requestAnimationFrame(sizeSrcWrap);
  prepare();
}

let preparing = Promise.resolve();
function prepare() {
  if (!source || phase !== 'setup') return preparing;
  const s = source;
  preparing = preparing.then(async () => {
    showError(null);
    $('#land-empty').hidden = false;
    $('#land-empty').textContent = 'Starting the preview…';
    try {
      await invoke('cast_prepare', { source: s, camera: $('#cam').checked, systemAudio: $('#sys').checked });
      prepared = true;
      sendView();
      sendBubble();
      $('#land-empty').hidden = true;
    } catch (e) {
      prepared = false;
      $('#land-empty').textContent = 'No preview';
      showError(String(e));
      refreshPermission();
    }
  });
  return preparing;
}

// ---------- previews ----------

function startPreviews() {
  clearInterval(previewTimer);
  let n = 0;
  previewTimer = setInterval(async () => {
    if (!prepared) return;
    n += 1;
    const steering = phase === 'recording' || phase === 'paused';
    if (format === 'landscape' && !steering) {
      const url = await invoke('cast_preview', { which: 0, width: 760 });
      if (url) $('#out-land').src = url;
    } else if (format === 'vertical') {
      const out = await invoke('cast_preview', { which: 0, width: 240 });
      if (out) $('#out-vert').src = out;
      if (n % 2 === 0) {
        const src = await invoke('cast_preview', { which: 1, width: 520 });
        if (src) $('#src-img').src = src;
      }
    }
  }, 120);
}

// ---------- permission ----------

async function refreshPermission() {
  const s = await invoke('cast_state');
  $('#perm').hidden = s.permission;
  return s;
}
$('#perm-btn').addEventListener('click', async () => {
  await invoke('cast_request_permission');
  refreshPermission();
});
$('#perm-reopen').addEventListener('click', () => invoke('cast_relaunch'));

invoke('extension_connections').then((n) => { $('#chrome').hidden = !n; }).catch(() => {});
listen('extension-connections', (e) => { $('#chrome').hidden = !e.payload; });
$('#chrome').addEventListener('click', async () => {
  try {
    await invoke('extension_record_tab');
    invoke('cast_close');
  } catch (e) {
    showError(String(e));
  }
});

// ---------- recording ----------

const blocks = () => ($('#prompt').checked ? parseBlocks($('#blocks').value).map((b) => b.title) : []);
let setupSize = null;

async function countdown() {
  if (!$('#countdown').checked) return;
  show('counting');
  for (let n = 3; n > 0; n--) {
    const el = $('#count');
    el.textContent = String(n);
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    await sleep(1000);
  }
}

async function begin() {
  showError(null);
  await preparing;
  if (!prepared) {
    showError('Pick what to record first (the preview has to be running).');
    return;
  }
  await countdown();
  try {
    await invoke('cast_start', { options: { microphone: $('#mic').checked, blocks: blocks() } });
  } catch (e) {
    show('setup');
    showError(String(e));
    return;
  }
  phase = 'recording';
  await compact();
}
$('#start').addEventListener('click', begin);

async function compact() {
  if (!setupSize) {
    const s = await win.innerSize();
    const f = await win.scaleFactor();
    setupSize = { w: s.width / f, h: s.height / f };
  }
  show('live');
  document.body.classList.add('live');
  const steering = format === 'vertical';
  document.body.classList.toggle('steering', steering);
  $('#steer').hidden = !steering;
  if (steering) {
    $('#steer').append($('#vert'));
    $('#vert').hidden = false;
  }
  await resize(steering ? STEER : BAR);
  if (steering) requestAnimationFrame(() => { sizeSrcWrap(); drawCrop(); });
  clearInterval(poll);
  poll = setInterval(tick, 250);
  tick();
}

async function backToSetup() {
  clearInterval(poll);
  document.body.classList.remove('live', 'steering');
  // the phone view goes back under the format switch
  $('#land').after($('#vert'));
  phase = 'setup';
  show('setup');
  syncOptions();
  if (setupSize) await resize(setupSize);
  if (format === 'vertical') requestAnimationFrame(sizeSrcWrap);
}

async function tick() {
  const s = await invoke('cast_state').catch(() => null);
  if (!s) return;
  const sec = Math.floor(s.elapsed_ms / 1000);
  $('#time').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const paused = s.phase === 'paused';
  phase = s.phase;
  $('#rec-dot').classList.toggle('paused', paused);
  $('#pause').innerHTML = paused ? ICONS.play : ICONS.pause;
  $('#pause').title = paused ? 'Resume' : 'Pause';
  if (s.phase === 'saving') show('saving');
  if (s.failure) showError(s.failure);
}

$('#pause').addEventListener('click', () => invoke('cast_pause'));
$('#stop').addEventListener('click', async () => {
  clearInterval(poll);
  show('saving');
  try {
    await invoke('cast_stop');
  } catch (e) {
    await backToSetup();
    showError(String(e));
  }
});
$('#discard').addEventListener('click', async () => {
  if (!(await ask('Throw this recording away?', { title: 'Gus Assistant', kind: 'warning' }))) return;
  clearInterval(poll);
  invoke('cast_discard');
});
$('#restart').addEventListener('click', async () => {
  clearInterval(poll);
  await invoke('cast_restart');
  await backToSetup();
  await begin();
});

// ---------- helpers ----------

function show(id) {
  for (const s of ['setup', 'counting', 'live', 'saving']) $(`#${s}`).hidden = s !== id;
}

async function resize({ w, h }) {
  await win.setSize(new LogicalSize(w, h)).catch(() => {});
}

function showError(text) {
  $('#err').hidden = !text;
  $('#err').textContent = text || '';
}

// ---------- boot ----------

syncOptions();
drawCrop();
startPreviews();
refreshPermission();
invoke('cast_state').then((s) => {
  if (s.phase === 'recording' || s.phase === 'paused') {
    phase = s.phase;
    prepared = true;
    compact();
  } else {
    show('setup');
    loadSources();
  }
});
