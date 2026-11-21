"use client";

import { useEffect, useState } from "react";
import type { LoopEngine } from "@/lib/engine";

/** ?debug=1: audio state on screen, for checking phones and in-app browsers. */
export default function DebugReadout({ engine }: { engine: LoopEngine | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  // exposed for poking at from the console / browser tests
  useEffect(() => {
    (window as Window & { __eng?: LoopEngine | null }).__eng = engine;
  }, [engine]);
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  const rows: [string, string][] = [
    ["context", engine ? `${engine.ctx.state} · ${engine.ctx.sampleRate} Hz · t=${engine.ctx.currentTime.toFixed(1)}` : "none"],
    ["audioSession", session ? session.type : "not available (silent <audio> unlock)"],
    ["playing", engine ? String(engine.playing) : "-"],
    ["stems", engine?.lastLoad ?? "-"],
    ["format", process.env.NEXT_PUBLIC_AUDIO ?? "wav"],
    ["page", document.visibilityState],
    ["browser", navigator.userAgent],
  ];
  return (
    <div className="debug" role="status">
      {rows.map(([k, v]) => (
        <div key={k}>
          <b>{k}</b> {v}
        </div>
      ))}
    </div>
  );
}
