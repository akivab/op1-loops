"""Find each loop's drum track and use its beat grid to place IN and OUT.

For every loop in data/loops.json (stems must be cut: npm run extract):

1. Drum track: of the four tracks, the one whose onset envelope is both peaky
   (sharp transients) and periodic (hits repeat at a steady interval).
2. Onsets: spectral-flux peaks on the drum track, each refined to the sample
   where its attack starts.
3. Beat grid: the tempo (60-200 BPM) whose 16th grid the hits line up on
   best, mildly preferring the tape's BPM, then a weighted
   least-squares fit of period and phase to the onsets on a 16th-note grid,
   dropping outliers. Fitting over many hits gives sub-millisecond precision.
4. Points: IN = the strong on-grid drum hit nearest the current IN, moved back
   by half the crossfade so the fade completes before the hit; OUT = IN + a
   whole number of beats (the current length, rounded).

Writes loop.drumFit = {track, bpm, beats, start, end, confidence, residualMs}.
Sets loop.timing: "bars" when the clip is already whole bars at the tape
tempo, "drums" when the drum grid fits well (confidence >= 0.6), else "free".
With --apply, untouched "drums" loops (start/end == detected) take the
drum-fit points as their new start/end/detected (the clip points are kept as
clipDetected); loops you've edited keep your points.

Usage: .venv/bin/python scripts/drumfit.py [--apply] [--only ID] [--verbose]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import wave

import numpy as np
from scipy.signal import find_peaks, stft

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOOPS = os.path.join(ROOT, "data", "loops.json")
AUDIO = os.path.join(ROOT, "public", "audio")
SR = 44100
HOP = 128  # 2.9 ms
NFFT = 1024
DEFAULT_FADE_MS = 20
MIN_CONF = 0.6  # drum grid must fit this well before it moves a loop


def read_mono(path: str) -> np.ndarray:
    with wave.open(path) as w:
        n, ch, sw = w.getnframes(), w.getnchannels(), w.getsampwidth()
        if sw != 2:
            raise ValueError(f"{path}: expected 16-bit")
        x = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float32) / 32768.0
    return x.reshape(-1, ch).mean(axis=1)


def onset_envelope(x: np.ndarray) -> np.ndarray:
    """Spectral flux (log magnitude, positive differences), one value per HOP."""
    _, _, Z = stft(x, fs=SR, nperseg=NFFT, noverlap=NFFT - HOP, boundary=None, padded=False)
    mag = np.log1p(100.0 * np.abs(Z))
    flux = np.maximum(0.0, np.diff(mag, axis=1)).sum(axis=0)
    flux = np.concatenate([[0.0], flux])
    # frame i is centred at sample i*HOP + NFFT/2; shift so index ~ sample/HOP
    shift = NFFT // (2 * HOP)
    return np.concatenate([np.zeros(shift), flux])[: len(flux)]


def autocorr(env: np.ndarray) -> np.ndarray:
    e = env - env.mean()
    n = len(e)
    f = np.fft.rfft(e, 2 * n)
    ac = np.fft.irfft(f * np.conj(f))[:n]
    return ac / (ac[0] + 1e-12)


def lag_frames(bpm: float) -> float:
    return 60.0 / bpm * SR / HOP


def percussiveness(x: np.ndarray, env: np.ndarray) -> tuple[float, dict]:
    """Peaky and periodic transients, over a track that actually plays through the loop."""
    if len(x) == 0:
        return 0.0, {}
    peak = float(np.abs(x).max())
    if peak < 10 ** (-40 / 20):  # quieter than -40 dBFS: treat as silent
        return 0.0, {"silent": True}
    # activity: share of 20 ms windows within 30 dB of the track's loudest window
    w = int(0.02 * SR)
    n = len(x) // w
    rms = np.sqrt((x[: n * w].reshape(n, w) ** 2).mean(axis=1)) + 1e-9
    active = float((rms > rms.max() * 10 ** (-30 / 20)).mean())
    # peakiness measured against the track's own active level, not its silences
    e = env[env > 0]
    if len(e) < 10:
        return 0.0, {}
    peaky = np.percentile(e, 97) / (np.percentile(e, 60) + 1e-6)
    ac = autocorr(env)
    lo, hi = int(lag_frames(200)), int(lag_frames(60))
    periodic = float(ac[lo:hi].max()) if hi < len(ac) else 0.0
    score = float(np.log1p(peaky) * max(0.0, periodic) * active**2)
    return score, {"active": round(active, 2), "peaky": round(float(peaky), 1), "periodic": round(periodic, 2)}


def beat_period(env: np.ndarray, tape_bpm: float) -> float:
    """Beat period in seconds; prefer the tape's tempo (or ×2, ÷2) if the drums agree."""
    ac = autocorr(env)
    lo, hi = int(lag_frames(190)), min(len(ac) - 1, int(lag_frames(65)))
    best = lo + int(np.argmax(ac[lo:hi]))
    best_val = ac[best]
    for mult in (1.0, 2.0, 0.5):
        lag = lag_frames(tape_bpm * mult)
        if lo <= lag <= hi:
            i = int(round(lag))
            local = i - 3 + int(np.argmax(ac[i - 3 : i + 4]))
            if ac[local] >= 0.8 * best_val:
                best = local
                break
    # parabolic refinement of the peak
    y0, y1, y2 = ac[best - 1], ac[best], ac[best + 1]
    d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 + 1e-12)
    return (best + d) * HOP / SR


def refine_attack(x: np.ndarray, t: int) -> int:
    """Sample where the hit's attack starts: first sample reaching 25% of the local peak."""
    a = max(0, t - int(0.012 * SR))
    b = min(len(x), t + int(0.012 * SR))
    seg = np.abs(x[a:b])
    if len(seg) == 0:
        return t
    # light smoothing (0.5 ms) so single-sample spikes don't trigger it
    k = max(1, int(0.0005 * SR))
    sm = np.convolve(seg, np.ones(k) / k, mode="same")
    peak = sm.max()
    if peak <= 0:
        return t
    idx = np.argmax(sm >= 0.25 * peak)
    return a + int(idx)


def grid_tempo(times: np.ndarray, weights: np.ndarray, tape_bpm: float) -> float:
    """Beat period (s) whose 16th grid the hits line up on best.

    Scans 60-200 BPM; the score is the weighted vector strength of the hit times at
    the 16th-note period (1 = every hit exactly on a grid line). Halving or doubling
    the tempo puts half the hits half-way between lines, so octave errors score low,
    and a mild prior breaks the remaining ties toward the tape's BPM (x1, x2, /2).
    """
    bpms = np.arange(60.0, 200.0, 0.02)
    sub = 60.0 / bpms / 4
    ph = 2 * np.pi * times[None, :] / sub[:, None]
    w = weights / weights.sum()
    vs = np.abs((w[None, :] * np.exp(1j * ph)).sum(axis=1))
    # A steady pattern fits its half-tempo grid just as well (8ths at 120 = 16ths
    # at 60), so octaves are decided by priors: the tape's own tempo first, then
    # double/half of it more weakly, then a broad preference for ~80-160 BPM.
    near = lambda b, w: np.exp(-0.5 * (np.log(bpms / b) / w) ** 2)
    prior = 1.0 + 0.6 * near(tape_bpm, 0.01) + 0.2 * np.maximum(near(2 * tape_bpm, 0.01), near(tape_bpm / 2, 0.01))
    prior *= 0.75 + 0.25 * near(115.0, 0.35)
    score = vs * prior
    return 60.0 / bpms[int(np.argmax(score))]


def fit_grid(times: np.ndarray, weights: np.ndarray, period: float):
    """Weighted LS fit of t = phase + k*sub on a 16th grid. Returns (period, phase, inliers, residuals)."""
    sub = period / 4
    ref = times[np.argmax(weights)]
    keep = np.ones(len(times), bool)
    phase = ref
    for _ in range(4):
        k = np.round((times - phase) / sub)
        A = np.stack([np.ones_like(k), k], axis=1)
        W = weights * keep
        if W.sum() <= 0 or keep.sum() < 3:
            break
        sol, *_ = np.linalg.lstsq(A * np.sqrt(W)[:, None], times * np.sqrt(W), rcond=None)
        phase, sub = float(sol[0]), float(sol[1])
        res = times - (phase + k * sub)
        keep = np.abs(res) < sub / 4
    k = np.round((times - phase) / sub)
    res = times - (phase + k * sub)
    return sub * 4, phase, keep, res


def analyse(loop: dict, verbose: bool):
    stem = loop.get("stem")
    if not stem:
        return None, "no stem"
    xs = []
    for t in range(1, 5):
        p = os.path.join(AUDIO, loop["id"], f"track_{t}.wav")
        if not os.path.exists(p):
            return None, "stems missing"
        xs.append(read_mono(p))
    in0 = loop["start"] - stem["start"]
    out0 = loop["end"] - stem["start"]
    a, b = max(0, in0), min(len(xs[0]), out0)

    # 1. drum track
    scores = []
    details = []
    envs = []
    for x in xs:
        env = onset_envelope(x)
        envs.append(env)
        sc, det = percussiveness(x[a:b], env[a // HOP : b // HOP])
        scores.append(sc)
        details.append(det)
    d = int(np.argmax(scores))
    if scores[d] <= 0:
        return None, "no percussive track"
    x, env = xs[d], envs[d]

    # 2. rough tempo (only to size the search window; refined from the hits below)
    period = beat_period(env[a // HOP : b // HOP], loop.get("bpm") or 120)

    # 3. onsets over the loop plus a beat either side, refined to attack starts
    lo_f = max(0, (a - int(period * SR)) // HOP)
    hi_f = min(len(env), (b + int(period * SR)) // HOP)
    seg = env[lo_f:hi_f]
    thr = np.median(seg) + 1.5 * np.std(seg)
    peaks, props = find_peaks(seg, height=thr, distance=max(1, int(0.06 * SR / HOP)))
    if len(peaks) < 4:
        return None, f"too few drum hits ({len(peaks)})"
    strength = props["peak_heights"]
    attacks = np.array([refine_attack(x, (lo_f + p) * HOP) for p in peaks], dtype=float)
    period = grid_tempo(attacks / SR, strength, loop.get("bpm") or 120)
    period, phase, inl, res = fit_grid(attacks / SR, strength, period)
    res_ms = float(np.sqrt(np.average(res[inl] ** 2, weights=strength[inl])) * 1000) if inl.any() else 99.0

    # 4. IN: strong, on-grid hit nearest the current IN; OUT: whole beats later
    strong = inl & (strength >= 0.5 * strength.max())
    cand = np.where(strong)[0] if strong.any() else np.where(inl)[0]
    near = cand[np.argmin(np.abs(attacks[cand] - in0))]
    if abs(attacks[near] - in0) > period * SR:
        # nothing within a beat: use the grid line nearest IN
        sub = period / 4
        k = round((in0 / SR - phase) / sub)
        hit = (phase + k * sub) * SR
    else:
        hit = attacks[near]
    fade = (loop.get("fadeMs") or DEFAULT_FADE_MS) / 1000
    new_in = int(round(hit - fade / 2 * SR))
    beats = max(1, int(round((out0 - in0) / SR / period)))
    new_out = int(round(new_in + beats * period * SR))

    on_grid = float(inl[strength >= 0.3 * strength.max()].mean())
    # hand-played hits sit within ~10 ms of a grid; tighter than that is a clean fit
    confidence = round(on_grid * float(np.exp(-max(0.0, res_ms - 3.0) / 10.0)), 3)
    fit = {
        "track": d + 1,
        "bpm": round(60.0 / period, 3),
        "beats": beats,
        "start": new_in + stem["start"],
        "end": new_out + stem["start"],
        "confidence": confidence,
        "residualMs": round(res_ms, 2),
        "hits": int(len(peaks)),
    }
    if verbose:
        for i, (sc, det) in enumerate(zip(scores, details)):
            print(f"    t{i + 1}: score {sc:.2f} {det}")
    return fit, None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="move untouched loops to the drum-fit points")
    ap.add_argument("--only", help="analyse one loop id")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    with open(LOOPS) as f:
        db = json.load(f)

    applied = kept = failed = 0
    for loop in db["loops"]:
        if args.only and loop["id"] != args.only:
            continue
        fit, why = analyse(loop, args.verbose)
        if not fit:
            failed += 1
            print(f"{loop['id']:14s}  skipped: {why}")
            continue
        loop["drumFit"] = fit
        moved_in = (fit["start"] - loop["start"]) / SR * 1000
        moved_out = (fit["end"] - loop["end"]) / SR * 1000
        untouched = loop["start"] == loop["detected"]["start"] and loop["end"] == loop["detected"]["end"]
        # timing: "bars" = the clip is already whole bars at the tape tempo (the
        # OP-1 looped it in time); "drums" = a steady drum grid sets the points;
        # "free" = played free, so the clip points stay
        clip = loop.get("clipDetected", loop["detected"])
        bar = 240.0 / loop["bpm"]
        nbars = (clip["end"] - clip["start"]) / SR / bar
        on_bars = nbars >= 0.75 and abs(nbars - round(nbars)) * bar < 0.015
        loop["timing"] = "bars" if on_bars else "drums" if fit["confidence"] >= MIN_CONF else "free"
        tag = loop["timing"]
        if args.apply and untouched and loop["timing"] == "drums":
            loop.setdefault("clipDetected", dict(loop["detected"]))
            loop["start"], loop["end"] = fit["start"], fit["end"]
            loop["detected"] = {"start": fit["start"], "end": fit["end"]}
            applied += 1
            tag = "drums, applied"
        elif not untouched:
            kept += 1
            tag += ", kept your edit"
        print(
            f"{loop['id']:14s}  drums=t{fit['track']}  {fit['bpm']:7.2f} BPM  {fit['beats']:3d} beats  "
            f"IN {moved_in:+7.1f} ms  OUT {moved_out:+7.1f} ms  fit ±{fit['residualMs']:.1f} ms  "
            f"conf {fit['confidence']:.2f}  {tag}"
        )

    tmp = LOOPS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(db, f, indent=2)
        f.write("\n")
    os.replace(tmp, LOOPS)
    print(f"\n{applied} applied, {kept} kept your edits, {failed} skipped -> {LOOPS}", file=sys.stderr)


if __name__ == "__main__":
    main()
