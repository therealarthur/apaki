/**
 * voice-model.js: the free English Whisper model the mic button needs, downloaded on request.
 *
 * WHY (Arthur, 2026-10-13, macOS port phase 2): on Windows the voice folder is filled by hand (whisper.cpp plus
 * models/ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp, see apaki/docs/windows.md): the model is large
 * (about 141 MB) and optional, so nothing downloads it on its own. The Mac app carries a signed whisper.cpp (Metal) in
 * its bundle, which leaves only this file to fetch. It is fetched when the person asks (Apaki menu, "Download Voice
 * Model...", which sends the engine op voiceModel), never at first run. Same file, same place as on Windows:
 * <voice folder>/models/ggml-base.en.bin.
 *
 * Safety: the download is written to a .part file next to the model, its SHA-256 is checked against the one pinned
 * here (the checksum Hugging Face publishes for the file, 2026-10-13), and only then is it renamed into place; a
 * mismatch deletes it. Nothing else is fetched and nothing is sent anywhere.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MODEL_FILE = 'ggml-base.en.bin';
export const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
export const MODEL_SHA256 = 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002';
export const MODEL_BYTES = 147964211;

/**
 * Downloads the model to `file`. Resolves with { file, bytes }; rejects with a readable Error.
 * @param {object} o
 * @param {string} o.file                    where the finished model goes
 * @param {string} [o.url]                   (tests point it at a local server)
 * @param {string|null} [o.sha256]           expected checksum; null skips the check (tests only)
 * @param {number} [o.bytes]                 size to report progress against when the server sends none
 * @param {(got: number, total: number) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @param {typeof fetch} [o.fetchImpl]
 */
export async function downloadModel({ file, url = MODEL_URL, sha256 = MODEL_SHA256, bytes = MODEL_BYTES, onProgress = () => {}, signal, fetchImpl = fetch } = {}) {
  if (!file) throw new Error('downloadModel needs a file to write.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  const res = await fetchImpl(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`The download server answered ${res.status || 'nothing'}, so the voice model was not downloaded.`);
  const total = Number(res.headers.get('content-length')) || bytes;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part, { mode: 0o644 });
  let got = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress(got, total);
    }
    await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw new Error(`The voice model download failed: ${e.message || e}`);
  }
  if (sha256 && hash.digest('hex') !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error('The downloaded voice model did not match its checksum, so it was deleted. Try again, or place ggml-base.en.bin in the voice folder by hand.');
  }
  fs.renameSync(part, file);
  return { file, bytes: got };
}
