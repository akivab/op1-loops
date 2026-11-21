"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoopEngine } from "@/lib/engine";
import { DEFAULT_FADE_MS, SR, bars, fadeMsOf, fmtDate, fmtMonth, stemUrl, tapeTitle, TIMING_LABEL, type Loop, type LoopPatch, type Tape } from "@/lib/types";
import TrackLanes, { isSilenced, type Mix } from "./TrackLanes";
import Vinyls from "./Vinyls";
import TapeStrip from "./TapeStrip";
import Spectrum from "./Spectrum";
import OutputMeter from "./OutputMeter";
import TapeReels3D from "./TapeReels3D";

const LOCAL_KEY = "op1-loops-edits-v1";

function readLocal(): Record<string, LoopPatch> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
  } catch {
    return {};
  }
}
function writeLocal(v: Record<string, LoopPatch>) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(v));
  } catch {}
}

/**
 * The mix with each non-null target applied. Solo is folded into plain mutes
 * first, so what you hear stays the same and every track can be switched on
 * or off on its own.
 */
function withTargets(mix: Mix, targets: (boolean | null)[]): Mix {
  return {
    vol: mix.vol,
    solo: [false, false, false, false],
    mute: mix.mute.map((_, i) => (targets[i] !== null && targets[i] !== undefined ? !targets[i] : isSilenced(mix, i))),
  };
}

export default function LoopApp({
  initial,
  tapes,
  editable,
}: {
  initial: Loop[];
  tapes: Tape[];
  editable: boolean;
}) {
  const [loops, setLoops] = useState<Loop[]>(initial);
  const [showKeys, setShowKeys] = useState(false);
  // start on the first loop of the first tape
  const [selId, setSelId] = useState(
    () => [...initial].filter((l) => l.tape === tapes[0]?.tape).sort((a, b) => a.start - b.start)[0]?.id ?? initial[0]?.id,
  );
  const [filter, setFilter] = useState("");
  const [engine, setEngine] = useState<LoopEngine | null>(null);
  const [buffers, setBuffers] = useState<AudioBuffer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | "local">(editable ? "saved" : "local");
  const [toast, setToast] = useState<string | null>(null);
  const [mix, setMix] = useState<Mix>({ mute: [false, false, false, false], solo: [false, false, false, false], vol: [1, 1, 1, 1] });
  // Per track: the on/off state it's queued to take at the next loop, or null.
  const [queued, setQueued] = useState<(boolean | null)[]>([null, null, null, null]);
  const applied = useRef<{ engine: LoopEngine | null; gain: (number | null)[] }>({ engine: null, gain: [null, null, null, null] });
  const pending = useRef<Record<string, LoopPatch>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loop = loops.find((l) => l.id === selId);

  // Tapes in the order they were made; titles ("Tape 3") follow that order.
  const tapeOrder = useMemo(() => {
    const known = tapes.map((t) => t.tape);
    const extra = [...new Set(loops.map((l) => l.tape))].filter((t) => !known.includes(t));
    return [...known, ...extra];
  }, [tapes, loops]);
  // a tape's main stretch: its start until the next tape was started (or its last save)
  const tapeSpan = (t: Tape) => {
    const dated = tapes.filter((x) => !x.current && x.started);
    const next = dated[dated.findIndex((x) => x.tape === t.tape) + 1]?.started ?? null;
    const end = next && t.saved && next < t.saved ? next : t.saved;
    return `${fmtDate(t.started)} → ${fmtDate(end)}`;
  };
  const tapeInfo = useCallback(
    (tape: string) => {
      const i = tapes.findIndex((t) => t.tape === tape);
      const t = tapes[i];
      return t ? { t, title: tapeTitle(t, i) } : { t: null, title: tape };
    },
    [tapes],
  );

  // Read-only deployments keep edits in this browser.
  useEffect(() => {
    if (editable) return;
    const local = readLocal();
    setLoops((ls) => ls.map((l) => (local[l.id] ? { ...l, ...local[l.id] } : l)));
  }, [editable]);

  useEffect(() => {
    const e = new LoopEngine();
    setEngine(e);
    return () => e.close();
  }, []);

  // Load the 4 stems whenever the loop or its cut changes.
  const stemKey = loop ? `${loop.id}:${loop.stem?.start}:${loop.stem?.end}` : "";
  useEffect(() => {
    if (!engine || !loop?.stem) return;
    const ac = new AbortController();
    const wasPlaying = engine.playing;
    setLoading(true);
    setError(null);
    engine
      .load([1, 2, 3, 4].map((t) => stemUrl(loop, t)), ac.signal)
      .then(() => {
        setBuffers(engine.buffers);
        engine.setLoop((loop.start - loop.stem!.start) / SR, (loop.end - loop.stem!.start) / SR);
        engine.setFade(fadeMsOf(loop) / 1000);
        if (wasPlaying) void engine.play(undefined, 0.6); // fade the new loop in
        setPlaying(engine.playing);
      })
      .catch((err) => {
        if (!ac.signal.aborted) setError(`Couldn't load stems: ${err.message}. Run "npm run extract".`);
      })
      .finally(() => !ac.signal.aborted && setLoading(false));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, stemKey]);

  // Live loop points.
  useEffect(() => {
    if (engine && loop?.stem && buffers.length) {
      engine.setLoop((loop.start - loop.stem.start) / SR, (loop.end - loop.stem.start) / SR);
      engine.setFade((loop.fadeMs ?? DEFAULT_FADE_MS) / 1000);
    }
  }, [engine, loop?.start, loop?.end, loop?.stem, loop?.fadeMs, buffers]);

  // Gains follow the mix. Queued targets land exactly on the next wrap (fading in
  // over a beat); everything else applies now. `applied` remembers what each
  // track's gain was last set or scheduled to, so stale schedules get replaced
  // and in-flight fades aren't cut short.
  const pendingQueue = queued.some((t, i) => t !== null && t !== !isSilenced(mix, i));
  useEffect(() => {
    if (!engine) return;
    if (applied.current.engine !== engine) applied.current = { engine, gain: [null, null, null, null] };
    const next = pendingQueue && playing ? withTargets(mix, queued) : mix;
    for (let i = 0; i < 4; i++) {
      const now = isSilenced(mix, i) ? 0 : mix.vol[i];
      const later = isSilenced(next, i) ? 0 : next.vol[i];
      if (later !== now) {
        engine.scheduleGainAtWrap(i, later, 60 / (loop?.bpm || 120));
        applied.current.gain[i] = later;
      } else if (applied.current.gain[i] !== now) {
        engine.setGain(i, now);
        applied.current.gain[i] = now;
      }
    }
    if (!(pendingQueue && playing)) return;
    const t = setTimeout(() => {
      setMix(next);
      setQueued([null, null, null, null]);
    }, engine.timeToWrap() * 1000 + 30);
    return () => clearTimeout(t);
  }, [engine, playing, queued, mix, pendingQueue, loop?.start, loop?.end, loop?.bpm, buffers]);

  // Records: switch straight away, or (immediate = false, i.e. shift, while
  // playing) queue the opposite of what the track is doing now; queue again to cancel.
  const toggleTrack = useCallback(
    (i: number, immediate = false) => {
      const on = !isSilenced(mix, i);
      if (playing && !immediate) {
        setQueued((q) => q.map((t, j) => (j === i ? (t === null || t === on ? !on : null) : t)));
        return;
      }
      setQueued((q) => q.map((t, j) => (j === i ? null : t)));
      setMix(withTargets(mix, [0, 1, 2, 3].map((j) => (j === i ? !on : null))));
    },
    [playing, mix],
  );

  const flush = useCallback(async () => {
    const batch = pending.current;
    pending.current = {};
    const ids = Object.keys(batch);
    if (!ids.length) return;
    setSaveState("saving");
    try {
      for (const id of ids) {
        const res = await fetch("/api/loops", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, ...batch[id] }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || res.statusText);
        // Server may have re-cut the stems; take its stem but keep any newer local edits.
        setLoops((ls) => ls.map((l) => (l.id === id ? { ...l, stem: body.loop.stem } : l)));
      }
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setToast(`Save failed: ${(err as Error).message}`);
    }
  }, []);

  const update = useCallback(
    (id: string, patch: LoopPatch) => {
      setLoops((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
      if (editable) {
        pending.current[id] = { ...pending.current[id], ...patch };
        setSaveState("saving");
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(flush, 500);
      } else {
        const local = readLocal();
        local[id] = { ...local[id], ...patch };
        writeLocal(local);
      }
    },
    [editable, flush],
  );

  const setPoints = (start: number, end: number) => loop && update(loop.id, { start: Math.round(start), end: Math.round(end) });

  const play = useCallback(
    async (from?: number) => {
      if (!engine || !buffers.length) return;
      await engine.play(from);
      setPlaying(true);
    },
    [engine, buffers],
  );
  const stop = useCallback(() => {
    engine?.stop();
    setPlaying(false);
    applied.current.gain = [null, null, null, null]; // re-apply gains now, dropping any scheduled fade
    // Stopping lands anything still queued.
    if (queued.some((t) => t !== null)) {
      setMix(withTargets(mix, queued));
      setQueued([null, null, null, null]);
    }
  }, [engine, queued, mix]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rank = (l: Loop) => tapeOrder.indexOf(l.tape);
    return loops
      .filter(
        (l) =>
          !q ||
          l.id.includes(q) ||
          l.name.toLowerCase().includes(q) ||
          l.tape.toLowerCase().includes(q) ||
          tapeInfo(l.tape).title.toLowerCase().includes(q),
      )
      .sort((a, b) => rank(a) - rank(b) || a.start - b.start);
  }, [loops, filter, tapeOrder, tapeInfo]);

  const select = useCallback(
    (id: string | undefined) => {
      if (!id) return;
      setSelId(id);
      document.getElementById(`item-${id}`)?.scrollIntoView({ block: "nearest" });
    },
    [],
  );

  // Keyboard: space play/stop, 1–4 tracks, ↑/↓ loops, ? controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select")) return;
      const i = visible.findIndex((l) => l.id === selId);
      if (e.code === "Space") {
        e.preventDefault();
        if (playing) stop();
        else void play();
      } else if (e.key === "?") setShowKeys((v) => !v);
      else if (e.key === "Escape") setShowKeys(false);
      else if (/^Digit[1-4]$/.test(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 1–4 switch right now; shift+1–4 queue for the next loop.
        e.preventDefault();
        toggleTrack(+e.code.slice(5) - 1, !e.shiftKey);
      }
      else if (e.key === "ArrowDown") {
        e.preventDefault();
        select(visible[Math.min(visible.length - 1, i + 1)]?.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        select(visible[Math.max(0, i - 1)]?.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selId, playing, play, stop, select, toggleTrack]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);



  const exportEdits = () => {
    const blob = new Blob([JSON.stringify(readLocal(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "op1-loop-edits.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const shownTapes = tapeOrder.filter((t) => visible.some((l) => l.tape === t));
  const loopIndex = loop ? loops.filter((l) => l.tape === loop.tape).sort((a, b) => a.start - b.start).findIndex((l) => l.id === loop.id) : -1;
  const tapeCount = loop ? loops.filter((l) => l.tape === loop.tape).length : 0;

  // "Feb 2023 – Sep 2024": first tape started to the last save
  const dated = tapes.filter((t) => !t.current && t.started);
  const lastSaved = dated.reduce<string | null>((m, t) => (t.saved && (!m || t.saved > m) ? t.saved : m), null);
  const span = dated.length && lastSaved ? `${fmtMonth(dated[0].started)} – ${fmtMonth(lastSaved)}` : "";

  const queuedFlags = queued.map((t, i) => t !== null && t !== !isSilenced(mix, i));
  const playButton = loop && (
    <button
      className={`play${playing ? " playing" : ""}`}
      onClick={() => (playing ? stop() : play())}
      disabled={!buffers.length}
      aria-label={playing ? "Stop" : "Play"}
      title={playing ? "Stop (space)" : "Play (space)"}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        {playing ? <rect x="7" y="7" width="10" height="10" rx="1.5" /> : <path d="M9 6.5v11a1 1 0 0 0 1.5.86l9-5.5a1 1 0 0 0 0-1.72l-9-5.5A1 1 0 0 0 9 6.5Z" />}
      </svg>
    </button>
  );
  const vinyls = loop && <Vinyls loop={loop} engine={engine} mix={mix} queued={queuedFlags} playing={playing} onToggle={toggleTrack} />;
  const reels = loop && <TapeReels3D loop={loop} engine={engine} mix={mix} queued={queuedFlags} />;
  const meter = <OutputMeter engine={engine} mix={mix} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <h1>OP-1 Loops</h1>
          <p>
            {tapes.length || shownTapes.length} tapes · {loops.length} loops
          </p>
        </header>
        <input
          className="search"
          placeholder="Search loops or tapes…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <nav className="list" aria-label="Loops">
          {shownTapes.map((tape) => {
            const { t, title } = tapeInfo(tape);
            return (
            <section key={tape}>
              <h2>
                <span>{title}</span>
                <small>
                  {t?.current ? "on the OP-1 now" : t ? tapeSpan(t) : ""}
                </small>
              </h2>
              {visible
                .filter((l) => l.tape === tape)
                .map((l) => (
                  <button
                    key={l.id}
                    id={`item-${l.id}`}
                    className={`item${l.id === selId ? " sel" : ""}`}
                    onClick={() => select(l.id)}
                  >
                    <span className="item-name">{l.name || l.id}</span>
                    <span className="item-meta">{bars(l).toFixed(1)} bars</span>
                  </button>
                ))}
            </section>
            );
          })}
        </nav>
        {(!editable || saveState === "saving" || saveState === "error") && (
          <footer className="side-foot">
            {!editable && <button onClick={exportEdits}>Export edits (.json)</button>}
            {(saveState === "saving" || saveState === "error") && (
              <span className={`save ${saveState}`}>{saveState === "saving" ? "Saving…" : "Not saved"}</span>
            )}
          </footer>
        )}
      </aside>

      <main className="editor">
        {!loop ? (
          <p className="empty">No loops. Run “npm run detect && npm run extract”.</p>
        ) : !loop.stem ? (
          <p className="empty">
            No stems cut for {loop.id} yet. Run <code>npm run extract</code>.
          </p>
        ) : (
          <>
            <div className="title-row">
              <input
                className="name"
                value={loop.name}
                placeholder={loop.id}
                aria-label="Loop name"
                title="Rename this loop (clear it to go back to the id)"
                onChange={(e) => update(loop.id, { name: e.target.value })}
              />
              <button
                className={`keys-btn${showKeys ? " on" : ""}`}
                onClick={() => setShowKeys((v) => !v)}
                aria-expanded={showKeys}
                aria-label="Controls"
                title="Controls (?)"
              >
                ?
              </button>
            </div>
            <p className="sub">
              <strong>{tapeInfo(loop.tape).title}</strong>
              {tapeInfo(loop.tape).t?.started && <> · started {fmtDate(tapeInfo(loop.tape).t!.started)}</>} · loop {loopIndex + 1} of {tapeCount} ·{" "}
              {loop.timing === "drums" && loop.drumFit ? `${loop.drumFit.bpm.toFixed(1)} BPM` : `${loop.bpm} BPM`} ·{" "}
              {((loop.end - loop.start) / SR).toFixed(1)} s ·{" "}
              {loop.timing === "drums" && loop.drumFit ? `${loop.drumFit.beats} beats` : `${bars(loop).toFixed(1)} bars`}
              {loop.timing && (
                <span className={`timing ${loop.timing}`} title={loop.timing === "drums" && loop.drumFit ? `IN on a track ${loop.drumFit.track} hit, OUT ${loop.drumFit.beats} beats later (grid fit ±${loop.drumFit.residualMs} ms)` : undefined}>
                  {TIMING_LABEL[loop.timing]}
                </span>
              )}
              {loading && " · loading…"}
            </p>
            {error && <p className="error">{error}</p>}

            <div className="transport">
              {playButton}
              {vinyls}
              {meter}
              {reels}
            </div>

            <h3 className="sec">
              Tracks
            </h3>
            <TrackLanes
              loop={loop}
              engine={engine}
              buffers={buffers}
              mix={mix}
              onMix={setMix}
              onPoints={setPoints}
              onSeek={(sec) => void play(sec)}
            />

            <h3 className="sec">
              Mix
            </h3>
            <TapeStrip loop={loop} engine={engine} buffers={buffers} mix={mix} />
            <h3 className="sec">
              Spectrum
            </h3>
            <Spectrum loop={loop} engine={engine} buffers={buffers} mix={mix} />

          </>
        )}
      </main>
      {showKeys && (
        <div className="modal-back" onClick={() => setShowKeys(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="About and controls" onClick={(e) => e.stopPropagation()}>
            <button className="modal-x" onClick={() => setShowKeys(false)} aria-label="Close">
              ×
            </button>
            <h2>OP-1 Loops</h2>
            <p className="modal-story">
              Musical ideas from my OP-1 field{span ? `, ${span}` : ""}: {tapes.length || shownTapes.length} tapes,{" "}
              {loops.length} four-track loops.
            </p>
            <dl className="modal-keys">
              <dt><kbd>Space</kbd></dt>
              <dd>Play / stop</dd>
              <dt><kbd>1</kbd>–<kbd>4</kbd> · click a record</dt>
              <dd>Track on / off now</dd>
              <dt><kbd>⇧</kbd> + <kbd>1</kbd>–<kbd>4</kbd> · ⇧ click</dt>
              <dd>Track on / off next loop</dd>
              <dt><kbd>↑</kbd> <kbd>↓</kbd></dt>
              <dd>Previous / next loop</dd>
              <dt>click a track</dt>
              <dd>Play from there</dd>
              <dt>drag IN / OUT</dt>
              <dd>Move the loop points</dd>
              <dt>M · S</dt>
              <dd>Mute · solo a track</dd>
              <dt><kbd>?</kbd> · <kbd>Esc</kbd></dt>
              <dd>Open · close this</dd>
            </dl>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
