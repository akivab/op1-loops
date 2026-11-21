export const SR = 44100;

export type LoopStatus = "unchecked" | "good" | "needs-fix";

export interface Loop {
  id: string;
  tape: string;
  name: string;
  bpm: number;
  /** Tape-absolute sample positions (44.1 kHz), same unit as the OP-1's tape.json. */
  start: number;
  end: number;
  detected: { start: number; end: number };
  recordedTracks: number[];
  status: LoopStatus;
  notes: string;
  /** Crossfade at the seam in ms (default DEFAULT_FADE_MS). */
  fadeMs?: number;
  stem?: { start: number; end: number; tracks: { track: number; peakDb: number | null }[] };
  /** Where the points come from (scripts/drumfit.py): "bars" = the clip is whole bars at
   *  the tape tempo, "drums" = a steady drum grid, "free" = played free, clip points kept. */
  timing?: "bars" | "drums" | "free";
  /** the original clip-based points, kept when the drum grid replaced them */
  clipDetected?: { start: number; end: number };
  drumFit?: { track: number; bpm: number; beats: number; start: number; end: number; confidence: number; residualMs: number; hits: number };
}

export const TIMING_LABEL = { bars: "in time", drums: "on the drum grid", free: "free time" } as const;

export interface LoopDb {
  sampleRate: number;
  loops: Loop[];
}


export const DEFAULT_FADE_MS = 20;
export const FADE_CHOICES_MS = [0, 5, 10, 20, 40, 80];
export const fadeMsOf = (l: Pick<Loop, "fadeMs">) => l.fadeMs ?? DEFAULT_FADE_MS;

export function fmtTime(samples: number): string {
  const s = samples / SR;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(3).padStart(6, "0")}`;
}

export function beatSamples(bpm: number) {
  return Math.round((60 / bpm) * SR);
}

export function bars(loop: Pick<Loop, "start" | "end" | "bpm">) {
  return (loop.end - loop.start) / (beatSamples(loop.bpm) * 4);
}

/** The local app plays the cut WAVs; the GitHub Pages build plays Opus copies (scripts/encode_web.py). */
export function stemUrl(loop: Loop, track: number) {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const v = `?v=${loop.stem?.start ?? 0}-${loop.stem?.end ?? 0}`;
  return process.env.NEXT_PUBLIC_AUDIO === "opus"
    ? `${base}/opus/${loop.id}/track_${track}.opus${v}`
    : `${base}/audio/${loop.id}/track_${track}.wav${v}`;
}

/** One OP-1 tape (data/tapes.json, written by npm run tapes). */
export interface Tape {
  tape: string;
  /** YYYY-MM-DD the tape was started (from its name); null for the tape still on the device */
  started: string | null;
  /** YYYY-MM-DD the tape was last saved on the OP-1 */
  saved: string | null;
  /** still on the device */
  current: boolean;
  bpm: number;
  loops: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "13 Feb 2023" */
export function fmtDate(iso: string | null, withYear = true) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
}
/** "Feb 2023" */
export function fmtMonth(iso: string | null) {
  if (!iso) return "";
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
/** "Tape 3" for archived tapes in order, "On the deck" for the current one */
export function tapeTitle(t: Tape, index: number) {
  return t.current ? "Current tape" : `Tape ${index + 1}`;
}
