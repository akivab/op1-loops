# OP-1 Loops

Four-track loops cut from my OP-1 field tapes, played sample-accurately with the Web Audio API.
Switch tracks on and off (now or on the next loop), watch the mix and spectrum, and move IN/OUT.
Press `?` in the app for the controls.

Live: **https://akivab.github.io/op1-loops/**

## Two ways it runs

|          | Local (`npm run dev`)                              | GitHub Pages                                   |
| -------- | -------------------------------------------------- | ---------------------------------------------- |
| Audio    | WAV stems in `public/audio/` (~1.9 GB, not in git) | Opus stems in `public/opus/` (~185 MB, in git) |
| Edits    | saved to `data/loops.json`                         | kept in the visitor's browser; "Export edits (.json)" downloads them |
| Built by | the Next.js dev server                             | a GitHub Action, as a static export            |

You cut and edit loops locally. The Pages site is a read-only copy of whatever is committed.

## Run locally

    export PATH="$HOME/.local/node/bin:$PATH"
    npm install
    npm run dev            # http://localhost:3000

The Python scripts use a project venv:

    python3 -m venv .venv && .venv/bin/pip install numpy==1.26.4 scipy==1.13.1 soundfile==0.13.1

## Updating the loops

Source tapes default to `~/Music/OP-1 backups/2026-11-20/tapes`; override with `OP1_TAPES_DIR`.
All times are tape-absolute samples at 44.1 kHz, matching the OP-1's `tape.json`.

1. `npm run detect` reads every tape's `tape.json` and writes candidate loops to
   `data/loops.json`. Clips starting together on 2+ tracks make one loop. Re-running only adds
   new ids, so names and edits are kept.
2. `npm run extract` cuts 4 padded WAV stems per loop into `public/audio/<id>/` (1 bar or 2 s of
   padding each side, so points can move without re-cutting). `--all` re-cuts everything.
3. `npm run tapes` writes `data/tapes.json`: when each tape was started (from its `YYYY-DDD`
   name) and last saved, for the sidebar.
4. `.venv/bin/python scripts/drumfit.py --apply` finds each loop's drum track and, where a steady
   grid fits, moves untouched loops so IN is on a hit and OUT a whole number of beats later.
   Sets `timing` to `bars` / `drums` / `free` and keeps the clip points as `clipDetected`.
5. Edit in the app (`npm run dev`, or a production server with `OP1_EDIT=1`). Moving a point past
   the padding makes the server re-cut that loop's stems.

## Publishing to GitHub Pages

After any change to loops or stems:

    npm run encode         # public/audio/*.wav -> public/opus/*.opus (skips ones already up to date)
    git add data public/opus && git commit -m "..." && git push

Every push to `main` runs `.github/workflows/pages.yml`, which:

1. runs `npm ci`, then `npm run build:pages` with `BASE_PATH=/op1-loops` (the repo name, which
   is the site's path on github.io);
2. `build:pages` sets `STATIC=1`, so `next.config.ts` makes a static export into `out/` that
   loads stems from `opus/` and leaves out the save API (`app/api/loops/route.dev.ts`);
3. uploads `out/` and deploys it. The site updates about a minute after the push.

Watch a deploy with `gh run watch -R akivab/op1-loops`. To rebuild without pushing, run the
workflow from the repo's Actions tab.

**Why Opus:** the WAVs are too big for git. Opus only runs at 48 kHz, so `encode` resamples
first and the browser resamples back when it decodes. All four tracks of a loop come out the
same length, so they stay sample-locked.

**Preview the Pages build locally:**

    BASE_PATH=/op1-loops npm run build:pages
    mkdir -p /tmp/site && ln -sfn "$PWD/out" /tmp/site/op1-loops
    python3 -m http.server 8089 -d /tmp/site     # http://127.0.0.1:8089/op1-loops/

**Bringing browser edits back:** "Export edits (.json)" on the live site downloads the loops
that were changed. Merge them into `data/loops.json` locally, then encode and push as above.

**Pushing changes to the workflow file** needs a GitHub login with the `workflow` scope
(`gh auth refresh -s workflow`, then `gh auth setup-git` so `git push` uses it).
