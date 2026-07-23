/* Editorial Covers — the rack, the focus scene, and the flight between them. */
'use strict';
(() => {

const { renderCover, STYLES, RATIOS } = window.CoverEngine;

/* A reload should return you to the covers you were looking at, not deal a
 * fresh set — the seed and the frame you chose are part of the work. */
const STORE_KEY = 'oai-style-cover:v1';
function readStored() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
}
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      seed: state.seed, ratio: state.ratio, title: state.title,
    }));
  } catch (e) { /* private mode: the session simply won't outlive the tab */ }
}

const stored = readStored();
const state = {
  style: 'S1',
  ratio: ['square', 'landscape', 'portrait'].includes(stored.ratio) ? stored.ratio : 'square',
  seed: Number.isInteger(stored.seed) ? stored.seed >>> 0 : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0),
  title: typeof stored.title === 'string' ? stored.title : '',
  assetImg: null,
  assetKind: 'ui',
};
/* Write it back at once. A first visit invents a seed, and if that only ever
 * lived in memory the very next reload would deal a different set. */
persist();

const canvas = document.getElementById('cover');
const ghost = document.getElementById('ghost');
const gctx = ghost.getContext('2d');
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(0.2, 0.9, 0.2, 1)';

const EN_NAMES = {
  S1: 'Cool Optical', S2: 'Organic Bloom', S3: 'Aurora Film',
  S4: 'Minimal Type', S5: 'Utility Cards', S6: 'Brand Lockup',
  S7: 'Product UI', S8: 'Semantic Object', S9: 'Signal Poster',
};

/* ---------- the rack: nine live spines ---------- */

const rackRow = document.getElementById('rack-row');
const rackEl = document.getElementById('rack');
const cardEls = {};
const cardCanvases = {};

/*
 * A spine shows the very same frame the focus scene will show — same seed,
 * same ratio, same composition — merely cropped to the tall card by
 * object-fit. Rendering it at the card's own shape instead would adapt the
 * composition and open a different picture than the one you clicked.
 */
const CARD_LONG = 800;
function cardSize() {
  const R = RATIOS[state.ratio];
  const k = CARD_LONG / Math.max(R.w, R.h);
  return { w: Math.round(R.w * k), h: Math.round(R.h * k) };
}

function renderCard(styleId) {
  const c = cardCanvases[styleId];
  if (!c) return;
  renderCover(c, {
    style: styleId,
    mode: 'pure',
    ratio: state.ratio,
    seed: state.seed,
    size: cardSize(),
  });
}

for (const key of Object.keys(STYLES)) {
  const s = STYLES[key];
  const card = document.createElement('button');
  card.className = 'card';
  // no native tooltip: the label already answers on hover, in the page's own voice
  const label = document.createElement('span');
  label.className = 'card-label';
  label.innerHTML = `${EN_NAMES[s.id]}<small>${s.id}</small>`;
  card.setAttribute('aria-label', `${EN_NAMES[s.id]} (${s.id})`);
  const c = document.createElement('canvas');
  c.className = 'card-canvas';
  cardEls[s.id] = card;
  cardCanvases[s.id] = c;
  card.append(label, c);
  card.addEventListener('click', () => {
    selectStyle(s.id);
    showFocus(card);
  });
  rackRow.appendChild(card);
}

/* One spine per frame, so the first card is on the wall before the last one
 * is drawn — the entrance stagger hides the rest of the work. */
function renderRack() {
  const ids = Object.keys(cardCanvases);
  if (REDUCED_MOTION || document.hidden) {
    for (const id of ids) renderCard(id);
    return;
  }
  let i = 0;
  const step = () => {
    if (i >= ids.length) return;
    renderCard(ids[i++]);
    requestAnimationFrame(step);
  };
  step();
}

/* gentle parallax: the whole rack breathes with the pointer */
let parallaxRaf = null;
rackEl.addEventListener('pointermove', e => {
  if (REDUCED_MOTION || view !== 'rack') return;
  if (parallaxRaf) return;
  parallaxRaf = requestAnimationFrame(() => {
    parallaxRaf = null;
    const nx = (e.clientX / window.innerWidth) - 0.5;
    const ny = (e.clientY / window.innerHeight) - 0.5;
    rackRow.style.transform = `rotateY(${(nx * 3.2).toFixed(2)}deg) rotateX(${(-ny * 1.6).toFixed(2)}deg)`;
  });
});
rackEl.addEventListener('pointerleave', () => {
  rackRow.style.transform = '';
});

/* remove the boot gate once the entrance has played */
setTimeout(() => document.body.classList.remove('boot'), 1700);

/* ---------- flight: one continuous shot between scenes ---------- */

let view = 'rack';
let inFlight = false;
let rackStale = false;

/* A flight must always end: WAAPI never fires onfinish in a background
 * tab, and a stranded traveler would block every later navigation. */
function guardFlight(traveler, ms, after) {
  let ended = false;
  const done = () => {
    if (ended) return;
    ended = true;
    traveler.remove();
    document.body.classList.remove('flight');
    inFlight = false;
    if (after) after();
  };
  setTimeout(done, ms);
  return done;
}

function makeTraveler(srcCanvas, rect, maxSrc) {
  const t = document.createElement('div');
  t.className = 'traveler';
  const tc = document.createElement('canvas');
  const k = Math.min(1, maxSrc / srcCanvas.width);
  tc.width = Math.round(srcCanvas.width * k);
  tc.height = Math.round(srcCanvas.height * k);
  tc.getContext('2d').drawImage(srcCanvas, 0, 0, tc.width, tc.height);
  t.appendChild(tc);
  Object.assign(t.style, {
    left: rect.left + 'px',
    top: rect.top + 'px',
    width: rect.width + 'px',
    height: rect.height + 'px',
  });
  document.body.appendChild(t);
  return t;
}

/* The card and the cover have different shapes, so the traveler opens its
 * frame rather than scaling: object-fit keeps the picture still while the
 * crop widens, which is how a cropped thumbnail honestly becomes the whole
 * image. Only this one fixed element relayouts, and the flight is the one
 * moment nothing else is competing for the main thread. */
function boxFrames(r0, r1) {
  return [
    { left: r0.left + 'px', top: r0.top + 'px', width: r0.width + 'px', height: r0.height + 'px' },
    { left: r1.left + 'px', top: r1.top + 'px', width: r1.width + 'px', height: r1.height + 'px' },
  ];
}

function measureCoverRect() {
  const R = RATIOS[state.ratio];
  if (canvas.width !== R.w || canvas.height !== R.h) {
    canvas.width = R.w;
    canvas.height = R.h;
  }
  return canvas.getBoundingClientRect();
}

function showFocus(fromCard) {
  if (view === 'focus' || inFlight) return;
  view = 'focus';
  const fly = fromCard && !REDUCED_MOTION && (!document.hidden || window.__forceFly);

  if (!fly) {
    document.body.classList.add('view-focus');
    document.body.classList.remove('view-rack');
    render();
    return;
  }

  inFlight = true;
  const art = fromCard.querySelector('canvas');
  const r0 = art.getBoundingClientRect();
  const traveler = makeTraveler(art, r0, CARD_LONG);

  document.body.classList.add('flight', 'view-focus');
  document.body.classList.remove('view-rack');

  const r1 = measureCoverRect();
  const anim = traveler.animate(boxFrames(r0, r1), { duration: 620, easing: EASE, fill: 'forwards' });
  // the toolbar and back control rise as the cover lands
  const bar = document.querySelector('.bar');
  const backBtn = document.getElementById('back');
  bar.animate(
    [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }],
    { duration: 460, delay: 280, easing: EASE, fill: 'backwards' }
  );
  backBtn.animate(
    [{ opacity: 0 }, { opacity: 1 }],
    { duration: 300, delay: 380, easing: 'ease', fill: 'backwards' }
  );

  /* Nothing heavy may touch the main thread while the traveler is in the
   * air: a full frame blocks for up to a second and freezes the flight
   * mid-arc. The cover is painted only once the traveler has landed — it
   * is hidden behind it until then anyway — and the sharp pass waits for
   * the hand-off to finish. */
  const finish = guardFlight(traveler, 1600, () => { paintPreview(); scheduleFull(); });
  const land = () => {
    paintPreview();
    traveler.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'ease', fill: 'forwards' })
      .onfinish = () => { finish(); scheduleFull(); };
  };
  if (anim.playState === 'finished') land();
  else anim.onfinish = land;
}

function showRack() {
  if (view === 'rack' || inFlight) return;
  view = 'rack';
  renderCard(state.style); // the spine reflects what was made in focus
  if (rackStale) {
    rackStale = false;
    const rest = Object.keys(cardCanvases).filter(id => id !== state.style);
    let i = 0;
    const step = () => {
      if (i >= rest.length || view !== 'rack') return;
      renderCard(rest[i++]);
      requestAnimationFrame(step);
    };
    setTimeout(step, 700); // after the return flight has landed
  }

  const fly = !REDUCED_MOTION && (!document.hidden || window.__forceFly) && canvas.width > 300;
  if (!fly) {
    document.body.classList.add('view-rack');
    document.body.classList.remove('view-focus');
    return;
  }

  inFlight = true;
  const r0 = canvas.getBoundingClientRect();
  const traveler = makeTraveler(canvas, r0, 1024);

  document.body.classList.add('flight', 'view-rack');
  document.body.classList.remove('view-focus');

  const finish = guardFlight(traveler, 1200);
  requestAnimationFrame(() => {
    const rT = cardCanvases[state.style].getBoundingClientRect();
    const [a, b] = boxFrames(r0, rT);
    traveler.animate(
      [
        Object.assign({ opacity: 1 }, a),
        Object.assign({ opacity: 1, offset: 0.75 }, b),
        Object.assign({ opacity: 0 }, b),
      ],
      { duration: 560, easing: EASE, fill: 'forwards' }
    ).onfinish = finish;
  });
}
document.getElementById('back').addEventListener('click', () => showRack());

/* anywhere off the cover and its toolbar dismisses the scene */
document.getElementById('focus').addEventListener('click', e => {
  if (view !== 'focus' || inFlight) return;
  if (e.target.closest('.stage') || e.target.closest('.bar')) return;
  showRack();
});

/* The rack is the style picker; the focus scene only ever shows one cover. */
function selectStyle(id) {
  state.style = id;
}

/* ---------- segmented controls & inputs ---------- */

const ratiosEl = document.getElementById('ratios');
ratiosEl.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === state.ratio) return;
  ratiosEl.querySelectorAll('button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  changeRatio(b.dataset.v);
});

/*
 * One frame, changing shape. Both the outgoing picture and the incoming one
 * are pinned inside the same box while it morphs, so object-fit re-crops
 * them together and the eye follows a single object throughout — swapping
 * one still layer for another would read as a cut, however it is timed.
 */
const stageEl = document.querySelector('.stage');
let morphTimer = null;

function endMorph() {
  clearTimeout(morphTimer);
  morphTimer = null;
  stageEl.style.width = '';
  stageEl.style.height = '';
  stageEl.classList.remove('morphing');
  canvas.classList.remove('fill');
  ghost.style.transition = 'none';
  ghost.style.opacity = '0';
  inFlight = false;
}

function changeRatio(next) {
  rackStale = true; // spines mirror the cover's ratio
  const commit = () => { state.ratio = next; persist(); };
  const fly = view === 'focus' && !inFlight && !REDUCED_MOTION
    && (!document.hidden || window.__forceFly) && canvas.width > 300;
  if (!fly) {
    commit();
    render();
    return;
  }

  inFlight = true;
  const r0 = canvas.getBoundingClientRect();
  snapshotToGhost();                 // the outgoing picture, held

  commit();
  paintPreview();                    // the incoming picture, at its new shape
  lastRatio = next;
  const r1 = canvas.getBoundingClientRect(); // where the frame is headed

  // pin both layers to the box and freeze it at the old size
  stageEl.classList.add('morphing');
  canvas.classList.add('fill');
  stageEl.style.width = r0.width + 'px';
  stageEl.style.height = r0.height + 'px';

  requestAnimationFrame(() => {
    stageEl.animate(
      [
        { width: r0.width + 'px', height: r0.height + 'px' },
        { width: r1.width + 'px', height: r1.height + 'px' },
      ],
      { duration: 560, easing: EASE, fill: 'forwards' }
    );
    ghost.style.transition = 'none';
    ghost.style.opacity = '1';
    ghost.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }],
      { duration: 560, easing: 'ease', fill: 'forwards' }
    ).onfinish = () => { endMorph(); scheduleFull(); };
  });
  morphTimer = setTimeout(() => { endMorph(); scheduleFull(); }, 1100);
}

/* reflect the restored session in the controls */
const titleInput = document.getElementById('title-input');
titleInput.value = state.title;
ratiosEl.querySelectorAll('button').forEach(b => {
  b.classList.toggle('on', b.dataset.v === state.ratio);
});

let debounce = null;
titleInput.addEventListener('input', e => {
  state.title = e.target.value;
  persist();
  clearTimeout(debounce);
  debounce = setTimeout(render, 200);
});
document.getElementById('title-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') shuffle();
});

/* ---------- asset: one button, kind auto-detected ---------- */

const assetBtn = document.getElementById('asset-btn');
const assetInput = document.getElementById('asset-input');

assetBtn.addEventListener('click', () => {
  if (state.assetImg) {
    state.assetImg = null;
    assetBtn.title = 'Add asset';
    assetBtn.classList.remove('loaded');
    render();
  } else {
    assetInput.click();
  }
});

assetInput.addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  loadAssetFromUrl(URL.createObjectURL(f));
  assetInput.value = '';
});

function detectKind(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, 48, 48);
  const d = g.getImageData(0, 0, 48, 48).data;
  for (let i = 3; i < d.length; i += 16) {
    if (d[i] < 250) return 'logo';
  }
  const ar = img.width / img.height;
  return (ar >= 1.35 || ar <= 1 / 1.35) ? 'ui' : 'photo';
}

function loadAssetFromUrl(url, kind) {
  const img = new Image();
  img.onload = () => {
    state.assetImg = img;
    state.assetKind = kind || detectKind(img);
    assetBtn.title = 'Remove asset';
    assetBtn.classList.add('loaded');
    render();
  };
  img.src = url;
}

/* ---------- actions ---------- */

const shuffleBtn = document.getElementById('shuffle');
function shuffle() {
  state.seed = (state.seed * 1664525 + 1013904223) >>> 0;
  persist();
  rackStale = true;
  if (!REDUCED_MOTION && shuffleBtn.firstElementChild.animate) {
    shuffleBtn.firstElementChild.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 480, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)' }
    );
  }
  render();
}
shuffleBtn.addEventListener('click', shuffle);
canvas.addEventListener('click', shuffle);
canvas.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); shuffle(); }
});

const downloadBtn = document.getElementById('download');
let downloadTimer = null;
function download() {
  ensureFull();
  canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.download = `cover-${state.style}-${state.ratio}-${state.seed}.png`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    downloadBtn.classList.add('done');
    clearTimeout(downloadTimer);
    downloadTimer = setTimeout(() => downloadBtn.classList.remove('done'), 1400);
  }, 'image/png');
}
downloadBtn.addEventListener('click', download);

/* keyboard: 1–9 pick a style, space/r reshuffle, d download, esc back */
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const id = 'S' + e.key;
    selectStyle(id);
    if (view === 'rack') showFocus(cardEls[id]);
    else render();
  } else if (e.key === 'Escape') {
    showRack();
  } else if (view !== 'focus') {
    return;
  } else if (e.key === ' ' || e.key === 'r') {
    e.preventDefault();
    shuffle();
  } else if (e.key === 'd') {
    e.preventDefault();
    download();
  }
});

/* ---------- render pipeline ---------- */

let lastReport = null;
let renderQueued = false;
let firstPaint = true;
let lastRatio = null;

function coverOpts() {
  return {
    style: state.style,
    mode: state.assetImg ? 'asset' : (state.title.trim() ? 'text' : 'pure'),
    ratio: state.ratio,
    seed: state.seed,
    title: state.title,
    assetImg: state.assetImg,
    assetKind: state.assetKind,
  };
}

/*
 * A full frame is 26 megapixels and costs up to a second, which is far too
 * slow to sit between a keystroke and its result. So every interaction paints
 * a quarter-scale preview immediately — same seed, same composition, just
 * softer — and the full-resolution frame lands afterwards while the browser
 * is idle. Downloads always force the sharp one first.
 */
const PREVIEW_DIV = 4;
const previewCanvas = document.createElement('canvas');
let renderGen = 0;
let fullFresh = false;
let idleHandle = null;

function doRender() {
  lastReport = renderCover(canvas, coverOpts());
  fullFresh = true;
}

function paintPreview() {
  const R = RATIOS[state.ratio];
  lastReport = renderCover(previewCanvas, Object.assign(coverOpts(), {
    size: { w: Math.round(R.w / PREVIEW_DIV), h: Math.round(R.h / PREVIEW_DIV) },
  }));
  if (canvas.width !== R.w || canvas.height !== R.h) {
    canvas.width = R.w;
    canvas.height = R.h;
  }
  const c = canvas.getContext('2d');
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(previewCanvas, 0, 0, R.w, R.h);
  fullFresh = false;
}

function scheduleFull() {
  const gen = ++renderGen;
  if (idleHandle && window.cancelIdleCallback) cancelIdleCallback(idleHandle);
  const run = () => {
    idleHandle = null;
    if (gen !== renderGen || view !== 'focus') return; // superseded
    doRender();
  };
  idleHandle = window.requestIdleCallback
    ? requestIdleCallback(run, { timeout: 500 })
    : setTimeout(run, 150);
}

/* the sharp frame must exist before anything reads pixels out of the canvas */
function ensureFull() {
  if (!fullFresh) {
    renderGen++;
    doRender();
  }
}

/* Hold the outgoing frame on the ghost canvas, compose the next one
 * beneath it, then release it — the swap reads as one continuous image. */
function snapshotToGhost() {
  const gw = Math.min(1024, canvas.width);
  ghost.width = gw;
  ghost.height = Math.max(1, Math.round(gw * canvas.height / canvas.width));
  gctx.drawImage(canvas, 0, 0, ghost.width, ghost.height);
  ghost.style.transition = 'none';
  ghost.style.opacity = '1';
}
function releaseGhost() {
  requestAnimationFrame(() => {
    void ghost.offsetWidth;
    ghost.style.transition = 'opacity 0.45s ease';
    ghost.style.opacity = '0';
  });
}

const renderCallbacks = [];
function render(onDone) {
  if (onDone) renderCallbacks.push(onDone);
  if (renderQueued) return;
  renderQueued = true;
  const sameFrame = !firstPaint && lastRatio === state.ratio && !inFlight;
  const crossfade = sameFrame && !document.hidden && !REDUCED_MOTION;
  if (crossfade) {
    snapshotToGhost();
  } else {
    canvas.classList.add('busy');
    ghost.style.transition = 'none';
    ghost.style.opacity = '0';
  }
  const run = () => {
    renderQueued = false;
    paintPreview();
    scheduleFull();
    firstPaint = false;
    lastRatio = state.ratio;
    canvas.classList.remove('busy');
    if (crossfade) releaseGhost();
    while (renderCallbacks.length) renderCallbacks.shift()();
  };
  // rAF stalls in background tabs; render immediately there instead
  if (document.hidden) setTimeout(run, 0);
  else requestAnimationFrame(() => requestAnimationFrame(run));
}

/* test hooks */
window.__setState = patch => { Object.assign(state, patch); doRender(); return lastReport; };
window.__ensureFull = ensureFull;
window.__isFullFresh = () => fullFresh;
window.__getReport = () => lastReport;
window.__loadAsset = loadAssetFromUrl;
window.__showFocus = () => showFocus(cardEls[state.style]);
window.__showRack = showRack;

renderRack();
})();
