// Backend speech-to-text (PRD F2.2, STT option B).
//
// Runs whisper.cpp locally. This exists for two reasons, and the second is the
// one that matters:
//
//   1. It is the documented fallback for noisy environments, where the browser
//      Web Speech API is weakest.
//   2. It is the only STT that can be driven from an automated harness here.
//      Chrome's Web Speech API returns NO transcript in this environment -
//      measured: on headful Chrome stable the whole audio chain fires
//      (audiostart, soundstart, speechstart, speechend) so the audio is
//      genuinely reaching the recogniser, but no result ever comes back;
//      headless reports `no-speech` outright. The PRD anticipates exactly this
//      ("use backend STT for the harness and say so").
//
// Audio arrives as raw 16-bit little-endian PCM mono. That is deliberate: the
// browser can produce it directly from an AudioWorklet, so there is no
// webm/opus transcode step and therefore no ffmpeg dependency.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

export function sttConfig() {
  return {
    bin: process.env.WHISPER_BIN || 'whisper-cli',
    model: process.env.WHISPER_MODEL || '',
    rate: Number(process.env.STT_RATE || 16000),
  };
}

export function sttAvailable() {
  const c = sttConfig();
  return !!c.model && fs.existsSync(c.model);
}

/** 16-bit PCM mono -> WAV. whisper.cpp reads the header, so it must be real. */
export function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Transcribe raw PCM. Returns { ok, text, ms, error }.
 * Never throws: a failed transcription is an answer the session can act on
 * ("I didn't catch that"), not a crash.
 */
export async function transcribePcm(pcm, { rate } = {}) {
  const c = sttConfig();
  const t0 = Date.now();
  if (!sttAvailable()) {
    return { ok: false, text: '', ms: 0, error: 'STT not configured - set WHISPER_MODEL to a ggml model file' };
  }
  if (!pcm || pcm.length < 3200) {   // under ~0.1s at 16k
    return { ok: false, text: '', ms: 0, error: 'audio too short' };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-stt-'));
  const wavPath = path.join(dir, 'in.wav');
  try {
    fs.writeFileSync(wavPath, pcmToWav(pcm, rate || c.rate));
    const { stdout } = await exec(c.bin, [
      '-m', c.model, '-f', wavPath,
      '-nt',              // no timestamps
      '-np',              // no progress prints
      '-l', 'en',
      '-t', String(Math.max(2, Math.min(8, os.cpus().length))),
    ], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const text = String(stdout || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    return { ok: true, text, ms: Date.now() - t0, error: null };
  } catch (e) {
    return { ok: false, text: '', ms: Date.now() - t0, error: String(e.message).slice(0, 200) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
