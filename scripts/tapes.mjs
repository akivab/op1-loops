// Writes data/tapes.json: when each tape was started and last saved, so the
// page can tell the story without the backup folder (e.g. when hosted).
//
// Archived OP-1 tapes are named YYYY-DDD#NN (year and day of the year the tape
// was started); "last saved" is tape.json's modification time on the OP-1.
// "tape 01" is the tape still on the device, so it has no start date.
import fs from "node:fs";
import path from "node:path";
import { TAPES_DIR, listTapes, readLoops } from "../lib/stems.mjs";

const out = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "tapes.json");
const loops = readLoops().loops;
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
let prev = {};
try {
  prev = Object.fromEntries(JSON.parse(fs.readFileSync(out, "utf8")).tapes.map((t) => [t.tape, t]));
} catch {}

const tapes = listTapes().map((tape) => {
  const m = /^(\d{4})-(\d{3})#\d+$/.exec(tape);
  const started = m ? new Date(Date.UTC(+m[1], 0, +m[2])).toISOString().slice(0, 10) : null;
  const json = JSON.parse(fs.readFileSync(path.join(TAPES_DIR, tape, "tape.json"), "utf8"));
  const current = !m;
  // the current tape's file time is just when it was copied off; keep any earlier value
  const saved = current ? (prev[tape]?.saved ?? null) : localDate(fs.statSync(path.join(TAPES_DIR, tape, "tape.json")).mtime);
  return {
    tape,
    started,
    saved,
    current,
    bpm: json.tempobpmdecimal / 10,
    loops: loops.filter((l) => l.tape === tape).length,
  };
});
tapes.sort((a, b) => (a.current ? 1 : b.current ? -1 : a.started.localeCompare(b.started)));
fs.writeFileSync(out, JSON.stringify({ tapes }, null, 2) + "\n");
for (const t of tapes) console.log(`${t.tape.padEnd(12)} started ${t.started ?? "—"}  saved ${t.saved ?? "—"}  ${t.loops} loops  ${t.bpm} BPM`);
