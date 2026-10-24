// The prompter: cue cards, not a script, floating on screen and kept out of the
// video. Next / Redo / Back drop time marks (start | redo | end) that reelkit
// uses to keep the last try of each block — the same marks as the extension's.
import { invoke } from '@tauri-apps/api/core';
import { parseBlocks, SILVIA_BLOCKS } from '../ext/lib/prompter.js';

const $ = (id) => document.getElementById(id);
const pref = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const blocks = parseBlocks(pref('blocks', '') || SILVIA_BLOCKS);
let cur = 0;
let flashTimer;

function render(state) {
  const done = cur >= blocks.length;
  const b = blocks[cur];
  $('count').textContent = done ? 'done' : `${cur + 1} / ${blocks.length}`;
  $('prog').style.width = `${(Math.min(cur, blocks.length) / blocks.length) * 100}%`;
  $('title').textContent = done ? 'That’s all. Stop the recording when you’re ready.' : b.title;
  $('cues').innerHTML = '';
  for (const c of done ? [] : b.cues) {
    const s = document.createElement('span');
    s.className = 'cue';
    s.textContent = c;
    $('cues').append(s);
  }
  const n = blocks[cur + 1];
  $('next').innerHTML = n ? `Next: <b>${n.title.replace(/</g, '&lt;')}</b>` : done ? '' : 'Last block';
  $('go').textContent = n ? 'Next ▶' : done ? 'Done' : 'Finish ▶';
  if (state) tickView(state);
}

function tickView(s) {
  const sec = Math.floor(s.elapsed_ms / 1000);
  $('time').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  $('rec').classList.toggle('off', s.phase !== 'recording');
}

function flash(text, sub) {
  $('flash').innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
  $('flash').classList.add('on');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => $('flash').classList.remove('on'), 1300);
}

function next() {
  if (cur >= blocks.length) return;
  cur += 1;
  invoke('cast_mark', { kind: cur < blocks.length ? 'start' : 'end', beat: cur });
  render();
  if (cur >= blocks.length) flash('Done', 'Stop the recording when you’re ready.');
}

function redo() {
  if (cur >= blocks.length) return;
  invoke('cast_mark', { kind: 'redo', beat: cur });
  flash('Again, no rush', 'Breathe, look at the camera, then just talk.');
}

function back() {
  if (cur === 0) return;
  cur -= 1;
  invoke('cast_mark', { kind: 'redo', beat: cur });
  render();
}

$('go').onclick = next;
$('redo').onclick = redo;
$('prev').onclick = back;
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  else if (e.key.toLowerCase() === 'r') { e.preventDefault(); redo(); }
});

render();
setInterval(async () => {
  const s = await invoke('cast_state').catch(() => null);
  if (s) tickView(s);
}, 300);
