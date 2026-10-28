// Thai text helpers: word segmentation, tone-marked romanisation (Paiboon-style),
// number reading, ๆ expansion and a "male speech" fixer for translated text.
// Pronunciation data: data/lexicon.tsv (TLTK-style phone codes, via VachanaTTS, MIT).

const THAI_RE = /[฀-๿]/;
export const hasThai = (s) => THAI_RE.test(s);

// ---------- lexicon ----------
let LEX = null;          // Map<thaiWord, phoneCode>
let MAXLEN = 1;

export function loadLexiconText(tsv) {
  LEX = new Map();
  for (const line of tsv.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 1) continue;
    const w = line.slice(0, tab);
    LEX.set(w, line.slice(tab + 1).trim());
    if (w.length > MAXLEN) MAXLEN = w.length;
  }
  MAXLEN = Math.min(MAXLEN, 32);
  // Small additions for words the lexicon lacks.
  for (const [w, p] of EXTRA) { LEX.set(w, p); }
  return LEX.size;
}
const EXTRA = [
  ['สวัสดี', 'sa?2 wat2 dI-1'],
  ['อรุณสวัสดิ์', '?a?2 run1 sa?2 wat2'],
  ['สบาย', 'sa?2 bAj1'],
  ['สบายดี', 'sa?2 bAj1 dI-1'],
  ['สนุก', 'sa?2 nuk2'],
  ['สะดวก', 'sa?2 dRk2'],
  ['ยังเลย', 'jaN1 lZj1'],
  ['สุขสันต์', 'suk2 san5'],
  ['เซอร์ไพรส์', 'sZ-1 Praj1'],
  ['โอเค', '?O-1 KE-1'],
  ['แจ็ค', 'cyk2'],
  ['จ๊ะ', 'ca?4'],
  ['นะคะ', 'na?4 Ka?4'],
];
export const lexiconReady = () => !!LEX;

// Characters that cannot start a word (following vowels, tone marks…)
const NO_START = /^[ะ-ฺๅ็-๎]/;
// Leading vowels cannot end a word
const NO_END = /[เ-ไ]$/;

// Segment text into tokens: {t: text, thai: bool, known: bool}
export function segment(text) {
  const out = [];
  const re = /[฀-๿]+|[^฀-๿]+/g;
  let m;
  while ((m = re.exec(text))) {
    const run = m[0];
    if (!hasThai(run)) { out.push({ t: run, thai: false, known: false }); continue; }
    for (const tok of segmentThaiRun(run)) out.push(tok);
  }
  return out;
}

function segmentThaiRun(s) {
  const n = s.length;
  const INF = 1e9;
  const cost = new Array(n + 1).fill(INF);
  const back = new Array(n + 1).fill(null);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    if (cost[i] >= INF) continue;
    const lim = Math.min(n, i + MAXLEN);
    for (let j = i + 1; j <= lim; j++) {
      const w = s.slice(i, j);
      if (LEX && LEX.has(w)) {
        // fewer, longer words win; prefer not splitting before a combining mark
        let c = cost[i] + 1;
        if (j < n && NO_START.test(s[j])) c += 50;
        if (c < cost[j]) { cost[j] = c; back[j] = [i, true]; }
      }
    }
    // unknown single char fallback (expensive)
    const c2 = cost[i] + 8;
    if (c2 < cost[i + 1]) { cost[i + 1] = c2; back[i + 1] = [i, false]; }
  }
  const toks = [];
  let j = n;
  while (j > 0) { const [i, known] = back[j]; toks.push({ t: s.slice(i, j), thai: true, known }); j = i; }
  toks.reverse();
  // merge consecutive unknown chars into one chunk
  const merged = [];
  for (const tk of toks) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.known && !tk.known) prev.t += tk.t;
    else if (prev && !tk.known && NO_START.test(tk.t)) { prev.t += tk.t; prev.known = false; }
    else merged.push({ ...tk });
  }
  return merged;
}

// ---------- numbers ----------
const DIG = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const PLACE = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
function below1M(n) {
  if (n === 0) return '';
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const d = +s[i];
    const pos = s.length - 1 - i;
    if (d === 0) continue;
    if (pos === 1 && d === 1) out += 'สิบ';
    else if (pos === 1 && d === 2) out += 'ยี่สิบ';
    else if (pos === 0 && d === 1 && s.length > 1) out += 'เอ็ด';
    else out += DIG[d] + PLACE[pos];
  }
  return out;
}
export function numberToThai(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return DIG[0];
  let out = '';
  const mil = Math.floor(n / 1e6), rest = n % 1e6;
  if (mil) out += numberToThai(mil) + 'ล้าน';
  out += below1M(rest);
  return out;
}

// ---------- normalisation for speech ----------
// Some sources write ำ as ํ + า; store it the standard way so the dictionary finds it
export const cleanThai = (text) => text.normalize('NFC').replace(/\u0E4D\u0E32/g, '\u0E33');

export function normaliseForSpeech(text) {
  let t = cleanThai(text);
  // Thai digits → Arabic digits
  t = t.replace(/[๐-๙]/g, (c) => String(c.charCodeAt(0) - 0x0E50));
  t = t.replace(/\d[\d,]*/g, (d) => {
    const n = parseInt(d.replace(/,/g, ''), 10);
    return Number.isFinite(n) && n < 1e12 ? numberToThai(n) : d;
  });
  // ๆ : repeat previous word
  if (t.includes('ๆ')) {
    const toks = segment(t);
    const out = [];
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk.t.trim() === 'ๆ' || tk.t === 'ๆ') {
        const prev = [...out].reverse().find((x) => x.thai);
        if (prev) out.push({ ...prev });
        continue;
      }
      if (tk.t.includes('ๆ')) {
        // e.g. lexicon word "ช้าๆ" → "ช้าช้า"
        const parts = tk.t.split('ๆ');
        let acc = '';
        for (let k = 0; k < parts.length; k++) { acc += parts[k]; if (k < parts.length - 1) acc += parts[k] || parts[k - 1] || ''; }
        out.push({ ...tk, t: acc });
        continue;
      }
      out.push(tk);
    }
    t = out.map((x) => x.t).join('');
  }
  return t.replace(/\s+/g, ' ').trim();
}

// ---------- romanisation ----------
const ONSET = { b: 'b', p: 'bp', P: 'p', m: 'm', f: 'f', d: 'd', t: 'dt', T: 't', n: 'n', s: 's', r: 'r', l: 'l', c: 'j', C: 'ch', k: 'g', K: 'k', N: 'ng', w: 'w', j: 'y', h: 'h', '?': '' };
const VOWEL = { a: 'a', A: 'aa', i: 'i', I: 'ii', u: 'u', U: 'uu', v: 'ʉ', V: 'ʉʉ', e: 'e', E: 'ee', y: 'ɛ', Y: 'ɛɛ', o: 'o', O: 'oo', x: 'ɔ', X: 'ɔɔ', z: 'ə', Z: 'əə', J: 'ia', W: 'ʉa', R: 'ua' };
const CODA = { p: 'p', m: 'm', f: 'p', t: 't', d: 't', n: 'n', s: 't', l: 'n', c: 't', k: 'k', N: 'ng', '?': '', '-': '' };
const TONE_MARK = { 1: '', 2: '̀', 3: '̂', 4: '́', 5: '̌' };
export const TONE_NAME = { 1: 'mid', 2: 'low', 3: 'falling', 4: 'high', 5: 'rising' };

function decodeSyl(code) {
  const tone = code.slice(-1), coda = code.slice(-2, -1), vowel = code.slice(-3, -2), onset = code.slice(0, -3);
  if (!'12345'.includes(tone) || !(vowel in VOWEL)) return null;
  let on = '';
  for (const ch of onset) { if (!(ch in ONSET)) return null; on += ONSET[ch]; }
  const v = VOWEL[vowel];
  let cd;
  if (coda === 'w') cd = (vowel === 'i' || vowel === 'I') ? 'u' : 'o';
  else if (coda === 'j') cd = 'i';
  else if (coda in CODA) cd = CODA[coda];
  else return null;
  const marked = (v[0] + TONE_MARK[tone] + v.slice(1)).normalize('NFC');
  return { text: on + marked + cd, tone: +tone };
}

// Returns array of words; each word = {thai, syls:[{text,tone}]|null, raw}
export function romanise(text) {
  const words = [];
  for (const tk of segment(normaliseForSpeech(text))) {
    if (!tk.thai) {
      const s = tk.t.trim();
      if (s) words.push({ thai: s, syls: null, raw: s, punct: true });
      continue;
    }
    const code = LEX && LEX.get(tk.t);
    if (!code) { words.push({ thai: tk.t, syls: null, raw: '?' }); continue; }
    const syls = code.split(/\s+/).map(decodeSyl);
    if (syls.some((x) => !x)) { words.push({ thai: tk.t, syls: null, raw: '?' }); continue; }
    words.push({ thai: tk.t, syls });
  }
  return words;
}

export function romanPlain(text) {
  return romanise(text)
    .map((w) => (w.syls ? w.syls.map((s) => s.text).join('-') : w.raw))
    .join(' ')
    .replace(/\s+([?!.,])/g, '$1');
}

// ---------- male speech fixer (for machine translation output) ----------
const MALE_SWAP = new Map([
  ['ดิฉัน', 'ผม'], ['ฉัน', 'ผม'], ['ค่ะ', 'ครับ'], ['คะ', 'ครับ'], ['นะคะ', 'นะครับ'],
]);
export function maleSpeech(text) {
  return segment(text)
    .map((tk) => (tk.thai && MALE_SWAP.has(tk.t) ? MALE_SWAP.get(tk.t) : tk.t))
    .join('');
}
