import { NextResponse } from "next/server";
import { cutLoop, readLoops, stemCovers, writeLoops } from "@/lib/stems.mjs";
import { editable } from "@/lib/editable";
import type { Loop, LoopDb, LoopPatch } from "@/lib/types";

export const dynamic = "force-dynamic";


export async function GET() {
  return NextResponse.json(readLoops() as LoopDb);
}

export async function PATCH(req: Request) {
  if (!editable()) return NextResponse.json({ error: "read-only deployment" }, { status: 403 });
  const { id, ...patch } = (await req.json()) as LoopPatch & { id: string };
  const db = readLoops() as LoopDb;
  const loop = db.loops.find((l) => l.id === id);
  if (!loop) return NextResponse.json({ error: `no loop ${id}` }, { status: 404 });

  if (typeof patch.name === "string") loop.name = patch.name.slice(0, 120);
  if (typeof patch.notes === "string") loop.notes = patch.notes.slice(0, 2000);
  if (typeof patch.fadeMs === "number" && patch.fadeMs >= 0 && patch.fadeMs <= 500) loop.fadeMs = Math.round(patch.fadeMs);
  if (patch.status && ["unchecked", "good", "needs-fix"].includes(patch.status)) loop.status = patch.status;
  const start = patch.start ?? loop.start;
  const end = patch.end ?? loop.end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start + 441) {
    return NextResponse.json({ error: "bad loop points" }, { status: 400 });
  }
  loop.start = start;
  loop.end = end;

  let recut = false;
  if (!stemCovers(loop)) {
    cutLoop(loop); // points moved outside the padded stem: cut a new one around them
    recut = true;
  }
  writeLoops(db);
  return NextResponse.json({ loop: loop as Loop, recut });
}
