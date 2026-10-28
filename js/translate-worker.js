// English → Thai translator, running Mozilla's Firefox Translations model
// (Bergamot / Marian, int8) entirely on the phone. Classic worker because the
// Bergamot loader is a plain script.
/* global loadBergamot */
const BASE = new URL('../translator/', self.location.href);
let manifest = null;
let engine = null; // { bergamot, service, model }

async function fetchBytes(path, onBytes) {
  const res = await fetch(new URL(path, BASE));
  if (!res.ok) throw new Error(`Couldn't download ${path.split('/').pop()} (HTTP ${res.status})`);
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
  return out;
}

function textConfig(cfg) {
  const indent = '            ';
  return '\n' + Object.entries(cfg).map(([k, v]) => `${indent}${k}: ${v}\n`).join('') + indent;
}

async function init() {
  manifest = await (await fetch(new URL('manifest.json', BASE))).json();
  const total = manifest.files.reduce((a, f) => a + f.bytes, 0);
  let loaded = 0;
  const tick = (n) => { loaded += n; postMessage({ type: 'progress', loaded, total }); };
  const get = (role) => manifest.files.find((f) => f.role === role);

  // Loader script (fetched so it is cached for offline use like everything else)
  const glue = await fetchBytes(get('glue').path, tick);
  importScripts(URL.createObjectURL(new Blob([glue], { type: 'text/javascript' })));

  const [wasmBinary, modelBuf, lexBuf, vocabBuf] = await Promise.all(
    ['wasm', 'model', 'lex', 'vocab'].map((r) => fetchBytes(get(r).path, tick)),
  );
  postMessage({ type: 'progress', loaded: total, total, stage: 'starting' });

  const bergamot = await new Promise((resolve, reject) => {
    const mod = loadBergamot({
      INITIAL_MEMORY: 41_943_040,
      print: () => {},
      printErr: () => {},
      onAbort() { reject(new Error('The translator engine failed to start')); },
      onRuntimeInitialized: async () => { await Promise.resolve(); resolve(mod); },
      wasmBinary: wasmBinary.buffer,
    });
  });

  const aligned = (bytes, alignment) => {
    const mem = new bergamot.AlignedMemory(bytes.byteLength, alignment);
    mem.getByteArrayView().set(bytes);
    return mem;
  };
  const vocabList = new bergamot.AlignedMemoryList();
  vocabList.push_back(aligned(vocabBuf, 64));
  const config = textConfig({
    'beam-size': '1',
    normalize: '1.0',
    'word-penalty': '0',
    'max-length-break': '128',
    'mini-batch-words': '1024',
    workspace: '128',
    'max-length-factor': '2.0',
    'skip-cost': 'true',
    'cpu-threads': '0',
    quiet: 'true',
    'quiet-translation': 'true',
    'gemm-precision': get('model').path.endsWith('intgemm8.bin') ? 'int8shiftAll' : 'int8shiftAlphaAll',
    alignment: 'soft',
  });
  const model = new bergamot.TranslationModel('en', 'th', config, aligned(modelBuf, 256), aligned(lexBuf, 64), vocabList, null);
  const service = new bergamot.BlockingService({ cacheSize: 0 });
  engine = { bergamot, service, model };
  postMessage({ type: 'ready' });
}

function translate(text) {
  const { bergamot, service, model } = engine;
  const messages = new bergamot.VectorString();
  const options = new bergamot.VectorResponseOptions();
  let responses = null;
  try {
    messages.push_back(text);
    options.push_back({ qualityScores: false, alignment: true, html: false });
    responses = service.translate(model, messages, options);
    return responses.get(0).getTranslatedText();
  } finally {
    messages.delete(); options.delete(); responses?.delete();
  }
}

let starting = null;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    starting = starting || init();
    try { await starting; } catch (err) { starting = null; postMessage({ type: 'error', message: String(err.message || err) }); }
  } else if (m.type === 'translate') {
    try {
      if (!engine) throw new Error('Translator not loaded');
      postMessage({ type: 'result', id: m.id, text: translate(m.text) });
    } catch (err) {
      postMessage({ type: 'result', id: m.id, error: String(err.message || err) });
    }
  }
};
