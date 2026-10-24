// Encodes frames into a GIF off the main thread.
//
// Quality: every frame gets its own 255-colour palette, built only from the
// pixels that changed, so text and UI stay sharp. Size: unchanged pixels are
// written as transparent over the previous frame (dispose = keep), which LZW
// squeezes to almost nothing, and frames with no change just extend the
// previous frame's delay.
import { GIFEncoder, quantize, applyPalette } from './gifenc/index.js';

// A pixel counts as unchanged when no channel moved more than this (video
// decoder noise). Anything looser leaves faint ghosts of old text on white.
const TOLERANCE = 3;
// A busy frame can run short of palette colours. Pixels left showing more than
// this far from the source are sent again in the next frames; once they fit in
// 255 exact colours they land exactly, so the repair always converges.
const REPAIR = 4;

let gif, W, H, repeat, ref, shown, changed, pending, frames;

self.onmessage = ({ data: m }) => {
  try {
    if (m.type === 'start') {
      W = m.width;
      H = m.height;
      repeat = m.loop ? 0 : -1;
      gif = GIFEncoder({ initialCapacity: 1 << 20 });
      ref = null;
      changed = new Uint32Array(W * H);
      pending = null;
      frames = 0;
    } else if (m.type === 'frame') {
      add(new Uint8ClampedArray(m.buffer), m.delay);
      self.postMessage({ type: 'ack' });
    } else if (m.type === 'finish') {
      if (pending) write(pending);
      gif.finish();
      const bytes = gif.bytes();
      self.postMessage({ type: 'done', bytes, frames }, [bytes.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};

function add(rgba, delay) {
  if (!ref) {
    const { palette, index } = paletteFor(rgba, W * H, 256);
    shown = new Uint8ClampedArray(rgba.length);
    for (let i = 0, p = 0; i < index.length; i++, p += 4) {
      const c = palette[index[i]];
      shown[p] = c[0]; shown[p + 1] = c[1]; shown[p + 2] = c[2];
    }
    pending = { index, palette, delay, transparent: false };
    ref = rgba;
    return;
  }

  const n = W * H;
  let count = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    if (
      Math.abs(r - ref[p]) > TOLERANCE || Math.abs(g - ref[p + 1]) > TOLERANCE || Math.abs(b - ref[p + 2]) > TOLERANCE ||
      Math.abs(r - shown[p]) > REPAIR || Math.abs(g - shown[p + 1]) > REPAIR || Math.abs(b - shown[p + 2]) > REPAIR
    ) {
      changed[count++] = i;
    }
  }
  if (!count) {
    pending.delay += delay;
    return;
  }

  const sub = new Uint8ClampedArray(count * 4);
  for (let k = 0; k < count; k++) {
    const p = changed[k] * 4, q = k * 4;
    sub[q] = ref[p] = rgba[p];
    sub[q + 1] = ref[p + 1] = rgba[p + 1];
    sub[q + 2] = ref[p + 2] = rgba[p + 2];
    sub[q + 3] = 255;
  }
  const { palette, index: subIndex } = paletteFor(sub, count, 255);
  const transparentIndex = palette.length;
  palette.push([255, 0, 255]);
  const index = new Uint8Array(n).fill(transparentIndex);
  for (let k = 0; k < count; k++) {
    const i = changed[k], c = palette[subIndex[k]], p = i * 4;
    index[i] = subIndex[k];
    shown[p] = c[0]; shown[p + 1] = c[1]; shown[p + 2] = c[2];
  }

  write(pending);
  pending = { index, palette, delay, transparent: true, transparentIndex };
}

// Exact colours when they fit, otherwise the best 'max'-colour approximation.
function paletteFor(rgba, count, max) {
  const map = new Map();
  const palette = [];
  for (let q = 0; q < count * 4; q += 4) {
    const key = (rgba[q] << 16) | (rgba[q + 1] << 8) | rgba[q + 2];
    if (map.has(key)) continue;
    if (palette.length === max) {
      const approx = quantize(rgba, max, { format: 'rgb565' });
      return { palette: approx, index: applyPalette(rgba, approx, 'rgb565') };
    }
    map.set(key, palette.length);
    palette.push([rgba[q], rgba[q + 1], rgba[q + 2]]);
  }
  const index = new Uint8Array(count);
  for (let k = 0, q = 0; k < count; k++, q += 4) index[k] = map.get((rgba[q] << 16) | (rgba[q + 1] << 8) | rgba[q + 2]);
  return { palette, index };
}

function write(f) {
  gif.writeFrame(f.index, W, H, {
    palette: f.palette,
    delay: f.delay,
    repeat,
    transparent: f.transparent,
    transparentIndex: f.transparentIndex ?? 0,
    dispose: 1, // keep the previous frame underneath; gifenc would clear it otherwise
  });
  frames += 1;
}
