// Loop detection and stem cutting for OP-1 field tape backups.
// Plain JS (ESM) so both the Node scripts and the Next.js API route can use it.
//
// Times are always tape-absolute sample positions at 44.1 kHz, the same unit
// the OP-1 field uses in tape.json.

import fs from "node:fs";
import path from "node:path";

export const SR = 44100;
export const ROOT = process.cwd();
export const LOOPS_FILE = path.join(ROOT, "data", "loops.json");
export const AUDIO_DIR = path.join(ROOT, "public", "audio");
export const TAPES_DIR =
  process.env.OP1_TAPES_DIR ||
  path.join(process.env.HOME || "", "Music", "OP-1 backups", "2026-11-20", "tapes");

const MIN_CLIP_SEC = 1.5; // shorter clips are punch-in fragments, not loops
const GROUP_TOLERANCE_SEC = 0.25; // clips starting this close together are one take
const MIN_PAD_SEC = 2;

export function tapeSlug(tape) {
  return tape.replace(/#\d+$/, "").replace(/\s+/g, "").toLowerCase();
}

export function barSamples(bpm) {
  return Math.round((60 / bpm) * 4 * SR);
}

/** Padding kept on each side of the loop so points can move without re-cutting. */
export function padSamples(bpm) {
  return Math.max(Math.round(MIN_PAD_SEC * SR), barSamples(bpm));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/** Group a tape's clips into candidate multi-track loops. */
export function detectTapeLoops(tape) {
  const meta = JSON.parse(fs.readFileSync(path.join(TAPES_DIR, tape, "tape.json"), "utf8"));
  const bpm = (meta.tempobpmdecimal || 1200) / 10;
  const clips = [...meta.clips]
    .filter((c) => c.stop - c.start >= MIN_CLIP_SEC * SR)
    .sort((a, b) => a.start - b.start);

  const groups = [];
  for (const c of clips) {
    const g = groups.find((g) => Math.abs(g.starts[0] - c.start) < GROUP_TOLERANCE_SEC * SR);
    if (g) {
      g.starts.push(c.start);
      g.stops.push(c.stop);
      g.chs.add(c.ch);
    } else {
      groups.push({ starts: [c.start], stops: [c.stop], chs: new Set([c.ch]) });
    }
  }

  return groups
    .filter((g) => g.chs.size >= 2)
    .map((g, i) => {
      const start = median(g.starts);
      const end = Math.max(...g.stops.filter((s) => Math.abs(s - median(g.stops)) < GROUP_TOLERANCE_SEC * SR));
      return {
        id: `${tapeSlug(tape)}-${String(i + 1).padStart(2, "0")}`,
        tape,
        name: "",
        bpm,
        start,
        end,
        detected: { start, end },
        recordedTracks: [...g.chs].sort(),
        status: "unchecked",
        notes: "",
      };
    });
}

export function listTapes() {
  return fs
    .readdirSync(TAPES_DIR)
    .filter((d) => fs.existsSync(path.join(TAPES_DIR, d, "tape.json")))
    .sort((a, b) => (a === "tape 01" ? -1 : b === "tape 01" ? 1 : a.localeCompare(b)));
}

// ---- WAV I/O --------------------------------------------------------------

function readWavInfo(fd) {
  const head = Buffer.alloc(4096);
  fs.readSync(fd, head, 0, head.length, 0);
  if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let off = 12;
  let fmt = null;
  while (off + 8 <= head.length) {
    const id = head.toString("ascii", off, off + 4);
    const size = head.readUInt32LE(off + 4);
    if (id === "fmt ") {
      fmt = {
        format: head.readUInt16LE(off + 8),
        channels: head.readUInt16LE(off + 10),
        sampleRate: head.readUInt32LE(off + 12),
        bits: head.readUInt16LE(off + 22),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("data before fmt");
      return { ...fmt, dataOffset: off + 8, dataBytes: size };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error("no data chunk in first 4 KB");
}

function wavHeader16(channels, frames) {
  const dataBytes = frames * channels * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Cut [from, to) frames of a tape track into a 16-bit WAV; returns peak in dBFS. */
function cutTrack(src, dest, from, to) {
  const fd = fs.openSync(src, "r");
  try {
    const info = readWavInfo(fd);
    if (info.sampleRate !== SR) throw new Error(`${src}: expected ${SR} Hz`);
    const bps = info.bits / 8;
    const frameBytes = bps * info.channels;
    const totalFrames = Math.floor(info.dataBytes / frameBytes);
    const a = Math.max(0, from);
    const b = Math.min(totalFrames, to);
    const frames = b - a;
    const raw = Buffer.alloc(frames * frameBytes);
    fs.readSync(fd, raw, 0, raw.length, info.dataOffset + a * frameBytes);

    const n = frames * info.channels;
    const out = Buffer.alloc(n * 2);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      let v; // normalised to [-1, 1)
      if (info.format === 3 && bps === 4) v = raw.readFloatLE(i * 4);
      else if (bps === 4) v = raw.readInt32LE(i * 4) / 2147483648;
      else if (bps === 3) v = raw.readIntLE(i * 3, 3) / 8388608;
      else if (bps === 2) v = raw.readInt16LE(i * 2) / 32768;
      else throw new Error(`${src}: unsupported ${info.bits}-bit`);
      const s = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      if (Math.abs(s) > peak) peak = Math.abs(s);
      out.writeInt16LE(s, i * 2);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.concat([wavHeader16(info.channels, frames), out]));
    return { stemStart: a, stemEnd: b, peakDb: peak ? +(20 * Math.log10(peak / 32767)).toFixed(1) : null };
  } finally {
    fs.closeSync(fd);
  }
}

/** True when the loop still sits inside its cut stem with some room to spare. */
export function stemCovers(loop) {
  if (!loop.stem) return false;
  const margin = Math.round(0.25 * SR);
  const ok = loop.stem.start <= Math.max(0, loop.start - margin) && loop.stem.end >= loop.end + margin;
  return ok && [1, 2, 3, 4].every((t) => fs.existsSync(path.join(AUDIO_DIR, loop.id, `track_${t}.wav`)));
}

/** (Re)cut the 4 stems for a loop, padded around its current points. Mutates loop.stem. */
export function cutLoop(loop) {
  const pad = padSamples(loop.bpm);
  const tracks = [];
  let range = null;
  for (let t = 1; t <= 4; t++) {
    const r = cutTrack(
      path.join(TAPES_DIR, loop.tape, `track_${t}.wav`),
      path.join(AUDIO_DIR, loop.id, `track_${t}.wav`),
      loop.start - pad,
      loop.end + pad,
    );
    range = { start: r.stemStart, end: r.stemEnd };
    tracks.push({ track: t, peakDb: r.peakDb });
  }
  loop.stem = { ...range, tracks };
  return loop;
}

export function readLoops() {
  return JSON.parse(fs.readFileSync(LOOPS_FILE, "utf8"));
}

export function writeLoops(db) {
  fs.mkdirSync(path.dirname(LOOPS_FILE), { recursive: true });
  const tmp = LOOPS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + "\n");
  fs.renameSync(tmp, LOOPS_FILE);
}
