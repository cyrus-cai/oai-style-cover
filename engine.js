/*
 * Editorial Cover Engine
 * Pure-code reimplementation of the openai-editorial-cover skill.
 * Nine style families, three content modes, three aspect ratios —
 * rendered deterministically with Canvas 2D. No image model involved.
 */
'use strict';
(() => {

/* ---------------- seeded randomness ---------------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const rf = (rnd, a, b) => a + (b - a) * rnd();
const ri = (rnd, a, b) => Math.floor(rf(rnd, a, b + 1));
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

/* ---------------- color utils ---------------- */

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function mix(h1, h2, t) {
  const a = hexRgb(h1), b = hexRgb(h2);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
function shade(hex, amt) { // amt -1..1
  return amt < 0 ? mix(hex, '#000000', -amt) : mix(hex, '#ffffff', amt);
}

/* ---------------- canvas utils ---------------- */

function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w));
  c.height = Math.max(2, Math.round(h));
  return c;
}

/*
 * Scratch canvases are recycled across renders: at 5K a single temp layer
 * costs ~100MB, and a style can stack five of them. Slots are handed out in
 * order within one render and reset at the next, so a layer is never reused
 * while it is still being read.
 */
const scratchPool = [];
let scratchIdx = 0;
const SCRATCH_MAX = 8;

function resetScratch() { scratchIdx = 0; }

function scratchCanvas(w, h) {
  w = Math.max(2, Math.round(w));
  h = Math.max(2, Math.round(h));
  if (scratchIdx >= SCRATCH_MAX) return mkCanvas(w, h);
  let c = scratchPool[scratchIdx];
  if (!c) {
    c = document.createElement('canvas');
    scratchPool[scratchIdx] = c;
  }
  scratchIdx++;
  const g = c.getContext('2d');
  if (c.width !== w || c.height !== h) {
    c.width = w;   // resizing also clears
    c.height = h;
  } else {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.filter = 'none';
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return c;
}

/* Render a layer at low resolution and upscale = cheap huge gaussian-ish blur. */
function softLayer(w, h, scale, draw) {
  const c = scratchCanvas(w * scale, h * scale);
  const g = c.getContext('2d');
  g.scale(c.width / w, c.height / h);
  draw(g);
  return c;
}

function paste(ctx, layer, w, h, alpha = 1, op = 'source-over') {
  // progressive upscale: one giant jump leaves blocky bilinear steps
  let src = layer;
  while (w / src.width >= 4) {
    const mid = scratchCanvas(src.width * 3, src.height * 3);
    const mg = mid.getContext('2d');
    mg.imageSmoothingEnabled = true;
    mg.imageSmoothingQuality = 'high';
    mg.drawImage(src, 0, 0, mid.width, mid.height);
    src = mid;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = op;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  ctx.restore();
}

/* True gaussian blur when the browser supports canvas filters. */
const FILTER_OK = (() => {
  try {
    const g = mkCanvas(2, 2).getContext('2d');
    g.filter = 'blur(2px)';
    return g.filter === 'blur(2px)';
  } catch (e) { return false; }
})();

/*
 * A full-resolution layer whose strokes are gaussian-blurred as drawn.
 * Fallback (no filter support): low-res render upscaled, which approximates
 * the blur at the cost of some softness precision.
 */
function blurLayer(w, h, blurPx, draw) {
  if (FILTER_OK) {
    const c = scratchCanvas(w, h);
    const g = c.getContext('2d');
    g.filter = `blur(${Math.max(0, Math.round(blurPx))}px)`;
    draw(g);
    return c;
  }
  const scale = Math.min(1, Math.max(0.03, 0.5 / Math.max(1, blurPx)));
  return softLayer(w, h, scale, draw);
}

/* Blur an existing canvas. */
function blurCanvas(src, w, h, blurPx) {
  const out = scratchCanvas(w, h);
  const og = out.getContext('2d');
  if (FILTER_OK) {
    og.filter = `blur(${Math.round(blurPx)}px)`;
    og.drawImage(src, 0, 0, w, h);
    return out;
  }
  const scale = Math.min(1, Math.max(0.03, 0.5 / Math.max(1, blurPx)));
  const mid = scratchCanvas(w * scale, h * scale);
  const mg = mid.getContext('2d');
  mg.imageSmoothingQuality = 'high';
  mg.drawImage(src, 0, 0, mid.width, mid.height);
  og.imageSmoothingQuality = 'high';
  og.drawImage(mid, 0, 0, w, h);
  return out;
}

let grainTile = null;
function grain(ctx, w, h, alpha, mode = 'overlay') {
  if (!grainTile) {
    grainTile = mkCanvas(192, 192);
    const g = grainTile.getContext('2d');
    const img = g.createImageData(192, 192);
    const nr = mulberry32(1234567);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 90 + Math.floor(nr() * 110);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  // two grain scales — fine sparkle plus a softer coarse layer — read as film
  ctx.save();
  ctx.globalCompositeOperation = mode;
  const k = Math.max(1, Math.min(w, h) / 2048);
  const pass = (scale, a) => {
    const pat = ctx.createPattern(grainTile, 'repeat');
    if (pat.setTransform) pat.setTransform(new DOMMatrix().scale(scale));
    ctx.globalAlpha = a;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, w, h);
  };
  pass(k, alpha);
  pass(k * 2.3, alpha * 0.5);
  ctx.restore();
}

function vignette(ctx, w, h, strength, color = '#000000') {
  const r = Math.hypot(w, h) / 2;
  const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.42, w / 2, h / 2, r);
  g.addColorStop(0, rgba(color, 0));
  g.addColorStop(1, rgba(color, strength));
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* Soft gradient blob field: the atmospheric base shared by most styles.
 * Gradients are inherently smooth — drawn directly at full resolution. */
function blobField(ctx, w, h, spec, rnd) {
  const grad = ctx.createLinearGradient(0, 0, spec.diag ? w : 0, h);
  grad.addColorStop(0, spec.top);
  grad.addColorStop(1, spec.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const m = Math.min(w, h);
  for (const b of spec.blobs) {
    const x = rf(rnd, b.x[0], b.x[1]) * w;
    const y = rf(rnd, b.y[0], b.y[1]) * h;
    const r = rf(rnd, b.r[0], b.r[1]) * m;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, rgba(b.c, b.a));
    gr.addColorStop(1, rgba(b.c, 0));
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, w, h);
  }
}

/* Sweeping ribbon: silky fold used by S1/S3/S6. */
function ribbonPath(g, w, h, p) {
  g.beginPath();
  g.moveTo(-0.15 * w, p.y0);
  g.bezierCurveTo(p.cx1, p.cy1, p.cx2, p.cy2, 1.15 * w, p.y1);
}
function makeRibbon(w, h, rnd, drift) {
  const y0 = rf(rnd, 0.1, 0.9) * h;
  return {
    y0,
    y1: y0 + rf(rnd, -drift, drift) * h,
    cx1: rf(rnd, 0.1, 0.45) * w,
    cy1: y0 + rf(rnd, -drift, drift) * h * 1.4,
    cx2: rf(rnd, 0.55, 0.9) * w,
    cy2: y0 + rf(rnd, -drift, drift) * h * 1.4,
  };
}
function ribbon(g, w, h, rnd, { color, alpha, width, drift }) {
  const p = makeRibbon(w, h, rnd, drift);
  g.strokeStyle = rgba(color, alpha);
  g.lineWidth = width;
  g.lineCap = 'round';
  ribbonPath(g, w, h, p);
  g.stroke();
}
/*
 * A silk fold: one wide luminous band with a shaded band hugging its lower
 * edge, so the pair reads as a soft fabric fold rather than a vector wave.
 */
function fold(g, w, h, rnd, { light, dark, alpha, width, drift }) {
  const p = makeRibbon(w, h, rnd, drift);
  g.lineCap = 'round';
  g.strokeStyle = rgba(light, alpha);
  g.lineWidth = width;
  ribbonPath(g, w, h, p);
  g.stroke();
  const off = width * 0.62;
  const q = { y0: p.y0 + off, y1: p.y1 + off, cx1: p.cx1, cy1: p.cy1 + off, cx2: p.cx2, cy2: p.cy2 + off };
  g.strokeStyle = rgba(dark, alpha * 0.7);
  g.lineWidth = width * 0.5;
  ribbonPath(g, w, h, q);
  g.stroke();
  return p;
}

/* ---------------- typography ---------------- */

const SANS = '"Helvetica Neue", Helvetica, Inter, "PingFang SC", "Hiragino Sans GB", "Segoe UI", Arial, sans-serif';

function fontStr(weight, size) {
  return `${weight} ${size}px ${SANS}`;
}

/* Manual tracked text: deterministic across browsers. */
function measureTracked(ctx, text, size, weight, tracking, stretch) {
  ctx.font = fontStr(weight, size);
  let wsum = 0;
  for (const ch of text) wsum += ctx.measureText(ch).width;
  const n = [...text].length;
  wsum += tracking * size * Math.max(0, n - 1);
  const m = ctx.measureText('Mg');
  return {
    width: wsum * stretch,
    cap: m.actualBoundingBoxAscent || size * 0.72,
  };
}

function drawTracked(ctx, text, cx, y, size, weight, tracking, stretch, color) {
  ctx.save();
  ctx.font = fontStr(weight, size);
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  const { width } = measureTracked(ctx, text, size, weight, tracking, stretch);
  ctx.translate(cx - width / 2, y);
  ctx.scale(stretch, 1);
  let x = 0;
  for (const ch of text) {
    ctx.fillText(ch, x, 0);
    x += ctx.measureText(ch).width + tracking * size;
  }
  ctx.restore();
}

function splitBalanced(text) {
  const words = text.trim().split(/\s+/);
  if (words.length < 2) {
    // CJK: split at midpoint if long
    const chars = [...text];
    if (chars.length >= 6 && /[　-鿿]/.test(text)) {
      const mid = Math.ceil(chars.length / 2);
      return [chars.slice(0, mid).join(''), chars.slice(mid).join('')];
    }
    return [text];
  }
  if (words.length === 2) return [words[0], words[1]];
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const diff = Math.abs(a.length - b.length);
    if (!best || diff < best.diff) best = { a, b, diff };
  }
  return [best.a, best.b];
}

function avgLuminance(ctx, x, y, w, h) {
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
  w = Math.max(1, Math.floor(Math.min(w, ctx.canvas.width - x)));
  h = Math.max(1, Math.floor(Math.min(h, ctx.canvas.height - y)));
  const data = ctx.getImageData(x, y, w, h).data;
  let sum = 0, rs = 0, gs = 0, bs = 0;
  const step = 16;
  let n = 0;
  for (let i = 0; i < data.length; i += 4 * step) {
    rs += data[i]; gs += data[i + 1]; bs += data[i + 2];
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    n++;
  }
  return { lum: sum / n / 255, rgb: [rs / n, gs / n, bs / n] };
}

/*
 * White-first contrast rule: flat white by default; if the zone behind the
 * title is pale, locally deepen the background with a scene-tinted veil
 * (never a hard shadow) before drawing flat white type.
 */
function contrastVeil(ctx, cx, cy, bw, bh, sample) {
  if (sample.lum < 0.62) return false;
  const [r, g, b] = sample.rgb;
  const tint = `rgba(${Math.round(r * 0.22)},${Math.round(g * 0.24)},${Math.round(b * 0.3)},1)`;
  const rad = Math.max(bw, bh) * 1.35;
  const strength = Math.min(0.5, (sample.lum - 0.55) * 1.15);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
  grad.addColorStop(0, tint.replace(',1)', `,${strength})`));
  grad.addColorStop(1, tint.replace(',1)', ',0)'));
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  ctx.restore();
  return true;
}

/*
 * Shared centered-title pipeline (L9/L10 geometry): the visible text block
 * is ink-centered horizontally, placed inside the style's vertical band,
 * inside a 7% safe area, flat white unless the style dictates dark type.
 */
function overlayTitle(ctx, w, h, rnd, text, spec) {
  const caseMode = spec.caseMode || 'upper';
  let t = text.trim();
  if (caseMode === 'upper' && !/[　-鿿]/.test(t)) t = t.toUpperCase();
  const lines = ([...t].length > (spec.splitAt || 14) && spec.maxLines !== 1) ? splitBalanced(t) : [t];
  const stretch = spec.stretch || 1;
  const tracking = spec.tracking || 0;
  const weight = spec.weight || 700;
  const targetW = (spec.widthFrac || 0.66) * w;
  const safe = 0.07;

  // fit size to the widest line
  let size = 100;
  let maxLineW = 0;
  for (const ln of lines) {
    maxLineW = Math.max(maxLineW, measureTracked(ctx, ln, size, weight, tracking, stretch).width);
  }
  size = size * (targetW / maxLineW);
  const maxH = (spec.maxHFrac || 0.2) * h;
  if (size > maxH / lines.length / 1.04) size = maxH / lines.length / 1.04;
  size = Math.min(size, w * (1 - safe * 2) / (maxLineW / 100) * 0.98);

  const lineH = size * (spec.lineHeight || 1.06);
  const cap = measureTracked(ctx, lines[0], size, weight, tracking, stretch).cap;
  const blockH = lineH * (lines.length - 1) + cap;
  const band = spec.band || [0.42, 0.56];
  let cy = rf(rnd, band[0], band[1]) * h;
  cy = Math.min(Math.max(cy, safe * h + blockH / 2), h * (1 - safe) - blockH / 2);
  const cx = w / 2;

  let bw = 0;
  for (const ln of lines) bw = Math.max(bw, measureTracked(ctx, ln, size, weight, tracking, stretch).width);

  let veiled = false;
  if (spec.color !== 'dark') {
    const sample = avgLuminance(ctx, cx - bw / 2, cy - blockH / 2, bw, blockH);
    veiled = contrastVeil(ctx, cx, cy, bw, blockH, sample);
  }

  const color = spec.color === 'dark' ? (spec.darkColor || '#16141c') : '#ffffff';
  let y = cy - blockH / 2 + cap;
  const drawn = [];
  for (const ln of lines) {
    drawTracked(ctx, ln, cx, y, size, weight, tracking, stretch, color);
    drawn.push({ line: ln, y });
    y += lineH;
  }
  return { lines, size, cx, cy, bw, blockH, veiled, capY: drawn };
}

/* ---------------- invented copy ---------------- */

/* ---------------- icon library (S5) ---------------- */
/*
 * A unified geometric set. Every glyph is stroke-only, drawn in a unit box
 * on the same grid: content lives inside [0.16, 0.84], stroke width and
 * round caps/joins are preset by the caller. No fills, no mixed weights.
 */

const ICONS = {
  spark(g) {
    g.beginPath();
    g.moveTo(0.5, 0.16);
    g.quadraticCurveTo(0.555, 0.445, 0.84, 0.5);
    g.quadraticCurveTo(0.555, 0.555, 0.5, 0.84);
    g.quadraticCurveTo(0.445, 0.555, 0.16, 0.5);
    g.quadraticCurveTo(0.445, 0.445, 0.5, 0.16);
    g.closePath();
    g.stroke();
  },
  globe(g) {
    g.beginPath(); g.arc(0.5, 0.5, 0.34, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.ellipse(0.5, 0.5, 0.15, 0.34, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(0.16, 0.5); g.lineTo(0.84, 0.5); g.stroke();
  },
  terminal(g) {
    g.beginPath(); g.moveTo(0.2, 0.3); g.lineTo(0.44, 0.5); g.lineTo(0.2, 0.7); g.stroke();
    g.beginPath(); g.moveTo(0.56, 0.7); g.lineTo(0.8, 0.7); g.stroke();
  },
  code(g) {
    g.beginPath(); g.moveTo(0.36, 0.28); g.lineTo(0.16, 0.5); g.lineTo(0.36, 0.72); g.stroke();
    g.beginPath(); g.moveTo(0.64, 0.28); g.lineTo(0.84, 0.5); g.lineTo(0.64, 0.72); g.stroke();
  },
  chat(g) {
    roundRectPath(g, 0.16, 0.2, 0.68, 0.46, 0.12); g.stroke();
    g.beginPath(); g.moveTo(0.32, 0.66); g.lineTo(0.28, 0.8); g.lineTo(0.46, 0.66); g.stroke();
  },
  bolt(g) {
    g.beginPath();
    g.moveTo(0.55, 0.16); g.lineTo(0.32, 0.54); g.lineTo(0.48, 0.54);
    g.lineTo(0.45, 0.84); g.lineTo(0.68, 0.46); g.lineTo(0.52, 0.46);
    g.closePath();
    g.stroke();
  },
  image(g) {
    roundRectPath(g, 0.16, 0.22, 0.68, 0.56, 0.08); g.stroke();
    g.beginPath(); g.arc(0.35, 0.4, 0.05, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    g.moveTo(0.22, 0.7); g.lineTo(0.42, 0.52); g.lineTo(0.56, 0.64);
    g.lineTo(0.67, 0.55); g.lineTo(0.78, 0.64);
    g.stroke();
  },
  cube(g) {
    g.beginPath();
    g.moveTo(0.5, 0.16); g.lineTo(0.8, 0.33); g.lineTo(0.8, 0.67);
    g.lineTo(0.5, 0.84); g.lineTo(0.2, 0.67); g.lineTo(0.2, 0.33);
    g.closePath();
    g.stroke();
    g.beginPath(); g.moveTo(0.2, 0.33); g.lineTo(0.5, 0.5); g.lineTo(0.8, 0.33); g.stroke();
    g.beginPath(); g.moveTo(0.5, 0.5); g.lineTo(0.5, 0.84); g.stroke();
  },
  key(g) {
    g.beginPath(); g.arc(0.28, 0.5, 0.12, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(0.4, 0.5); g.lineTo(0.84, 0.5); g.stroke();
    g.beginPath(); g.moveTo(0.66, 0.5); g.lineTo(0.66, 0.64); g.stroke();
    g.beginPath(); g.moveTo(0.8, 0.5); g.lineTo(0.8, 0.68); g.stroke();
  },
  lock(g) {
    roundRectPath(g, 0.22, 0.44, 0.56, 0.38, 0.09); g.stroke();
    g.beginPath(); g.arc(0.5, 0.44, 0.17, Math.PI, 0); g.stroke();
    g.beginPath(); g.moveTo(0.5, 0.58); g.lineTo(0.5, 0.68); g.stroke();
  },
  layers(g) {
    g.beginPath();
    g.moveTo(0.5, 0.18); g.lineTo(0.84, 0.36); g.lineTo(0.5, 0.54); g.lineTo(0.16, 0.36);
    g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(0.16, 0.5); g.lineTo(0.5, 0.68); g.lineTo(0.84, 0.5); g.stroke();
    g.beginPath(); g.moveTo(0.16, 0.64); g.lineTo(0.5, 0.82); g.lineTo(0.84, 0.64); g.stroke();
  },
  graph(g) {
    g.beginPath(); g.moveTo(0.18, 0.8); g.lineTo(0.18, 0.2); g.stroke();
    g.beginPath(); g.moveTo(0.18, 0.8); g.lineTo(0.84, 0.8); g.stroke();
    g.beginPath();
    g.moveTo(0.28, 0.66); g.lineTo(0.45, 0.46); g.lineTo(0.6, 0.56); g.lineTo(0.8, 0.28);
    g.stroke();
  },
  search(g) {
    g.beginPath(); g.arc(0.45, 0.45, 0.24, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(0.63, 0.63); g.lineTo(0.83, 0.83); g.stroke();
  },
  branch(g) {
    g.beginPath(); g.arc(0.28, 0.24, 0.1, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(0.28, 0.78, 0.1, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(0.74, 0.5, 0.1, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(0.28, 0.34); g.lineTo(0.28, 0.68); g.stroke();
    g.beginPath(); g.moveTo(0.28, 0.5); g.lineTo(0.64, 0.5); g.stroke();
  },
  share(g) {
    g.beginPath(); g.arc(0.26, 0.5, 0.1, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(0.74, 0.26, 0.1, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(0.74, 0.74, 0.1, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(0.35, 0.455); g.lineTo(0.65, 0.305); g.stroke();
    g.beginPath(); g.moveTo(0.35, 0.545); g.lineTo(0.65, 0.695); g.stroke();
  },
};

/* ---------------- asset compositing (layout rules L1/L2/L3/L7/L8) ---------------- */

function drawAssetCard(ctx, img, x, y, dw, dh, radius) {
  ctx.save();
  ctx.shadowColor = 'rgba(8,16,32,0.28)';
  ctx.shadowBlur = dw * 0.05;
  ctx.shadowOffsetY = dw * 0.012;
  roundRectPath(ctx, x, y, dw, dh, radius);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRectPath(ctx, x, y, dw, dh, radius);
  ctx.clip();
  ctx.drawImage(img, x, y, dw, dh);
  ctx.restore();
  ctx.save();
  roundRectPath(ctx, x, y, dw, dh, radius);
  ctx.strokeStyle = 'rgba(10,16,30,0.14)';
  ctx.lineWidth = Math.max(1, dw * 0.0022);
  ctx.stroke();
  ctx.restore();
}

function drawAsset(ctx, w, h, rnd, o, hasTitle) {
  const img = o.assetImg;
  if (!img) return null;
  const ar = img.width / img.height;
  const landscape = w / h > 1.2, portrait = h / w > 1.15;

  if (o.assetKind === 'logo') {
    // L7 partner lockup: white silhouette (or original colors), optically centered.
    const capH = h * (landscape ? 0.16 : 0.14);
    const lw = capH * ar;
    const cx = w / 2, cy = h * 0.5;
    let mark = img;
    if (!o.assetKeepColor) {
      const m = mkCanvas(img.width, img.height);
      const mg = m.getContext('2d');
      mg.drawImage(img, 0, 0);
      mg.globalCompositeOperation = 'source-in';
      mg.fillStyle = '#ffffff';
      mg.fillRect(0, 0, m.width, m.height);
      mark = m;
    }
    ctx.drawImage(mark, cx - lw / 2, cy - capH / 2, lw, capH);
    return 'L7 partner-lockup';
  }

  if (o.assetKind === 'photo') {
    // L8 artwork hero crop: fill most of the frame, crop into edges.
    const frac = rf(rnd, 0.78, 0.9);
    let dw = w * frac, dh = dw / ar;
    if (dh < h * 0.62) { dh = h * rf(rnd, 0.7, 0.85); dw = dh * ar; }
    const x = w - dw * rf(rnd, 0.82, 0.95);
    const y = h - dh * rf(rnd, 0.8, 0.92);
    drawAssetCard(ctx, img, x, y, dw, dh, w * 0.012);
    return 'L8 artwork-hero-crop';
  }

  // UI screenshots: pick by geometry.
  const r = w * 0.018;
  if (ar <= 1 / 1.35) {
    // L1 narrow: centered, bottom clipped.
    let dw = w * (portrait ? 0.62 : 0.56);
    let dh = dw / ar;
    const top = (hasTitle ? 0.34 : rf(rnd, 0.1, 0.18)) * h;
    if (top + dh < h * 1.08) dh = h * 1.1 - top, dw = dh * ar;
    drawAssetCard(ctx, img, (w - dw) / 2, top, dw, dh, r);
    return 'L1 ui-narrow-center-bottom-crop';
  }
  if (ar >= 1.35) {
    // L2 wide: near full width, clip one side + bottom.
    const dw = w * rf(rnd, 0.92, 1.08);
    const dh = dw / ar;
    const left = rnd() < 0.5;
    const x = left ? -dw * rf(rnd, 0.08, 0.16) : w - dw * rf(rnd, 0.84, 0.92);
    const y = h - dh * rf(rnd, 0.76, 0.9);
    drawAssetCard(ctx, img, x, y, dw, dh, r);
    return 'L2 ui-wide-side-crop';
  }
  // L3 square-ish: large, lower crop.
  const dw = w * (landscape ? 0.6 : 0.76);
  const dh = dw / ar;
  const top = (hasTitle ? 0.32 : rf(rnd, 0.24, 0.34)) * h;
  drawAssetCard(ctx, img, (w - dw) / 2, top, dw, dh, r);
  return 'L3 ui-square-lower-crop';
}

/* ---------------- S8 procedural macro subjects ---------------- */

const MATERIALS = {
  wood:   { deep: '#1c110a', dark: '#33200f', mid: '#6b4423', lit: '#a9713d', hi: '#dca470' },
  moss:   { deep: '#0b1408', dark: '#1e3312', mid: '#42611f', lit: '#71903a', hi: '#b4c96a' },
  slate:  { deep: '#0a0e14', dark: '#1d2733', mid: '#43566b', lit: '#728aa1', hi: '#b3c4d4' },
  copper: { deep: '#160a05', dark: '#3d1c0d', mid: '#8a4520', lit: '#c1712f', hi: '#eaa960' },
  paper:  { deep: '#4a4136', dark: '#8a7d6a', mid: '#cfc4ae', lit: '#e9e0cc', hi: '#f8f2e4' },
  linen:  { deep: '#2c2318', dark: '#57472e', mid: '#8d7852', lit: '#b7a173', hi: '#e2cfa4' },
};

function macroPhyllotaxis(g, w, h, rnd, mat) {
  const m = Math.min(w, h);
  const cx = w * rf(rnd, 0.4, 0.6), cy = h * rf(rnd, 0.36, 0.52);
  const maxR = Math.hypot(w, h) * 0.62;
  const N = 540;
  const golden = 2.39996323;
  const rot = rf(rnd, 0, Math.PI * 2);
  const lightA = rf(rnd, -2.4, -1.2); // light from upper-left-ish
  g.fillStyle = mat.deep;
  g.fillRect(0, 0, w, h);
  for (let i = N - 1; i >= 0; i--) {
    const r = maxR * Math.sqrt((i + 0.5) / N);
    const th = i * golden + rot;
    const x = cx + r * Math.cos(th);
    const y = cy + r * Math.sin(th) * 0.94;
    if (x < -m * 0.2 || x > w + m * 0.2 || y < -m * 0.2 || y > h + m * 0.2) continue;
    const s = m * 0.052 + r * 0.16;
    const lit = 0.62 + 0.38 * Math.cos(th - lightA);
    const jitter = rf(rnd, -0.08, 0.08);
    g.save();
    g.translate(x, y);
    g.rotate(th + Math.PI / 2 + jitter);
    const grad = g.createLinearGradient(0, s * 0.35, 0, -s * 0.95);
    grad.addColorStop(0, mix(mat.deep, mat.dark, lit * 0.5));
    grad.addColorStop(0.55, mix(mat.dark, mat.mid, lit));
    grad.addColorStop(1, mix(mat.mid, mat.hi, lit * lit));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-s * 0.44, s * 0.16);
    g.quadraticCurveTo(-s * 0.4, -s * 0.5, 0, -s * 0.95);
    g.quadraticCurveTo(s * 0.4, -s * 0.5, s * 0.44, s * 0.16);
    g.quadraticCurveTo(0, s * 0.4, -s * 0.44, s * 0.16);
    g.closePath();
    g.fill();
    g.strokeStyle = rgba(mat.deep, 0.5);
    g.lineWidth = s * 0.035;
    g.stroke();
    // lit tip edge
    g.strokeStyle = rgba(mat.hi, 0.28 * lit);
    g.lineWidth = s * 0.05;
    g.beginPath();
    g.moveTo(-s * 0.3, -s * 0.42);
    g.quadraticCurveTo(0, -s * 0.9, s * 0.3, -s * 0.42);
    g.stroke();
    // fibre striations along the scale axis
    g.strokeStyle = rgba(mat.deep, 0.16);
    g.lineWidth = s * 0.022;
    for (let k = -1; k <= 1; k++) {
      g.beginPath();
      g.moveTo(k * s * 0.16, s * 0.08);
      g.quadraticCurveTo(k * s * 0.2, -s * 0.3, k * s * 0.08, -s * 0.72);
      g.stroke();
    }
    g.restore();
  }
}

function macroStrata(g, w, h, rnd, mat) {
  const rot = rf(rnd, -0.2, 0.2);
  g.fillStyle = mat.dark;
  g.fillRect(0, 0, w, h);
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate(rot);
  g.translate(-w / 2, -h / 2);
  const pad = Math.max(w, h) * 0.35;
  let y = -pad;
  while (y < h + pad) {
    const rowH = h * rf(rnd, 0.055, 0.11);
    const phase = rf(rnd, 0, Math.PI * 2);
    const freq = rf(rnd, 0.7, 1.5);
    const waveA = rowH * rf(rnd, 0.12, 0.3);
    const tone = rf(rnd, 0, 1);
    const base = mix(mix(mat.lit, mat.mid, tone * 0.8), mat.hi, rf(rnd, 0, 0.3));
    const edge = y + rowH * 0.5;
    const edgeAt = x => edge + Math.sin((x / w) * Math.PI * freq + phase) * waveA;
    // sheet face
    g.beginPath();
    g.moveTo(-pad, edgeAt(-pad));
    for (let x = -pad; x <= w + pad; x += w / 36) g.lineTo(x, edgeAt(x));
    g.lineTo(w + pad, h + pad);
    g.lineTo(-pad, h + pad);
    g.closePath();
    g.fillStyle = base;
    g.fill();
    // deep occlusion just under the edge, fading down the face
    g.save();
    g.clip();
    const sh = g.createLinearGradient(0, edge, 0, edge + rowH * 1.4);
    sh.addColorStop(0, rgba(mat.deep, 0.72));
    sh.addColorStop(0.45, rgba(mat.deep, 0.2));
    sh.addColorStop(1, rgba(mat.deep, 0));
    g.fillStyle = sh;
    g.fillRect(-pad, edge - rowH, w + pad * 2, rowH * 3);
    g.restore();
    // bright paper rim
    g.beginPath();
    for (let x = -pad; x <= w + pad; x += w / 36) {
      x === -pad ? g.moveTo(x, edgeAt(x)) : g.lineTo(x, edgeAt(x));
    }
    g.strokeStyle = rgba(mat.hi, 0.8);
    g.lineWidth = h * rf(rnd, 0.004, 0.007);
    g.stroke();
    y += rowH;
  }
  g.restore();
}

function macroFins(g, w, h, rnd, mat) {
  const rot = rf(rnd, -0.1, 0.1);
  g.fillStyle = mat.deep;
  g.fillRect(0, 0, w, h);
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate(rot);
  g.translate(-w / 2, -h / 2);
  const finW = w * rf(rnd, 0.075, 0.105);
  const gap = finW * rf(rnd, 0.14, 0.22);
  const pad = Math.max(w, h) * 0.25;
  for (let x = -pad; x < w + pad; x += finW + gap) {
    const grad = g.createLinearGradient(x, 0, x + finW, 0);
    grad.addColorStop(0, mat.dark);
    grad.addColorStop(0.32, mat.mid);
    grad.addColorStop(0.5, mat.lit);
    grad.addColorStop(0.62, mat.mid);
    grad.addColorStop(1, mat.deep);
    g.fillStyle = grad;
    roundRectPath(g, x, -pad, finW, h + pad * 2, finW * 0.24);
    g.fill();
    // specular streak with soft edges
    const spec = g.createLinearGradient(x + finW * 0.34, 0, x + finW * 0.58, 0);
    const sa = rf(rnd, 0.18, 0.32);
    spec.addColorStop(0, rgba(mat.hi, 0));
    spec.addColorStop(0.5, rgba(mat.hi, sa));
    spec.addColorStop(1, rgba(mat.hi, 0));
    g.fillStyle = spec;
    g.fillRect(x + finW * 0.34, -pad, finW * 0.24, h + pad * 2);
    // gap shadow
    g.fillStyle = rgba('#000000', 0.5);
    g.fillRect(x + finW, -pad, gap, h + pad * 2);
  }
  // brushed-metal texture: broken micro-streaks with varied tone
  for (let i = 0; i < 320; i++) {
    const y = rf(rnd, 0, 1) * h;
    const x = rf(rnd, -0.1, 1.0) * w;
    const len = w * rf(rnd, 0.03, 0.2);
    const light = rnd() < 0.6;
    g.strokeStyle = rgba(light ? mat.hi : mat.deep, rf(rnd, 0.03, 0.09));
    g.lineWidth = Math.max(1, h * rf(rnd, 0.0006, 0.0014));
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y); g.stroke();
  }
  g.restore();
}

function macroWeave(g, w, h, rnd, mat) {
  const rot = rf(rnd, -0.12, 0.12);
  g.fillStyle = mat.deep;
  g.fillRect(0, 0, w, h);
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate(rot);
  g.translate(-w / 2, -h / 2);
  const bw = w * rf(rnd, 0.1, 0.14);   // band width
  const gap = bw * rf(rnd, 0.1, 0.18);
  const step = bw + gap;
  const pad = Math.max(w, h) * 0.3;
  const bandFill = (x0, y0, x1, y1, horiz) => {
    // per-segment lightness jitter keeps the weave from reading machine-perfect
    const t = rf(rnd, -0.14, 0.14);
    const lit = t < 0 ? mix(mat.lit, mat.mid, -t * 2.2) : mix(mat.lit, mat.hi, t * 2.2);
    const grad = horiz
      ? g.createLinearGradient(0, y0, 0, y1)
      : g.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, mat.dark);
    grad.addColorStop(0.3, mix(mat.mid, lit, 0.25));
    grad.addColorStop(0.5, lit);
    grad.addColorStop(0.7, mix(mat.mid, lit, 0.25));
    grad.addColorStop(1, mat.dark);
    return grad;
  };
  const fibres = (x, y, ww, hh, horiz) => {
    g.save();
    g.beginPath();
    g.rect(x, y, ww, hh);
    g.clip();
    g.strokeStyle = rgba(mat.hi, 0.09);
    g.lineWidth = Math.max(1, h * 0.001);
    const n = 7;
    for (let k = 1; k < n; k++) {
      g.beginPath();
      if (horiz) { g.moveTo(x, y + (hh * k) / n); g.lineTo(x + ww, y + (hh * k) / n); }
      else { g.moveTo(x + (ww * k) / n, y); g.lineTo(x + (ww * k) / n, y + hh); }
      g.stroke();
    }
    g.restore();
  };
  // pass 1: horizontal bands
  for (let y = -pad; y < h + pad; y += step) {
    g.fillStyle = bandFill(0, y, 0, y + bw, true);
    roundRectPath(g, -pad, y, w + pad * 2, bw, bw * 0.18);
    g.fill();
    fibres(-pad, y, w + pad * 2, bw, true);
  }
  // pass 2: vertical bands over them
  for (let x = -pad; x < w + pad; x += step) {
    g.fillStyle = bandFill(x, 0, x + bw, 0, false);
    roundRectPath(g, x, -pad, bw, h + pad * 2, bw * 0.18);
    g.fill();
    fibres(x, -pad, bw, h + pad * 2, false);
  }
  // pass 3: alternate intersections woven back over + occlusion shadows
  let iy = 0;
  for (let y = -pad; y < h + pad; y += step, iy++) {
    let ix = 0;
    for (let x = -pad; x < w + pad; x += step, ix++) {
      if ((ix + iy) % 2 === 0) continue;
      g.save();
      g.beginPath();
      g.rect(x - gap, y, bw + gap * 2, bw);
      g.clip();
      g.fillStyle = bandFill(0, y, 0, y + bw, true);
      roundRectPath(g, x - step, y, bw + step * 2, bw, bw * 0.18);
      g.fill();
      fibres(x - gap, y, bw + gap * 2, bw, true);
      // shadow where the horizontal band dives under its neighbours
      const shL = g.createLinearGradient(x - gap, 0, x + bw * 0.3, 0);
      shL.addColorStop(0, rgba(mat.deep, 0.65));
      shL.addColorStop(1, rgba(mat.deep, 0));
      g.fillStyle = shL;
      g.fillRect(x - gap, y, bw * 0.3 + gap, bw);
      const shR = g.createLinearGradient(x + bw + gap, 0, x + bw * 0.7, 0);
      shR.addColorStop(0, rgba(mat.deep, 0.65));
      shR.addColorStop(1, rgba(mat.deep, 0));
      g.fillStyle = shR;
      g.fillRect(x + bw * 0.7, y, bw * 0.3 + gap, bw);
      g.restore();
    }
  }
  g.restore();
}

/* The subject follows the seed alone: shuffling asks for a new one, writing
 * a title must not silently swap the photograph under the words. */
function pickS8Subject(o, rnd) {
  return pick(rnd, ['phyllo', 'strata', 'fins', 'weave', 'rope', 'ripple']);
}

/* Braided cord: three strands crossing over one another, the plainest
 * physical picture of things holding together. */
function macroRope(g, w, h, rnd, mat) {
  const rot = rf(rnd, -0.5, 0.5);
  g.fillStyle = mat.deep;
  g.fillRect(0, 0, w, h);
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate(rot);
  g.translate(-w / 2, -h / 2);
  const pad = Math.max(w, h) * 0.4;
  const ropeW = h * rf(rnd, 0.26, 0.38);
  const step = ropeW * 0.52;             // pitch of the braid
  const bulge = ropeW * 0.62;
  for (let cy = -pad; cy < h + pad; cy += ropeW * 1.02) {
    let i = 0;
    for (let x = -pad; x < w + pad; x += step, i++) {
      const lean = (i % 2 ? 1 : -1);
      const yOff = lean * ropeW * 0.16;
      g.save();
      g.translate(x, cy + yOff);
      g.rotate(lean * 0.62);
      const grad = g.createLinearGradient(0, -bulge * 0.5, 0, bulge * 0.5);
      const t = rf(rnd, -0.1, 0.1);
      grad.addColorStop(0, mix(mat.dark, mat.deep, 0.4));
      grad.addColorStop(0.34, mix(mat.mid, mat.lit, 0.4 + t));
      grad.addColorStop(0.5, mix(mat.lit, mat.hi, 0.45 + t));
      grad.addColorStop(0.68, mat.mid);
      grad.addColorStop(1, mat.deep);
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(0, 0, step * 0.86, bulge * 0.5, 0, 0, Math.PI * 2);
      g.fill();
      // the crossing edge that reads as one strand tucking under the next
      g.strokeStyle = rgba(mat.deep, 0.55);
      g.lineWidth = ropeW * 0.035;
      g.stroke();
      // fibre twist along the strand
      g.strokeStyle = rgba(mat.hi, 0.14);
      g.lineWidth = ropeW * 0.018;
      for (let k = -2; k <= 2; k++) {
        g.beginPath();
        g.moveTo(-step * 0.7, k * bulge * 0.13);
        g.quadraticCurveTo(0, k * bulge * 0.13 - bulge * 0.06, step * 0.7, k * bulge * 0.13);
        g.stroke();
      }
      g.restore();
    }
  }
  g.restore();
}

/* Still water taking a touch: rings spreading from one point. */
function macroRipple(g, w, h, rnd, mat) {
  const cx = w * rf(rnd, 0.32, 0.68), cy = h * rf(rnd, 0.3, 0.62);
  const base = g.createLinearGradient(0, 0, w * 0.4, h);
  base.addColorStop(0, mat.mid);
  base.addColorStop(0.55, mat.dark);
  base.addColorStop(1, mat.deep);
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const maxR = Math.hypot(w, h) * 0.78;
  const pitch = Math.min(w, h) * rf(rnd, 0.055, 0.085);
  const lightA = rf(rnd, -2.6, -1.4);
  for (let r = maxR; r > pitch * 0.6; r -= pitch) {
    const k = 1 - r / maxR;                 // rings sharpen towards the centre
    const band = pitch * (0.42 + k * 0.2);
    g.save();
    g.translate(cx, cy);
    g.scale(1, 0.82);                        // seen at a slight angle
    // trough
    g.strokeStyle = rgba(mat.deep, 0.4 + k * 0.25);
    g.lineWidth = band;
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
    // crest, lit from one side only
    const crest = g.createLinearGradient(-r, -r, r, r);
    const lx = Math.cos(lightA), ly = Math.sin(lightA);
    crest.addColorStop(0, rgba(mat.hi, lx < 0 ? 0.5 + k * 0.4 : 0.08));
    crest.addColorStop(0.5, rgba(mat.lit, 0.3 + k * 0.3));
    crest.addColorStop(1, rgba(mat.hi, lx < 0 ? 0.08 : 0.45 + k * 0.4));
    g.strokeStyle = crest;
    g.lineWidth = band * 0.5;
    g.beginPath(); g.arc(0, 0, r - band * 0.45, 0, Math.PI * 2); g.stroke();
    g.restore();
  }
  // the point of contact
  const spot = g.createRadialGradient(cx, cy, 0, cx, cy, pitch * 2.2);
  spot.addColorStop(0, rgba(mat.hi, 0.5));
  spot.addColorStop(1, rgba(mat.hi, 0));
  g.fillStyle = spot;
  g.fillRect(0, 0, w, h);
}

const S8_BRIDGES = {
  phyllo: { zh: '叶序螺旋:简单规则堆叠出复杂秩序', mats: ['wood', 'moss', 'copper'] },
  strata: { zh: '层叠纸页:知识与记忆的分层堆积', mats: ['paper', 'paper', 'slate'] },
  fins:   { zh: '散热鳍片:承载算力的物理基础设施', mats: ['slate', 'copper'] },
  weave:  { zh: '织物交织:系统之间的互联与协作', mats: ['linen', 'linen', 'copper'] },
  rope:   { zh: '编绳:各自独立的股缠成一根承重的绳', mats: ['linen', 'wood', 'copper'] },
  ripple: { zh: '水面涟漪:一次触碰向外传播', mats: ['slate', 'slate', 'moss'] },
};

/* ---------------- style renderers ---------------- */

const STYLES = {
  S1: {
    id: 'S1', name: 'cool-optical', zh: '冷色光学', group: 'soft_light',
    render(ctx, w, h, rnd, o) {
      // three colour moods of the same optical family
      const moods = [
        { name: 'cobalt', top: '#a9c9ec', bottom: '#3f6cc8', pale: '#eaf3fb', cool: '#57bdf0',
          deep: '#0f2fae', extra: '#c4ecd9', tint: '#f3e9f6', foldDark: '#3a60c8', crease: '#4a6fd0' },
        { name: 'dusk', top: '#8a90d4', bottom: '#20266e', pale: '#e4e2f8', cool: '#7a8ae8',
          deep: '#241a8c', extra: '#b8a8ec', tint: '#e8c8e0', foldDark: '#443cb0', crease: '#6a62d0' },
        { name: 'glacier', top: '#d8eaf6', bottom: '#84b2dc', pale: '#f6fbfe', cool: '#a4dcf2',
          deep: '#3a78c8', extra: '#cfeee2', tint: '#e8eef8', foldDark: '#7aa2d0', crease: '#8ab2dc' },
      ];
      const mood = pick(rnd, moods);
      blobField(ctx, w, h, {
        top: mood.top, bottom: mood.bottom, diag: true,
        blobs: [
          { c: mood.pale, a: 0.95, x: [0.5, 0.85], y: [0.05, 0.35], r: [0.5, 0.8] },
          { c: mood.cool, a: 0.8, x: [0.0, 0.3], y: [0.1, 0.5], r: [0.4, 0.7] },
          { c: mood.deep, a: 0.9, x: [0.7, 1.0], y: [0.7, 1.0], r: [0.45, 0.75] },
          { c: mood.extra, a: 0.5, x: [0.1, 0.4], y: [0.6, 0.9], r: [0.2, 0.4] },
          { c: mood.tint, a: 0.4, x: [0.3, 0.6], y: [0.3, 0.6], r: [0.25, 0.45] },
        ],
      }, rnd);
      const m1 = Math.min(w, h);
      /* Two ways cool light behaves: gathered into silk folds, or thrown
       * through moving water as a caustic web. */
      const figure = rnd() < 0.34 ? 'caustic' : 'folds';
      if (figure === 'caustic') {
        const ang = rf(rnd, -0.5, 0.5);
        const web = (g, n, wide, alpha) => {
          g.globalCompositeOperation = 'lighter';
          g.lineCap = 'round';
          g.translate(w / 2, h / 2);
          g.rotate(ang);
          g.translate(-w / 2, -h / 2);
          for (let i = 0; i < n; i++) {
            const y0 = rf(rnd, -0.2, 1.2) * h;
            const amp = h * rf(rnd, 0.04, 0.13);
            const freq = rf(rnd, 1.4, 3.2);
            const phase = rf(rnd, 0, Math.PI * 2);
            const grad = g.createLinearGradient(0, 0, w, 0);
            grad.addColorStop(0, rgba('#ffffff', 0));
            grad.addColorStop(rf(rnd, 0.3, 0.6), rgba(mood.pale, alpha));
            grad.addColorStop(1, rgba('#ffffff', 0));
            g.strokeStyle = grad;
            g.lineWidth = h * wide;
            g.beginPath();
            for (let x = -0.1 * w; x <= 1.1 * w; x += w / 44) {
              const y = y0 + Math.sin((x / w) * Math.PI * freq + phase) * amp
                          + Math.sin((x / w) * Math.PI * freq * 2.7 + phase * 1.7) * amp * 0.35;
              x === -0.1 * w ? g.moveTo(x, y) : g.lineTo(x, y);
            }
            g.stroke();
          }
        };
        paste(ctx, blurLayer(w, h, m1 * 0.05, g => web(g, 16, 0.05, 0.5)), w, h);
        paste(ctx, blurLayer(w, h, m1 * 0.012, g => web(g, 22, 0.012, 0.55)), w, h);
        paste(ctx, blurLayer(w, h, m1 * 0.002, g => web(g, 26, 0.0035, 0.7)), w, h);
        vignette(ctx, w, h, 0.2, mood.deep);
        grain(ctx, w, h, 0.045);
        return { layout: `optical caustics (${mood.name})`, title: { band: [0.42, 0.55], weight: 600, tracking: 0.04, widthFrac: 0.6 } };
      }
      // silky folds: broad melted bands, then one visible fold pair + crease
      const foldN = ri(rnd, 3, 5);
      paste(ctx, blurLayer(w, h, m1 * 0.06, g => {
        for (let i = 0; i < foldN; i++) {
          fold(g, w, h, rnd, { light: '#ffffff', dark: mood.foldDark, alpha: 0.35, width: rf(rnd, 0.2, 0.34) * h, drift: 0.4 });
        }
      }), w, h);
      paste(ctx, blurLayer(w, h, m1 * 0.024, g => {
        fold(g, w, h, rnd, { light: '#f2f8ff', dark: mood.foldDark, alpha: 0.4, width: rf(rnd, 0.1, 0.16) * h, drift: 0.35 });
        ribbon(g, w, h, rnd, { color: mood.cool, alpha: 0.3, width: rf(rnd, 0.08, 0.14) * h, drift: 0.3 });
      }), w, h);
      const creaseN = ri(rnd, 1, 2);
      for (let c = 0; c < creaseN; c++) {
        let creasePath;
        paste(ctx, blurLayer(w, h, m1 * 0.008, g => {
          creasePath = fold(g, w, h, rnd, { light: '#ffffff', dark: mood.crease, alpha: c === 0 ? 0.3 : 0.2, width: rf(rnd, 0.05, 0.08) * h, drift: 0.3 });
        }), w, h);
        // crease highlight riding the fold edge, nearly crisp
        paste(ctx, blurLayer(w, h, m1 * 0.0015, g => {
          g.strokeStyle = `rgba(255,255,255,${c === 0 ? 0.55 : 0.35})`;
          g.lineWidth = rf(rnd, 0.004, 0.008) * h;
          g.lineCap = 'round';
          ribbonPath(g, w, h, creasePath);
          g.stroke();
        }), w, h);
      }
      // broad diagonal light sweep, direction varies
      const flip = rnd() < 0.4;
      const sweep = ctx.createLinearGradient(flip ? w : 0, 0, flip ? 0 : w, h);
      sweep.addColorStop(0, 'rgba(255,255,255,0)');
      sweep.addColorStop(rf(rnd, 0.35, 0.55), 'rgba(255,255,255,0.16)');
      sweep.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sweep;
      ctx.fillRect(0, 0, w, h);
      // anisotropic silk sheen: faint parallel micro-streaks along one angle
      paste(ctx, blurLayer(w, h, m1 * 0.0025, g => {
        g.save();
        g.translate(w / 2, h / 2);
        g.rotate(rf(rnd, -0.5, -0.15));
        for (let i = 0; i < 36; i++) {
          const sy = rf(rnd, -0.7, 0.7) * h;
          const gr2 = g.createLinearGradient(-w, 0, w, 0);
          gr2.addColorStop(0, 'rgba(255,255,255,0)');
          gr2.addColorStop(rf(rnd, 0.3, 0.7), `rgba(255,255,255,${rf(rnd, 0.04, 0.1).toFixed(3)})`);
          gr2.addColorStop(1, 'rgba(255,255,255,0)');
          g.strokeStyle = gr2;
          g.lineWidth = h * rf(rnd, 0.0008, 0.002);
          g.beginPath();
          g.moveTo(-w, sy);
          g.lineTo(w, sy + rf(rnd, -0.02, 0.02) * h);
          g.stroke();
        }
        g.restore();
      }), w, h, 1, 'overlay');
      grain(ctx, w, h, 0.045);
      return { layout: `atmospheric field (${mood.name})`, title: { band: [0.42, 0.55], weight: 600, tracking: 0.04, widthFrac: 0.6 } };
    },
  },

  S2: {
    id: 'S2', name: 'organic-bloom', zh: '有机花卉', group: 'soft_light',
    render(ctx, w, h, rnd, o) {
      const palettes = [
        { name: 'butter', base: '#f7ecd4', deep: '#f0a86e', c1: '#f6d488', c2: '#f2b0be', hi: '#fdf6e8' },
        { name: 'teal', base: '#dff2ea', deep: '#177a72', c1: '#8adcc3', c2: '#5cbccc', hi: '#f0faf5' },
        { name: 'coral', base: '#fbe8e0', deep: '#e86a5a', c1: '#f8b8a0', c2: '#f5c8d8', hi: '#fef4ee' },
        { name: 'iris', base: '#eae6f6', deep: '#8a7ad0', c1: '#c4b8ec', c2: '#a8c4ec', hi: '#f8f6fd' },
      ];
      const pal = pick(rnd, palettes);
      blobField(ctx, w, h, {
        top: pal.base, bottom: mix(pal.base, pal.deep, 0.55),
        blobs: [
          { c: pal.c1, a: 0.85, x: [0.1, 0.5], y: [0.1, 0.5], r: [0.4, 0.7] },
          { c: pal.c2, a: 0.7, x: [0.5, 0.9], y: [0.4, 0.8], r: [0.35, 0.6] },
          { c: pal.hi, a: 0.8, x: [0.4, 0.7], y: [0.0, 0.3], r: [0.3, 0.55] },
        ],
      }, rnd);
      const m = Math.min(w, h);
      const petalAt = (g, px, py, ang, len, wd, t) => {
        g.save();
        g.translate(px, py);
        g.rotate(ang);
        const grad = g.createLinearGradient(0, 0, 0, -len);
        grad.addColorStop(0, rgba(mix(pal.deep, pal.c1, t), 0.85));
        grad.addColorStop(0.7, rgba(pal.c2, 0.75));
        grad.addColorStop(1, rgba(pal.hi, 0.95));
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(0, 0);
        g.bezierCurveTo(-wd, -len * 0.3, -wd * 0.7, -len * 0.85, 0, -len);
        g.bezierCurveTo(wd * 0.7, -len * 0.85, wd, -len * 0.3, 0, 0);
        g.closePath();
        g.fill();
        g.restore();
      };
      // three bloom figures: rising fan, frontal bloom, drifting petals
      const form = pick(rnd, ['fan', 'bloom', 'drift']);
      let hx, hy;
      if (form === 'fan') {
        const ox = w * rf(rnd, 0.3, 0.7), oy = h * rf(rnd, 0.62, 0.85);
        paste(ctx, blurLayer(w, h, m * 0.032, g => {
          for (let i = 0; i < 6; i++) petalAt(g, ox, oy, rf(rnd, -2.4, 0.6), m * rf(rnd, 0.7, 1.05), m * rf(rnd, 0.22, 0.34), rnd());
        }), w, h, 0.9);
        paste(ctx, blurLayer(w, h, m * 0.011, g => {
          for (let i = 0; i < 4; i++) petalAt(g, ox, oy, rf(rnd, -2.2, 0.4), m * rf(rnd, 0.55, 0.85), m * rf(rnd, 0.16, 0.26), rnd());
        }), w, h);
        paste(ctx, blurLayer(w, h, m * 0.004, g => {
          petalAt(g, ox, oy, rf(rnd, -1.9, 0.1), m * rf(rnd, 0.45, 0.7), m * rf(rnd, 0.13, 0.2), rnd());
        }), w, h);
        hx = ox + Math.sin(rf(rnd, -1.6, 0)) * m * 0.3;
        hy = oy - m * rf(rnd, 0.35, 0.55);
      } else if (form === 'bloom') {
        // frontal flower: petals around one off-centre heart
        const cx = w * rf(rnd, 0.35, 0.65), cy = h * rf(rnd, 0.35, 0.6);
        const n = ri(rnd, 8, 12);
        const rot = rf(rnd, 0, Math.PI * 2);
        paste(ctx, blurLayer(w, h, m * 0.026, g => {
          for (let i = 0; i < n; i++) {
            const a = rot + (i / n) * Math.PI * 2 + rf(rnd, -0.1, 0.1);
            petalAt(g, cx, cy, a, m * rf(rnd, 0.5, 0.72), m * rf(rnd, 0.16, 0.24), rnd());
          }
        }), w, h, 0.92);
        paste(ctx, blurLayer(w, h, m * 0.008, g => {
          for (let i = 0; i < Math.floor(n / 2); i++) {
            const a = rot + ((i * 2 + 0.5) / n) * Math.PI * 2 + rf(rnd, -0.12, 0.12);
            petalAt(g, cx, cy, a, m * rf(rnd, 0.32, 0.5), m * rf(rnd, 0.11, 0.17), rnd());
          }
          // luminous heart
          const gr = g.createRadialGradient(cx, cy, 0, cx, cy, m * 0.14);
          gr.addColorStop(0, rgba(pal.hi, 0.95));
          gr.addColorStop(1, rgba(pal.hi, 0));
          g.fillStyle = gr;
          g.fillRect(0, 0, w, h);
        }), w, h);
        hx = cx; hy = cy - m * 0.05;
      } else {
        // drifting petals along one diagonal flow
        const flow = rf(rnd, -0.5, 0.5);
        paste(ctx, blurLayer(w, h, m * 0.04, g => {
          for (let i = 0; i < 4; i++) {
            petalAt(g, w * rf(rnd, 0.1, 0.9), h * rf(rnd, 0.2, 1.0), flow + rf(rnd, -0.35, 0.35), m * rf(rnd, 0.55, 0.85), m * rf(rnd, 0.2, 0.3), rnd());
          }
        }), w, h, 0.85);
        paste(ctx, blurLayer(w, h, m * 0.012, g => {
          for (let i = 0; i < 4; i++) {
            petalAt(g, w * rf(rnd, 0.15, 0.85), h * rf(rnd, 0.25, 0.95), flow + rf(rnd, -0.3, 0.3), m * rf(rnd, 0.32, 0.52), m * rf(rnd, 0.12, 0.19), rnd());
          }
        }), w, h);
        paste(ctx, blurLayer(w, h, m * 0.0035, g => {
          for (let i = 0; i < 2; i++) {
            petalAt(g, w * rf(rnd, 0.25, 0.75), h * rf(rnd, 0.3, 0.8), flow + rf(rnd, -0.25, 0.25), m * rf(rnd, 0.28, 0.42), m * rf(rnd, 0.1, 0.15), rnd());
          }
        }), w, h);
        hx = w * rf(rnd, 0.3, 0.7); hy = h * rf(rnd, 0.15, 0.4);
      }
      // luminous highlight: smooth gradient, no blur
      const gr = ctx.createRadialGradient(hx, hy, 0, hx, hy, m * 0.22);
      gr.addColorStop(0, rgba(pal.hi, 0.9));
      gr.addColorStop(1, rgba(pal.hi, 0));
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, w, h);
      grain(ctx, w, h, 0.04);
      return { layout: `petal ${form} field (${pal.name})`, title: { band: [0.36, 0.5], weight: 600, tracking: 0.03, widthFrac: 0.58 } };
    },
  },

  S3: {
    id: 'S3', name: 'aurora-film', zh: '极光薄膜', group: 'soft_light',
    render(ctx, w, h, rnd, o) {
      // three colour moods of the same film family
      const moods = [
        { name: 'aurora', top: '#e7e3f6', bottom: '#bccbe9',
          blobs: [['#c3a8ef', 0.7], ['#aedcf6', 0.7], ['#f4c0dd', 0.55]],
          sheets: [{ c: '#b493ea', a: 0.5 }, { c: '#9fd4f4', a: 0.5 }, { c: '#f2b3d8', a: 0.42 }, { c: '#6a3ae0', a: 0.3 }, { c: '#ffffff', a: 0.4 }] },
        { name: 'polar', top: '#e9f4f7', bottom: '#b9d6e6',
          blobs: [['#a0d8f0', 0.7], ['#a8ecd4', 0.6], ['#cfe8f8', 0.55]],
          sheets: [{ c: '#8ecbe8', a: 0.5 }, { c: '#9ae4c8', a: 0.42 }, { c: '#c8e8f6', a: 0.5 }, { c: '#7a92e0', a: 0.26 }, { c: '#ffffff', a: 0.45 }] },
        { name: 'orchid', top: '#e6d9f0', bottom: '#af9ed2',
          blobs: [['#a578e0', 0.7], ['#e590c5', 0.55], ['#b8d0f2', 0.55]],
          sheets: [{ c: '#9a6ae0', a: 0.48 }, { c: '#e588c8', a: 0.42 }, { c: '#b8d4f4', a: 0.45 }, { c: '#5a2ad0', a: 0.26 }, { c: '#ffffff', a: 0.38 }] },
      ];
      const mood = pick(rnd, moods);
      blobField(ctx, w, h, {
        top: mood.top, bottom: mood.bottom,
        blobs: [
          { c: mood.blobs[0][0], a: mood.blobs[0][1], x: [0.1, 0.5], y: [0.1, 0.6], r: [0.4, 0.7] },
          { c: mood.blobs[1][0], a: mood.blobs[1][1], x: [0.5, 0.9], y: [0.3, 0.8], r: [0.4, 0.7] },
          { c: mood.blobs[2][0], a: mood.blobs[2][1], x: [0.3, 0.8], y: [0.0, 0.4], r: [0.3, 0.55] },
        ],
      }, rnd);
      // sheet direction: falling right, falling left, or steep drape
      const dir = pick(rnd, ['fall-right', 'fall-left', 'drape']);
      const ang = dir === 'fall-right' ? rf(rnd, -0.62, -0.38)
        : dir === 'fall-left' ? rf(rnd, 0.38, 0.62)
        : rf(rnd, -1.18, -0.95);
      const sheets = mood.sheets;
      // translucent sheets are pure gradients — drawn directly, no blur needed
      const sheetPass = (count, wRange, aMul) => {
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(ang);
        for (let i = 0; i < count; i++) {
          const s = pick(rnd, sheets);
          const sy = rf(rnd, -0.65, 0.65) * h;
          const sh = rf(rnd, wRange[0], wRange[1]) * h;
          const grad = ctx.createLinearGradient(0, sy - sh / 2, 0, sy + sh / 2);
          grad.addColorStop(0, rgba(s.c, 0));
          grad.addColorStop(0.5, rgba(s.c, s.a * aMul));
          grad.addColorStop(1, rgba(s.c, 0));
          ctx.fillStyle = grad;
          ctx.fillRect(-w * 1.2, sy - sh / 2, w * 2.4, sh);
        }
        ctx.restore();
      };
      sheetPass(5, [0.18, 0.34], 1);
      sheetPass(4, [0.08, 0.18], 1);
      // silky bright streaks
      paste(ctx, blurLayer(w, h, Math.min(w, h) * 0.002, g => {
        g.translate(w / 2, h / 2);
        g.rotate(ang);
        for (let i = 0; i < 3; i++) {
          const sy = rf(rnd, -0.5, 0.5) * h;
          const grad = g.createLinearGradient(-w, 0, w, 0);
          grad.addColorStop(0, rgba('#ffffff', 0));
          grad.addColorStop(0.5, rgba('#ffffff', 0.55));
          grad.addColorStop(1, rgba('#ffffff', 0));
          g.strokeStyle = grad;
          g.lineWidth = h * rf(rnd, 0.003, 0.008);
          g.beginPath();
          g.moveTo(-w, sy);
          g.quadraticCurveTo(0, sy + rf(rnd, -0.06, 0.06) * h, w, sy + rf(rnd, -0.1, 0.1) * h);
          g.stroke();
        }
      }), w, h);
      grain(ctx, w, h, 0.04);
      return { layout: `film sheets (${mood.name}/${dir})`, title: { band: [0.42, 0.55], weight: 500, tracking: 0.09, widthFrac: 0.56 } };
    },
  },

  S4: {
    id: 'S4', name: 'minimal-type', zh: '极简字体', group: 'graphic_system',
    render(ctx, w, h, rnd, o) {
      const pairs = [
        { bg: '#cfc2ec', accent: '#e8f542', ink: '#17151f' },
        { bg: '#f5e7c9', accent: '#3a53f5', ink: '#191720' },
        { bg: '#dcecc9', accent: '#ff5c2a', ink: '#16181a' },
        { bg: '#f7cad4', accent: '#c8f542', ink: '#1c141a' },
        { bg: '#cfe3f2', accent: '#f5e642', ink: '#131722' },
        { bg: '#cdeedd', accent: '#7a3af0', ink: '#12201a' },
        { bg: '#f8d8b8', accent: '#2a8cf5', ink: '#221a12' },
        { bg: '#e8e2d8', accent: '#f03a9e', ink: '#1b1916' },
        { bg: '#bcdcf5', accent: '#ff8c2a', ink: '#101a24' },
      ];
      const pal = pick(rnd, pairs);
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, w, h);
      // paper tooth
      grain(ctx, w, h, 0.05, 'multiply');
      grain(ctx, w, h, 0.03, 'screen');
      o._s4 = pal;
      /* With no headline the poster would be bare paper, so the marker
       * gesture stops annotating and becomes the subject itself. */
      if (!o._hasTitle) {
        const m = Math.min(w, h);
        const cx = w / 2, cy = h * rf(rnd, 0.46, 0.54);
        const rx = w * rf(rnd, 0.26, 0.34), ry = h * rf(rnd, 0.15, 0.21);
        const jitter = () => rf(rnd, -m * 0.008, m * 0.008);
        ctx.save();
        ctx.strokeStyle = pal.accent;
        ctx.lineCap = 'round';
        ctx.rotate(0);
        const loops = ri(rnd, 2, 3);
        for (let pass = 0; pass < loops; pass++) {
          ctx.lineWidth = m * rf(rnd, 0.016, 0.026);
          ctx.beginPath();
          const start = rf(rnd, 0, Math.PI * 2);
          for (let a = 0; a <= Math.PI * 2.15; a += Math.PI / 26) {
            const x = cx + Math.cos(a + start) * (rx + jitter() * 3);
            const y = cy + Math.sin(a + start) * (ry + jitter() * 3);
            a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.restore();
        return {
          layout: 'flat poster, marker gesture is the image',
          title: { band: [0.46, 0.52], weight: 700, tracking: -0.012, widthFrac: w / h > 1.2 ? 0.6 : 0.76, color: 'dark', darkColor: pal.ink, caseMode: 'keep', splitAt: 8, maxHFrac: 0.52, lineHeight: 1.02 },
        };
      }
      const caseMode = 'keep';
      return {
        layout: 'flat poster, headline is the image',
        title: { band: [0.46, 0.52], weight: 700, tracking: caseMode === 'upper' ? 0.004 : -0.012, widthFrac: w / h > 1.2 ? 0.6 : 0.76, color: 'dark', darkColor: pal.ink, caseMode, splitAt: 8, maxHFrac: 0.52, lineHeight: 1.02 },
      };
    },
    /* Marker gesture drawn after the title so it wraps real geometry. */
    after(ctx, w, h, rnd, o, titleBox) {
      if (!titleBox || !o._s4) return;
      const pal = o._s4;
      const last = titleBox.capY[titleBox.capY.length - 1];
      const gesture = pick(rnd, titleBox.lines.length > 1
        ? ['ellipse', 'ellipse', 'underline', 'double']
        : ['underline', 'underline', 'double']);
      ctx.save();
      ctx.strokeStyle = pal.accent;
      ctx.lineCap = 'round';
      const m = Math.min(w, h);
      const jitter = () => rf(rnd, -m * 0.006, m * 0.006);
      if (gesture === 'ellipse') {
        // rough ellipse around the last line
        const lw = ctx.measureText(last.line).width;
        const ex = w / 2, ey = last.y - titleBox.size * 0.3;
        const rx = titleBox.bw * 0.62, ryy = titleBox.size * 0.72;
        ctx.rotate(0);
        for (let pass = 0; pass < 2; pass++) {
          ctx.lineWidth = m * rf(rnd, 0.012, 0.02);
          ctx.beginPath();
          const start = rf(rnd, 0, Math.PI * 2);
          for (let a = 0; a <= Math.PI * 2.1; a += Math.PI / 24) {
            const x = ex + Math.cos(a + start) * (rx + jitter() * 3);
            const y = ey + Math.sin(a + start) * (ryy + jitter() * 3);
            a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      } else {
        // marker underline below the last line; 'double' adds a shorter echo
        const uy = last.y + titleBox.size * 0.26;
        const strokeLine = (y, wf) => {
          ctx.lineWidth = m * rf(rnd, 0.014, 0.022);
          ctx.beginPath();
          ctx.moveTo(w / 2 - titleBox.bw * wf, y + jitter());
          ctx.quadraticCurveTo(w / 2 + jitter() * 4, y + rf(rnd, -1, 1) * m * 0.014, w / 2 + titleBox.bw * rf(rnd, wf - 0.04, wf + 0.04), y + jitter());
          ctx.stroke();
        };
        for (let pass = 0; pass < 2; pass++) strokeLine(uy, 0.54);
        if (gesture === 'double') strokeLine(uy + titleBox.size * 0.14, rf(rnd, 0.3, 0.4));
      }
      ctx.restore();
    },
  },

  S5: {
    id: 'S5', name: 'utility-cards', zh: '功能卡片', group: 'graphic_system',
    render(ctx, w, h, rnd, o) {
      blobField(ctx, w, h, {
        top: '#7fb2e6', bottom: '#2a63c8', diag: true,
        blobs: [
          { c: '#eef5fc', a: 0.9, x: [0.4, 0.8], y: [0.0, 0.35], r: [0.5, 0.8] },
          { c: '#49b4ee', a: 0.7, x: [0.0, 0.35], y: [0.3, 0.7], r: [0.4, 0.65] },
          { c: '#0f37b0', a: 0.7, x: [0.6, 1.0], y: [0.65, 1.0], r: [0.4, 0.7] },
          { c: '#bfe9d4', a: 0.4, x: [0.1, 0.4], y: [0.75, 1.0], r: [0.2, 0.4] },
        ],
      }, rnd);
      paste(ctx, blurLayer(w, h, Math.min(w, h) * 0.055, g => {
        fold(g, w, h, rnd, { light: '#ffffff', dark: '#2a55c0', alpha: 0.28, width: 0.24 * h, drift: 0.35 });
      }), w, h);
      grain(ctx, w, h, 0.04);

      const count = o.iconCount || pick(rnd, [1, 2, 4, 6]);
      const names = Object.keys(ICONS);
      // seeded shuffle
      const shuffled = names.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const icons = shuffled.slice(0, count);
      const landscape = w / h > 1.2;
      const portrait = h / w > 1.15;
      const m = Math.min(w, h);

      /* One off-white ceramic tile with a glyph — the shared unit of every
       * arrangement. `wide` stretches it into a pill. */
      const drawTile = (x, y, tw, th, icon) => {
        const rad = Math.min(tw, th) * 0.22;
        ctx.save();
        ctx.shadowColor = 'rgba(10,25,50,0.22)';
        ctx.shadowBlur = th * 0.09;
        ctx.shadowOffsetY = th * 0.028;
        roundRectPath(ctx, x, y, tw, th, rad);
        ctx.fillStyle = '#f9f9f5';
        ctx.fill();
        ctx.restore();
        ctx.save();
        roundRectPath(ctx, x, y, tw, th, rad);
        ctx.clip();
        const hg = ctx.createLinearGradient(0, y, 0, y + th * 0.35);
        hg.addColorStop(0, 'rgba(255,255,255,0.75)');
        hg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = hg;
        ctx.fillRect(x, y, tw, th * 0.35);
        const sg = ctx.createLinearGradient(0, y + th * 0.72, 0, y + th);
        sg.addColorStop(0, 'rgba(30,40,60,0)');
        sg.addColorStop(1, 'rgba(30,40,60,0.07)');
        ctx.fillStyle = sg;
        ctx.fillRect(x, y + th * 0.72, tw, th * 0.28);
        ctx.restore();
        const iconSize = th * 0.5;
        ctx.save();
        ctx.translate(x + (tw - iconSize) / 2, y + (th - iconSize) / 2);
        ctx.scale(iconSize, iconSize);
        ctx.strokeStyle = '#141c2c';
        ctx.lineWidth = 0.085;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ICONS[icon](ctx);
        ctx.restore();
      };

      // three arrangements of the same tiles
      const arrangement = count === 1 ? 'single'
        : pick(rnd, ['grid', 'grid', 'row', 'tower']);
      const titleShift = o._hasTitle ? h * 0.07 : 0;
      let layoutName;

      if (arrangement === 'row') {
        // L6-style single line of pills across the optical centre
        const n = Math.min(count, landscape ? 4 : 3);
        const th = m * (landscape ? 0.12 : 0.13);
        const tw = th * 1.55;
        const gap = th * 0.42;
        const total = n * tw + (n - 1) * gap;
        const sx = (w - total) / 2;
        const sy = (h - th) / 2 + titleShift;
        for (let i = 0; i < n; i++) drawTile(sx + i * (tw + gap), sy, tw, th, icons[i]);
        layoutName = 'L6 dual-pill row';
      } else if (arrangement === 'tower') {
        // one vertical column: a stack of capabilities
        const n = Math.min(count, portrait ? 4 : 3);
        const tile = m * (portrait ? 0.15 : 0.13);
        const gap = tile * 0.34;
        const total = n * tile + (n - 1) * gap;
        const sx = (w - tile) / 2;
        const sy = (h - total) / 2 + titleShift * 0.6;
        for (let i = 0; i < n; i++) drawTile(sx, sy + i * (tile + gap), tile, tile, icons[i]);
        layoutName = 'L5 utility-tower';
      } else if (arrangement === 'single') {
        const tile = m * 0.17;
        drawTile((w - tile) / 2, (h - tile) / 2 + titleShift, tile, tile, icons[0]);
        layoutName = 'L4 single-utility-tile';
      } else {
        // portrait avoids three-column grids (orientation adaptation rule)
        const cols = count === 2 ? 2 : count === 4 ? 2 : portrait ? 2 : 3;
        const rows = Math.ceil(count / cols);
        const tile = (landscape ? w * 0.42 : w * 0.44) / (cols + (cols - 1) * 0.38);
        const gap = tile * 0.38;
        const gw = cols * tile + (cols - 1) * gap;
        const gh = rows * tile + (rows - 1) * gap;
        const gx = (w - gw) / 2;
        const gy = (h - gh) / 2 + titleShift;
        let k = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols && k < count; c++, k++) {
            drawTile(gx + c * (tile + gap), gy + r * (tile + gap), tile, tile, icons[k]);
          }
        }
        layoutName = 'L5 utility-grid';
      }

      return {
        layout: layoutName,
        title: { band: [0.13, 0.18], weight: 600, tracking: 0.03, widthFrac: 0.5, maxHFrac: 0.09 },
      };
    },
  },

  S6: {
    id: 'S6', name: 'brand-lockup', zh: '品牌锁定', group: 'graphic_system',
    render(ctx, w, h, rnd, o) {
      const fields = [
        { top: '#0a1f9e', bottom: '#03104f', blobs: [{ c: '#2a6bf2', a: 0.85, x: [0.2, 0.8], y: [0.1, 0.6], r: [0.5, 0.8] }, { c: '#59c2f0', a: 0.5, x: [0.5, 0.9], y: [0.0, 0.4], r: [0.3, 0.5] }] },
        { top: '#3a1470', bottom: '#180a38', blobs: [{ c: '#8a4bf0', a: 0.8, x: [0.1, 0.7], y: [0.2, 0.7], r: [0.45, 0.75] }, { c: '#f068b8', a: 0.4, x: [0.6, 1.0], y: [0.5, 0.9], r: [0.3, 0.5] }] },
        { top: '#06413d', bottom: '#02201e', blobs: [{ c: '#2a9d8f', a: 0.8, x: [0.2, 0.8], y: [0.2, 0.7], r: [0.45, 0.75] }, { c: '#9fe0c8', a: 0.4, x: [0.0, 0.4], y: [0.0, 0.4], r: [0.25, 0.45] }] },
        { top: '#8a2250', bottom: '#3d0d28', blobs: [{ c: '#f2699e', a: 0.7, x: [0.2, 0.8], y: [0.1, 0.6], r: [0.45, 0.7] }, { c: '#f9b16e', a: 0.5, x: [0.5, 1.0], y: [0.6, 1.0], r: [0.3, 0.5] }] },
      ];
      const f = pick(rnd, fields);
      blobField(ctx, w, h, { ...f, diag: true }, rnd);
      const m6 = Math.min(w, h);
      // three ways the field carries the marks
      const texture = pick(rnd, ['drape', 'spotlight', 'mesh']);
      if (texture === 'drape') {
        paste(ctx, blurLayer(w, h, m6 * 0.05, g => {
          fold(g, w, h, rnd, { light: '#ffffff', dark: '#000000', alpha: 0.16, width: 0.26 * h, drift: 0.35 });
          ribbon(g, w, h, rnd, { color: '#ffffff', alpha: 0.1, width: 0.12 * h, drift: 0.3 });
        }), w, h);
      } else if (texture === 'spotlight') {
        // one broad shaft of light behind the lockup, everything else recedes
        const cx = w * rf(rnd, 0.4, 0.6), cy = h * rf(rnd, 0.4, 0.55);
        const gl = ctx.createRadialGradient(cx, cy, 0, cx, cy, m6 * rf(rnd, 0.6, 0.85));
        gl.addColorStop(0, 'rgba(255,255,255,0.22)');
        gl.addColorStop(0.5, 'rgba(255,255,255,0.06)');
        gl.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gl;
        ctx.fillRect(0, 0, w, h);
        vignette(ctx, w, h, 0.42);
      } else {
        // a quiet engineered mesh, receding with distance
        paste(ctx, blurLayer(w, h, m6 * 0.004, g => {
          const step = m6 * rf(rnd, 0.055, 0.085);
          g.strokeStyle = 'rgba(255,255,255,0.16)';
          g.lineWidth = Math.max(1, m6 * 0.0011);
          for (let x = 0; x <= w; x += step) {
            g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
          }
          for (let y = 0; y <= h; y += step) {
            g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
          }
        }), w, h, 0.7);
        // fade the mesh away from one corner so it never reads as graph paper
        const fx = rnd() < 0.5 ? 0 : w, fy = rnd() < 0.5 ? 0 : h;
        const fade = ctx.createRadialGradient(fx, fy, 0, fx, fy, Math.hypot(w, h) * 0.9);
        fade.addColorStop(0, rgba(f.bottom, 0));
        fade.addColorStop(1, rgba(f.bottom, 0.85));
        ctx.fillStyle = fade;
        ctx.fillRect(0, 0, w, h);
      }
      grain(ctx, w, h, 0.04);
      o._lockupField = true;
      return {
        layout: `L7 partner-lockup (${texture})`,
        lockup: true,
        title: { band: [0.47, 0.53], weight: 600, tracking: 0.12, widthFrac: 0.52, maxLines: 1, maxHFrac: 0.09 },
      };
    },
  },

  S7: {
    id: 'S7', name: 'product-ui', zh: '产品 UI', group: 'editorial_object',
    render(ctx, w, h, rnd, o) {
      const accents = [
        { a: '#2a5bf0', top: '#9cc0ea', bottom: '#40549e' },
        { a: '#0f8f80', top: '#a4d8cd', bottom: '#2b6e64' },
        { a: '#7a4bdc', top: '#c4b2ea', bottom: '#4d3a8e' },
      ];
      const pal = pick(rnd, accents);
      blobField(ctx, w, h, {
        top: pal.top, bottom: pal.bottom, diag: true,
        blobs: [
          { c: '#f2f6fa', a: 0.8, x: [0.3, 0.8], y: [0.0, 0.3], r: [0.4, 0.7] },
          { c: pal.a, a: 0.5, x: [0.0, 0.4], y: [0.5, 0.9], r: [0.4, 0.6] },
        ],
      }, rnd);
      grain(ctx, w, h, 0.035);
      if (o.assetImg && o.assetKind !== 'logo') return { layout: 'asset', title: { band: [0.1, 0.16], weight: 600, tracking: 0.02, widthFrac: 0.52, maxHFrac: 0.08 } };

      // six product surfaces, each with its own geometry
      const form = pick(rnd, ['app', 'code', 'mobile', 'terminal', 'browser', 'chat']);
      const landscape = w / h > 1.2;
      const hasTitle = o._hasTitle;
      const dark = form === 'code' || form === 'terminal';
      const phone = form === 'mobile';

      const uw = phone
        ? w * (landscape ? 0.24 : 0.38)
        : w * (landscape ? 0.56 : 0.8);
      const ux = (w - uw) / 2;
      const uy = (hasTitle ? 0.32 : 0.26) * h;
      const uh = h * 1.05 - uy;
      const r = phone ? uw * 0.11 : w * 0.02;
      const u = uw / 100;

      ctx.save();
      ctx.shadowColor = 'rgba(10,18,40,0.35)';
      ctx.shadowBlur = w * 0.045;
      ctx.shadowOffsetY = w * 0.012;
      roundRectPath(ctx, ux, uy, uw, uh, r);
      ctx.fillStyle = dark ? '#14161f' : '#fbfbf9';
      ctx.fill();
      ctx.restore();

      ctx.save();
      roundRectPath(ctx, ux, uy, uw, uh, r);
      ctx.clip();

      if (phone) {
        // status bar + notch, then a feed of cards
        ctx.fillStyle = '#fbfbf9';
        ctx.fillRect(ux, uy, uw, uh);
        roundRectPath(ctx, ux + uw * 0.34, uy + u * 2, uw * 0.32, u * 5, u * 2.5);
        ctx.fillStyle = '#1a1a1e';
        ctx.fill();
        roundRectPath(ctx, ux + u * 6, uy + u * 14, u * 46, u * 5, u * 2.5);
        ctx.fillStyle = '#23252c';
        ctx.fill();
        let fy = uy + u * 26;
        while (fy < uy + uh) {
          roundRectPath(ctx, ux + u * 6, fy, u * 88, u * 30, u * 4);
          ctx.fillStyle = '#f1f1ed';
          ctx.fill();
          roundRectPath(ctx, ux + u * 6, fy, u * 88, u * 17, u * 4);
          ctx.fillStyle = rgba(pal.a, rf(rnd, 0.5, 0.95));
          ctx.fill();
          roundRectPath(ctx, ux + u * 11, fy + u * 21, u * rf(rnd, 30, 60), u * 3, u * 1.5);
          ctx.fillStyle = '#c9c9c3';
          ctx.fill();
          fy += u * 36;
        }
      } else if (form === 'terminal') {
        ctx.fillStyle = '#12141b';
        ctx.fillRect(ux, uy, uw, uh);
        ctx.fillStyle = '#1d2029';
        ctx.fillRect(ux, uy, uw, u * 8);
        const dots = ['#f26d5f', '#f2bd4e', '#59c26a'];
        dots.forEach((c, i) => {
          ctx.beginPath();
          ctx.arc(ux + u * (4 + i * 3.4), uy + u * 4, u * 1.05, 0, Math.PI * 2);
          ctx.fillStyle = c;
          ctx.fill();
        });
        let ty = uy + u * 14;
        while (ty < uy + uh) {
          const isPrompt = rnd() < 0.4;
          if (isPrompt) {
            roundRectPath(ctx, ux + u * 6, ty, u * 2.4, u * 2.2, u * 1.1);
            ctx.fillStyle = '#59c26a';
            ctx.fill();
            roundRectPath(ctx, ux + u * 10, ty, u * rf(rnd, 24, 56), u * 2.2, u * 1.1);
            ctx.fillStyle = '#e6e8ee';
            ctx.fill();
          } else {
            roundRectPath(ctx, ux + u * 6, ty, u * rf(rnd, 30, 80), u * 2.2, u * 1.1);
            ctx.fillStyle = rgba('#8a93a6', rf(rnd, 0.45, 0.8));
            ctx.fill();
          }
          ty += u * 4.4;
        }
        // the cursor block
        roundRectPath(ctx, ux + u * 6, Math.min(ty, uy + uh - u * 6), u * 3, u * 2.4, u * 0.6);
        ctx.fillStyle = '#59c26a';
        ctx.fill();
      } else if (form === 'browser') {
        // a site: chrome, then a hero block and a row of cards
        ctx.fillStyle = '#eeeeea';
        ctx.fillRect(ux, uy, uw, u * 9);
        const dots = ['#f26d5f', '#f2bd4e', '#59c26a'];
        dots.forEach((c, i) => {
          ctx.beginPath();
          ctx.arc(ux + u * (4 + i * 3.4), uy + u * 4.5, u * 1.05, 0, Math.PI * 2);
          ctx.fillStyle = c;
          ctx.fill();
        });
        roundRectPath(ctx, ux + u * 16, uy + u * 2.2, u * 62, u * 4.6, u * 2.3);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        roundRectPath(ctx, ux + u * 19, uy + u * 3.9, u * rf(rnd, 18, 34), u * 1.3, u * 0.65);
        ctx.fillStyle = '#c2c2bc';
        ctx.fill();
        // hero
        const hy = uy + u * 9;
        const hero = ctx.createLinearGradient(ux, hy, ux + uw, hy + u * 34);
        hero.addColorStop(0, rgba(pal.a, 0.9));
        hero.addColorStop(1, rgba(mix(pal.a, '#ffffff', 0.45), 0.85));
        ctx.fillStyle = hero;
        ctx.fillRect(ux, hy, uw, u * 34);
        roundRectPath(ctx, ux + u * 9, hy + u * 10, u * 48, u * 4.2, u * 1.6);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fill();
        roundRectPath(ctx, ux + u * 9, hy + u * 17, u * 32, u * 2.4, u * 1.2);
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fill();
        roundRectPath(ctx, ux + u * 9, hy + u * 23, u * 17, u * 5.2, u * 2.6);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        // cards below
        for (let i = 0; i < 3; i++) {
          const cx2 = ux + u * (7 + i * 29);
          roundRectPath(ctx, cx2, hy + u * 40, u * 25, u * 26, u * 2);
          ctx.fillStyle = '#f4f4f0';
          ctx.fill();
          roundRectPath(ctx, cx2 + u * 3, hy + u * 43, u * 19, u * 11, u * 1.4);
          ctx.fillStyle = rgba(pal.a, 0.25 + i * 0.2);
          ctx.fill();
          roundRectPath(ctx, cx2 + u * 3, hy + u * 57, u * rf(rnd, 10, 18), u * 1.8, u * 0.9);
          ctx.fillStyle = '#cfcfc9';
          ctx.fill();
        }
      } else if (form === 'chat') {
        ctx.fillStyle = '#fbfbf9';
        ctx.fillRect(ux, uy, uw, uh);
        ctx.fillStyle = '#f0f0ec';
        ctx.fillRect(ux, uy, uw, u * 9);
        roundRectPath(ctx, ux + u * 6, uy + u * 3, u * 22, u * 3, u * 1.5);
        ctx.fillStyle = '#23252c';
        ctx.fill();
        let by = uy + u * 15;
        let side = 0;
        while (by < uy + uh - u * 8) {
          const bw = u * rf(rnd, 30, 58);
          const bh = u * rf(rnd, 8, 17);
          const bx = side ? ux + uw - u * 6 - bw : ux + u * 6;
          roundRectPath(ctx, bx, by, bw, bh, u * 3.2);
          ctx.fillStyle = side ? pal.a : '#ecece8';
          ctx.fill();
          // lines of text inside the bubble
          ctx.fillStyle = side ? 'rgba(255,255,255,0.55)' : '#c6c6c0';
          const rows = Math.max(1, Math.floor(bh / (u * 5)));
          for (let r = 0; r < rows; r++) {
            roundRectPath(ctx, bx + u * 3.5, by + u * (3 + r * 4.6), bw - u * 7 - (r === rows - 1 ? u * rf(rnd, 4, 16) : 0), u * 1.7, u * 0.85);
            ctx.fill();
          }
          by += bh + u * 5;
          side ^= 1;
        }
      } else if (form === 'code') {
        ctx.fillStyle = '#1d2029';
        ctx.fillRect(ux, uy, uw, u * 8);
        const dots = ['#f26d5f', '#f2bd4e', '#59c26a'];
        dots.forEach((c, i) => {
          ctx.beginPath();
          ctx.arc(ux + u * (4 + i * 3.4), uy + u * 4, u * 1.05, 0, Math.PI * 2);
          ctx.fillStyle = c;
          ctx.fill();
        });
        roundRectPath(ctx, ux + u * 18, uy + u * 1.8, u * 50, u * 4.4, u * 2.2);
        ctx.fillStyle = '#272b36';
        ctx.fill();
        const cols = ['#7cc4ff', '#f2a0c8', '#a0e8b0', '#e8d089', '#8a93a6'];
        let ln = 0;
        for (let y = uy + u * 13; y < uy + uh; y += u * 4.6, ln++) {
          let x = ux + u * (6 + (ln % 5 === 1 || ln % 5 === 2 ? 6 : ln % 7 === 3 ? 12 : 0));
          const segs = ri(rnd, 2, 4);
          for (let s = 0; s < segs; s++) {
            const len = u * rf(rnd, 6, 20);
            roundRectPath(ctx, x, y, len, u * 2.2, u * 1.1);
            ctx.fillStyle = rgba(pick(rnd, cols), 0.9);
            ctx.fill();
            x += len + u * 2.4;
          }
        }
      } else {
        // app: sidebar + content + chart
        ctx.fillStyle = '#f0f0ec';
        ctx.fillRect(ux, uy, uw, u * 8);
        const dots = ['#f26d5f', '#f2bd4e', '#59c26a'];
        dots.forEach((c, i) => {
          ctx.beginPath();
          ctx.arc(ux + u * (4 + i * 3.4), uy + u * 4, u * 1.05, 0, Math.PI * 2);
          ctx.fillStyle = c;
          ctx.fill();
        });
        roundRectPath(ctx, ux + u * 18, uy + u * 1.8, u * 50, u * 4.4, u * 2.2);
        ctx.fillStyle = '#e2e2dc';
        ctx.fill();
        ctx.fillStyle = '#f4f4f0';
        ctx.fillRect(ux, uy + u * 8, u * 24, uh);
        ctx.beginPath();
        ctx.arc(ux + u * 6, uy + u * 15, u * 2.6, 0, Math.PI * 2);
        ctx.fillStyle = pal.a;
        ctx.fill();
        for (let i = 0; i < 6; i++) {
          roundRectPath(ctx, ux + u * 4, uy + u * (23 + i * 6), u * rf(rnd, 10, 16), u * 2, u * 1);
          ctx.fillStyle = i === 0 ? rgba(pal.a, 0.85) : '#d8d8d2';
          ctx.fill();
        }
        const mx = ux + u * 30;
        roundRectPath(ctx, mx, uy + u * 14, u * 34, u * 3.6, u * 1.4);
        ctx.fillStyle = '#23252c';
        ctx.fill();
        for (let i = 0; i < 2; i++) {
          roundRectPath(ctx, mx, uy + u * (21 + i * 4), u * rf(rnd, 40, 58), u * 1.9, u * 0.9);
          ctx.fillStyle = '#d4d4ce';
          ctx.fill();
        }
        roundRectPath(ctx, mx, uy + u * 31, u * 16, u * 5.4, u * 2.7);
        ctx.fillStyle = pal.a;
        ctx.fill();
        const cy0 = uy + u * 42;
        roundRectPath(ctx, mx, cy0, u * 62, u * 30, u * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#e4e4de';
        ctx.lineWidth = u * 0.3;
        ctx.stroke();
        if (rnd() < 0.5) {
          const bars = 7;
          for (let i = 0; i < bars; i++) {
            const bh = u * rf(rnd, 6, 20);
            roundRectPath(ctx, mx + u * (5 + i * 8), cy0 + u * 26 - bh, u * 4.6, bh, u * 1.2);
            ctx.fillStyle = rgba(pal.a, 0.35 + 0.6 * (i / bars));
            ctx.fill();
          }
        } else {
          // a rising line with a soft area fill
          const pts = [];
          for (let i = 0; i <= 8; i++) {
            pts.push({ x: mx + u * (4 + i * 7), y: cy0 + u * (24 - (i / 8) * rf(rnd, 8, 17) - rf(rnd, 0, 4)) });
          }
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
          ctx.lineTo(pts[pts.length - 1].x, cy0 + u * 26);
          ctx.lineTo(pts[0].x, cy0 + u * 26);
          ctx.closePath();
          ctx.fillStyle = rgba(pal.a, 0.16);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
          ctx.strokeStyle = pal.a;
          ctx.lineWidth = u * 0.9;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.stroke();
        }
      }
      ctx.restore();
      const lay = phone ? 'L1 ui-narrow-center-bottom-crop' : (landscape ? 'L1 ui-narrow-center-bottom-crop' : 'L3 ui-square-lower-crop');
      return { layout: `${lay} (${form})`, title: { band: [0.1, 0.16], weight: 600, tracking: 0.02, widthFrac: 0.52, maxHFrac: 0.08 } };
    },
  },

  S8: {
    id: 'S8', name: 'semantic-object', zh: '语义实物', group: 'editorial_object',
    render(ctx, w, h, rnd, o) {
      const subject = pickS8Subject(o, rnd);
      const matName = pick(rnd, S8_BRIDGES[subject].mats);
      const mat = MATERIALS[matName];
      const sharp = scratchCanvas(w, h);
      const sg = sharp.getContext('2d');
      if (subject === 'phyllo') macroPhyllotaxis(sg, w, h, rnd, mat);
      else if (subject === 'strata') macroStrata(sg, w, h, rnd, mat);
      else if (subject === 'weave') macroWeave(sg, w, h, rnd, mat);
      else if (subject === 'rope') macroRope(sg, w, h, rnd, mat);
      else if (subject === 'ripple') macroRipple(sg, w, h, rnd, mat);
      else macroFins(sg, w, h, rnd, mat);
      ctx.drawImage(sharp, 0, 0);
      // depth of field: blurred copy masked to the frame edges
      const blurred = blurCanvas(sharp, w, h, Math.min(w, h) * 0.011);
      const mask = scratchCanvas(w, h);
      const mg = mask.getContext('2d');
      mg.drawImage(blurred, 0, 0);
      const r = Math.hypot(w, h) / 2;
      const grad = mg.createRadialGradient(w / 2, h / 2, r * 0.3, w / 2, h / 2, r * 0.95);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      mg.globalCompositeOperation = 'destination-out';
      mg.fillStyle = grad;
      mg.fillRect(0, 0, w, h);
      ctx.drawImage(mask, 0, 0);
      // light sweep + vignette + photographic grain
      const ls = ctx.createRadialGradient(w * 0.3, h * 0.2, 0, w * 0.3, h * 0.2, r * 1.1);
      ls.addColorStop(0, 'rgba(255,250,240,0.14)');
      ls.addColorStop(1, 'rgba(255,250,240,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = ls;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      vignette(ctx, w, h, 0.38);
      grain(ctx, w, h, 0.06);
      o._s8 = { subject, matName };
      return {
        layout: 'L9 semantic-object-crop',
        subject, material: matName, bridge: S8_BRIDGES[subject].zh,
        title: { band: [0.42, 0.56], weight: 700, tracking: 0.05, widthFrac: 0.62, maxHFrac: 0.14 },
      };
    },
  },

  S9: {
    id: 'S9', name: 'signal-poster', zh: '强信号海报', group: 'editorial_object',
    render(ctx, w, h, rnd, o) {
      const palettes = [
        { c: '#38f56a', c2: '#b8ffd0' }, { c: '#f53a9e', c2: '#ffc0e2' }, { c: '#59b8ff', c2: '#cfeaff' },
        { c: '#ffb238', c2: '#ffe8c0' }, { c: '#9a6af5', c2: '#d8c8ff' },
      ];
      const pal = pick(rnd, palettes);
      ctx.fillStyle = '#04050a';
      ctx.fillRect(0, 0, w, h);
      const vg = ctx.createRadialGradient(w * 0.5, h * 0.6, 0, w * 0.5, h * 0.6, Math.max(w, h));
      vg.addColorStop(0, 'rgba(24,28,58,0.5)');
      vg.addColorStop(1, 'rgba(4,5,10,0)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
      const diag = Math.hypot(w, h);
      // four energy figures: radial burst, meteor rain, horizontal rush, shockwave
      const mode = pick(rnd, ['burst', 'rain', 'rush', 'rings']);
      if (mode === 'rings') {
        const cx = w * rf(rnd, 0.35, 0.65), cy = h * rf(rnd, 0.35, 0.6);
        const pitch = diag * rf(rnd, 0.035, 0.06);
        const drawRings = (g, wide, alpha, sparkle) => {
          g.globalCompositeOperation = 'lighter';
          for (let r = pitch; r < diag * 0.95; r += pitch) {
            const k = 1 - r / (diag * 0.95);
            g.strokeStyle = rgba(mix(pal.c, '#ffffff', rnd() * 0.35), alpha * (0.35 + k * 0.75));
            g.lineWidth = diag * wide * (0.4 + k);
            g.beginPath();
            g.ellipse(cx, cy, r, r * rf(rnd, 0.9, 1.0), 0, 0, Math.PI * 2);
            g.stroke();
            if (sparkle && rnd() < 0.5) {
              const a = rf(rnd, 0, Math.PI * 2);
              const sx = cx + Math.cos(a) * r, sy = cy + Math.sin(a) * r;
              const sr = diag * 0.004;
              const sg2 = g.createRadialGradient(sx, sy, 0, sx, sy, sr * 5);
              sg2.addColorStop(0, rgba(pal.c2, 0.9));
              sg2.addColorStop(1, rgba(pal.c2, 0));
              g.fillStyle = sg2;
              g.beginPath(); g.arc(sx, sy, sr * 5, 0, Math.PI * 2); g.fill();
            }
          }
        };
        paste(ctx, blurLayer(w, h, diag * 0.012, g => drawRings(g, 0.004, 0.5, false)), w, h);
        paste(ctx, blurLayer(w, h, diag * 0.002, g => drawRings(g, 0.0012, 0.85, true)), w, h);
        const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, pitch * 3);
        core.addColorStop(0, rgba(pal.c2, 0.85));
        core.addColorStop(1, rgba(pal.c2, 0));
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = core;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
        grain(ctx, w, h, 0.05);
        return {
          layout: 'L10 bold-wordmark (rings)',
          title: { band: [0.44, 0.54], weight: 800, tracking: 0.005, stretch: 0.82, widthFrac: 0.74, maxHFrac: 0.34, splitAt: 10 },
          wordmark: true,
        };
      }
      let ray;
      if (mode === 'burst') {
        const vx = w * rf(rnd, 0.3, 0.7), vy = h * rf(rnd, 0.32, 0.6);
        ray = () => {
          const a = rf(rnd, 0, Math.PI * 2);
          const r0 = diag * rf(rnd, 0.05, 0.4);
          const r1 = r0 + diag * rf(rnd, 0.12, 0.55);
          return { x0: vx + Math.cos(a) * r0, y0: vy + Math.sin(a) * r0, x1: vx + Math.cos(a) * r1, y1: vy + Math.sin(a) * r1 };
        };
      } else if (mode === 'rain') {
        const base = rf(rnd, Math.PI * 0.3, Math.PI * 0.42);
        const th = rnd() < 0.5 ? base : Math.PI - base;
        const dx = Math.cos(th), dy = Math.sin(th);
        ray = () => {
          const x0 = rf(rnd, -0.25, 1.25) * w, y0 = rf(rnd, -0.4, 1.0) * h;
          const len = diag * rf(rnd, 0.08, 0.38);
          return { x0, y0, x1: x0 + dx * len, y1: y0 + dy * len };
        };
      } else {
        const vx = (rnd() < 0.5 ? -0.8 : 1.8) * w;
        const vy = h * rf(rnd, 0.3, 0.7);
        ray = () => {
          const tx = rf(rnd, -0.1, 1.1) * w, ty = rf(rnd, -0.2, 1.2) * h;
          const ang = Math.atan2(ty - vy, tx - vx);
          const dist = Math.hypot(tx - vx, ty - vy);
          const r0 = dist * rf(rnd, 0.3, 0.8);
          const r1 = r0 + diag * rf(rnd, 0.12, 0.45);
          return { x0: vx + Math.cos(ang) * r0, y0: vy + Math.sin(ang) * r0, x1: vx + Math.cos(ang) * r1, y1: vy + Math.sin(ang) * r1 };
        };
      }
      const streaks = (g, n, wRange, aRange, colorMixT, sparkle) => {
        g.globalCompositeOperation = 'lighter';
        g.lineCap = 'round';
        for (let i = 0; i < n; i++) {
          const { x0, y0, x1, y1 } = ray();
          const col = mix(pal.c, colorMixT > 0 ? '#ffffff' : pal.c, rnd() * colorMixT);
          const grad = g.createLinearGradient(x0, y0, x1, y1);
          const alpha = rf(rnd, aRange[0], aRange[1]);
          grad.addColorStop(0, rgba(col, 0));
          grad.addColorStop(0.75, rgba(col, alpha));
          grad.addColorStop(1, rgba(col, alpha * 0.8));
          g.strokeStyle = grad;
          g.lineWidth = h * rf(rnd, wRange[0], wRange[1]);
          g.beginPath();
          g.moveTo(x0, y0);
          g.lineTo(x1, y1);
          g.stroke();
          if (sparkle && rnd() < 0.4) {
            const sr = h * rf(rnd, 0.002, 0.005);
            const sg2 = g.createRadialGradient(x1, y1, 0, x1, y1, sr * 4);
            sg2.addColorStop(0, rgba(pal.c2, 0.9));
            sg2.addColorStop(1, rgba(pal.c2, 0));
            g.fillStyle = sg2;
            g.beginPath();
            g.arc(x1, y1, sr * 4, 0, Math.PI * 2);
            g.fill();
          }
        }
      };
      const m9 = Math.min(w, h);
      paste(ctx, blurLayer(w, h, m9 * 0.012, g => streaks(g, 80, [0.01, 0.02], [0.25, 0.5], 0.2, false)), w, h);
      paste(ctx, blurLayer(w, h, m9 * 0.004, g => streaks(g, 130, [0.004, 0.008], [0.4, 0.7], 0.35, false)), w, h);
      const fullLayer = scratchCanvas(w, h);
      const fg = fullLayer.getContext('2d');
      streaks(fg, 170, [0.0012, 0.0032], [0.5, 0.95], 0.6, true);
      paste(ctx, fullLayer, w, h, 1, 'lighter');
      grain(ctx, w, h, 0.05);
      return {
        layout: `L10 bold-wordmark (${mode})`,
        title: { band: [0.44, 0.54], weight: 800, tracking: 0.005, stretch: 0.82, widthFrac: 0.74, maxHFrac: 0.34, splitAt: 10 },
        wordmark: true,
      };
    },
  },
};

/* ---------------- typography direction description ---------------- */

function typeDirection(style, spec) {
  const parts = [];
  parts.push(spec.weight >= 800 ? 'heavy' : spec.weight >= 700 ? 'bold' : spec.weight >= 600 ? 'semibold' : 'regular');
  if (spec.stretch && spec.stretch < 0.92) parts.push('condensed');
  if (spec.tracking >= 0.08) parts.push('wide-tracked caps');
  else if (spec.tracking >= 0.02) parts.push('open-tracked');
  else if (spec.tracking < 0) parts.push('tight');
  parts.push('grotesk sans (no serifs)');
  return parts.join(', ');
}

/* ---------------- main entry ---------------- */

/*
 * Output resolution: 5K-class on capable desktops (probed by actually
 * allocating a 5120px canvas and reading a pixel back), 4K-class desktop
 * fallback, halved on mobile to stay inside iOS canvas limits.
 */
const BASE = (() => {
  try {
    if (/iPhone|iPad|Android/i.test(navigator.userAgent)) return 1024;
    const c = mkCanvas(5120, 5120);
    const g = c.getContext('2d');
    g.fillStyle = '#124578';
    g.fillRect(5117, 5117, 3, 3);
    if (g.getImageData(5118, 5118, 1, 1).data[0] === 0x12) return 2560;
  } catch (e) { /* fall through */ }
  return 2048;
})();
const RATIOS = {
  square: { w: BASE * 2, h: BASE * 2, label: '1:1' },
  landscape: { w: BASE * 2, h: BASE * 1.125, label: '16:9' },
  portrait: { w: BASE * 1.5, h: BASE * 1.875, label: '4:5' },
};

/*
 * opts: { style:'S1'..'S9', mode:'pure'|'text'|'asset', ratio, seed:int,
 *         title, assetImg, assetKind:'ui'|'logo'|'photo', assetKeepColor, iconCount }
 * Returns a render report.
 */
function renderCover(canvas, opts) {
  const o = Object.assign({}, opts);
  resetScratch();
  const spec = o.size ? { w: o.size.w, h: o.size.h, label: 'card' } : (RATIOS[o.ratio] || RATIOS.square);
  canvas.width = spec.w;
  canvas.height = spec.h;
  const ctx = canvas.getContext('2d');
  const w = spec.w, h = spec.h;
  /* Only the style and the seed decide the picture. The frame is a crop and
   * the title is an overlay; neither may enter the hash, or changing one
   * would deal a whole new hand of colour and composition. */
  const seed = (o.seed >>> 0) ^ hashStr(o.style);
  const rnd = mulberry32(seed);

  const style = STYLES[o.style] || STYLES.S1;
  /* Copy is the author's decision alone. No style invents a headline for an
   * empty field — a cover with nothing to say says nothing. */
  const isText = !!(o.title && o.title.trim());
  o._hasTitle = isText;

  const info = style.render(ctx, w, h, rnd, o) || {};
  let layout = info.layout || 'field';

  // asset compositing (any style may host content assets)
  if (o.mode === 'asset' && o.assetImg) {
    const al = drawAsset(ctx, w, h, rnd, o, isText);
    if (al) layout = al;
  }

  // title overlay
  let titleBox = null;
  let copy = null;
  let tspec = null;
  if (isText && info.title) {
    copy = o.title.trim();
    tspec = info.title;
    if (o.style === 'S6' && /[×+&\/]| x /i.test(copy)) {
      // two-mark lockup with thin divider (L7)
      const parts = copy.split(/\s*(?:[×+&\/]|\bx\b)\s*/i).filter(Boolean).slice(0, 2);
      if (parts.length === 2) {
        const capH = h * 0.052;
        const gapW = w * 0.055;
        ctx.save();
        const wA = measureTracked(ctx, parts[0], capH * 1.4, 600, 0.02, 1).width;
        const wB = measureTracked(ctx, parts[1], capH * 1.4, 600, 0.02, 1).width;
        const total = wA + wB + gapW * 2;
        const scale2 = Math.min(1, w * 0.74 / total);
        const y = h * 0.5 + capH * 0.5 * scale2;
        const x0 = w / 2 - (total * scale2) / 2;
        drawTracked(ctx, parts[0], x0 + (wA * scale2) / 2, y, capH * 1.4 * scale2, 600, 0.02, 1, '#ffffff');
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillRect(w / 2 + (wA - wB) * scale2 / 2 - Math.max(1.5, w * 0.0016) / 2, h * 0.5 - capH * 1.35, Math.max(1.5, w * 0.0016), capH * 2.7);
        drawTracked(ctx, parts[1], x0 + (wA + gapW * 2) * scale2 + (wB * scale2) / 2, y, capH * 1.4 * scale2, 600, 0.02, 1, '#ffffff');
        ctx.restore();
        titleBox = { lines: parts, size: capH, cx: w / 2, cy: h / 2, bw: total * scale2, blockH: capH * 1.4, capY: [] };
        layout = 'L7 partner-lockup (two marks)';
      }
    }
    if (!titleBox) {
      titleBox = overlayTitle(ctx, w, h, rnd, copy, tspec);
    }
    if (style.after) style.after(ctx, w, h, rnd, o, titleBox);
  }

  return {
    style: `${style.id} ${style.name}`,
    styleZh: style.zh,
    layout,
    ratio: spec.label,
    seed: o.seed >>> 0,
    copy,
    typography: tspec ? typeDirection(style, tspec) : null,
    veiled: titleBox ? !!titleBox.veiled : false,
    subject: info.subject ? `${info.subject} / ${info.material} — ${info.bridge}` : null,
  };
}

window.CoverEngine = { renderCover, STYLES, RATIOS };
})();
