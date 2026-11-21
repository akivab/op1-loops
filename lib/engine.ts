// Sample-accurate 4-track looper on the Web Audio API.
//
// Instead of AudioBufferSourceNode.loop (which jumps OUT→IN with no fade), every
// pass of the loop is its own scheduled segment. A pass starts fade/2 before IN
// and ends fade/2 after OUT, using the real audio either side of the loop, so
// consecutive passes overlap into an equal-power crossfade centred on the seam.
// All four tracks share one schedule, so they never drift.
//
//   graph: pass source → pass gain (crossfade envelope) → session bus (start/stop
//          fades, one per play) → track gain (mute/solo/volume, queued changes) → out
//          → speakers, and an analyser for the live output meter

const LOOKAHEAD = 0.3; // seconds of passes scheduled ahead
const TICK_MS = 25;
const START_FADE = 0.008;
const STOP_FADE = 0.015;
const CURVE_N = 64;

const fadeInCurve = Float32Array.from({ length: CURVE_N }, (_, i) => Math.sin(((i / (CURVE_N - 1)) * Math.PI) / 2));
const fadeOutCurve = Float32Array.from({ length: CURVE_N }, (_, i) => Math.cos(((i / (CURVE_N - 1)) * Math.PI) / 2));

interface Pass {
  /** Context time at which this pass is at loop IN (may be before it starts, for a partial first pass). */
  t0: number;
  start: number;
  len: number;
  nodes: { src: AudioBufferSourceNode; gain: GainNode }[];
}

interface Session {
  bus: GainNode[];
  passes: Pass[];
  nextT: number;
  timer: ReturnType<typeof setInterval>;
}

export class LoopEngine {
  readonly ctx: AudioContext;
  private gains: GainNode[] = [];
  buffers: AudioBuffer[] = [];
  private loopStart = 0;
  private loopEnd = 0;
  private fade = 0.02;
  private session: Session | null = null;
  playing = false;

  /** Taps the final output (after crossfades, mutes and fades) for metering. */
  readonly analyser: AnalyserNode;
  /** Per-track taps after each track's gain (so muted tracks read silent). */
  readonly trackAnalysers: AnalyserNode[] = [];

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    const out = this.ctx.createGain();
    out.connect(this.ctx.destination);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    out.connect(this.analyser);
    for (let i = 0; i < 4; i++) {
      const g = this.ctx.createGain();
      g.connect(out);
      const a = this.ctx.createAnalyser();
      a.fftSize = 1024;
      g.connect(a);
      this.gains.push(g);
      this.trackAnalysers.push(a);
    }
  }

  async load(urls: string[], signal?: AbortSignal) {
    const buffers = await Promise.all(
      urls.map(async (u) => {
        const res = await fetch(u, { signal });
        if (!res.ok) throw new Error(`${u}: ${res.status}`);
        return this.ctx.decodeAudioData(await res.arrayBuffer());
      }),
    );
    this.stop();
    this.buffers = buffers;
  }

  get duration() {
    return this.buffers[0]?.duration ?? 0;
  }

  private get len() {
    return Math.max(0.01, this.loopEnd - this.loopStart);
  }

  /** Crossfade length at the seam, in seconds. Applies from the next pass. */
  setFade(sec: number) {
    this.fade = Math.max(0, Math.min(sec, this.len / 4));
  }

  /** Loop points in seconds from the start of the stem. Applies from the next pass. */
  setLoop(start: number, end: number) {
    const changed = start !== this.loopStart || end !== this.loopEnd;
    this.loopStart = start;
    this.loopEnd = end;
    this.fade = Math.min(this.fade, this.len / 4);
    const s = this.session;
    if (!changed || !s) return;
    // Drop passes that haven't started; the current one finishes with its old points.
    const now = this.ctx.currentTime;
    const keep: Pass[] = [];
    for (const p of s.passes) {
      if (p.t0 - this.fade / 2 > now + 0.01 && keep.length) this.killPass(p, 0);
      else keep.push(p);
    }
    s.passes = keep;
    const last = keep[keep.length - 1];
    if (last) s.nextT = last.t0 + last.len;
  }

  setGain(track: number, value: number) {
    const g = this.gains[track]?.gain;
    if (!g) return;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  /** Context time of the next seam (next pass's IN). */
  private nextWrapAt() {
    const s = this.session;
    if (!s) return Infinity;
    const now = this.ctx.currentTime;
    const upcoming = s.passes.find((p) => p.t0 > now);
    return upcoming ? upcoming.t0 : s.nextT;
  }

  /** Seconds from now until the next seam. */
  timeToWrap() {
    return this.playing ? Math.max(0, this.nextWrapAt() - this.ctx.currentTime) : Infinity;
  }

  /**
   * Change a track's gain at the next seam. Tracks coming in fade in over
   * `fadeIn` seconds from the seam; tracks going out fade over the crossfade.
   */
  scheduleGainAtWrap(track: number, value: number, fadeIn = 0.5) {
    const g = this.gains[track]?.gain;
    if (!g || !this.playing) return;
    const now = this.ctx.currentTime;
    const at = this.nextWrapAt();
    const from = g.value;
    g.cancelScheduledValues(now);
    g.setValueAtTime(from, now);
    if (value > from) {
      g.setValueAtTime(from, at);
      g.linearRampToValueAtTime(value, at + fadeIn);
    } else {
      const f = Math.max(0.015, this.fade);
      g.setValueAtTime(from, Math.max(now, at - f / 2));
      g.linearRampToValueAtTime(value, at + f / 2);
    }
  }

  /** Start every track at `from` stem-seconds (default: IN), fading in over `fadeIn`. */
  async play(from = this.loopStart, fadeIn = START_FADE) {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.stop();
    if (!this.buffers.length) return;
    const when = this.ctx.currentTime + 0.03;
    // Starting inside the closing crossfade would overlap envelope automation; start at IN instead.
    if (from >= this.loopEnd - this.fade / 2 - 0.005) from = this.loopStart;

    const bus = this.gains.map((tg) => {
      const b = this.ctx.createGain();
      b.gain.setValueAtTime(0, when);
      b.gain.linearRampToValueAtTime(1, when + Math.max(START_FADE, fadeIn));
      b.connect(tg);
      return b;
    });
    const t0 = when - (from - this.loopStart); // when the playhead would be at IN
    const first = this.makePass(bus, t0, { startAt: when, offset: from });
    this.session = {
      bus,
      passes: [first],
      nextT: t0 + first.len,
      timer: setInterval(() => this.schedule(), TICK_MS),
    };
    this.playing = true;
    this.schedule();
  }

  private schedule() {
    const s = this.session;
    if (!s) return;
    const now = this.ctx.currentTime;
    while (s.nextT - this.fade / 2 < now + LOOKAHEAD) {
      const p = this.makePass(s.bus, s.nextT);
      s.passes.push(p);
      s.nextT += p.len;
    }
    // Forget passes that have finished.
    s.passes = s.passes.filter((p) => p.t0 + p.len + this.fade > now - 0.1);
  }

  /** One pass of the loop on every track, crossfaded at both ends. */
  private makePass(bus: GainNode[], t0: number, first?: { startAt: number; offset: number }): Pass {
    const len = this.len;
    const f = this.fade;
    const end = t0 + len + f / 2;
    const nodes = this.buffers.map((buf, i) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const gain = this.ctx.createGain();
      src.connect(gain);
      gain.connect(bus[i]);
      const g = gain.gain;
      if (first) {
        // Partial first pass: the session bus handles the start fade.
        g.setValueAtTime(1, first.startAt);
        src.start(first.startAt, first.offset);
      } else {
        const startAt = t0 - f / 2;
        if (f > 0) g.setValueCurveAtTime(fadeInCurve, startAt, f);
        else g.setValueAtTime(1, startAt);
        src.start(startAt, Math.max(0, this.loopStart - f / 2));
      }
      if (f > 0) g.setValueCurveAtTime(fadeOutCurve, t0 + len - f / 2, f);
      else g.setValueAtTime(0, t0 + len);
      src.stop(end);
      src.onended = () => {
        src.disconnect();
        gain.disconnect();
      };
      return { src, gain };
    });
    return { t0, start: this.loopStart, len, nodes };
  }

  private killPass(p: Pass, at: number) {
    for (const { src } of p.nodes) {
      try {
        src.stop(at);
      } catch {}
    }
  }

  /** Fade out over 15 ms, then stop. */
  stop() {
    const s = this.session;
    this.session = null;
    this.playing = false;
    if (!s) return;
    clearInterval(s.timer);
    const now = this.ctx.currentTime;
    for (const b of s.bus) {
      b.gain.cancelScheduledValues(now);
      b.gain.setValueAtTime(b.gain.value, now);
      b.gain.linearRampToValueAtTime(0, now + STOP_FADE);
    }
    for (const p of s.passes) this.killPass(p, now + STOP_FADE + 0.005);
    setTimeout(() => s.bus.forEach((b) => b.disconnect()), (STOP_FADE + 0.1) * 1000);
  }

  /** Current playhead in stem seconds. */
  position() {
    const s = this.session;
    if (!s) return this.loopStart;
    const now = this.ctx.currentTime;
    let cur = s.passes[0];
    for (const p of s.passes) if (p.t0 <= now) cur = p;
    if (!cur) return this.loopStart;
    return cur.start + Math.min(now - cur.t0, cur.len);
  }

  close() {
    this.stop();
    void this.ctx.close();
  }
}

/** Equal-power crossfade weights at `t` seconds from the seam (negative = before). */
export function seamWeights(t: number, fade: number): { out: number; in: number } {
  if (fade <= 0) return t < 0 ? { out: 1, in: 0 } : { out: 0, in: 1 };
  const x = Math.min(1, Math.max(0, (t + fade / 2) / fade));
  return { out: Math.cos((x * Math.PI) / 2), in: Math.sin((x * Math.PI) / 2) };
}

/** Per-pixel min/max peaks of the left+right mix for drawing. */
export function computePeaks(buf: AudioBuffer, columns: number) {
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const per = buf.length / columns;
  const out = new Float32Array(columns * 2);
  for (let x = 0; x < columns; x++) {
    let lo = 0;
    let hi = 0;
    const a = Math.floor(x * per);
    const b = Math.min(buf.length, Math.floor((x + 1) * per));
    for (let i = a; i < b; i++) {
      let v = 0;
      for (const ch of chans) v += ch[i];
      v /= chans.length;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[x * 2] = lo;
    out[x * 2 + 1] = hi;
  }
  return out;
}
