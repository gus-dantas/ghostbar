// Cut an MP4 recording to [start, end) seconds, frame-exact.
// Video: decoded from the keyframe before the cut and re-encoded with the
// browser's hardware H.264 encoder. Sound: the original AAC packets, copied.
import { demux, mux, bytes } from './mp4.js';

const OUT_SCALE = 90000;
const KEYFRAME_EVERY_US = 2_000_000;

export async function trimMp4(blob, start, end, onProgress = () => {}, signal) {
  const { tracks } = await demux(blob);
  const vt = tracks.find((t) => t.kind === 'video');
  const at = tracks.find((t) => t.kind === 'audio' && t.codec === 'mp4a');
  if (!vt || !vt.avcC) throw new Error('only H.264 recordings can be cut');

  const us = (t, scale) => Math.round((t * 1e6) / scale);
  const startUs = Math.round(start * 1e6);
  const endUs = Math.round(end * 1e6);
  const vs = vt.samples;

  // The frame on screen at the start may have begun earlier (screen recordings
  // only add a frame when something changes): keep it, pulled back to 0.
  let activeUs = -Infinity;
  for (const s of vs) { const p = us(s.pts, vt.timescale); if (p <= startUs && p > activeUs) activeUs = p; }
  if (activeUs === -Infinity) activeUs = startUs;
  let first = 0;
  for (let i = 0; i < vs.length; i++) if (vs[i].sync && us(vs[i].pts, vt.timescale) <= activeUs) first = i;
  let last = vs.length - 1;
  while (last > first && us(vs[last].pts, vt.timescale) >= endUs) last -= 1;

  // Presentation order of the frames we keep, to give each one its duration.
  const keptPts = vs.slice(first, last + 1).map((s) => us(s.pts, vt.timescale)).filter((p) => p >= activeUs && p < endUs).sort((a, b) => a - b);
  const durationOf = new Map(keptPts.map((p, i) => [p, (i + 1 < keptPts.length ? keptPts[i + 1] : endUs) - Math.max(p, startUs)]));

  const width = vt.width & ~1, height = vt.height & ~1;
  const codec = await pickEncoder(width, height);
  const bitrate = Math.min(16e6, Math.max(4e6, ((blob.size * 8) / Math.max(1, us(vt.decoded, vt.timescale) / 1e6)) * 2));

  let failure = null;
  const fail = (e) => { failure = failure || e; };
  const out = [];
  let avcC = null, lastKey = -Infinity;

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d) avcC = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      out.push({ data, ptsUs: chunk.timestamp, durUs: chunk.duration || 0, sync: chunk.type === 'key' });
    },
    error: fail,
  });
  encoder.configure({ codec, width, height, bitrate, bitrateMode: 'variable', framerate: 30, latencyMode: 'quality', avc: { format: 'avc' } });

  const decoder = new VideoDecoder({
    output: (frame) => {
      const p = frame.timestamp;
      if (p < activeUs || p >= endUs || failure) { frame.close(); return; }
      const ts = Math.max(0, p - startUs);
      const copy = new VideoFrame(frame, {
        timestamp: ts,
        duration: durationOf.get(p) || 33333,
        visibleRect: { x: 0, y: 0, width, height },
      });
      frame.close();
      const keyFrame = ts - lastKey >= KEYFRAME_EVERY_US;
      if (keyFrame) lastKey = ts;
      try { encoder.encode(copy, { keyFrame }); } catch (e) { fail(e); }
      copy.close();
    },
    error: fail,
  });
  const a = vt.avcC;
  decoder.configure({ codec: `avc1.${hex(a[1])}${hex(a[2])}${hex(a[3])}`, description: a, codedWidth: vt.width, codedHeight: vt.height });

  const drained = (c) => new Promise((r) => c.addEventListener('dequeue', r, { once: true }));
  try {
    for (let i = first; i <= last; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (failure) throw failure;
      while (decoder.decodeQueueSize > 6) await drained(decoder);
      while (encoder.encodeQueueSize > 6) await drained(encoder);
      const s = vs[i];
      decoder.decode(new EncodedVideoChunk({
        type: s.sync ? 'key' : 'delta',
        timestamp: us(s.pts, vt.timescale),
        duration: us(s.duration, vt.timescale),
        data: await bytes(blob, s.offset, s.offset + s.size),
      }));
      onProgress((i - first + 1) / (last - first + 1));
    }
    await decoder.flush();
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
    if (encoder.state !== 'closed') encoder.close();
  }
  if (!out.length || !avcC) throw new Error('the encoder produced no video');

  const video = {
    timescale: OUT_SCALE, width, height, avcC,
    samples: out.map((c) => ({ data: c.data, pts: Math.round((c.ptsUs * OUT_SCALE) / 1e6), duration: Math.max(1, Math.round((c.durUs * OUT_SCALE) / 1e6)), sync: c.sync })),
  };

  let audio = null;
  if (at) {
    const s0 = Math.round(start * at.timescale), s1 = Math.round(end * at.timescale);
    const kept = at.samples.filter((s) => s.pts >= s0 && s.pts < s1);
    audio = { timescale: at.timescale, stsd: at.stsd, samples: kept.map((s) => ({ data: blob.slice(s.offset, s.offset + s.size), duration: s.duration })) };
  }
  return mux({ video, audio });
}

async function pickEncoder(width, height) {
  for (const codec of ['avc1.640033', 'avc1.640028', 'avc1.4d0033', 'avc1.42e033', 'avc1.42e01f']) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 6e6, avc: { format: 'avc' } });
      if (supported) return codec;
    } catch { /* try the next one */ }
  }
  throw new Error("this Chrome can't encode H.264 at this size");
}

const hex = (n) => n.toString(16).padStart(2, '0');
