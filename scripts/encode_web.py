"""Encode the cut WAV stems to Ogg Opus for the web build (GitHub Pages).

public/audio/<id>/track_N.wav (44.1 kHz, ~1.9 GB, not committed)
  -> public/opus/<id>/track_N.opus (48 kHz Opus, ~157 kbps, committed)

Opus only runs at 48 kHz, so each stem is resampled 44.1 -> 48 kHz first; the
browser resamples back when it decodes, so times (and the loop points, which
are stored in seconds-from-stem-start terms) are unchanged. Every stem of a
loop has the same length, so the four tracks stay sample-locked.

Skips stems whose .opus is newer than the .wav. Usage:
  .venv/bin/python scripts/encode_web.py [--force] [--jobs N]
"""

from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import soundfile as sf
from scipy.signal import resample_poly

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "audio")
DST = os.path.join(ROOT, "public", "opus")
LEVEL = 0.65  # libsndfile Opus compression level: ~157 kbps stereo


def encode(job: tuple[str, str]) -> tuple[str, int]:
    src, dst = job
    x, sr = sf.read(src, dtype="float32", always_2d=True)
    if sr != 44100:
        raise ValueError(f"{src}: expected 44.1 kHz, got {sr}")
    y = resample_poly(x, 160, 147, axis=0).astype("float32")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".tmp"
    sf.write(tmp, y, 48000, format="OGG", subtype="OPUS", compression_level=LEVEL)
    os.replace(tmp, dst)
    return dst, os.path.getsize(dst)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    args = ap.parse_args()

    jobs = []
    for lid in sorted(os.listdir(SRC)):
        d = os.path.join(SRC, lid)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.endswith(".wav"):
                continue
            src = os.path.join(d, f)
            dst = os.path.join(DST, lid, f[:-4] + ".opus")
            if not args.force and os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
                continue
            jobs.append((src, dst))

    total = 0
    with ProcessPoolExecutor(args.jobs) as ex:
        for i, (dst, size) in enumerate(ex.map(encode, jobs), 1):
            total += size
            if i % 50 == 0 or i == len(jobs):
                print(f"{i}/{len(jobs)} encoded", file=sys.stderr)
    print(f"encoded {len(jobs)} stems, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
