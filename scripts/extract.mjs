// Cut 4 padded 16-bit WAV stems per loop into public/audio/<id>/.
// Skips loops whose stems already cover their points unless --all.
// Usage: npm run extract [-- --all] [-- --tape "tape 01"]
import { cutLoop, readLoops, stemCovers, writeLoops } from "../lib/stems.mjs";

const args = process.argv.slice(2);
const all = args.includes("--all");
const only = args.includes("--tape") ? args[args.indexOf("--tape") + 1] : null;

const db = readLoops();
let cut = 0;
for (const loop of db.loops) {
  if (only && loop.tape !== only) continue;
  if (!all && stemCovers(loop)) continue;
  cutLoop(loop);
  cut++;
  process.stdout.write(`\rcut ${cut}: ${loop.id}      `);
}
writeLoops(db);
console.log(`\ndone, cut ${cut} loops`);
