// The prompter: cue cards, not a script. Each block is one thing to say, written as the question it answers
// plus two or three words to remember. Nothing on it can be read out, so what comes out is talking, not reading.
//
// It floats in a Document Picture-in-Picture window, always on top, outside any captured Chrome window, so the
// recording never shows it (record a window, not the whole screen). Next / Redo drop time marks; reelkit
// keeps the last attempt of each block and joins them.

export const SILVIA_BLOCKS = `Hi Silvia · why this video
hands-on
what we discussed in the email

What is this?
GA4 · Google Merchandise Store
public demo data, anyone can open it

What does this report compare?
last click vs data-driven

Last click vs data-driven, in plain words
last click: the last channel gets it all
data-driven: by how much each one helped

What changes between them?
paid search gains
organic loses

So what's missing?
still aggregated
we want our own model → BigQuery

The raw export
one real shopper
GA4 nests everything → unnest session + source

The catch
6 sessions
a purchase fired twice → dedupe

The journey
sessions → the next order, within 30 days
4 visits · $118

Who gets the credit?
last click: referral
first click: Google
linear: split across the 4

Why it matters to you
same data, different story
build the model that fits the goal

Close
happy to walk you through it`;

// Blocks are paragraphs: first line is what the block answers, the rest are cues.
export function parseBlocks(text) {
  return (text || '')
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length)
    .map(([title, ...cues]) => ({ title, cues }));
}

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { background: #0f1012; color: #f1efe9; font: 15px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
         display: flex; flex-direction: column; padding: 14px 18px 12px; user-select: none; }
  .top { display: flex; align-items: center; gap: 10px; color: #8d9096; font-size: 12px; font-weight: 600; letter-spacing: .02em; }
  .rec { width: 9px; height: 9px; border-radius: 50%; background: #e03131; animation: p 1.2s ease-in-out infinite; }
  .rec.off { background: #555; animation: none; }
  @keyframes p { 50% { opacity: .3; } }
  .bar { flex: 1; height: 3px; background: #2a2c31; border-radius: 3px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: #ffc233; transition: width .25s; }
  .title { margin: 12px 0 8px; font-size: 26px; font-weight: 750; letter-spacing: -.01em; line-height: 1.15; text-wrap: balance; }
  .cues { display: flex; flex-wrap: wrap; gap: 6px 8px; }
  .cue { background: #1d1f23; border: 1px solid #2c2f35; border-radius: 9px; padding: 5px 10px; font-size: 17px; font-weight: 600; color: #ffd36b; }
  .next { margin-top: auto; padding-top: 10px; color: #7b7f86; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .next b { color: #a6a9ae; font-weight: 600; }
  .row { display: flex; gap: 6px; margin-top: 10px; }
  button { font: inherit; font-weight: 650; border-radius: 10px; border: 1px solid #2c2f35; background: #1d1f23; color: #f1efe9;
           height: 38px; padding: 0 12px; cursor: pointer; }
  button:hover { border-color: #444851; }
  button.go { flex: 1; background: #ffc233; border-color: #ffc233; color: #1a1405; }
  .flash { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(15,16,18,.92); font-size: 22px; font-weight: 700;
           opacity: 0; pointer-events: none; transition: opacity .2s; text-align: center; padding: 20px; }
  .flash.on { opacity: 1; }
  .flash small { display: block; margin-top: 6px; font-size: 14px; font-weight: 500; color: #a6a9ae; }
  .keys { color: #5d6067; font-size: 11px; margin-top: 6px; text-align: center; }
`;

// Opens the floating card. Needs a click (Document PiP asks for a user gesture).
// Returns null when the browser can't, and the caller falls back to its own window.
export async function openPrompter({ blocks, onNext, onPrev, onRedo }) {
  if (!('documentPictureInPicture' in window)) return null;
  const pip = await documentPictureInPicture.requestWindow({ width: 560, height: 250 });
  const d = pip.document;
  d.title = 'Prompter';
  const style = d.createElement('style');
  style.textContent = CSS;
  d.head.append(style);
  d.body.innerHTML = `
    <div class="top"><span class="rec"></span><span id="count"></span><div class="bar"><i id="prog"></i></div><span id="time"></span></div>
    <div class="title" id="title"></div>
    <div class="cues" id="cues"></div>
    <div class="next" id="next"></div>
    <div class="row">
      <button id="prev" title="Back one block (←)">◀</button>
      <button id="redo" title="Say this block again (R)">↺ Redo</button>
      <button class="go" id="go" title="Next block (→ or space)">Next ▶</button>
    </div>
    <div class="keys">→ / space next · R redo · ← back — click here first for the keys</div>
    <div class="flash" id="flash"></div>`;
  const $ = (id) => d.getElementById(id);
  $('go').onclick = () => onNext();
  $('redo').onclick = () => onRedo();
  $('prev').onclick = () => onPrev();
  d.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onNext(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); onPrev(); }
    else if (e.key.toLowerCase() === 'r') { e.preventDefault(); onRedo(); }
  });

  let flashTimer;
  return {
    window: pip,
    show(i, { recording = true, elapsed = '' } = {}) {
      const b = blocks[i];
      const done = i >= blocks.length;
      $('count').textContent = done ? 'done' : `${i + 1} / ${blocks.length}`;
      $('prog').style.width = `${(Math.min(i, blocks.length) / blocks.length) * 100}%`;
      $('title').textContent = done ? 'That’s all. Stop the recording when you’re ready.' : b.title;
      $('cues').innerHTML = '';
      for (const c of done ? [] : b.cues) {
        const s = d.createElement('span');
        s.className = 'cue';
        s.textContent = c;
        $('cues').append(s);
      }
      const n = blocks[i + 1];
      $('next').innerHTML = n ? `Next: <b>${n.title.replace(/</g, '&lt;')}</b>` : done ? '' : 'Last block';
      $('go').textContent = n ? 'Next ▶' : done ? 'Done' : 'Finish ▶';
      d.querySelector('.rec').classList.toggle('off', !recording);
      $('time').textContent = elapsed;
    },
    tick(elapsed, recording) {
      $('time').textContent = elapsed;
      d.querySelector('.rec').classList.toggle('off', !recording);
    },
    flash(text, sub = '') {
      $('flash').innerHTML = `${text.replace(/</g, '&lt;')}${sub ? `<small>${sub.replace(/</g, '&lt;')}</small>` : ''}`;
      $('flash').classList.add('on');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => $('flash').classList.remove('on'), 1300);
    },
    close() { try { pip.close(); } catch { /* already closed */ } },
  };
}
