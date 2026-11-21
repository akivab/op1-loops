"use client";

import { useEffect, useRef, useState } from "react";
import { computePeaks, type LoopEngine } from "@/lib/engine";
import { SR, type Loop } from "@/lib/types";

export interface Mix {
  mute: boolean[];
  solo: boolean[];
  vol: number[];
}

interface Props {
  loop: Loop;
  engine: LoopEngine | null;
  buffers: AudioBuffer[];
  mix: Mix;
  onMix: (m: Mix) => void;
  onPoints: (start: number, end: number) => void;
  onSeek: (stemSec: number) => void;
}


const LANE_H = 64;
const GRAB_PX = 8;

export default function TrackLanes({ loop, engine, buffers, mix, onMix, onPoints, onSeek }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const headLabel = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(800);
  const drag = useRef<null | "start" | "end">(null);
  const stem = loop.stem!;
  const total = stem.end - stem.start;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const xOf = (tapeSample: number) => ((tapeSample - stem.start) / total) * width;
  const inSec = (loop.start - stem.start) / SR;

  // Time ruler: seconds from IN, at a tick spacing that fits the width.
  const totalSec = total / SR;
  const tickSec = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30].find((t) => (t / totalSec) * width >= 56) ?? 60;
  const ticks: number[] = [];
  for (let t = Math.ceil(-inSec / tickSec) * tickSec; t <= totalSec - inSec + 1e-9; t += tickSec) ticks.push(+t.toFixed(3));
  const sampleAt = (clientX: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(stem.start + f * total);
  };

  // Playhead follows the engine every frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (engine && headRef.current) {
        const x = ((engine.position() * SR) / total) * width;
        headRef.current.style.transform = `translateX(${x}px)`;
        headRef.current.style.opacity = engine.playing ? "1" : "0";
        if (headLabel.current) headLabel.current.textContent = fmtSec(engine.position() - inSec);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, total, width, inSec]);

  const onPointerDown = (e: React.PointerEvent) => {
    const x = e.clientX - wrapRef.current!.getBoundingClientRect().left;
    if (Math.abs(x - xOf(loop.start)) <= GRAB_PX) drag.current = "start";
    else if (Math.abs(x - xOf(loop.end)) <= GRAB_PX) drag.current = "end";
    else {
      onSeek((sampleAt(e.clientX) - stem.start) / SR);
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const x = e.clientX - wrapRef.current!.getBoundingClientRect().left;
    const near = Math.abs(x - xOf(loop.start)) <= GRAB_PX || Math.abs(x - xOf(loop.end)) <= GRAB_PX;
    wrapRef.current!.style.cursor = drag.current || near ? "ew-resize" : "pointer";
    if (!drag.current) return;
    const s = sampleAt(e.clientX);
    if (drag.current === "start") onPoints(Math.min(s, loop.end - 441), loop.end);
    else onPoints(loop.start, Math.max(s, loop.start + 441));
  };
  const onPointerUp = () => (drag.current = null);

  const toggle = (key: "mute" | "solo", i: number) =>
    onMix({ ...mix, [key]: mix[key].map((v, j) => (j === i ? !v : v)) });

  return (
    <div className="lanes">
      <div className="ruler-spacer">s from IN</div>
      <div className="ruler" aria-hidden>
        {ticks.map((t) => (
          <span key={t} className={t === 0 ? "zero" : ""} style={{ left: ((t + inSec) / totalSec) * width }}>
            {fmtSec(t)}
          </span>
        ))}
      </div>
      <div className="lane-controls">
        {[0, 1, 2, 3].map((i) => {
          const peak = stem.tracks[i]?.peakDb;
          return (
            <div className="lane-ctl" key={i} style={{ height: LANE_H }}>
              <div className="lane-name">
                <span className={`track-dot t${i}`} />
                Track {i + 1}
                {peak === null || (peak !== undefined && peak < -60) ? <em> silent</em> : null}
              </div>
              <div className="lane-btns">
                <button className={mix.mute[i] ? "on" : ""} onClick={() => toggle("mute", i)} title="Mute">
                  M
                </button>
                <button className={mix.solo[i] ? "on solo" : ""} onClick={() => toggle("solo", i)} title="Solo">
                  S
                </button>
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.01}
                  value={mix.vol[i]}
                  aria-label={`Track ${i + 1} volume`}
                  onChange={(e) => onMix({ ...mix, vol: mix.vol.map((v, j) => (j === i ? +e.target.value : v)) })}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div
        className="lane-wave"
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {[0, 1, 2, 3].map((i) => (
          <Wave key={i} buf={buffers[i]} width={width} track={i} dim={isSilenced(mix, i)} />
        ))}
        <div className="region-shade" style={{ left: 0, width: xOf(loop.start) }} />
        <div className="region-shade" style={{ left: xOf(loop.end), right: 0 }} />
        <div className="marker start" style={{ left: xOf(loop.start) }}>
          <span>IN</span>
        </div>
        <div className="marker end" style={{ left: xOf(loop.end) }}>
          <span>OUT</span>
        </div>
        {loop.detected.start !== loop.start && (
          <div className="ghost" style={{ left: xOf(loop.detected.start) }} title="detected IN" />
        )}
        {loop.detected.end !== loop.end && (
          <div className="ghost" style={{ left: xOf(loop.detected.end) }} title="detected OUT" />
        )}
        <div className="playhead" ref={headRef}>
          <span ref={headLabel} />
        </div>
      </div>
    </div>
  );
}

/** Seconds rounded to 0.1, e.g. "3.4s", "-0.5s". */
export function fmtSec(t: number) {
  const r = Math.round(t * 10) / 10;
  return `${(Object.is(r, -0) ? 0 : r).toFixed(1)}s`;
}

export function isSilenced(mix: Mix, i: number) {
  const anySolo = mix.solo.some(Boolean);
  return mix.mute[i] || (anySolo && !mix.solo[i]);
}

function Wave({ buf, width, track, dim }: { buf?: AudioBuffer; width: number; track: number; dim: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = LANE_H * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, LANE_H);
    if (!buf) return;
    const peaks = computePeaks(buf, width);
    g.fillStyle = getComputedStyle(c).getPropertyValue("--wave").trim() || "#888";
    const mid = LANE_H / 2;
    for (let x = 0; x < width; x++) {
      const lo = peaks[x * 2];
      const hi = peaks[x * 2 + 1];
      g.fillRect(x, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
    }
  }, [buf, width]);
  return <canvas ref={ref} className={`wave t${track}${dim ? " dim" : ""}`} style={{ width, height: LANE_H }} />;
}
