"use client";

import { useEffect, useRef } from "react";
import type { LoopEngine } from "@/lib/engine";
import { fft, hann } from "@/lib/fft";
import { drawHills } from "@/lib/hills";
import { SR, type Loop } from "@/lib/types";
import { isSilenced, type Mix } from "./TrackLanes";

// Live spectrum at the playhead, split by track. For each log-spaced band the
// mix spectrum M = Σ X_t, and track t's share is Re(X_t · conj M) / |M|² — the
// shares sum to 1, positive when the track reinforces the mix at that
// frequency, negative when it cancels. Heights are share × the mix level in dB,
// stacked like the tape strip's hills; the orange line is the mix itself.

const N = 2048; // ~46 ms window
const BANDS = 96;
const F_LO = 40;
const F_HI = 18000;
const FLOOR_DB = -90;
const H = 150;
const DECAY = 0.35; // smoothing toward each new frame (higher = snappier)

const window_ = hann(N);
const bandEdges = Array.from({ length: BANDS + 1 }, (_, b) => F_LO * Math.pow(F_HI / F_LO, b / BANDS));
const bandBins = Array.from({ length: BANDS }, (_, b) => {
  const lo = Math.max(1, Math.floor((bandEdges[b] * N) / SR));
  const hi = Math.max(lo + 1, Math.floor((bandEdges[b + 1] * N) / SR));
  return [lo, Math.min(N / 2, hi)] as const;
});

interface Props {
  loop: Loop;
  engine: LoopEngine | null;
  buffers: AudioBuffer[];
  mix: Mix;
}

export default function Spectrum({ loop, engine, buffers, mix }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ loop, engine, buffers, mix });
  live.current = { loop, engine, buffers, mix };

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const re = [0, 1, 2, 3].map(() => new Float32Array(N));
    const im = [0, 1, 2, 3].map(() => new Float32Array(N));
    const shown = [0, 1, 2, 3].map(() => new Float32Array(BANDS));
    const target = [0, 1, 2, 3].map(() => new Float32Array(BANDS));
    const shownMix = new Float32Array(BANDS);
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { loop, engine, buffers, mix } = live.current;
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

      const padL = 34;
      const padB = 16;
      const plotW = w - padL - 8;
      const top = 6;
      const bot = H - padB;

      // frequency grid
      g.font = "10px ui-sans-serif, -apple-system, system-ui, sans-serif";
      g.fillStyle = col("--muted");
      g.strokeStyle = col("--grid");
      g.lineWidth = 1;
      g.textAlign = "center";
      const xOfF = (f: number) => padL + (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * plotW;
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = xOfF(f);
        g.globalAlpha = 0.6;
        g.beginPath();
        g.moveTo(x, top);
        g.lineTo(x, bot);
        g.stroke();
        g.globalAlpha = 1;
        g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, H - 4);
      }
      g.textAlign = "left";
      g.fillText("Hz", 4, H - 4);

      if (!loop.stem || buffers.length < 4) return;

      // window centred on the playhead
      const pos = engine?.playing ? engine.position() : (loop.start - loop.stem.start) / SR;
      const centre = Math.round(pos * SR);
      const a = centre - N / 2;
      const gains = [0, 1, 2, 3].map((t) => (isSilenced(mix, t) ? 0 : mix.vol[t]));
      for (let t = 0; t < 4; t++) {
        const b = buffers[t];
        const chs = Array.from({ length: b.numberOfChannels }, (_, ch) => b.getChannelData(ch));
        const r = re[t];
        const q = im[t];
        for (let i = 0; i < N; i++) {
          const j = a + i;
          let v = 0;
          if (j >= 0 && j < b.length) {
            for (const ch of chs) v += ch[j];
            v /= chs.length;
          }
          r[i] = v * window_[i] * gains[t];
          q[i] = 0;
        }
        if (gains[t]) fft(r, q);
      }

      // per band: shares of the mix and the mix level in dB
      const norm = 2 / N / 0.5; // amplitude normalisation for a Hann window
      for (let bnd = 0; bnd < BANDS; bnd++) {
        const [lo, hi] = bandBins[bnd];
        const dot = [0, 0, 0, 0];
        let mm = 0;
        let own = 0; // Σ|X_t|²: what the tracks would add up to with no cancellation
        for (let k = lo; k < hi; k++) {
          for (let t = 0; t < 4; t++) if (gains[t]) own += re[t][k] * re[t][k] + im[t][k] * im[t][k];
          let mr = 0;
          let mi = 0;
          for (let t = 0; t < 4; t++) {
            if (!gains[t]) continue;
            mr += re[t][k];
            mi += im[t][k];
          }
          mm += mr * mr + mi * mi;
          for (let t = 0; t < 4; t++) if (gains[t]) dot[t] += re[t][k] * mr + im[t][k] * mi;
        }
        const amp = Math.sqrt(mm / (hi - lo)) * norm;
        const db = amp > 0 ? 20 * Math.log10(amp) : FLOOR_DB;
        const level = Math.max(0, (db - FLOOR_DB) / -FLOOR_DB); // 0..1
        shownMix[bnd] += (level - shownMix[bnd]) * DECAY;
        for (let t = 0; t < 4; t++) {
          // When the tracks nearly cancel, |M|² is tiny and raw shares explode;
          // never divide by less than a quarter of the tracks' own energy.
          const denom = Math.max(mm, own * 0.25);
          const v = denom > 1e-20 ? (dot[t] / denom) * level : 0;
          target[t][bnd] = v;
        }
      }
      // light smoothing across neighbouring bands, then toward the new frame
      for (let t = 0; t < 4; t++) {
        for (let bnd = 0; bnd < BANDS; bnd++) {
          const l = target[t][Math.max(0, bnd - 1)];
          const r = target[t][Math.min(BANDS - 1, bnd + 1)];
          const v = 0.25 * l + 0.5 * target[t][bnd] + 0.25 * r;
          shown[t][bnd] += (v - shown[t][bnd]) * DECAY;
        }
      }

      // stacked hills: up for reinforcing, down for cancelling
      const base = top + (bot - top) * 0.82;
      const upPx = base - top;
      const xs = Array.from({ length: BANDS }, (_, bnd) => xOfF(Math.sqrt(bandEdges[bnd] * bandEdges[bnd + 1])));
      drawHills(g, {
        xs,
        shares: shown,
        colors: [0, 1, 2, 3].map((t) => col(`--t${t}`)),
        base,
        top,
        bot,
        scale: upPx,
        border: false,
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="spectrum">
      <canvas ref={ref} style={{ height: H }} aria-label="Spectrum at the playhead, split by track" />
    </div>
  );
}
