/* mandarin-cards — scheduling, storage and UI.
 *
 * Model: a "card" is a (word, direction) pair, so 好 → good and good → hǎo carry
 * independent memory. Records live in state.cards keyed `${wordId}:${dirCode}`.
 *
 * Scheduler: Leitner-style levels with fixed intervals (LEVEL_MIN). Due cards come
 * first; then new words from the manually released pool; then, so a session is never
 * empty and strong cards never fall out of rotation entirely, a weighted-random
 * "filler" draw over not-yet-due cards whose weight rises with elapsed fraction of
 * the interval and falls with level. Weight is strictly positive at every level.
 */

'use strict';

/* ── constants ──────────────────────────────────────────── */

const STORE_KEY = 'mandarin-cards.v1';
const DAY = 1440;                       // minutes
const LEVEL_MIN = [1, 10, DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 120 * DAY];
const MAX_LEVEL = LEVEL_MIN.length - 1;
const MATURE_LEVEL = 5;                 // interval >= 14 days
const LEARN_BUFFER = 5;                 // learning cards held in flight before draining
const HIST_DAYS = 90;
const UNDO_DEPTH = 30;

const DIRS = [
  { code: 'hz>en', from: 'hz', to: 'en', label: '汉字 → English', short: '汉 → EN' },
  { code: 'hz>py', from: 'hz', to: 'py', label: '汉字 → Pīnyīn', short: '汉 → PY' },
  { code: 'py>en', from: 'py', to: 'en', label: 'Pīnyīn → English', short: 'PY → EN' },
  { code: 'en>py', from: 'en', to: 'py', label: 'English → Pīnyīn', short: 'EN → PY' },
];
const DIR_BY_CODE = Object.fromEntries(DIRS.map(d => [d.code, d]));

const BUCKETS = [
  { name: 'New', color: '#3a4249', test: r => !r },
  { name: 'Learning', color: '#e05555', test: r => r.l <= 1 },
  { name: 'Young', color: '#d38b2b', test: r => r.l <= 4 },
  { name: 'Mature', color: '#3f9f5f', test: r => r.l <= 6 },
  { name: 'Solid', color: '#4c8dd8', test: () => true },
];

/* ── state ──────────────────────────────────────────────── */

const DEFAULTS = () => ({
  v: 1,
  cards: {},                                   // "id:dir" -> {l, due, reps, lapses, last}
  hist: {},                                    // "YYYY-MM-DD" -> review count
  daily: { date: '', used: {} },               // new cards introduced today, per direction
  settings: {
    maxSection: 2,
    maxUnit: 14,
    dirs: ['hz>en'],
    hzAnswer: 'en',     // remembered answer side for 汉字 prompts, which allow both
    released: 0,        // words unlocked, counted in course order; see isReleased()
    autoRelease: 0,     // optional per-day top-up; 0 means release only by hand
    tones: 'marks',
  },
});

let WORDS = [];
let state = DEFAULTS();
let current = null;          // {word, dir, key, rec}
let revealed = false;
let lastKey = null;
let undoStack = [];
let sessionCount = 0;

/* ── storage ────────────────────────────────────────────── */

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const got = JSON.parse(raw);
    state = Object.assign(DEFAULTS(), got);
    state.settings = Object.assign(DEFAULTS().settings, got.settings || {});
    migrate(got);
  } catch (err) {
    console.warn('could not read saved progress, starting fresh', err);
  }
}

/* Progress saved before manual release existed has no `released` pointer. Anything
 * already studied was necessarily released, so seed the pointer past the furthest
 * card on record — otherwise a returning deck would look entirely locked. */
function migrate(got) {
  if (typeof (got.settings || {}).released === 'number') return;
  let furthest = -1;
  for (const key of Object.keys(state.cards)) {
    const id = parseInt(key, 10);
    if (Number.isFinite(id) && id > furthest) furthest = id;
  }
  state.settings.released = furthest + 1;
  // The old daily allowance is deliberately not carried over: release is manual now,
  // and a surviving drip would quietly add words on top of every batch.
  state.settings.autoRelease = 0;
  delete state.settings.newPerDay;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      toast('Could not save progress — storage may be full.');
      console.error(err);
    }
  }, 150);
}

/* ── helpers ────────────────────────────────────────────── */

const $ = sel => document.querySelector(sel);
const now = () => Date.now();
const dayKey = (t = now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function fmtInterval(min) {
  if (min < 60) return `${Math.round(min)} min`;
  if (min < DAY) return `${Math.round(min / 60)} h`;
  const d = min / DAY;
  if (d < 31) return `${Math.round(d)} d`;
  return `${(d / 30.4).toFixed(1)} mo`;
}

const TONE_MAP = {
  ā: 'a1', á: 'a2', ǎ: 'a3', à: 'a4',
  ē: 'e1', é: 'e2', ě: 'e3', è: 'e4',
  ī: 'i1', í: 'i2', ǐ: 'i3', ì: 'i4',
  ō: 'o1', ó: 'o2', ǒ: 'o3', ò: 'o4',
  ū: 'u1', ú: 'u2', ǔ: 'u3', ù: 'u4',
  ǖ: 'v1', ǘ: 'v2', ǚ: 'v3', ǜ: 'v4', ü: 'v',
};

function toNumbered(py) {
  return py.split(/\s+/).map(syl => {
    let tone = '';
    let out = '';
    for (const ch of syl) {
      const m = TONE_MAP[ch] || TONE_MAP[ch.toLowerCase()];
      if (m) {
        out += m[0];
        if (m[1]) tone = m[1];
      } else {
        out += ch;
      }
    }
    return out + tone;
  }).join(' ');
}

const showPinyin = py => state.settings.tones === 'numbers' ? toNumbered(py) : py;

function field(word, which) {
  if (which === 'hz') return word.hz;
  if (which === 'py') return showPinyin(word.py);
  return word.en.join(' / ');
}

/* ── deck selection ─────────────────────────────────────── */

function inRange(w) {
  const s = state.settings;
  return w.s < s.maxSection || (w.s === s.maxSection && w.u <= s.maxUnit);
}

const deck = () => WORDS.filter(inRange);
const activeDirs = () => state.settings.dirs.filter(c => DIR_BY_CODE[c]);

/* Words are stored in course order, so ids double as a position in the course and
 * `released` is simply how far down that order the queue is allowed to reach. A word
 * must be both in range and released before it can be introduced. */
const isReleased = w => w.id < state.settings.released;
const released = () => deck().filter(isReleased);
const heldBack = () => deck().filter(w => !isReleased(w));

/* Release the first n words of the deck that are still held back. */
function releaseMore(n) {
  const held = heldBack();
  if (!held.length) { toast('Everything in range is already released.'); return 0; }
  const take = Math.min(n, held.length);
  state.settings.released = held[take - 1].id + 1;
  save();
  return take;
}

function releaseThrough(section, unit) {
  const upto = WORDS.filter(w => w.s < section || (w.s === section && w.u <= unit));
  const target = upto.length ? upto[upto.length - 1].id + 1 : 0;
  const added = deck().filter(w => w.id >= state.settings.released && w.id < target).length;
  state.settings.released = Math.max(state.settings.released, target);
  save();
  return added;
}

function rollDaily() {
  const k = dayKey();
  if (state.daily.date === k) return;
  state.daily = { date: k, used: {} };
  const auto = state.settings.autoRelease | 0;
  if (auto > 0) releaseMore(auto);
  save();
}

/* ── scheduling ─────────────────────────────────────────── */

function nextLevel(level, grade) {
  if (grade === 0) return 0;
  if (grade === 1) return Math.max(0, level - 1);
  if (grade === 2) return Math.min(MAX_LEVEL, level + 1);
  return Math.min(MAX_LEVEL, level + 2);
}

function intervalFor(level) {
  const base = LEVEL_MIN[level];
  if (base < DAY) return base;
  return base * (0.95 + Math.random() * 0.1);   // fuzz to stop day-clumping
}

function grade(g) {
  if (!current) return;
  const { key, rec } = current;
  undoStack.push({ key, before: rec ? { ...rec } : null, day: dayKey(), isNew: !rec });
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();

  const t = now();
  const level = rec ? rec.l : 0;
  let next;

  if (current.extra && g > 0) {
    // Bonus rep on a card that was not yet due. Getting it right is not new
    // evidence of retention at this interval, so leave the schedule untouched —
    // otherwise idle drilling would inflate intervals without being earned.
    next = { ...rec, reps: rec.reps + 1 };
  } else {
    const nl = nextLevel(level, g);
    next = {
      l: nl,
      due: t + intervalFor(nl) * 60000,
      reps: (rec ? rec.reps : 0) + 1,
      lapses: (rec ? rec.lapses : 0) + (g === 0 && rec && rec.l >= 2 ? 1 : 0),
      last: t,
    };
  }
  state.cards[key] = next;

  const dk = dayKey();
  state.hist[dk] = (state.hist[dk] || 0) + 1;
  pruneHist();

  sessionCount++;
  lastKey = key;
  save();
  drawCard();
}

function undo() {
  const u = undoStack.pop();
  if (!u) { toast('Nothing to undo.'); return; }
  if (u.before) state.cards[u.key] = u.before;
  else delete state.cards[u.key];
  state.hist[u.day] = Math.max(0, (state.hist[u.day] || 1) - 1);
  sessionCount = Math.max(0, sessionCount - 1);
  save();
  toast('Undone.');
  drawCard();
}

function pruneHist() {
  const keys = Object.keys(state.hist);
  if (keys.length <= HIST_DAYS) return;
  keys.sort();
  for (const k of keys.slice(0, keys.length - HIST_DAYS)) delete state.hist[k];
}

/* Pick the next card. Priority: overdue learning → overdue review → new (from the
 * released pool) → weighted filler over not-yet-due cards. */
function pickNext() {
  rollDaily();
  const dirs = activeDirs();
  const words = deck();
  if (!dirs.length || !words.length) return null;

  const t = now();
  const learn = [], review = [], fresh = [], later = [];

  for (const d of dirs) {
    for (const w of words) {
      const key = `${w.id}:${d}`;
      const rec = state.cards[key];
      const item = { w, d, key, rec };
      if (!rec) {
        if (isReleased(w)) fresh.push(item);   // held-back words never enter the queue
        continue;
      }
      if (rec.due <= t) (rec.l <= 1 ? learn : review).push(item);
      else later.push(item);
    }
  }
  fresh.sort((a, b) => a.w.id - b.w.id);       // introduce in course order

  const notLast = arr => {
    const f = arr.filter(x => x.key !== lastKey);
    return f.length ? f : arr;
  };

  const serveLearn = () => {
    const pool = notLast(learn);
    pool.sort((a, b) => a.rec.due - b.rec.due);
    return pool[0];
  };

  // Drain the learning buffer once it grows past LEARN_BUFFER, otherwise let
  // reviews and new material interleave so a session isn't a wall of one kind.
  if (learn.length >= LEARN_BUFFER) return serveLearn();
  if (review.length) {
    const pool = notLast(review);
    pool.sort((a, b) => a.rec.due - b.rec.due);
    // slight shuffle among the most overdue so order isn't identical each session
    return pool[Math.floor(Math.random() * Math.min(5, pool.length))];
  }
  if (fresh.length) return fresh[0];
  if (learn.length) return serveLearn();
  if (later.length) {
    const pool = notLast(later);
    let total = 0;
    const weights = pool.map(x => {
      const span = Math.max(1, x.rec.due - x.rec.last);
      const frac = Math.min(1, (t - x.rec.last) / span);
      const w = (0.02 + frac * frac) / Math.pow(x.rec.l + 1, 1.5) * (1 + 0.4 * x.rec.lapses);
      total += w;
      return w;
    });
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return { ...pool[i], extra: true };
    }
    return { ...pool[pool.length - 1], extra: true };
  }
  return null;
}

/* ── study view ─────────────────────────────────────────── */

function drawCard() {
  const pick = pickNext();
  current = pick && {
    word: pick.w, dir: DIR_BY_CODE[pick.d], key: pick.key, rec: pick.rec, extra: !!pick.extra,
  };
  revealed = false;

  const cardEl = $('#card'), emptyEl = $('#empty');
  if (!current) {
    cardEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    const c = counts();
    emptyEl.innerHTML = c.held && !c.released
      ? `<p>No words released yet.</p>
         <p class="sub">${c.held} words are in range and waiting.
         Open <b>Setup</b> and release as many as you want to study.</p>`
      : `<p>No cards in range.</p>
         <p class="sub">Pick a vocabulary range and at least one direction in <b>Setup</b>.</p>`;
    updateCounter();
    return;
  }
  cardEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');

  const { word, dir, rec } = current;

  $('#dir-label').textContent = dir.label;
  $('#lesson-label').textContent = `S${word.s} · U${word.u}`;
  $('#strength-label').textContent = rec
    ? `${bucketOf(rec).name} · ${fmtInterval(LEVEL_MIN[rec.l])}`
    : 'New';
  $('#extra-label').classList.toggle('hidden', !current.extra);

  const p = $('#prompt');
  p.textContent = field(word, dir.from);
  p.className = 'prompt' + (dir.from === 'hz' ? ' hanzi' : '');

  const a = $('#answer');
  a.textContent = field(word, dir.to);
  a.className = 'answer hidden' + (dir.to === 'hz' ? ' hanzi' : '');

  // context: whichever of the three fields was neither prompt nor answer
  const shown = new Set([dir.from, dir.to]);
  const rest = ['hz', 'py', 'en'].filter(k => !shown.has(k));
  $('#extra').innerHTML = rest
    .map(k => k === 'hz' ? `<span class="x-hz">${word.hz}</span>` : field(word, k))
    .join(' &nbsp;·&nbsp; ');
  $('#extra').classList.add('hidden');

  $('#reveal').classList.remove('hidden');
  $('#grades').classList.add('hidden');

  const level = rec ? rec.l : 0;
  for (let g = 0; g < 4; g++) {
    $('#iv' + g).textContent = (current.extra && g > 0)
      ? 'no change'
      : fmtInterval(LEVEL_MIN[nextLevel(level, g)]);
  }
  updateCounter();
}

function reveal() {
  if (!current || revealed) return;
  revealed = true;
  $('#answer').classList.remove('hidden');
  $('#extra').classList.remove('hidden');
  $('#reveal').classList.add('hidden');
  $('#grades').classList.remove('hidden');
}

/* ── direction switcher ─────────────────────────────────── */

/* The Study bar drives settings.dirs directly. A single active direction shows as its
 * prompt side; anything else reads as "Mix". Pīnyīn and English prompts admit only one
 * answer side, so those buttons are disabled rather than hidden — the row keeps its
 * height and the constraint stays visible. */
const ANSWER_FOR = { py: 'en', en: 'py' };

function promptMode() {
  const d = activeDirs();
  return d.length === 1 ? DIR_BY_CODE[d[0]].from : 'mix';
}

function setPrompt(mode) {
  const s = state.settings;
  if (mode === 'mix') s.dirs = DIRS.map(d => d.code);
  else if (mode === 'hz') s.dirs = [`hz>${s.hzAnswer || 'en'}`];
  else s.dirs = [`${mode}>${ANSWER_FOR[mode]}`];
  save();
  renderDirBar();
  drawCard();
}

function setAnswer(side) {
  const s = state.settings;
  s.hzAnswer = side;
  if (promptMode() === 'hz') s.dirs = [`hz>${side}`];
  save();
  renderDirBar();
  drawCard();
}

function renderDirBar() {
  const mode = promptMode();
  document.querySelectorAll('#seg-prompt button').forEach(b =>
    b.classList.toggle('on', b.dataset.prompt === mode));

  const answer = mode === 'hz' ? (state.settings.hzAnswer || 'en') : ANSWER_FOR[mode];
  document.querySelectorAll('#seg-answer button').forEach(b => {
    const side = b.dataset.answer;
    b.classList.toggle('on', mode !== 'mix' && side === answer);
    b.disabled = mode !== 'hz';
  });
}

function renderReleaseBar() {
  const held = heldBack().length;
  const bar = $('#release-bar');
  bar.classList.toggle('hidden', held === 0);
  if (held) {
    const next = heldBack()[0];
    $('#release-bar-label').textContent =
      `${held} word${held === 1 ? '' : 's'} held back, from S${next.s} U${next.u} — add`;
  }
}

function bucketOf(rec) {
  for (const b of BUCKETS) if (b.test(rec)) return b;
  return BUCKETS[BUCKETS.length - 1];
}

function counts() {
  rollDaily();
  const t = now();
  const dirs = activeDirs();
  const words = deck();
  let due = 0, newLeft = 0, seen = 0, mature = 0;
  for (const d of dirs) {
    for (const w of words) {
      const rec = state.cards[`${w.id}:${d}`];
      if (!rec) { if (isReleased(w)) newLeft++; continue; }
      seen++;
      if (rec.l >= MATURE_LEVEL) mature++;
      if (rec.due <= t) due++;
    }
  }
  return {
    due, newLeft, seen, mature,
    cards: words.length * dirs.length,
    words: words.length,
    released: released().length,
    held: heldBack().length,
  };
}

function updateCounter() {
  const c = counts();
  $('#counter').textContent = `${c.due} due · ${c.newLeft} new · ${sessionCount} done`;

  let line = '';
  if (c.due === 0 && c.newLeft === 0 && sessionCount > 0) {
    line = c.held
      ? `Everything released is under control — ${c.held} more word${c.held === 1 ? '' : 's'} waiting in Setup.`
      : 'Everything due is cleared — these are extra reps drawn from your weaker cards.';
  }
  $('#session-line').textContent = line;
  renderReleaseBar();
}

/* ── stats view ─────────────────────────────────────────── */

function renderStats() {
  const c = counts();
  const words = deck();
  const dirs = activeDirs();

  $('#stat-tiles').innerHTML = [
    ['Words in range', c.words],
    ['Cards tracked', c.cards],
    ['Seen', c.seen],
    ['Mature', c.mature],
    ['Due now', c.due],
    ['New left today', c.newLeft],
  ].map(([k, v]) => `<div class="tile"><b>${v}</b><span>${k}</span></div>`).join('');

  // stacked bars, one row per direction
  const rows = DIRS.map(d => {
    const tally = BUCKETS.map(() => 0);
    for (const w of words) {
      const rec = state.cards[`${w.id}:${d.code}`];
      tally[BUCKETS.indexOf(bucketOf(rec))]++;
    }
    const total = tally.reduce((a, b) => a + b, 0) || 1;
    const known = total - tally[0];
    const segs = tally.map((n, i) =>
      n ? `<div style="width:${(n / total * 100).toFixed(2)}%;background:${BUCKETS[i].color}" title="${BUCKETS[i].name}: ${n}"></div>` : ''
    ).join('');
    const on = dirs.includes(d.code) ? '' : ' (not in rotation)';
    return `<div class="bar-row">
      <div class="bar-head"><b>${d.label}</b><span>${known} / ${total} started${on}</span></div>
      <div class="bar">${segs}</div>
    </div>`;
  }).join('');

  $('#chart-dirs').innerHTML = rows + `<div class="legend">` +
    BUCKETS.map(b => `<span><i style="background:${b.color}"></i>${b.name}</span>`).join('') + `</div>`;

  // reviews per day, last 30 days
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(dayKey(now() - i * 86400000));
  const vals = days.map(d => state.hist[d] || 0);
  const max = Math.max(1, ...vals);
  $('#chart-history').innerHTML =
    `<div class="hist">${vals.map((v, i) =>
      `<div style="height:${(v / max * 100).toFixed(1)}%;opacity:${v ? 0.85 : 0.15}" title="${days[i]}: ${v}"></div>`
    ).join('')}</div>
    <div class="hist-labels"><span>${days[0].slice(5)}</span><span>peak ${max}/day</span><span>today ${vals[29]}</span></div>`;

  // weakest cards
  const seen = [];
  for (const w of words) {
    for (const d of DIRS) {
      const rec = state.cards[`${w.id}:${d.code}`];
      if (rec) seen.push({ w, d, rec });
    }
  }
  seen.sort((a, b) => (b.rec.lapses - a.rec.lapses) || (a.rec.l - b.rec.l) || (a.rec.due - b.rec.due));
  $('#weak-list').innerHTML = seen.slice(0, 25).map(x => `
    <div class="weak-row">
      <span class="hz">${x.w.hz}</span>
      <span class="py">${showPinyin(x.w.py)}</span>
      <span class="en">${x.w.en.join(' / ')}</span>
      <span class="tag">${x.d.short} · ${x.rec.lapses} lapse${x.rec.lapses === 1 ? '' : 's'} · ${fmtInterval(LEVEL_MIN[x.rec.l])}</span>
    </div>`).join('') || '<p class="hint">Nothing reviewed yet.</p>';
}

/* ── setup view ─────────────────────────────────────────── */

function maxUnitIn(section) {
  return Math.max(...WORDS.filter(w => w.s === section).map(w => w.u));
}

function renderSetup() {
  const s = state.settings;
  const sections = [...new Set(WORDS.map(w => w.s))].sort((a, b) => a - b);

  const selS = $('#sel-section');
  selS.innerHTML = sections.map(n => `<option value="${n}">${n}</option>`).join('');
  selS.value = s.maxSection;

  const selU = $('#sel-unit');
  const units = maxUnitIn(s.maxSection);
  selU.innerHTML = Array.from({ length: units }, (_, i) =>
    `<option value="${i + 1}">${i + 1}</option>`).join('');
  selU.value = Math.min(s.maxUnit, units);

  $('#range-count').textContent = `${deck().length} words`;

  $('#dir-picker').innerHTML = DIRS.map(d => `
    <label class="dir-opt${s.dirs.includes(d.code) ? ' on' : ''}">
      <input type="checkbox" value="${d.code}"${s.dirs.includes(d.code) ? ' checked' : ''}>
      <span class="cjk">${d.label}</span>
    </label>`).join('');

  $('#auto-release').value = s.autoRelease;
  $('#show-tones').value = s.tones;
  renderRelease();
}

function renderRelease() {
  const d = deck(), rel = released(), held = heldBack();
  const nDirs = activeDirs().length;
  const pct = d.length ? (rel.length / d.length * 100) : 0;

  const next = held.length
    ? `Next up: ${held.slice(0, 3).map(w => w.hz).join(' ')}${held.length > 3 ? ' …' : ''}
       from S${held[0].s} U${held[0].u}.`
    : 'Everything in range has been released.';

  $('#release-status').innerHTML =
    `<b>${rel.length}</b> of ${d.length} words released
     &nbsp;·&nbsp; ${held.length} held back
     &nbsp;·&nbsp; ${rel.length * nDirs} cards at ${nDirs} direction${nDirs === 1 ? '' : 's'}
     <span class="next-up">${next}</span>`;
  $('#release-meter').firstElementChild.style.width = `${pct.toFixed(1)}%`;

  const selS = $('#rel-section');
  if (!selS.options.length) {
    const sections = [...new Set(WORDS.map(w => w.s))].sort((a, b) => a - b);
    selS.innerHTML = sections.map(n => `<option value="${n}">${n}</option>`).join('');
    selS.value = state.settings.maxSection;
  }
  const selU = $('#rel-unit');
  const units = maxUnitIn(+selS.value);
  const keep = +selU.value;
  selU.innerHTML = Array.from({ length: units }, (_, i) =>
    `<option value="${i + 1}">${i + 1}</option>`).join('');
  selU.value = keep >= 1 && keep <= units ? keep : units;
}

function bindSetup() {
  $('#sel-section').addEventListener('change', e => {
    state.settings.maxSection = +e.target.value;
    state.settings.maxUnit = Math.min(state.settings.maxUnit, maxUnitIn(state.settings.maxSection));
    save(); renderSetup(); drawCard();
  });
  $('#sel-unit').addEventListener('change', e => {
    state.settings.maxUnit = +e.target.value;
    save();
    $('#range-count').textContent = `${deck().length} words`;
    renderRelease(); drawCard();
  });
  $('#dir-picker').addEventListener('change', () => {
    const picked = [...document.querySelectorAll('#dir-picker input:checked')].map(i => i.value);
    if (!picked.length) { toast('Keep at least one direction.'); renderSetup(); return; }
    state.settings.dirs = picked;
    if (picked.length === 1 && DIR_BY_CODE[picked[0]].from === 'hz') {
      state.settings.hzAnswer = DIR_BY_CODE[picked[0]].to;
    }
    save(); renderSetup(); renderDirBar(); drawCard();
  });
  $('#rel-section').addEventListener('change', renderRelease);

  $('#btn-release-through').addEventListener('click', () => {
    const added = releaseThrough(+$('#rel-section').value, +$('#rel-unit').value);
    toast(added ? `Released ${added} more word${added === 1 ? '' : 's'}.`
                : 'Those units were already released.');
    renderRelease(); drawCard();
  });

  $('#auto-release').addEventListener('change', e => {
    state.settings.autoRelease = Math.max(0, Math.min(500, +e.target.value || 0));
    e.target.value = state.settings.autoRelease;
    save();
  });

  $('#btn-unrelease').addEventListener('click', () => {
    let furthest = -1;
    for (const key of Object.keys(state.cards)) {
      const id = parseInt(key, 10);
      if (Number.isFinite(id) && id > furthest) furthest = id;
    }
    const before = released().length;
    state.settings.released = furthest + 1;
    save();
    const now = released().length;
    toast(before === now ? 'Nothing to hold back.' : `Held back ${before - now} unstudied words.`);
    renderRelease(); drawCard();
  });
  $('#show-tones').addEventListener('change', e => {
    state.settings.tones = e.target.value;
    save(); drawCard();
  });

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mandarin-cards-${dayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $('#io-msg').textContent = 'Exported.';
  });

  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const got = JSON.parse(await file.text());
      if (!got || typeof got.cards !== 'object') throw new Error('not a progress file');
      let merged = 0, added = 0;
      for (const [k, v] of Object.entries(got.cards)) {
        const mine = state.cards[k];
        if (!mine) { state.cards[k] = v; added++; }
        else if ((v.reps || 0) > (mine.reps || 0)) { state.cards[k] = v; merged++; }
      }
      for (const [d, n] of Object.entries(got.hist || {})) {
        state.hist[d] = Math.max(state.hist[d] || 0, n);
      }
      pruneHist();
      save();
      $('#io-msg').textContent = `Imported: ${added} new records, ${merged} updated.`;
      drawCard();
    } catch (err) {
      $('#io-msg').textContent = `Import failed: ${err.message}`;
    }
    e.target.value = '';
  });

  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Erase all review history and memory strengths on this device? This cannot be undone.')) return;
    const keep = state.settings;
    state = DEFAULTS();
    state.settings = keep;
    undoStack = [];
    sessionCount = 0;
    save();
    $('#io-msg').textContent = 'Progress reset.';
    drawCard();
  });
}

/* ── wiring ─────────────────────────────────────────────── */

function showView(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'stats') renderStats();
  if (name === 'setup') renderSetup();
}

function bind() {
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => showView(t.dataset.view)));

  // Release buttons appear on both Study and Setup; one handler serves both.
  document.querySelectorAll('[data-release]').forEach(btn =>
    btn.addEventListener('click', () => {
      const spec = btn.dataset.release;
      const got = releaseMore(spec === 'all' ? heldBack().length : +spec);
      if (got) toast(`Added ${got} word${got === 1 ? '' : 's'}.`);
      renderRelease();
      drawCard();
    }));

  $('#seg-prompt').addEventListener('click', e => {
    const b = e.target.closest('[data-prompt]');
    if (b) setPrompt(b.dataset.prompt);
  });
  $('#seg-answer').addEventListener('click', e => {
    const b = e.target.closest('[data-answer]');
    if (b && !b.disabled) setAnswer(b.dataset.answer);
  });

  $('#reveal').addEventListener('click', reveal);
  $('.card-body').addEventListener('click', () => revealed || reveal());
  $('#grades').addEventListener('click', e => {
    const b = e.target.closest('[data-grade]');
    if (b) grade(+b.dataset.grade);
  });

  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#view-study').classList.contains('active')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); revealed ? grade(2) : reveal(); }
    else if (e.key >= '1' && e.key <= '4' && revealed) { e.preventDefault(); grade(+e.key - 1); }
    else if (e.key === 'u') { e.preventDefault(); undo(); }
  });

  bindSetup();
}

async function main() {
  load();
  try {
    const res = await fetch('data/vocab.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    WORDS = (await res.json()).words;
  } catch (err) {
    $('#empty').classList.remove('hidden');
    $('#card').classList.add('hidden');
    $('#empty').innerHTML =
      `<p>Could not load the vocabulary file.</p>
       <p class="sub">${err.message}. If you opened this as a local <code>file://</code> page,
       run a local server instead — browsers block <code>fetch</code> from the filesystem:<br>
       <code>python3 -m http.server 8000</code></p>`;
    return;
  }
  bind();
  rollDaily();
  renderDirBar();
  drawCard();
}

main();
