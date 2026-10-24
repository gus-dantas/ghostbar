// The live dictation editor. Speech lands where the caret is, one span per
// stretch between pauses; the accurate model's second pass replaces a span
// unless Gus edited it. When the dictation key ends the recording (released,
// or tapped again), the text gets one check against his words and is pasted:
// no Enter. Enter still finishes early; Escape closes (History keeps the text).
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';


const $ = (s) => document.querySelector(s);
const doc = $('#doc');
const LABELS = {
  idle: 'Ready', listening: 'Listening', finishing: 'Finishing…', review: 'Checking…', proofreading: 'Checking…',
  pasting: 'Pasting…',
};

let phase = 'idle';
let live = null;           // the span the current stretch of speech streams into
const chunks = new Map();  // chunk id -> span
let pending = 0;           // chunks still waiting for the accurate pass
let action = null;         // 'raw' | 'proof' asked for before the text was ready
let forceTimer = null;

// ---------- placing speech ----------

const ZWSP = '\u200B';
const plain = (t) => t.replace(/\u200B/g, '');

function caretRange() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !doc.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(false);
  // At the very end of a chunk, new speech goes after it, not inside it.
  const host = range.startContainer.parentElement?.closest('.chunk, .live');
  if (host && host !== doc) {
    const tail = document.createRange();
    tail.selectNodeContents(host);
    tail.setStart(range.startContainer, range.startOffset);
    if (!tail.toString()) range.setStartAfter(host);
  }
  return range;
}

// Typing right after a chunk lands in a text node of its own (behind an
// invisible marker), so the chunk stays as heard and can still be improved.
function caretAfter(span) {
  let next = span.nextSibling;
  if (!(next && next.nodeType === Node.TEXT_NODE && next.data.startsWith(ZWSP))) {
    next = document.createTextNode(ZWSP);
    span.after(next);
  }
  if (document.activeElement !== doc) return;
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(next, 1);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// A new span where the caret is (or at the end), with a space before it when
// it would otherwise run into the word before.
function newSpan() {
  const span = document.createElement('span');
  span.className = 'live';
  let range = caretRange();
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(doc);
    range.collapse(false);
  }
  const before = document.createRange();
  before.setStart(doc, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const textBefore = plain(before.toString());
  range.insertNode(span);
  if (textBefore && !/\s$/.test(textBefore)) {
    span._space = document.createTextNode(' ');
    span.before(span._space);
  }
  caretAfter(span);
  return span;
}

const escapeHtml = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

listen('stream-text-event', ({ payload }) => {
  // The page may have missed the start (it was reloading): ask where things are.
  if (phase === 'idle') { syncPhase(); return; }
  if (phase !== 'listening' && phase !== 'finishing') return;
  const { committed = '', tentative = '' } = payload || {};
  if (!committed && !tentative) return;
  if (!live || !live.isConnected) live = newSpan();
  live.innerHTML = escapeHtml(committed.trimStart()) + (tentative ? `<span class="tent">${escapeHtml(tentative)}</span>` : '');
  doc.scrollTop = doc.scrollHeight;
});

listen('dictation-chunk', ({ payload }) => {
  const { id, text, refining } = payload;
  let span = live && live.isConnected ? live : null;
  live = null;
  if (!text && !refining) {
    if (span) { span._space?.remove(); span.remove(); }
    return settle();
  }
  const hadCaret = span && caretRange()?.startContainer && span.contains(caretRange().startContainer);
  span = span || newSpan();
  span.textContent = text;
  span.className = refining ? 'chunk pending' : 'chunk';
  span.dataset.orig = text;
  span.dataset.shown = text;
  chunks.set(id, span);
  if (hadCaret || !span.nextSibling) caretAfter(span);
  if (refining) pending += 1;
  settle();
});

listen('dictation-refined', ({ payload }) => {
  const { id, text } = payload;
  const span = chunks.get(id);
  if (!span) return;
  chunks.delete(id);
  pending = Math.max(0, pending - 1);
  span.classList.remove('pending');
  // Only words Gus didn't touch are swapped for the better hearing; text he
  // added at either end of them stays.
  const orig = span.dataset.orig;
  const now = span.textContent;
  if (text && span.isConnected && text !== orig) {
    let better = null;
    if (now === orig) better = text;
    else if (orig && now.startsWith(orig)) better = text + now.slice(orig.length);
    else if (orig && now.endsWith(orig)) better = now.slice(0, now.length - orig.length) + text;
    if (better !== null) {
      span.textContent = better;
      span.classList.add('refined');
    }
  }
  if (!span.textContent) { span._space?.remove(); span.remove(); }
  else span.dataset.shown = span.textContent;
  if (phase === 'review' && pending === 0) recover();
  // The pause before this chunk fell mid-sentence: the chunk before loses the
  // full stop it got there (unless Gus changed that chunk himself).
  if (payload.joins != null && span.isConnected) {
    const prev = previousChunk(span);
    const t = prev?.textContent || '';
    if (prev && t === prev.dataset.shown && /[^.]\.$/.test(t)) {
      prev.textContent = t.slice(0, -1) + payload.joins;
      prev.dataset.shown = prev.textContent;
    }
  }
  settle();
});

// The chunk right before this one, with only spaces between them.
function previousChunk(span) {
  let node = span.previousSibling;
  while (node && node.nodeType === Node.TEXT_NODE && !plain(node.data).trim()) node = node.previousSibling;
  return node?.classList?.contains('chunk') ? node : null;
}

// ---------- phases and actions ----------

// The app keeps its own copy of everything heard. If the panel ends up empty
// anyway (an event it never got), it takes the text from there.
async function recover() {
  if (plain(doc.innerText).trim() || pending > 0) return;
  try {
    const s = await invoke('dictation_state');
    if (!s.text || plain(doc.innerText).trim()) return;
    const span = newSpan();
    span.textContent = s.text;
    span.className = 'chunk';
    span.dataset.orig = span.dataset.shown = s.text;
    caretAfter(span);
    $('#state-text').textContent = 'Ready · text recovered';
  } catch { /* nothing to recover */ }
}

async function syncPhase() {
  try {
    const s = await invoke('dictation_state');
    if (s.phase !== phase) setPhase(s.phase);
  } catch { /* keep the phase we have */ }
}

listen('dictation-error', ({ payload }) => showError(payload));

function setPhase(p) {
  phase = p;
  document.body.dataset.phase = p;
  $('#state-text').textContent = LABELS[p] || p;
  if (p === 'idle') reset();
  if (p === 'listening') {
    showError(null);
    focusEnd();
  }
  if (p === 'review') {
    recover();
    // The key ended it: check and paste on its own once the last words are in.
    if (!action) action = 'proof';
  }
  settle();
}

function reset() {
  doc.textContent = '';
  chunks.clear();
  live = null;
  pending = 0;
  action = null;
  clearTimeout(forceTimer);
}

function focusEnd() {
  doc.focus({ preventScroll: true });
  if (caretRange()) return;
  const range = document.createRange();
  range.selectNodeContents(doc);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

listen('dictation-phase', ({ payload }) => setPhase(payload));

// Run a waiting Enter once the last chunk and its second pass are in.
function settle() {
  if (phase === 'review' && pending > 0) $('#state-text').textContent = 'Checking · the last words…';
  if (!action || phase !== 'review') return;
  if (pending > 0) {
    clearTimeout(forceTimer);
    forceTimer = setTimeout(() => run(action), 3000);
    return;
  }
  run(action);
}

function act(kind) {
  if (phase === 'proofreading') return;
  action = kind;
  if (phase === 'listening') {
    $('#state-text').textContent = 'Finishing…';
    invoke('dictation_stop');
    return;
  }
  settle();
}

async function run(kind) {
  clearTimeout(forceTimer);
  action = null;
  const text = plain(doc.innerText);
  showError(null);
  try {
    await invoke('dictation_finish', { text, proofread: kind === 'proof' });
  } catch (e) {
    showError(String(e));
  }
}

function showError(text) {
  $('#err').hidden = !text;
  $('#err').textContent = text || '';
}

doc.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    act('proof');
  } else if (e.key === 'Escape') {
    e.preventDefault();
    invoke('dictation_close', { text: plain(doc.innerText) });
  }
});
$('#close').addEventListener('click', () => invoke('dictation_close', { text: plain(doc.innerText) }));
window.addEventListener('focus', () => {
  syncPhase();
  if (phase === 'listening' || phase === 'review') focusEnd();
});

// ---------- size ----------

// The panel is only as tall as its text (up to a cap), growing upward so its
// bottom edge stays put.
const win = getCurrentWindow();
const MIN_H = 64;
const MAX_H = 230;
let height = 0;
let fitting = false;

async function fit() {
  if (fitting) return;
  fitting = true;
  try {
    const footer = document.querySelector('footer');
    const err = $('#err');
    const wanted = doc.scrollHeight + footer.offsetHeight + (err.hidden ? 0 : err.offsetHeight) + 14;
    const h = Math.round(Math.min(MAX_H, Math.max(MIN_H, wanted)));
    if (Math.abs(h - height) < 2) return;
    const scale = await win.scaleFactor();
    const pos = (await win.outerPosition()).toLogical(scale);
    const size = (await win.outerSize()).toLogical(scale);
    const bottom = pos.y + size.height;
    await win.setSize(new LogicalSize(size.width, h));
    await win.setPosition(new LogicalPosition(pos.x, bottom - h));
    height = h;
  } catch {
    /* outside the app (tests) there is no window to size */
  } finally {
    fitting = false;
  }
}
new MutationObserver(() => requestAnimationFrame(fit)).observe(doc, { childList: true, subtree: true, characterData: true });
new MutationObserver(() => requestAnimationFrame(fit)).observe($('#err'), { attributes: true });

// ---------- boot ----------

invoke('dictation_state').then((s) => setPhase(s.phase));
