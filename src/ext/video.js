import { getCapture, deleteCapture, fileStem, saveBlob, makeThumb } from './lib/store.js';
import { ICONS } from './lib/icons.js';
import { trimMp4 } from './lib/trim.js';

const $ = (s) => document.querySelector(s);
const id = new URLSearchParams(location.search).get('id');
const rec = id ? await getCapture(id) : null;

$('#save').innerHTML = `${ICONS.save}<span>Save MP4</span>`;
$('#delete').innerHTML = `${ICONS.trash}<span>Discard</span>`;
$('#gif-save').innerHTML = `${ICONS.save}<span>Save GIF</span>`;
$('#cut-save').innerHTML = `${ICONS.scissors}<span>Save this part as MP4</span>`;

if (!rec) {
  $('#player').hidden = true;
  $('#empty').hidden = false;
  $('#gif').hidden = true;
  for (const b of ['#save', '#save-as', '#delete']) $(b).disabled = true;
} else {
  setUp(rec);
}

function setUp(rec) {
  const ext = rec.mime.includes('mp4') ? 'mp4' : 'webm';
  const stem = fileStem(rec.title || 'Screen recording', new Date(rec.createdAt));
  const url = URL.createObjectURL(rec.blob);
  const player = $('#player');
  player.src = url;
  const secs = Math.round((rec.duration || 0) / 1000);
  $('#meta').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · ${(rec.blob.size / 1048576).toFixed(1)} MB · ${ext.toUpperCase()}`;
  if (ext !== 'mp4') $('#save').innerHTML = `${ICONS.save}<span>Save ${ext.toUpperCase()}</span>`;

  // Saved once is enough: a second click would only make a copy.
  const markSaved = () => {
    $('#save').disabled = true;
    $('#save').innerHTML = `${ICONS.save}<span>Saved</span>`;
    $('#save').title = 'Already in Downloads › Ghostbar';
  };
  if (rec.onDisk) markSaved(); // the app saves every recording as it stops
  // In the app the recording on disk is the only copy, so the button says what it does.
  if (rec.onDisk) $('#delete').innerHTML = `${ICONS.trash}<span>Move to Bin</span>`;
  $('#save').addEventListener('click', async () => {
    markSaved();
    try {
      await saveBlob(rec.blob, `${stem}.${ext}`, false, { captureId: id, thumb: await videoThumb(url, 0.5) });
      toast('Saved to Downloads › Ghostbar');
    } catch (e) {
      $('#save').disabled = false;
      $('#save').innerHTML = `${ICONS.save}<span>Save ${ext.toUpperCase()}</span>`;
      toast(`Couldn't save: ${e.message}`);
    }
  });
  $('#save-as').addEventListener('click', async () => saveBlob(rec.blob, `${stem}.${ext}`, true, { captureId: id, thumb: await videoThumb(url, 0.5) }).catch(() => {}));
  $('#delete').addEventListener('click', async () => {
    const ask = rec.onDisk
      ? 'Move this recording to the Bin? It is the only copy (you can put it back from the Bin).'
      : 'Discard this recording? Saved copies stay in Downloads.';
    if (!confirm(ask)) return;
    await deleteCapture(id);
    window.close();
  });

  if (rec.marks?.length) $('#meta').textContent += ` · ${rec.blocks?.length || 0} prompter blocks`;

  setUpGif(url, player, stem, rec);
}

// ---------- GIF ----------

function setUpGif(url, player, stem, rec) {
  const settings = { width: 0, fps: 15 };
  let duration = (rec.duration || 0) / 1000;
  let gifBlob = null, gifUrl = null, controller = null;

  const segment = (el, options, current, onPick) => {
    el.innerHTML = '';
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(o.value === current));
      b.textContent = o.label;
      b.title = o.title || '';
      b.addEventListener('click', () => {
        el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        onPick(o.value);
      });
      el.append(b);
    }
  };

  player.addEventListener('loadedmetadata', async () => {
    duration = await knownDuration(player, duration);
    const vw = player.videoWidth;
    const widths = [vw, 1280, 960, 640].filter((w, i, all) => w <= vw && all.indexOf(w) === i);
    settings.width = vw;
    segment($('#gif-width'), widths.map((w) => ({ value: w, label: w === vw ? `${w} (full)` : String(w) })), vw, (w) => { settings.width = w; });
    $('#gif-start').value = '0';
    $('#gif-end').value = duration.toFixed(1);
    $('#gif-end').max = duration.toFixed(1);
  }, { once: true });

  segment($('#gif-fps'), [10, 15, 20, 25].map((f) => ({ value: f, label: String(f), title: f === 15 ? 'Good balance of smoothness and size' : '' })), 15, (f) => { settings.fps = f; });

  $('#set-start').addEventListener('click', () => { $('#gif-start').value = player.currentTime.toFixed(1); });
  $('#set-end').addEventListener('click', () => { $('#gif-end').value = player.currentTime.toFixed(1); });
  $('#set-all').addEventListener('click', () => { $('#gif-start').value = '0'; $('#gif-end').value = duration.toFixed(1); });

  const range = () => {
    const start = Math.max(0, parseFloat($('#gif-start').value) || 0);
    const end = Math.min(duration, parseFloat($('#gif-end').value) || duration);
    return { start, end, whole: start < 0.05 && end > duration - 0.05 };
  };

  // MP4 of the selected part
  let cutController = null;
  $('#cut-cancel').addEventListener('click', () => cutController?.abort());
  $('#cut-save').addEventListener('click', async () => {
    const { start, end, whole } = range();
    if (!(end - start >= 0.2)) return showError('Choose a part at least 0.2 seconds long.', '#cut-err');
    showError(null, '#cut-err');
    if (whole && (rec.onDisk || $('#save').disabled)) return toast('That is the whole recording, and it is already saved.');
    if (whole || !rec.mime.includes('mp4')) {
      await saveBlob(rec.blob, `${stem}.${rec.mime.includes('mp4') ? 'mp4' : 'webm'}`, false, { captureId: id, thumb: await videoThumb(url, 0.5) });
      return toast('Saved to Downloads › Ghostbar');
    }
    $('#cut-save').disabled = true;
    $('#cut-progress').hidden = false;
    $('#cut-bar').style.width = '0%';
    cutController = new AbortController();
    try {
      const cut = await trimMp4(rec.blob, start, end, (f) => {
        $('#cut-bar').style.width = `${Math.round(f * 100)}%`;
        $('#cut-pct').textContent = `Cutting… ${Math.round(f * 100)}%`;
      }, cutController.signal);
      await saveBlob(cut, `${stem} (${fmt(start)}–${fmt(end)}).mp4`, false, { captureId: id, thumb: await videoThumb(url, start + 0.3) });
      toast(`Saved the part (${formatSize(cut.size)}) to Downloads › Ghostbar`);
    } catch (err) {
      if (err.name !== 'AbortError') showError(`Couldn't cut the recording: ${err.message}`, '#cut-err');
    } finally {
      cutController = null;
      $('#cut-progress').hidden = true;
      $('#cut-save').disabled = false;
    }
  });

  $('#gif-make').addEventListener('click', async () => {
    const { start, end } = range();
    if (!(end - start >= 0.2)) return showError('Choose a part at least 0.2 seconds long.');
    showError(null);
    $('#gif-make').disabled = true;
    $('#gif-result').hidden = true;
    $('#gif-progress').hidden = false;
    setProgress(0, 'Preparing…');
    controller = new AbortController();
    const t0 = performance.now();
    try {
      const out = await makeGif(url, { ...settings, start, end, loop: $('#gif-loop').checked }, setProgress, controller.signal);
      if (gifUrl) URL.revokeObjectURL(gifUrl);
      gifBlob = out.blob;
      gifUrl = URL.createObjectURL(gifBlob);
      $('#gif-img').src = gifUrl;
      $('#gif-meta').textContent = `${out.width} × ${out.height} · ${settings.fps} fps · ${(end - start).toFixed(1)} s · ${formatSize(gifBlob.size)} · made in ${Math.round((performance.now() - t0) / 1000)} s`;
      $('#gif-result').hidden = false;
    } catch (err) {
      if (err.name !== 'AbortError') showError(`Couldn't make the GIF: ${err.message}`);
    } finally {
      controller = null;
      $('#gif-progress').hidden = true;
      $('#gif-make').disabled = false;
    }
  });

  $('#gif-cancel').addEventListener('click', () => controller?.abort());
  $('#gif-save').addEventListener('click', async () => {
    if (!gifBlob) return;
    await saveBlob(gifBlob, `${stem}.gif`, false, { captureId: id });
    toast('Saved to Downloads › Ghostbar');
  });
}

async function makeGif(url, opts, onProgress, signal) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  await once(v, 'loadeddata');
  const width = opts.width;
  const height = Math.max(1, Math.round((width * v.videoHeight) / v.videoWidth));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';

  const worker = new Worker(new URL('./lib/gif-worker.js', import.meta.url), { type: 'module' });
  let inFlight = 0, wake = null, failure = null;
  const finished = new Promise((resolve, reject) => {
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'ack') { inFlight -= 1; wake?.(); }
      else if (m.type === 'done') resolve(m);
      else if (m.type === 'error') { failure = new Error(m.message); reject(failure); wake?.(); }
    };
    worker.onerror = (e) => { failure = new Error(e.message || 'the encoder stopped'); reject(failure); wake?.(); };
  });
  finished.catch(() => {});
  worker.postMessage({ type: 'start', width, height, loop: opts.loop });

  const total = Math.max(1, Math.round((opts.end - opts.start) * opts.fps));
  try {
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (failure) throw failure;
      await seek(v, opts.start + i / opts.fps);
      ctx.drawImage(v, 0, 0, width, height);
      const { data } = ctx.getImageData(0, 0, width, height);
      const delay = (Math.round(((i + 1) * 100) / opts.fps) - Math.round((i * 100) / opts.fps)) * 10;
      while (inFlight >= 3 && !failure) await new Promise((r) => { wake = r; });
      if (failure) throw failure;
      inFlight += 1;
      worker.postMessage({ type: 'frame', buffer: data.buffer, delay }, [data.buffer]);
      onProgress((i + 1) / total);
    }
    onProgress(1, 'Finishing…');
    worker.postMessage({ type: 'finish' });
    const m = await finished;
    return { blob: new Blob([m.bytes], { type: 'image/gif' }), width, height, frames: m.frames };
  } finally {
    worker.terminate();
    v.removeAttribute('src');
    v.load();
  }
}

// A still of the recording at `t` seconds, for the library.
async function videoThumb(url, t) {
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.src = url;
    await once(v, 'loadeddata');
    await seek(v, Math.min(t, Math.max(0, (v.duration || t) - 0.1)));
    const thumb = await makeThumb(v);
    v.removeAttribute('src');
    v.load();
    return thumb;
  } catch {
    return null;
  }
}

// MediaRecorder files can report no duration until the end has been read.
async function knownDuration(v, fallback) {
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  const back = v.currentTime;
  v.currentTime = 1e9;
  await once(v, 'seeked');
  const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : fallback;
  v.currentTime = back;
  return d;
}

function seek(v, t) {
  return new Promise((resolve) => {
    v.addEventListener('seeked', resolve, { once: true });
    v.currentTime = Math.max(0, Math.min(t, (v.duration || t) - 0.001));
  });
}

const once = (el, type) => new Promise((resolve, reject) => {
  el.addEventListener(type, resolve, { once: true });
  el.addEventListener('error', () => reject(new Error('the video could not be read')), { once: true });
});

function setProgress(fraction, text) {
  $('#gif-bar').style.width = `${Math.round(fraction * 100)}%`;
  $('#gif-pct').textContent = text || `Creating GIF… ${Math.round(fraction * 100)}%`;
}

function showError(text, where = '#gif-err') {
  $(where).hidden = !text;
  $(where).textContent = text || '';
}

const fmt = (sec) => `${Math.floor(sec / 60)}m${String(Math.floor(sec % 60)).padStart(2, '0')}s`;

function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

let timer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => t.classList.remove('show'), 2600);
}
