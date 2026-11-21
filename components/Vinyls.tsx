"use client";

import { useEffect, useRef } from "react";
import type { LoopEngine } from "@/lib/engine";
import { SR, type Loop } from "@/lib/types";
import { isSilenced, type Mix } from "./TrackLanes";

// Four records, one per track. On = spinning with the track's colour on the label,
// off = still and grey. Queued for the next loop = flashing. The outer ring fills
// with how far through the loop playback is.

const R = 26; // record radius in a 64x64 box
const RING = 30;
const CIRC = 2 * Math.PI * RING;

interface Props {
  loop: Loop;
  engine: LoopEngine | null;
  mix: Mix;
  queued: boolean[];
  playing: boolean;
  onToggle: (track: number, immediate?: boolean) => void;
}

export default function Vinyls({ loop, engine, mix, queued, playing, onToggle }: Props) {
  const discs = useRef<(SVGGElement | null)[]>([]);
  const rings = useRef<(SVGCircleElement | null)[]>([]);
  const angles = useRef([0, 0, 0, 0]);
  const mixRef = useRef(mix);
  mixRef.current = mix;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const stem = loop.stem;
      const frac =
        engine?.playing && stem
          ? Math.min(1, Math.max(0, (engine.position() * SR - (loop.start - stem.start)) / (loop.end - loop.start)))
          : 0;
      for (let i = 0; i < 4; i++) {
        const on = !isSilenced(mixRef.current, i);
        if (engine?.playing && on) angles.current[i] = (angles.current[i] + dt * 200) % 360; // ~33 rpm
        discs.current[i]?.setAttribute("transform", `rotate(${angles.current[i].toFixed(1)})`);
        rings.current[i]?.setAttribute("stroke-dashoffset", (CIRC * (1 - frac)).toFixed(2));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, loop.start, loop.end, loop.stem]);

  return (
    <div className="vinyls" role="group" aria-label="Tracks">
      {[0, 1, 2, 3].map((i) => {
        const on = !isSilenced(mix, i);
        const label = queued[i]
          ? `Track ${i + 1}: turning ${on ? "off" : "on"} at the next loop (shift-click to cancel, click to switch now)`
          : playing
            ? `Track ${i + 1} is ${on ? "on" : "off"}: click to turn it ${on ? "off" : "on"}, shift-click to queue it ${on ? "out" : "in"} at the next loop`
            : `Track ${i + 1} is ${on ? "on" : "off"}: click to turn it ${on ? "off" : "on"}`;
        return (
          <button
            key={i}
            className={`vinyl t${i}${on ? " on" : " off"}${queued[i] ? " queued" : ""}`}
            onClick={(e) => onToggle(i, !e.shiftKey)}
            title={label}
            aria-label={label}
            aria-pressed={on}
          >
            <svg viewBox="-32 -32 64 64">
              <circle r={RING} className="v-track" />
              <circle
                ref={(el) => {
                  rings.current[i] = el;
                }}
                r={RING}
                className="v-progress"
                strokeDasharray={CIRC}
                strokeDashoffset={CIRC}
                transform="rotate(-90)"
              />
              <g
                ref={(el) => {
                  discs.current[i] = el;
                }}
              >
                <circle r={R} className="v-disc" />
                {[22, 18.5, 15].map((g) => (
                  <circle key={g} r={g} className="v-groove" />
                ))}
                <circle r={10} className="v-label" />
                <path d="M0 -10 A10 10 0 0 1 8.66 -5 L0 0 Z" className="v-shine" />
                <circle r={1.6} className="v-hole" />
              </g>
            </svg>
            <span className="v-num">{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}
