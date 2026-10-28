"""Pre-render phrasebook audio (normal + slow) so phrasebook taps play instantly.

Usage: python3 tools/build_audio.py path/to/mms-tha-model.onnx
Needs: onnxruntime, numpy, soundfile (libsndfile with Opus), node.
Mirrors js/tts-worker.js: same tokens, noise settings and loudness handling.
"""
import hashlib, json, subprocess, sys, pathlib
import numpy as np, onnxruntime as ort, soundfile as sf

ROOT = pathlib.Path(__file__).resolve().parent.parent
SLOW = 1.6  # must match the app's default slow speed
voice = json.loads((ROOT / "model/voice.json").read_text(encoding="utf-8"))
tok = voice["tokens"]
sess = ort.InferenceSession(sys.argv[1], providers=["CPUExecutionProvider"])
spoken = json.loads(subprocess.check_output(["node", str(ROOT / "tools/normalise.mjs")]))

def ids(text):
    import unicodedata
    t = unicodedata.normalize("NFKC", text).lower()
    i = [tok[c] for c in t if c in tok]
    o = [voice["blank_id"]] * (2 * len(i) + 1); o[1::2] = i
    return o

def synth(text, ls):
    x = ids(text)
    y = sess.run(None, {"x": np.array([x], np.int64), "x_length": np.array([len(x)], np.int64),
                        "noise_scale": np.array([0.6], np.float32), "length_scale": np.array([ls], np.float32),
                        "noise_scale_w": np.array([0.7], np.float32)})[0][0, 0]
    y = y * (0.9 / max(1e-6, float(np.max(np.abs(y)))))
    f = min(160, len(y) // 4); ramp = np.arange(f) / f
    y[:f] *= ramp; y[-f:] *= ramp[::-1]
    return y.astype(np.float32)

out_dir = ROOT / "audio/pb"
out_dir.mkdir(parents=True, exist_ok=True)
for old in out_dir.glob("*.ogg"): old.unlink()
index = {}
for th, text in spoken.items():
    key = hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]
    for suffix, ls in (("n", 1.0), ("s", SLOW)):
        sf.write(out_dir / f"{key}-{suffix}.ogg", synth(text, ls), voice["sample_rate"], format="OGG", subtype="OPUS")
    index[th] = f"audio/pb/{key}"
(ROOT / "data/phrase-audio.json").write_text(json.dumps({"slow": SLOW, "files": index}, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"rendered {len(index)} phrases")
