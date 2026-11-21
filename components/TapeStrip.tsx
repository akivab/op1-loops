"use client";

import { useEffect, useMemo, useRef } from "react";
import type { LoopEngine } from "@/lib/engine";
import { drawHills } from "@/lib/hills";
import { SR, type Loop } from "@/lib/types";
import { isSilenced, type Mix } from "./TrackLanes";

// A strip of tape running past a fixed playhead, showing how each track adds to
// or takes away from the mix. For every slice, a track's share is its
// correlation with the mix: share_t = <x_t, m> / <m, m> (the shares sum to 1),
// scaled by the mix's RMS level. Positive shares (reinforcing) stack up from
// the baseline in track colours; negative shares (cancelling) stack down. The
// orange line is the mix level itself — the gap between it and the top of the
// stack is what's being cancelled. Beat ticks and seams scroll past with the
// tape; it wraps the way the loop does.

const BIN = 0.01; // seconds per slice
const SMOOTH = 2; // slices either side for display smoothing
const SPAN = 4; // seconds across the strip
const H = 130;

interface Props {
  loop: Loop;
  engine: LoopEngine | null;
  buffers: AudioBuffer[];
  mix: Mix;
}

export default function TapeStrip({ loop, engine, buffers, mix }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stem = loop.stem;
  const inSec = stem ? (loop.start - stem.start) / SR : 0;
  const len = Math.max(0.01, (loop.end - loop.start) / SR);

  // Once per set of stems: for every 10 ms slice of the whole stem, how each pair
  // of tracks lines up (G[t][u] = Σ x_t·x_u, 10 unique pairs). Everything the
  // river needs follows from these for any mix, so mute/solo/volume and IN/OUT
  // changes never rescan the audio.
  const gram = useMemo(() => {
    if (buffers.length < 4) return null;
    const per = Math.round(BIN * SR);
    const n = buffers[0].length;
    const bins = Math.ceil(n / per);
    const G = new Float32Array(bins * 10);
    const chans = buffers.map((b) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)));
    const x = new Float32Array(4);
    for (let k = 0; k < bins; k++) {
      const a = k * per;
      const b = Math.min(n, a + per);
      const o = k * 10;
      for (let i = a; i < b; i++) {
        for (let t = 0; t < 4; t++) {
          const cs = chans[t];
          let v = 0;
          for (const ch of cs) v += ch[i] ?? 0;
          x[t] = v / cs.length;
        }
        G[o] += x[0] * x[0]; G[o + 1] += x[0] * x[1]; G[o + 2] += x[0] * x[2]; G[o + 3] += x[0] * x[3];
        G[o + 4] += x[1] * x[1]; G[o + 5] += x[1] * x[2]; G[o + 6] += x[1] * x[3];
        G[o + 7] += x[2] * x[2]; G[o + 8] += x[2] * x[3];
        G[o + 9] += x[3] * x[3];
      }
    }
    return { G, bins, per };
  }, [buffers]);

  // Signed contribution of each track per slice of the loop, plus the mix level.
  const env = useMemo(() => {
    if (!stem || !gram) return null;
    const { G, per } = gram;
    const k0 = Math.round((inSec * SR) / per);
    const bins = Math.max(1, Math.min(gram.bins - k0, Math.round((len * SR) / per)));
    const gains = [0, 1, 2, 3].map((t) => (isSilenced(mix, t) ? 0 : mix.vol[t]));
    const pair = (o: number, t: number, u: number) => {
      const [i, j] = t <= u ? [t, u] : [u, t];
      return G[o + [0, 4, 7, 9][i] + (j - i)];
    };
    const raw = [0, 1, 2, 3].map(() => new Float32Array(bins));
    const rawMix = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const o = (k0 + k) * 10;
      const dot = [0, 0, 0, 0];
      let mm = 0;
      for (let t = 0; t < 4; t++) {
        if (!gains[t]) continue;
        for (let u = 0; u < 4; u++) if (gains[u]) dot[t] += gains[t] * gains[u] * pair(o, t, u);
        mm += dot[t];
      }
      const rms = Math.sqrt(Math.max(0, mm) / per);
      rawMix[k] = rms;
      // bound the shares when tracks nearly cancel (see Spectrum)
      let own = 0;
      for (let t = 0; t < 4; t++) if (gains[t]) own += gains[t] * gains[t] * pair(o, t, t);
      const denom = Math.max(mm, own * 0.25);
      if (denom > 1e-12) for (let t = 0; t < 4; t++) raw[t][k] = (dot[t] / denom) * rms;
    }
    // light smoothing (wraps around the loop) so it reads as a river, not noise
    const smooth = (arr: Float32Array) => {
      const out = new Float32Array(bins);
      for (let k = 0; k < bins; k++) {
        let s = 0;
        for (let j = -SMOOTH; j <= SMOOTH; j++) s += arr[(k + j + bins) % bins];
        out[k] = s / (2 * SMOOTH + 1);
      }
      return out;
    };
    const share = raw.map(smooth);
    const level = smooth(rawMix);
    let up = 0.02;
    let down = 0.02;
    for (let k = 0; k < bins; k++) {
      let p = 0;
      let q = 0;
      for (let t = 0; t < 4; t++) {
        if (share[t][k] > 0) p += share[t][k];
        else q -= share[t][k];
      }
      up = Math.max(up, p, level[k]);
      down = Math.max(down, q);
    }
    return { share, level, bins, up, down };
  }, [gram, stem, inSec, len, mix]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = c.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(H * dpr);
      }
      const g = c.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, H);
      const style = getComputedStyle(c);
      const col = (n: string) => style.getPropertyValue(n).trim();

      // tape body
      const top = 14;
      const bot = H - 14;
      g.fillStyle = col("--tape");
      g.fillRect(0, top, w, bot - top);
      g.fillStyle = col("--tape-edge");
      g.fillRect(0, top, w, 2);
      g.fillRect(0, bot - 2, w, 2);
      if (!env) return;

      const pos = engine?.playing ? engine.position() : inSec;
      const secPerPx = SPAN / w;
      const mid = w / 2;
      const loopT = (x: number) => {
        const t = pos + (x - mid) * secPerPx - inSec;
        return ((t % len) + len) % len; // seconds into the loop
      };

      // time ticks (every 0.5 s, labelled on whole seconds from IN) and seams, scrolling with the tape
      g.strokeStyle = col("--tape-edge");
      g.fillStyle = col("--muted");
      g.font = "10px ui-sans-serif, -apple-system, system-ui, sans-serif";
      g.textAlign = "center";
      g.lineWidth = 1;
      const t0 = pos - mid * secPerPx - inSec;
      const firstPass = Math.floor(t0 / len);
      for (let p = firstPass; p * len < t0 + SPAN + len; p++) {
        for (let k = 0; k * 0.5 < len - 1e-6; k++) {
          const x = mid + (p * len + k * 0.5 - (pos - inSec)) / secPerPx;
          if (x < 0 || x > w) continue;
          const major = k % 2 === 0;
          g.globalAlpha = major ? 0.9 : 0.4;
          g.beginPath();
          g.moveTo(x, top + 2);
          g.lineTo(x, top + (major ? 9 : 5));
          g.moveTo(x, bot - 2);
          g.lineTo(x, bot - (major ? 9 : 5));
          g.stroke();
          // no label right before the seam, where it would sit on top of the next pass's 0.0s
          if (major && k * 0.5 < len - 0.25) g.fillText(`${(k * 0.5).toFixed(1)}s`, x, top - 3);
        }
        const xs = mid + (p * len - (pos - inSec)) / secPerPx;
        if (xs >= 0 && xs <= w) {
          g.globalAlpha = 1;
          g.strokeStyle = col("--accent");
          g.setLineDash([3, 3]);
          g.beginPath();
          g.moveTo(xs, top);
          g.lineTo(xs, bot);
          g.stroke();
          g.setLineDash([]);
          g.strokeStyle = col("--tape-edge");
        }
      }
      g.globalAlpha = 1;

      // contribution river: reinforcing shares above the baseline, cancelling below
      const room = bot - top - 8;
      const downFrac = Math.min(0.4, Math.max(0.18, env.down / (env.up + env.down)));
      const base = top + 4 + room * (1 - downFrac);
      const scale = Math.min((base - top - 4) / env.up, (bot - 4 - base) / env.down);
      const step = 2;
      const nx = Math.floor(w / step) + 1;
      const ks = new Int32Array(nx);
      for (let j = 0; j < nx; j++) ks[j] = Math.min(env.bins - 1, Math.floor(loopT(j * step) / BIN));
      const xs = Float32Array.from({ length: nx }, (_, j) => j * step);
      drawHills(g, {
        xs,
        shares: env.share.map((sh) => Float32Array.from(ks, (k) => sh[k])),
        colors: [0, 1, 2, 3].map((t) => col(`--t${t}`)),
        base,
        top: top + 2,
        bot: bot - 2,
        scale,
      });

      // playhead
      g.strokeStyle = col("--ink");
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(mid, 4);
      g.lineTo(mid, H - 4);
      g.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, env, inSec, len]);

  return (
    <div className="tape-strip">
      <canvas ref={ref} style={{ height: H }} aria-label="Tape running past the playhead" />
    </div>
  );
}
