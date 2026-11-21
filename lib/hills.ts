// Shared drawing for the stacked "hills": signed per-track shares stacked up
// (reinforcing) and down (cancelling) from a baseline, each band filled with a
// gradient that is faint at the baseline and rich at its outer edge. Only the
// outside of the whole stack gets a border: a soft white rim.

export function hexA(color: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export interface HillsOptions {
  xs: ArrayLike<number>;
  /** shares[t][i]: signed value at xs[i], in the same units as `scale`. */
  shares: ArrayLike<number>[];
  colors: string[];
  base: number;
  top: number;
  bot: number;
  /** pixels per unit of share */
  scale: number;
  /** brighter additive fills and a glowing magenta→cyan outer edge */
  neon?: boolean;
  /** draw the outer border (default true) */
  border?: boolean;
}

export function drawHills(g: CanvasRenderingContext2D, o: HillsOptions) {
  const n = o.xs.length;
  const accUp = new Float32Array(n);
  const accDown = new Float32Array(n);
  // Each track's positive and negative parts are separate shapes, so a band that
  // changes sign tapers to zero instead of cutting diagonally across the baseline.
  const layers: { t: number; sign: 1 | -1 }[] = [];
  for (const sign of [1, -1] as const) o.shares.forEach((_, t) => layers.push({ t, sign }));
  layers.forEach(({ t, sign }) => {
    const share = o.shares[t];
    const lo = new Float32Array(n);
    const hi = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = sign > 0 ? Math.max(0, share[i]) : Math.max(0, -share[i]);
      const acc = sign > 0 ? accUp : accDown;
      lo[i] = o.base - sign * acc[i] * o.scale;
      acc[i] += v;
      hi[i] = Math.min(o.bot, Math.max(o.top, o.base - sign * acc[i] * o.scale));
    }
    const c = o.colors[t];
    const grad = g.createLinearGradient(0, o.top, 0, o.bot);
    const baseStop = Math.min(1, Math.max(0, (o.base - o.top) / (o.bot - o.top)));
    grad.addColorStop(0, hexA(c, o.neon ? 0.95 : 0.85));
    grad.addColorStop(baseStop, hexA(c, o.neon ? 0.06 : 0.12));
    grad.addColorStop(1, hexA(c, o.neon ? 0.8 : 0.7));

    g.save();
    if (o.neon) {
      g.globalCompositeOperation = "lighter";
      g.shadowColor = hexA(c, 0.9);
      g.shadowBlur = 14;
    }
    g.fillStyle = grad;
    g.beginPath();
    for (let i = 0; i < n; i++) (i ? g.lineTo : g.moveTo).call(g, o.xs[i], hi[i]);
    for (let i = n - 1; i >= 0; i--) g.lineTo(o.xs[i], lo[i]);
    g.closePath();
    g.fill();
    g.restore();
  });

  // One border around the outside of the whole stack, broken wherever the
  // stack is flat on the baseline so it never draws a line along it.
  const edge = (stroke: () => void) => {
    for (const [acc, sign] of [[accUp, -1], [accDown, 1]] as const) {
      g.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        if (acc[i] * o.scale < 0.75) {
          pen = false;
          continue;
        }
        const y = Math.min(o.bot, Math.max(o.top, o.base + sign * acc[i] * o.scale));
        if (pen) g.lineTo(o.xs[i], y);
        else g.moveTo(o.xs[i], y);
        pen = true;
      }
      stroke();
    }
  };
  if (o.border === false) return;
  g.save();
  g.lineJoin = "round";
  g.lineCap = "round";
  if (o.neon) {
    const x0 = o.xs[0] ?? 0;
    const x1 = o.xs[n - 1] ?? 1;
    const neon = g.createLinearGradient(x0, 0, x1, 0);
    neon.addColorStop(0, "#ff3df2");
    neon.addColorStop(0.5, "#b46bff");
    neon.addColorStop(1, "#3dfcff");
    g.globalCompositeOperation = "lighter";
    // wide soft glow, then a thin hot core
    edge(() => {
      g.strokeStyle = neon;
      g.globalAlpha = 0.35;
      g.lineWidth = 6;
      g.shadowColor = "#c86bff";
      g.shadowBlur = 18;
      g.stroke();
      g.globalAlpha = 1;
      g.lineWidth = 1.5;
      g.shadowBlur = 6;
      g.stroke();
      g.strokeStyle = "rgba(255, 255, 255, 0.85)";
      g.lineWidth = 0.6;
      g.shadowBlur = 0;
      g.stroke();
    });
  } else {
    edge(() => {
      g.strokeStyle = "rgba(255, 255, 255, 0.6)";
      g.shadowColor = "rgba(255, 255, 255, 0.8)";
      g.shadowBlur = 8;
      g.lineWidth = 1.25;
      g.stroke();
    });
  }
  g.restore();
}
