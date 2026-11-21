import LoopApp from "@/components/LoopApp";
import { readLoops } from "@/lib/stems.mjs";
import fs from "node:fs";
import path from "node:path";
import type { LoopDb, Tape } from "@/lib/types";

export default function Page() {
  const db = readLoops() as LoopDb;
  let tapes: Tape[] = [];
  try {
    tapes = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "tapes.json"), "utf8")).tapes;
  } catch {}
  return <LoopApp initial={db.loops} tapes={tapes} />;
}
