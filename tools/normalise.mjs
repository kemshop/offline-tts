// Prints {thai: textAsSpoken} for every phrasebook entry (used by build_audio.py)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as T from '../js/thaitext.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
T.loadLexiconText(fs.readFileSync(path.join(root, 'data/lexicon.tsv'), 'utf8'));
const pb = JSON.parse(fs.readFileSync(path.join(root, 'data/phrasebook.json'), 'utf8'));
const out = {};
for (const c of pb.categories) for (const p of c.phrases) out[p.th] = T.normaliseForSpeech(p.th);
process.stdout.write(JSON.stringify(out));
