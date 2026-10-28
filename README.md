# Thai Voice

A phone app (installable web app) that says Thai out loud in a male voice. Type English or Thai, hear it, slow it down, and shadow it. Everything runs on the phone — after the first load it works with no signal.

## What it does

- **Thai in → voice out.** Paste or type Thai and a Thai male voice reads it.
- **English in → Thai out.** English is matched against the phrasebook and your saved phrases first. For anything else, download the optional offline translator (about 40 MB) — Mozilla's Firefox English→Thai model, running on the phone.
- **Tone-coloured romanisation** under every phrase (Paiboon-style), with a little pitch line showing each tone.
- **Slow** replay and **Shadow** mode: it plays the phrase, gives you time to say it back, and repeats.
- **Phrasebook** of ~70 casual, male-register phrases, with audio built in so they play instantly.
- **Saved** list with import: paste lines of `English | Thai` (e.g. phrases Claude writes for you).

## Put it online (GitHub Pages)

The app is static files. GitHub Pages hosts them for free over HTTPS, which the phone needs to install it.

1. Create a new **public** repository on GitHub (any name).
2. Upload everything in this folder to it, keeping the folder structure.
   With git:
   ```bash
   cd thai-voice
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
   Or drag the files into the GitHub web uploader (each file is under 25 MB; do it in a couple of batches).
3. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save.**
4. After a minute the site is at `https://<you>.github.io/<repo>/`.

## Install on the phone

1. Open that address in **Chrome** on Wi-Fi.
2. Wait for "Setting up the Thai voice" to finish (about 125 MB, once).
3. Chrome menu (⋮) → **Add to home screen** / **Install app**.
4. Close and reopen it once — from the second launch it uses all your phone's cores, so typed phrases speak faster.

## Updating the app

Change the files, bump `VERSION` in `sw.js`, push. The phone picks up the new version the next time the app is opened with a connection.

If you edit `data/phrasebook.json`, new phrases still work — they just use the live voice instead of pre-built audio. To rebuild the instant audio: `python3 tools/build_audio.py path/to/model.onnx` (the model is the five `model/mms-tha.onnx.part*` files joined: `cat model/mms-tha.onnx.part* > model.onnx`).

## How it's built

| Piece | What | Licence |
|---|---|---|
| Voice | Meta MMS-TTS Thai (VITS), converted to ONNX by sherpa-onnx; runs with onnxruntime-web | CC BY-NC 4.0 (non-commercial) |
| Romanisation | TLTK-style Thai pronunciation lexicon from VachanaTTS | MIT |
| Translator (optional) | Mozilla Firefox Translations English→Thai model v2.0 + Bergamot runtime v0.6.0, in `translator/` (fetched and hash-checked by the GitHub Action from `translator/sources.json`) | MPL 2.0 |
| Fonts | Andika (romanisation), IBM Plex Sans Thai Looped | SIL OFL |

The voice model is licensed for **non-commercial use** — fine for personal learning, not for business use.

## Limits worth knowing

- The voice gets tones right most of the time, not always. Use it for drilling; check anything important with a native speaker.
- Romanisation comes from a dictionary. Words it doesn't know show in grey Thai without romanisation.
- Machine-translated Thai can be stiff or formal. The phrasebook and phrases you import are better material.
