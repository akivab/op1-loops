# OP-1 Loops

Four-track loops cut from OP-1 field tape backups, played sample-accurately with the Web Audio API.
Switch tracks on and off (now or on the next loop), watch the mix and spectrum, and move IN/OUT.
Press `?` in the app for the controls.

## Run

    export PATH="$HOME/.local/node/bin:$PATH"
    npm run dev            # http://localhost:3000 (plays the WAV stems, saves edits)

## Data flow

1. `npm run detect` reads every tape's `tape.json` (clip start/stop positions) and writes candidate
   loops to `data/loops.json`. Clips starting together on 2+ tracks make one loop. Re-running it
   only adds new ids, so names and edits are kept.
2. `npm run extract` cuts 4 padded 16-bit WAV stems per loop into `public/audio/<id>/`
   (1 bar or 2 s of padding each side, so points can move without re-cutting). `--all` re-cuts all.
3. `npm run tapes` writes `data/tapes.json`: when each tape was started (from its `YYYY-DDD`
   name) and last saved, for the sidebar.
4. `.venv/bin/python scripts/drumfit.py --apply` finds each loop's drum track and, where a steady
   drum grid fits, moves untouched loops so IN is on a hit and OUT a whole number of beats later.
   Sets `timing` to `bars` / `drums` / `free`; the clip points are kept as `clipDetected`.
5. In the app, edits save to `data/loops.json` (dev, or `OP1_EDIT=1`). Moving a point past the
   padding makes the server re-cut that loop's stems. In a read-only deployment, edits stay
   in the browser and can be exported as JSON.

All times are tape-absolute samples at 44.1 kHz, matching the OP-1's `tape.json`.
Source tapes default to `~/Music/OP-1 backups/2026-11-20/tapes`; override with `OP1_TAPES_DIR`.

## GitHub Pages

The site is a static export (`STATIC=1`), served from the `gh-pages` branch. It plays Opus copies of the stems from `public/opus/` (~185 MB, committed)
instead of the WAVs, and has no save API: edits stay in the visitor's browser.

After cutting or re-cutting stems, re-encode and commit them:

    npm run encode         # public/audio/*.wav -> public/opus/*.opus (needs the .venv)

Build it and publish it:

    npm run deploy    # BASE_PATH=/op1-loops build -> out/, force-pushed to gh-pages

The Python scripts use a project venv: `python3 -m venv .venv && .venv/bin/pip install
numpy==1.26.4 scipy==1.13.1 soundfile==0.13.1`.
