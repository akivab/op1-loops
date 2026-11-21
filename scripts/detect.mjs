// Detect loops from every tape's tape.json and write data/loops.json.
// Existing loops (names, edited points, notes) are kept; only new ids are added.
// Usage: npm run detect            (add new loops)
//        npm run detect -- --tape "tape 01"
import fs from "node:fs";
import { detectTapeLoops, listTapes, readLoops, writeLoops, LOOPS_FILE, TAPES_DIR } from "../lib/stems.mjs";

const args = process.argv.slice(2);
const only = args.includes("--tape") ? args[args.indexOf("--tape") + 1] : null;

const db = fs.existsSync(LOOPS_FILE) ? readLoops() : { sampleRate: 44100, loops: [] };
const known = new Set(db.loops.map((l) => l.id));
let added = 0;

for (const tape of listTapes()) {
  if (only && tape !== only) continue;
  const found = detectTapeLoops(tape);
  for (const loop of found) {
    if (known.has(loop.id)) continue;
    db.loops.push(loop);
    added++;
  }
  console.log(`${tape}: ${found.length} loops`);
}

writeLoops(db);
console.log(`added ${added}, total ${db.loops.length} -> ${LOOPS_FILE} (tapes from ${TAPES_DIR})`);
