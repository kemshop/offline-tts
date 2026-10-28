// Runs the Thai voice model (MMS-TTS Thai, VITS) off the main thread.
import * as ort from '../vendor/ort/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
// Threads need cross-origin isolation, which the service worker switches on
// from the second launch. Before that, run single-threaded.
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
ort.env.logLevel = 'error';

const MODEL_CACHE = 'tv-model-1';
let session = null;
let voice = null;

async function fetchCached(url, onBytes) {
  let cache = null;
  try { cache = await caches.open(MODEL_CACHE); } catch { /* no Cache API */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) { const buf = await hit.arrayBuffer(); onBytes(buf.byteLength); return new Uint8Array(buf); }
  }
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Couldn't download ${url.split('/').pop()} (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.byteLength; onBytes(value.byteLength);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  if (cache) { try { await cache.put(url, new Response(out.slice().buffer)); } catch { /* quota */ } }
  return out;
}

async function init() {
  const base = new URL('../model/', import.meta.url);
  voice = await (await fetch(new URL('voice.json', base))).json();
  const total = voice.bytes;
  let loaded = 0;
  const parts = [];
  for (const p of voice.parts) {
    parts.push(await fetchCached(new URL(p, base).href, (n) => {
      loaded += n;
      postMessage({ type: 'progress', loaded, total });
    }));
  }
  const model = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { model.set(p, o); o += p.byteLength; }
  postMessage({ type: 'progress', loaded: total, total, stage: 'starting' });
  session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  postMessage({ type: 'ready' });
}

function toIds(text) {
  const t = text.normalize('NFKC').toLowerCase();
  const ids = [];
  for (const ch of t) { const id = voice.tokens[ch]; if (id !== undefined) ids.push(id); }
  // VITS "add_blank": blank (0) between and around every symbol
  const out = new Array(ids.length * 2 + 1).fill(voice.blank_id);
  for (let i = 0; i < ids.length; i++) out[i * 2 + 1] = ids[i];
  return out;
}

function chunkText(text, max = 140) {
  if (text.length <= max) return [text];
  const words = text.split(' ');
  const chunks = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { chunks.push(cur.trim()); cur = w; }
    else cur += ' ' + w;
  }
  if (cur.trim()) chunks.push(cur.trim());
  // hard-split anything still too long
  return chunks.flatMap((c) => (c.length <= max * 1.5 ? [c] : c.match(new RegExp(`.{1,${max}}`, 'gu'))));
}

async function synth(text, lengthScale) {
  const sr = voice.sample_rate;
  const pieces = [];
  for (const chunk of chunkText(text)) {
    const ids = toIds(chunk);
    if (ids.length < 3) continue;
    const feeds = {
      x: new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]),
      x_length: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      noise_scale: new ort.Tensor('float32', Float32Array.from([0.6]), [1]),
      length_scale: new ort.Tensor('float32', Float32Array.from([lengthScale]), [1]),
      noise_scale_w: new ort.Tensor('float32', Float32Array.from([0.7]), [1]),
    };
    const out = await session.run(feeds);
    pieces.push(out.y.data);
  }
  const gap = Math.round(sr * 0.14);
  const len = pieces.reduce((a, p) => a + p.length, 0) + gap * Math.max(0, pieces.length - 1);
  const audio = new Float32Array(len);
  let o = 0;
  pieces.forEach((p, i) => { audio.set(p, o); o += p.length + (i < pieces.length - 1 ? gap : 0); });
  // normalise loudness and soften the edges
  let peak = 0;
  for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
  const g = peak > 0 ? 0.9 / peak : 1;
  const fade = Math.min(160, audio.length >> 2);
  for (let i = 0; i < audio.length; i++) {
    let v = audio[i] * g;
    if (i < fade) v *= i / fade;
    if (i > audio.length - fade) v *= (audio.length - i) / fade;
    audio[i] = v;
  }
  return { audio, sampleRate: sr };
}

let queue = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init().catch((err) => postMessage({ type: 'error', message: String(err.message || err) }));
  } else if (msg.type === 'synth') {
    queue = queue.then(async () => {
      try {
        const { audio, sampleRate } = await synth(msg.text, msg.lengthScale || 1);
        postMessage({ type: 'audio', id: msg.id, audio, sampleRate }, [audio.buffer]);
      } catch (err) {
        postMessage({ type: 'audio', id: msg.id, error: String(err.message || err) });
      }
    });
  }
};
