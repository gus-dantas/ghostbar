import { getCapture, fileStem, saveBlob } from './lib/store.js';
import { ICONS } from './lib/icons.js';

// ---------- constants ----------

const MAX_SIDE = 32000;   // canvas hard limit per side
const MAX_AREA = 50e6;    // keeps full-page captures inside a sane memory budget
const SIZES = { stroke: [2, 4, 8], font: [16, 22, 32], marker: [11, 14, 19], block: [6, 10, 16] };
const COLORS = ['#F03E3E', '#FAB005', '#40C057', '#228BE6', '#7048E8', '#FFFFFF', '#1A1B1E'];
const FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", sans-serif';
const TOOLS = [
  { id: 'move', key: 'v', label: 'Move' },
  { id: 'arrow', key: 'a', label: 'Arrow' },
  { id: 'rect', key: 'r', label: 'Rectangle' },
  { id: 'ellipse', key: 'o', label: 'Ellipse' },
  { id: 'pen', key: 'p', label: 'Pen' },
  { id: 'text', key: 't', label: 'Text' },
  { id: 'hl', key: 'h', label: 'Highlight' },
  { id: 'blur', key: 'b', label: 'Blur' },
  { id: 'num', key: 'n', label: 'Step number' },
  { id: 'crop', key: 'c', label: 'Crop' },
];
const BOX_TYPES = new Set(['rect', 'ellipse', 'hl', 'blur', 'crop']);

// ---------- elements ----------

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const viewport = $('#viewport');
const board = $('#board');
const scene = $('#scene');
const draft = $('#draft');
const textInput = $('#text-input');
const sctx = scene.getContext('2d');
const dctx = draft.getContext('2d');
const tmp = document.createElement('canvas');

// ---------- state ----------

let base = null;          // canvas holding the untouched capture
let W = 0, H = 0;         // image size in pixels
let px = 1;               // image pixels per CSS pixel of the captured page
let title = '';
let state = { objects: [], crop: null };
let undoStack = [];
let redoStack = [];
let tool = 'arrow';
let color = COLORS[0];
let size = 1;
let selected = -1;
let zoom = 1;
let drag = null;
let editing = null;       // text being typed: { obj, index }

// ---------- toolbar ----------

function buildToolbar() {
  const tools = $('#tools');
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.dataset.tool = t.id;
    b.title = `${t.label} (${t.key.toUpperCase()})`;
    b.setAttribute('aria-label', t.label);
    b.innerHTML = ICONS[t.id];
    b.addEventListener('click', () => setTool(t.id));
    tools.append(b);
  }

  const colors = $('#colors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    b.addEventListener('click', () => setColor(c));
    colors.append(b);
  }
  const custom = document.createElement('label');
  custom.className = 'swatch custom';
  custom.title = 'Pick any colour';
  custom.innerHTML = '<input type="color" value="#ff6b6b">';
  custom.querySelector('input').addEventListener('input', (e) => setColor(e.target.value.toUpperCase()));
  colors.append(custom);

  const sizes = $('#sizes');
  ['Thin', 'Medium', 'Thick'].forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'size-btn';
    b.title = label;
    b.dataset.size = i;
    const d = [4, 7, 11][i];
    b.innerHTML = `<i style="width:${d}px;height:${d}px"></i>`;
    b.addEventListener('click', () => setSize(i));
    sizes.append(b);
  });

  $('#undo').innerHTML = ICONS.undo;
  $('#redo').innerHTML = ICONS.redo;
  $('#copy').innerHTML = `${ICONS.copy}<span>Copy</span>`;
  $('#save').innerHTML = `${ICONS.save}<span>Save</span>`;
  $('.empty-icon').innerHTML = ICONS.image;

  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#copy').addEventListener('click', () => copy());
  $('#save').addEventListener('click', (e) => save(e.shiftKey));
  $('#zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
  $('#zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
  $('#zoom-fit').addEventListener('click', fit);
}

function setTool(id) {
  if (editing) commitText();
  tool = id;
  if (tool !== 'move') selected = -1;
  if (tool === 'hl' && color === COLORS[0]) setColor(COLORS[1]); // highlighters are yellow unless told otherwise
  board.className = `tool-${id}`;
  renderDraft();
  syncUi();
}

function setColor(c) {
  color = c;
  if (editing) { editing.obj.color = c; placeText(); }
  if (selected >= 0 && state.objects[selected] && 'color' in state.objects[selected]) {
    pushHistory();
    state.objects[selected].color = c;
    renderScene();
  }
  syncUi();
}

function setSize(i) {
  size = i;
  if (editing) { editing.obj.fs = SIZES.font[i] * px; placeText(); }
  syncUi();
}

function syncUi() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  document.querySelectorAll('.swatch[data-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
  document.querySelectorAll('[data-size]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.size === size)));
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  const ready = !!base;
  $('#copy').disabled = !ready;
  $('#save').disabled = !ready;
  $('#zoom-label').textContent = ready ? `${Math.round(zoom * px * 100)}%` : '';
  $('#dims').textContent = ready ? `${W} × ${H} px` : '';
  const crop = state.crop && clampRect(norm(state.crop));
  const ci = $('#crop-info');
  ci.hidden = !crop;
  if (crop) {
    ci.innerHTML = `Cropped to ${crop.w} × ${crop.h} px <button type="button">Clear crop</button>`;
    ci.querySelector('button').onclick = () => { pushHistory(); state.crop = null; renderDraft(); syncUi(); };
  }
}

// ---------- geometry ----------

function norm(o) {
  const x = Math.min(o.x, o.x + o.w), y = Math.min(o.y, o.y + o.h);
  return { x, y, w: Math.abs(o.w), h: Math.abs(o.h) };
}

function clampRect(r) {
  const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
  const x2 = Math.min(W, Math.round(r.x + r.w)), y2 = Math.min(H, Math.round(r.y + r.h));
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

function toImage(e) {
  const r = board.getBoundingClientRect();
  return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
}

function lightColour(c) {
  const n = parseInt(c.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

function textMetrics(o) {
  sctx.save();
  sctx.font = `600 ${o.fs}px ${FONT}`;
  const lines = o.text.split('\n');
  const w = Math.max(...lines.map((l) => sctx.measureText(l).width), o.fs * 0.3);
  sctx.restore();
  return { lines, w, lh: o.fs * 1.25, h: lines.length * o.fs * 1.25 };
}

function bbox(o) {
  const pad = (o.lw || 0) / 2;
  switch (o.type) {
    case 'arrow': {
      const p = Math.max(pad, (o.head || 0) / 2);
      return { x: Math.min(o.x1, o.x2) - p, y: Math.min(o.y1, o.y2) - p, w: Math.abs(o.x2 - o.x1) + 2 * p, h: Math.abs(o.y2 - o.y1) + 2 * p };
    }
    case 'pen': {
      const xs = o.pts.map((q) => q[0]), ys = o.pts.map((q) => q[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x: x - pad, y: y - pad, w: Math.max(...xs) - x + 2 * pad, h: Math.max(...ys) - y + 2 * pad };
    }
    case 'text': {
      const m = textMetrics(o);
      return { x: o.x, y: o.y, w: m.w, h: m.h };
    }
    case 'num':
      return { x: o.x - o.r, y: o.y - o.r, w: 2 * o.r, h: 2 * o.r };
    default: {
      const r = norm(o);
      return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
    }
  }
}

function segmentDistance(p, o) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - o.x1) * dx + (p.y - o.y1) * dy) / len2));
  return Math.hypot(p.x - (o.x1 + t * dx), p.y - (o.y1 + t * dy));
}

function hitTest(p, onlyType) {
  const tol = 6 / zoom;
  for (let i = state.objects.length - 1; i >= 0; i--) {
    const o = state.objects[i];
    if (onlyType && o.type !== onlyType) continue;
    if (o.type === 'arrow') {
      if (segmentDistance(p, o) <= Math.max(tol, o.lw)) return i;
      continue;
    }
    const b = bbox(o);
    if (p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol) return i;
  }
  return -1;
}

function translate(o, dx, dy) {
  if (o.type === 'arrow') { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
  else if (o.type === 'pen') o.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
  else { o.x += dx; o.y += dy; }
}

// ---------- drawing ----------

function drawObject(ctx, o) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (o.type) {
    case 'rect': {
      const r = norm(o);
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.lw;
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(o.lw * 1.5, r.w / 2, r.h / 2));
      ctx.stroke();
      break;
    }
    case 'ellipse': {
      const r = norm(o);
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.lw;
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'arrow': drawArrow(ctx, o); break;
    case 'pen': {
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.lw;
      const p = o.pts;
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      if (p.length < 3) {
        const last = p[p.length - 1];
        ctx.lineTo(last[0] + 0.01, last[1]);
      } else {
        for (let i = 1; i < p.length - 1; i++) {
          ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
        }
        ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      }
      ctx.stroke();
      break;
    }
    case 'hl': {
      const r = norm(o);
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = o.color;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'blur': pixelate(ctx, o); break;
    case 'num': {
      ctx.fillStyle = o.color;
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = o.r * 0.16;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = lightColour(o.color) ? '#1A1B1E' : '#fff';
      ctx.font = `700 ${o.r * (o.n > 9 ? 0.95 : 1.15)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(o.n), o.x, o.y + o.r * 0.06);
      break;
    }
    case 'text': {
      const m = textMetrics(o);
      ctx.font = `600 ${o.fs}px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, o.fs * 0.22);
      ctx.strokeStyle = lightColour(o.color) ? 'rgba(20,21,26,.85)' : '#fff';
      m.lines.forEach((ln, i) => ctx.strokeText(ln, o.x, o.y + m.lh * (i + 0.5)));
      ctx.fillStyle = o.color;
      m.lines.forEach((ln, i) => ctx.fillText(ln, o.x, o.y + m.lh * (i + 0.5)));
      break;
    }
  }
  ctx.restore();
}

function drawArrow(ctx, o) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ang = Math.atan2(dy, dx);
  const head = Math.min(o.head, len * 0.7);
  const spread = 0.42;
  const bx = o.x2 - Math.cos(ang) * head * 0.75;
  const by = o.y2 - Math.sin(ang) * head * 0.75;
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineWidth = o.lw;
  ctx.beginPath();
  ctx.moveTo(o.x1, o.y1);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(o.x2, o.y2);
  ctx.lineTo(o.x2 - head * Math.cos(ang - spread), o.y2 - head * Math.sin(ang - spread));
  ctx.lineTo(o.x2 - head * Math.cos(ang + spread), o.y2 - head * Math.sin(ang + spread));
  ctx.closePath();
  ctx.lineWidth = Math.max(1, o.lw * 0.5);
  ctx.stroke();
  ctx.fill();
}

function pixelate(ctx, o) {
  const r = clampRect(norm(o));
  if (r.w < 1 || r.h < 1) return;
  const sw = Math.max(1, Math.round(r.w / o.block));
  const sh = Math.max(1, Math.round(r.h / o.block));
  tmp.width = sw;
  tmp.height = sh;
  const t = tmp.getContext('2d');
  t.imageSmoothingEnabled = true;
  t.imageSmoothingQuality = 'high';
  t.drawImage(base, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
}

function renderScene(skip = -1) {
  if (!base) return;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, W, H);
  sctx.drawImage(base, 0, 0);
  state.objects.forEach((o, i) => { if (i !== skip) drawObject(sctx, o); });
}

// The draft layer covers the visible stage only, so live previews stay cheap
// even on a 30,000 px page.
function renderDraft() {
  const dpr = devicePixelRatio || 1;
  const sr = stage.getBoundingClientRect();
  const cw = Math.round(sr.width * dpr), ch = Math.round(sr.height * dpr);
  if (draft.width !== cw || draft.height !== ch) { draft.width = cw; draft.height = ch; }
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, cw, ch);
  if (!base) return;

  const br = board.getBoundingClientRect();
  const ox = br.left - sr.left, oy = br.top - sr.top;
  const screen = (r) => ({ x: ox + r.x * zoom, y: oy + r.y * zoom, w: r.w * zoom, h: r.h * zoom });

  const dragging = drag?.kind === 'draw' ? drag.obj : null;
  const cropRect = dragging?.type === 'crop' ? clampRect(norm(dragging)) : state.crop ? clampRect(norm(state.crop)) : null;
  if (cropRect) {
    const s = screen(cropRect);
    const img = screen({ x: 0, y: 0, w: W, h: H });
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.beginPath();
    dctx.rect(img.x, img.y, img.w, img.h);
    dctx.rect(s.x, s.y, s.w, s.h);
    dctx.fillStyle = 'rgba(8, 9, 12, 0.62)';
    dctx.fill('evenodd');
    dctx.setLineDash([6, 4]);
    dctx.lineWidth = 1.5;
    dctx.strokeStyle = '#fff';
    dctx.strokeRect(s.x, s.y, s.w, s.h);
    dctx.setLineDash([]);
    if (dragging) label(`${cropRect.w} × ${cropRect.h}`, s.x, s.y);
  }

  const live = dragging && dragging.type !== 'crop' ? dragging : drag?.kind === 'move' ? state.objects[selected] : null;
  if (live) {
    dctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * ox, dpr * oy);
    drawObject(dctx, live);
  }

  if (tool === 'move' && selected >= 0 && state.objects[selected]) {
    const s = screen(bbox(state.objects[selected]));
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.setLineDash([5, 4]);
    dctx.lineWidth = 1.5;
    dctx.strokeStyle = '#74c0fc';
    dctx.strokeRect(s.x - 4, s.y - 4, s.w + 8, s.h + 8);
    dctx.setLineDash([]);
  }

  function label(text, x, y) {
    dctx.font = `600 11px ${FONT}`;
    const w = dctx.measureText(text).width + 12;
    const ly = y > 26 ? y - 24 : y + 6;
    dctx.fillStyle = 'rgba(20,22,30,.9)';
    dctx.beginPath();
    dctx.roundRect(x, ly, w, 19, 5);
    dctx.fill();
    dctx.fillStyle = '#fff';
    dctx.textBaseline = 'middle';
    dctx.fillText(text, x + 6, ly + 10);
  }
}

// ---------- history ----------

const snapshot = () => structuredClone(state);

function pushHistory(snap = snapshot()) {
  undoStack.push(snap);
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
}

function undo() {
  if (editing) commitText();
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  state = undoStack.pop();
  selected = -1;
  renderScene();
  renderDraft();
  syncUi();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  state = redoStack.pop();
  selected = -1;
  renderScene();
  renderDraft();
  syncUi();
}

// ---------- pointer ----------

function newShape(type, p) {
  const lw = SIZES.stroke[size] * px;
  switch (type) {
    case 'arrow': return { type, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, lw, head: lw * 3 + 9 * px };
    case 'pen': return { type, pts: [[p.x, p.y]], color, lw };
    case 'blur': return { type, x: p.x, y: p.y, w: 0, h: 0, block: SIZES.block[size] * px };
    case 'hl': return { type, x: p.x, y: p.y, w: 0, h: 0, color };
    case 'crop': return { type, x: p.x, y: p.y, w: 0, h: 0 };
    default: return { type, x: p.x, y: p.y, w: 0, h: 0, color, lw };
  }
}

function updateShape(o, start, p, constrain) {
  if (o.type === 'arrow') {
    let { x, y } = p;
    if (constrain) {
      const ang = Math.round(Math.atan2(y - start.y, x - start.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(x - start.x, y - start.y);
      x = start.x + Math.cos(ang) * len;
      y = start.y + Math.sin(ang) * len;
    }
    o.x2 = x;
    o.y2 = y;
  } else if (o.type === 'pen') {
    const last = o.pts[o.pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) >= 1.5 * px) o.pts.push([p.x, p.y]);
  } else {
    let w = p.x - start.x, h = p.y - start.y;
    if (constrain) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    o.w = w;
    o.h = h;
  }
}

function bigEnough(o) {
  if (o.type === 'arrow') return Math.hypot(o.x2 - o.x1, o.y2 - o.y1) >= 6 * px;
  if (o.type === 'pen') return true;
  return Math.abs(o.w) >= 3 * px && Math.abs(o.h) >= 3 * px;
}

board.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !base) return;
  if (e.target === textInput) return;
  const p = toImage(e);

  if (editing) {
    commitText();
    if (tool === 'text') { e.preventDefault(); return; }
  }

  if (tool === 'move') {
    selected = hitTest(p);
    if (selected >= 0) {
      drag = { kind: 'move', last: p, moved: false, snap: snapshot() };
      board.setPointerCapture(e.pointerId);
      renderScene(selected);
    }
    renderDraft();
    return;
  }

  if (tool === 'text') {
    e.preventDefault();
    const i = hitTest(p, 'text');
    if (i >= 0) openText(state.objects[i], i);
    else openText({ type: 'text', x: p.x, y: p.y - SIZES.font[size] * px * 0.625, text: '', color, fs: SIZES.font[size] * px }, -1);
    return;
  }

  if (tool === 'num') {
    pushHistory();
    const n = state.objects.filter((o) => o.type === 'num').reduce((m, o) => Math.max(m, o.n), 0) + 1;
    state.objects.push({ type: 'num', x: p.x, y: p.y, n, color, r: SIZES.marker[size] * px });
    renderScene();
    syncUi();
    return;
  }

  if (tool === 'crop' && state.crop) {
    // Clicking inside an existing crop without dragging clears it on release.
    drag = { kind: 'draw', start: p, obj: newShape('crop', p), clearOnClick: true };
  } else {
    drag = { kind: 'draw', start: p, obj: newShape(tool, p) };
  }
  board.setPointerCapture(e.pointerId);
  renderDraft();
});

board.addEventListener('pointermove', (e) => {
  if (!base) return;
  const p = toImage(e);
  if (!drag) {
    if (tool === 'move') board.classList.toggle('can-move', hitTest(p) >= 0);
    return;
  }
  if (drag.kind === 'move') {
    translate(state.objects[selected], p.x - drag.last.x, p.y - drag.last.y);
    drag.last = p;
    drag.moved = true;
  } else {
    updateShape(drag.obj, drag.start, p, e.shiftKey);
  }
  renderDraft();
});

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'move') {
    if (d.moved) pushHistory(d.snap);
  } else if (d.obj.type === 'crop') {
    if (bigEnough(d.obj)) {
      pushHistory();
      state.crop = clampRect(norm(d.obj));
    } else if (d.clearOnClick) {
      pushHistory();
      state.crop = null;
    }
  } else if (bigEnough(d.obj)) {
    pushHistory();
    const o = BOX_TYPES.has(d.obj.type) ? { ...d.obj, ...norm(d.obj) } : d.obj;
    state.objects.push(o);
  }
  renderScene();
  renderDraft();
  syncUi();
}
board.addEventListener('pointerup', endDrag);
// Keep focus in the text box when clicking the board to place or finish text.
board.addEventListener('mousedown', (e) => { if (e.target !== textInput && (editing || tool === 'text')) e.preventDefault(); });
board.addEventListener('pointercancel', endDrag);
board.addEventListener('dblclick', (e) => {
  if (tool !== 'move' || !base) return;
  const i = hitTest(toImage(e), 'text');
  if (i >= 0) { setTool('text'); openText(state.objects[i], i); }
});

viewport.addEventListener('scroll', renderDraft, { passive: true });
new ResizeObserver(() => renderDraft()).observe(stage);

// ---------- text ----------

function openText(obj, index) {
  if (index >= 0) {
    pushHistory();
    state.objects.splice(index, 1);
    renderScene();
  }
  editing = { obj: { ...obj }, index };
  selected = -1;
  textInput.value = obj.text;
  textInput.hidden = false;
  placeText();
  renderDraft();
  const focus = () => {
    textInput.focus({ preventScroll: true });
    textInput.setSelectionRange(textInput.value.length, textInput.value.length);
  };
  focus();
  setTimeout(focus);
}

function placeText() {
  if (!editing) return;
  const o = editing.obj;
  const halo = lightColour(o.color) ? 'rgba(20,21,26,.85)' : '#fff';
  Object.assign(textInput.style, {
    left: `${o.x * zoom}px`,
    top: `${o.y * zoom}px`,
    fontSize: `${o.fs * zoom}px`,
    color: o.color,
    textShadow: `0 0 ${Math.max(1, o.fs * zoom * 0.12)}px ${halo}, 0 0 ${Math.max(1, o.fs * zoom * 0.12)}px ${halo}`,
  });
  textInput.style.width = '1px';
  textInput.style.height = '1px';
  textInput.style.width = `${textInput.scrollWidth + o.fs * zoom * 0.5}px`;
  textInput.style.height = `${textInput.scrollHeight}px`;
}

function commitText() {
  if (!editing) return;
  const { obj, index } = editing;
  editing = null;
  const text = textInput.value.replace(/\s+$/, '');
  textInput.hidden = true;
  textInput.value = '';
  if (text) {
    if (index < 0) pushHistory();
    const o = { ...obj, text };
    if (index >= 0) state.objects.splice(index, 0, o);
    else state.objects.push(o);
  }
  renderScene();
  renderDraft();
  syncUi();
}

textInput.addEventListener('input', placeText);
textInput.addEventListener('blur', () => setTimeout(() => { if (editing && document.activeElement !== textInput) commitText(); }, 0));

// ---------- zoom ----------

function setZoom(z, keepCenter = true) {
  if (!base) return;
  const vp = viewport;
  const cx = (vp.scrollLeft + vp.clientWidth / 2 - board.offsetLeft) / zoom;
  const cy = (vp.scrollTop + vp.clientHeight / 2 - board.offsetTop) / zoom;
  zoom = Math.min(8 / px, Math.max(0.05, z));
  board.style.width = `${W * zoom}px`;
  board.style.height = `${H * zoom}px`;
  if (keepCenter) {
    vp.scrollLeft = cx * zoom + board.offsetLeft - vp.clientWidth / 2;
    vp.scrollTop = cy * zoom + board.offsetTop - vp.clientHeight / 2;
  }
  placeText();
  renderDraft();
  syncUi();
}

function fit() {
  const avail = viewport.clientWidth - 64;
  setZoom(Math.min(1 / px, avail / W), false);
  viewport.scrollTop = 0;
}

// ---------- output ----------

function exportBlob() {
  if (editing) commitText();
  const c = state.crop ? clampRect(norm(state.crop)) : { x: 0, y: 0, w: W, h: H };
  const out = document.createElement('canvas');
  out.width = c.w;
  out.height = c.h;
  out.getContext('2d').drawImage(scene, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), 'image/png'));
}

async function copy(quiet = false) {
  if (!base) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })]);
    toast(quiet ? 'Copied to clipboard · annotate and ⌘C to copy again' : 'Copied to clipboard');
  } catch (err) {
    if (!quiet) toast(`Couldn't copy: ${err.message}`, true);
  }
}

async function save(saveAs = false) {
  if (!base) return;
  try {
    await saveBlob(await exportBlob(), `${fileStem(title)}.png`, saveAs, { captureId: new URLSearchParams(location.search).get('id') });
    if (!saveAs) toast('Saved to Downloads › Ghostbar');
  } catch (err) {
    if (!/cancel/i.test(err.message)) toast(`Couldn't save: ${err.message}`, true);
  }
}

let toastTimer;
function toast(text, error = false) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), error ? 5000 : 2600);
}

// ---------- keyboard ----------

addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (editing) {
    if (e.key === 'Escape' || (e.key === 'Enter' && mod)) { e.preventDefault(); commitText(); }
    return;
  }
  if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && key === 'y') { e.preventDefault(); redo(); return; }
  if (mod && key === 'c') {
    if (!String(getSelection())) { e.preventDefault(); copy(); }
    return;
  }
  if (mod && key === 's') { e.preventDefault(); save(e.shiftKey); return; }
  if (mod || e.altKey) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) {
    e.preventDefault();
    pushHistory();
    state.objects.splice(selected, 1);
    selected = -1;
    renderScene();
    renderDraft();
    syncUi();
    return;
  }
  if (e.key === 'Escape') { selected = -1; renderDraft(); return; }
  const t = TOOLS.find((x) => x.key === key);
  if (t) setTool(t.id);
});

// ---------- loading ----------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function setBase(canvas, scale, meta = {}) {
  base = canvas;
  W = canvas.width;
  H = canvas.height;
  px = scale;
  title = meta.title || title;
  state = { objects: [], crop: null };
  undoStack = [];
  redoStack = [];
  scene.width = W;
  scene.height = H;
  document.title = title ? `${title} · Ghostbar` : 'Ghostbar';
  $('#empty').hidden = true;
  viewport.hidden = false;
  renderScene();
  fit();
  const note = $('#note');
  note.hidden = !meta.note;
  note.textContent = meta.note || '';
  syncUi();
}

async function loadCapture(id) {
  const rec = await getCapture(id);
  if (!rec) return showEmpty('This capture has expired. Paste or drop an image instead.');
  const bitmaps = await Promise.all(rec.parts.map((p) => createImageBitmap(p.blob)));
  const inScale = bitmaps[0].width / rec.parts[0].view.w;
  const s = Math.min(inScale, MAX_SIDE / rec.width, MAX_SIDE / rec.height, Math.sqrt(MAX_AREA / (rec.width * rec.height)));
  const c = makeCanvas(Math.max(1, Math.round(rec.width * s)), Math.max(1, Math.round(rec.height * s)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  rec.parts.forEach((p, i) => {
    const bm = bitmaps[i];
    const k = bm.width / p.view.w;
    const sx = Math.round(p.src.x * k), sy = Math.round(p.src.y * k);
    const sw = Math.min(bm.width - sx, Math.round(p.src.w * k)), sh = Math.min(bm.height - sy, Math.round(p.src.h * k));
    if (sw <= 0 || sh <= 0) return;
    ctx.drawImage(bm, sx, sy, sw, sh, Math.round(p.dst.x * s), Math.round(p.dst.y * s), Math.round((sw / k) * s), Math.round((sh / k) * s));
    bm.close();
  });
  for (const r of rec.rails || []) extendRail(ctx, c, r, s);
  const notes = [];
  if (rec.truncated) notes.push('Very long page: captured the first 30,000 px.');
  if (s < inScale - 0.01) notes.push(`Scaled to ${Math.round((s / inScale) * 100)}% to fit.`);
  setBase(c, s, { title: rec.title, note: notes.join(' ') });
  if (document.hasFocus()) copy(true);
}

// A side menu shows only in the first screen of a full-page capture. If the
// column it leaves below is one flat colour, paint it in the menu's colour.
function extendRail(ctx, c, rail, s) {
  const x = Math.max(0, Math.round(rail.x * s));
  const w = Math.min(c.width - x, Math.round(rail.w * s));
  const top = Math.round((rail.y + rail.h) * s);
  const h = c.height - top;
  if (w < 4 || h < 4 || top < 4) return;
  const colour = dominantColour(ctx.getImageData(x, top - 3, w, 1).data);
  if (!colour) return;
  const col = ctx.getImageData(x, top, w, h).data;
  const [r0, g0, b0] = [col[0], col[1], col[2]];
  let off = 0, seen = 0;
  for (let yy = 0; yy < h; yy += 6) {
    for (let xx = 0; xx < w; xx += 6) {
      const i = (yy * w + xx) * 4;
      seen += 1;
      if (Math.abs(col[i] - r0) > 6 || Math.abs(col[i + 1] - g0) > 6 || Math.abs(col[i + 2] - b0) > 6) off += 1;
    }
  }
  if (off / seen > 0.01) return; // something lives there: leave it alone
  ctx.fillStyle = `rgb(${colour.join(',')})`;
  ctx.fillRect(x, top, w, h);
}

function dominantColour(data) {
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  if (best == null || n < data.length / 4 / 2) return null;
  return [best >> 16, (best >> 8) & 255, best & 255];
}

async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const bm = await createImageBitmap(file);
  const c = makeCanvas(bm.width, bm.height);
  c.getContext('2d').drawImage(bm, 0, 0);
  bm.close();
  setBase(c, devicePixelRatio || 1, { title: (file.name || '').replace(/\.[a-z0-9]+$/i, '') || 'Image' });
}

function showEmpty(message) {
  viewport.hidden = true;
  $('#empty').hidden = false;
  if (message) $('#empty-title').textContent = message;
  syncUi();
}

document.addEventListener('paste', (e) => {
  if (editing || base) return;
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); loadFile(file); }
});
$('#file').addEventListener('change', (e) => loadFile(e.target.files[0]));
stage.addEventListener('dragover', (e) => { e.preventDefault(); $('#empty').classList.add('drag'); });
stage.addEventListener('dragleave', () => $('#empty').classList.remove('drag'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  $('#empty').classList.remove('drag');
  loadFile([...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/')));
});

// ---------- boot ----------

buildToolbar();
setTool('arrow');
const params = new URLSearchParams(location.search);
if (params.get('id')) {
  loadCapture(params.get('id')).catch((err) => showEmpty(`Couldn't open this capture: ${err.message}`));
} else {
  showEmpty();
}
