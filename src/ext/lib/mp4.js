// Just enough MP4 to cut a recording: read the samples of a fragmented
// (MediaRecorder) or plain MP4, and write a plain MP4 with one H.264 track and,
// optionally, one audio track copied as is.

// ---------- reading ----------

export async function demux(blob) {
  const top = await topLevel(blob);
  const moovBox = top.find((b) => b.type === 'moov');
  if (!moovBox) throw new Error('not an MP4 file');
  const moov = await bytes(blob, moovBox.start, moovBox.end);
  const v = dv(moov);
  const tracks = new Map();
  const trex = new Map();

  for (const b of children(moov, 8, moov.length)) {
    if (b.type === 'trak') {
      const t = readTrak(moov, b);
      if (t) tracks.set(t.id, t);
    } else if (b.type === 'mvex') {
      for (const x of children(moov, b.body, b.end)) {
        if (x.type !== 'trex') continue;
        const p = x.body + 4;
        trex.set(v.getUint32(p), { dur: v.getUint32(p + 8), size: v.getUint32(p + 12), flags: v.getUint32(p + 16) });
      }
    }
  }

  const fragmented = top.some((b) => b.type === 'moof');
  if (fragmented) {
    for (const box of top) {
      if (box.type === 'moof') readMoof(await bytes(blob, box.start, box.end), box.start, tracks, trex);
    }
  } else {
    for (const t of tracks.values()) readSampleTables(moov, t);
  }
  return { tracks: [...tracks.values()] };
}

function readTrak(buf, trak) {
  const v = dv(buf);
  const t = { samples: [], decoded: 0 };
  let stbl = null;
  for (const b of children(buf, trak.body, trak.end)) {
    if (b.type === 'tkhd') t.id = v.getUint32(b.body + 4 + (buf[b.body] ? 16 : 8));
    if (b.type !== 'mdia') continue;
    for (const m of children(buf, b.body, b.end)) {
      if (m.type === 'mdhd') t.timescale = v.getUint32(m.body + 4 + (buf[m.body] ? 16 : 8));
      if (m.type === 'hdlr') t.handler = ascii4(buf, m.body + 8);
      if (m.type !== 'minf') continue;
      for (const s of children(buf, m.body, m.end)) if (s.type === 'stbl') stbl = s;
    }
  }
  if (!stbl || !t.timescale) return null;
  t.stbl = stbl;
  const stsd = children(buf, stbl.body, stbl.end).find((x) => x.type === 'stsd');
  t.stsd = buf.slice(stsd.start, stsd.end);
  t.kind = t.handler === 'vide' ? 'video' : t.handler === 'soun' ? 'audio' : 'other';
  const entry = children(buf, stsd.body + 8, stsd.end)[0];
  t.codec = entry?.type;
  if (entry && (entry.type === 'avc1' || entry.type === 'avc3')) {
    t.width = v.getUint16(entry.body + 24);
    t.height = v.getUint16(entry.body + 26);
    const avcC = children(buf, entry.body + 78, entry.end).find((x) => x.type === 'avcC');
    if (avcC) t.avcC = buf.slice(avcC.body, avcC.end);
  }
  return t;
}

function readMoof(moof, moofStart, tracks, trex) {
  const v = dv(moof);
  let prevEnd = moofStart;
  for (const traf of children(moof, 8, moof.length)) {
    if (traf.type !== 'traf') continue;
    let tf = null, base = null;
    const runs = [];
    for (const x of children(moof, traf.body, traf.end)) {
      const ver = moof[x.body];
      const flags = (moof[x.body + 1] << 16) | (moof[x.body + 2] << 8) | moof[x.body + 3];
      let p = x.body + 4;
      if (x.type === 'tfhd') {
        tf = { flags, id: v.getUint32(p) };
        p += 4;
        if (flags & 0x1) { tf.baseOffset = Number(v.getBigUint64(p)); p += 8; }
        if (flags & 0x2) p += 4;
        if (flags & 0x8) { tf.dur = v.getUint32(p); p += 4; }
        if (flags & 0x10) { tf.size = v.getUint32(p); p += 4; }
        if (flags & 0x20) { tf.sflags = v.getUint32(p); p += 4; }
      } else if (x.type === 'tfdt') {
        base = ver ? Number(v.getBigUint64(p)) : v.getUint32(p);
      } else if (x.type === 'trun') {
        runs.push({ ver, flags, p });
      }
    }
    const t = tf && tracks.get(tf.id);
    if (!t) continue;
    const d = trex.get(tf.id) || {};
    if (base != null) t.decoded = base;
    let cursor = tf.flags & 0x1 ? tf.baseOffset : tf.flags & 0x20000 ? moofStart : prevEnd;
    const dataBase = cursor;
    for (const run of runs) {
      let p = run.p;
      const count = v.getUint32(p); p += 4;
      if (run.flags & 0x1) { cursor = dataBase + v.getInt32(p); p += 4; }
      let firstFlags = null;
      if (run.flags & 0x4) { firstFlags = v.getUint32(p); p += 4; }
      for (let i = 0; i < count; i++) {
        const duration = run.flags & 0x100 ? v.getUint32((p += 4) - 4) : (tf.dur ?? d.dur ?? 0);
        const size = run.flags & 0x200 ? v.getUint32((p += 4) - 4) : (tf.size ?? d.size ?? 0);
        let sflags = run.flags & 0x400 ? v.getUint32((p += 4) - 4) : (tf.sflags ?? d.flags ?? 0);
        if (i === 0 && firstFlags != null) sflags = firstFlags;
        const cto = run.flags & 0x800 ? (run.ver ? v.getInt32((p += 4) - 4) : v.getUint32((p += 4) - 4)) : 0;
        t.samples.push({ offset: cursor, size, dts: t.decoded, pts: t.decoded + cto, duration, sync: !(sflags & 0x10000) });
        t.decoded += duration;
        cursor += size;
      }
      prevEnd = cursor;
    }
  }
}

function readSampleTables(buf, t) {
  const v = dv(buf);
  const box = (type) => children(buf, t.stbl.body, t.stbl.end).find((x) => x.type === type);
  const count = (b) => v.getUint32(b.body + 4);
  const durations = [];
  const stts = box('stts');
  for (let i = 0, p = stts.body + 8; i < count(stts); i++, p += 8) {
    for (let k = 0; k < v.getUint32(p); k++) durations.push(v.getUint32(p + 4));
  }
  const ctts = box('ctts');
  const offsets = [];
  if (ctts) {
    const signed = buf[ctts.body] === 1;
    for (let i = 0, p = ctts.body + 8; i < count(ctts); i++, p += 8) {
      for (let k = 0; k < v.getUint32(p); k++) offsets.push(signed ? v.getInt32(p + 4) : v.getUint32(p + 4));
    }
  }
  const stss = box('stss');
  const sync = stss ? new Set(Array.from({ length: count(stss) }, (_, i) => v.getUint32(stss.body + 8 + i * 4))) : null;
  const stsz = box('stsz');
  const fixed = v.getUint32(stsz.body + 4);
  const n = v.getUint32(stsz.body + 8);
  const sizes = Array.from({ length: n }, (_, i) => (fixed || v.getUint32(stsz.body + 12 + i * 4)));
  const stco = box('stco') || box('co64');
  const wide = stco.type === 'co64';
  const chunkOffsets = Array.from({ length: count(stco) }, (_, i) => (wide ? Number(v.getBigUint64(stco.body + 8 + i * 8)) : v.getUint32(stco.body + 8 + i * 4)));
  const stsc = box('stsc');
  const runs = Array.from({ length: count(stsc) }, (_, i) => ({ first: v.getUint32(stsc.body + 8 + i * 12), per: v.getUint32(stsc.body + 12 + i * 12) }));

  let s = 0, dts = 0;
  for (let c = 0; c < chunkOffsets.length && s < n; c++) {
    const run = runs.filter((r) => r.first <= c + 1).pop();
    let off = chunkOffsets[c];
    for (let k = 0; k < (run?.per || 0) && s < n; k++, s++) {
      t.samples.push({ offset: off, size: sizes[s], dts, pts: dts + (offsets[s] || 0), duration: durations[s] || 0, sync: sync ? sync.has(s + 1) : true });
      off += sizes[s];
      dts += durations[s] || 0;
    }
  }
}

// ---------- writing ----------

// video: { timescale, width, height, avcC, samples: [{ data, pts, duration, sync }] } in decode order
// audio: { timescale, stsd, samples: [{ data, duration }] } or null
export function mux({ video, audio }) {
  const tracks = [videoTrack(video, 1)];
  if (audio && audio.samples.length) tracks.push(audioTrack(audio, 2));
  const movieScale = 1000;
  const movieDur = Math.max(...tracks.map((t) => Math.round((t.duration / t.timescale) * movieScale)));

  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2avc1mp41'));
  const build = (mdatStart) => {
    let offset = mdatStart;
    const traks = tracks.map((t) => {
      const chunkOffset = offset;
      offset += t.bytes;
      return t.build(chunkOffset, Math.round((t.duration / t.timescale) * movieScale));
    });
    const mvhd = fullbox('mvhd', 0, 0, u32(0), u32(0), u32(movieScale), u32(movieDur), u32(0x00010000), u16(0x0100), zeros(10), MATRIX(), zeros(24), u32(tracks.length + 1));
    return box('moov', mvhd, ...traks);
  };
  const payload = tracks.reduce((n, t) => n + t.bytes, 0);
  if (payload + 8 > 0xffffffff) throw new Error('the cut is larger than 4 GB');
  const moovSize = build(0).length;
  const moov = build(ftyp.length + moovSize + 8);
  const parts = [ftyp, moov, concat(u32(payload + 8), ascii('mdat'))];
  for (const t of tracks) for (const s of t.samples) parts.push(s.data);
  return new Blob(parts, { type: 'video/mp4' });
}

const MATRIX = () => concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

function videoTrack(video, id) {
  const s = video.samples;
  // Decode timestamps are the presentation times in ascending order.
  const sorted = s.map((x) => x.pts).sort((a, b) => a - b);
  const dts = sorted;
  const ctts = s.map((x, i) => x.pts - dts[i]);
  const durations = s.map((x, i) => (i + 1 < s.length ? dts[i + 1] - dts[i] : x.duration || 1));
  const duration = durations.reduce((a, b) => a + b, 0);
  const bytes = s.reduce((n, x) => n + sizeOf(x.data), 0);

  const avc1 = box('avc1',
    zeros(6), u16(1),                       // reserved, data_reference_index
    zeros(16),                              // pre_defined + reserved
    u16(video.width), u16(video.height),
    u32(0x00480000), u32(0x00480000),       // 72 dpi
    u32(0), u16(1),                         // reserved, frame_count
    zeros(32),                              // compressorname
    u16(0x0018), u16(0xffff),               // depth, pre_defined
    box('avcC', video.avcC));
  const stsd = fullbox('stsd', 0, 0, u32(1), avc1);

  return {
    timescale: video.timescale, duration, bytes, samples: s,
    build: (chunkOffset, movieDuration) => {
      const tables = [stsd, stts(durations)];
      if (ctts.some((x) => x !== 0)) tables.push(cttsBox(ctts));
      if (s.some((x) => !x.sync)) {
        const keys = [];
        s.forEach((x, i) => { if (x.sync) keys.push(i + 1); });
        tables.push(fullbox('stss', 0, 0, u32(keys.length), ...keys.map(u32)));
      }
      tables.push(stsc(s.length), stsz(s.map((x) => sizeOf(x.data))), fullbox('stco', 0, 0, u32(1), u32(chunkOffset)));
      return box('trak',
        fullbox('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(movieDuration), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX(), u32(video.width << 16), u32(video.height << 16)),
        box('mdia',
          fullbox('mdhd', 0, 0, u32(0), u32(0), u32(video.timescale), u32(duration), u16(0x55c4), u16(0)),
          fullbox('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('VideoHandler\0')),
          box('minf', fullbox('vmhd', 0, 1, zeros(8)), DINF(), box('stbl', ...tables))));
    },
  };
}

function audioTrack(audio, id) {
  const s = audio.samples;
  const durations = s.map((x) => x.duration);
  const duration = durations.reduce((a, b) => a + b, 0);
  const bytes = s.reduce((n, x) => n + sizeOf(x.data), 0);
  return {
    timescale: audio.timescale, duration, bytes, samples: s,
    build: (chunkOffset, movieDuration) => box('trak',
      fullbox('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(movieDuration), zeros(8), u16(0), u16(1), u16(0x0100), u16(0), MATRIX(), u32(0), u32(0)),
      box('mdia',
        fullbox('mdhd', 0, 0, u32(0), u32(0), u32(audio.timescale), u32(duration), u16(0x55c4), u16(0)),
        fullbox('hdlr', 0, 0, u32(0), ascii('soun'), zeros(12), ascii('SoundHandler\0')),
        box('minf', fullbox('smhd', 0, 0, zeros(4)), DINF(), box('stbl',
          audio.stsd, stts(durations), stsc(s.length), stsz(s.map((x) => sizeOf(x.data))), fullbox('stco', 0, 0, u32(1), u32(chunkOffset)))))),
  };
}

const DINF = () => box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1)));

function stts(durations) {
  const runs = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0] += 1;
    else runs.push([1, d]);
  }
  return fullbox('stts', 0, 0, u32(runs.length), ...runs.map(([n, d]) => concat(u32(n), u32(d))));
}

function cttsBox(offsets) {
  const signed = offsets.some((x) => x < 0);
  const runs = [];
  for (const o of offsets) {
    const last = runs[runs.length - 1];
    if (last && last[1] === o) last[0] += 1;
    else runs.push([1, o]);
  }
  return fullbox('ctts', signed ? 1 : 0, 0, u32(runs.length), ...runs.map(([n, o]) => concat(u32(n), signed ? i32(o) : u32(o))));
}

const stsc = (n) => fullbox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));
const stsz = (sizes) => fullbox('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map(u32));
const sizeOf = (d) => (d instanceof Blob ? d.size : d.byteLength);

// ---------- box plumbing ----------

async function topLevel(blob) {
  const out = [];
  let p = 0;
  while (p + 8 <= blob.size) {
    const h = await bytes(blob, p, Math.min(blob.size, p + 16));
    const v = dv(h);
    let size = v.getUint32(0);
    let hdr = 8;
    if (size === 1) { size = Number(v.getBigUint64(8)); hdr = 16; }
    else if (size === 0) size = blob.size - p;
    if (size < hdr) break;
    out.push({ type: ascii4(h, 4), start: p, end: Math.min(blob.size, p + size) });
    p += size;
  }
  return out;
}

function children(buf, start, end) {
  const v = dv(buf);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = v.getUint32(p);
    let hdr = 8;
    if (size === 1) { size = Number(v.getBigUint64(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type: ascii4(buf, p + 4), start: p, end: p + size, body: p + hdr });
    p += size;
  }
  return out;
}

export async function bytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

const dv = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const ascii4 = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const zeros = (n) => new Uint8Array(n);
const u16 = (n) => { const b = new Uint8Array(2); dv(b).setUint16(0, n); return b; };
const u32 = (n) => { const b = new Uint8Array(4); dv(b).setUint32(0, n >>> 0); return b; };
const i32 = (n) => { const b = new Uint8Array(4); dv(b).setInt32(0, n); return b; };

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function box(type, ...parts) {
  return concat(u32(8 + parts.reduce((n, p) => n + p.length, 0)), ascii(type), ...parts);
}

function fullbox(type, version, flags, ...parts) {
  return box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
}
