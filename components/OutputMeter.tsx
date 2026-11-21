"use client";

import { useEffect, useRef } from "react";
import type { LoopEngine } from "@/lib/engine";
import { hexA } from "@/lib/hills";
import { isSilenced, type Mix } from "./TrackLanes";

// What you're hearing, live: the output's amplitude over the last few seconds,
// scrolling left, with the current moment at the right edge. The shape is split
// into four even bands, one per track, coloured like the reel: track colour
// when on, grey when muted.

const W = 280;
const H = 64;
const HISTORY_SEC = 4;
const FLOOR_DB = -60;
const GREY = "#6b6964";

export default function OutputMeter({ engine, mix }: { engine: LoopEngine | null; mix: Mix }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const mixRef = useRef(mix);
  mixRef.current = mix;
  const label = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c || !engine) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    const mbuf = new Float32Array(engine.analyser.fftSize);
    const cols = W;
    const level = new Float32Array(cols);
    let shown = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;

    const energy = (buf: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return sum / buf.length;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = (now - last) / 1000;
      last = now;

      engine.analyser.getFloatTimeDomainData(mbuf);
      const rms = Math.sqrt(energy(mbuf));
      const db = rms > 1e-6 ? 20 * Math.log10(rms) : -Infinity;
      const lv = Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
      shown += (lv - shown) * (lv > shown ? 0.6 : 0.15);

      // scroll the history at a steady rate
      acc += (dt / HISTORY_SEC) * cols;
      const shift = Math.floor(acc);
      if (shift > 0) {
        acc -= shift;
        const s = Math.min(cols, shift);
        level.copyWithin(0, s);
        level.fill(shown, cols - s);
      }
      level[cols - 1] = shown;
      if (label.current) label.current.textContent = Number.isFinite(db) ? `${Math.round(db)} dB` : "−∞ dB";

      const style = getComputedStyle(c);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const mid = H / 2;
      const amp = mid - 4;

      // mirrored, four even bands outward from the centre: track 1 innermost
      const inner = new Float32Array(cols);
      for (let t = 0; t < 4; t++) {
        const color = isSilenced(mixRef.current, t) ? GREY : style.getPropertyValue(`--t${t}`).trim();
        const fill = g.createLinearGradient(0, 0, W, 0);
        fill.addColorStop(0, hexA(color, 0));
        fill.addColorStop(0.7, hexA(color, 0.4));
        fill.addColorStop(1, hexA(color, 0.85));
        g.fillStyle = fill;
        const outer = new Float32Array(cols);
        for (let x = 0; x < cols; x++) outer[x] = inner[x] + level[x] / 4;
        for (const sign of [-1, 1]) {
          g.beginPath();
          for (let x = 0; x < cols; x++) g.lineTo(x, mid + sign * outer[x] * amp);
          for (let x = cols - 1; x >= 0; x--) g.lineTo(x, mid + sign * inner[x] * amp);
          g.closePath();
          g.fill();
        }
        inner.set(outer);
      }

      // soft white outer edge, fading in toward now
      const edge = g.createLinearGradient(0, 0, W, 0);
      edge.addColorStop(0, "rgba(255,255,255,0)");
      edge.addColorStop(1, "rgba(255,255,255,0.75)");
      g.strokeStyle = edge;
      g.lineWidth = 1;
      for (const sign of [-1, 1]) {
        g.beginPath();
        for (let x = 0; x < cols; x++) g.lineTo(x, mid + sign * level[x] * amp);
        g.stroke();
      }

      // the current moment
      g.save();
      g.fillStyle = "#fff";
      g.shadowColor = "rgba(255,255,255,0.8)";
      g.shadowBlur = 10;
      g.fillRect(W - 2, mid - shown * amp, 2, Math.max(1, 2 * shown * amp));
      g.restore();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return (
    <div className="out-meter" title="What you're hearing: output level over the last 4 seconds">
      <canvas ref={ref} style={{ width: W, height: H }} />
      <span ref={label} className="out-db">
        −∞ dB
      </span>
    </div>
  );
}
