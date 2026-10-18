/**
 * sound.js: the ding when a session comes back (Arthur, 2026-10-09: "a ding
 * sound when any of the sessions come back").
 *
 * Synthesized with Web Audio, so there is no sound file to ship. Two soft sine
 * notes with a quiet octave: rising when a turn finishes, falling when a
 * session is waiting on you (a question or a plan to approve). Dings closer
 * than DEBOUNCE_MS apart play once, so six panes finishing together do not
 * stack into noise. The audio context starts on the first click or key press,
 * because the webview only allows sound after a user gesture.
 */

const KEY = 'apaki.sound';
const DEBOUNCE_MS = 350;
const NOTES = {
  done: [[784, 0], [1175, 0.11]], // G5 then D6
  ask: [[988, 0], [740, 0.14]], // B5 then F#5
};

let ctx = null;
let last = 0;
let on = true;
try { on = localStorage.getItem(KEY) !== 'off'; } catch { /* storage unavailable: default on */ }

export function soundOn() { return on; }

export function setSoundOn(value) {
  on = Boolean(value);
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* not saved */ }
}

// When the context was last asked to resume (arm). Every key press and click arms it; while the context stays suspended
// (no audio device, or the system holding it) each of those asked again, and resume() is not cheap: about 7 ms of
// every key press went there in a measured run (2026-10-15, window lag). Once a second is plenty.
let resumedAt = -Infinity;
const RESUME_GAP_MS = 1000;

/** Creates or resumes the audio context; call from a user gesture. */
export function arm() {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended' && Date.now() - resumedAt >= RESUME_GAP_MS) {
      resumedAt = Date.now();
      ctx.resume().catch(() => {});
    }
  } catch { ctx = null; }
}

/** Plays the ding. kind: 'done' (a turn finished) or 'ask' (needs an answer). */
export function ding(kind = 'done', { force = false } = {}) {
  if (!on && !force) return false;
  const now = Date.now();
  if (now - last < DEBOUNCE_MS) return false;
  last = now;
  arm();
  if (!ctx) return false;
  const t = ctx.currentTime + 0.01;
  const master = ctx.createGain();
  master.gain.value = 0.16;
  master.connect(ctx.destination);
  for (const [freq, dt] of NOTES[kind] || NOTES.done) {
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t + dt);
    env.gain.exponentialRampToValueAtTime(1, t + dt + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.85);
    env.connect(master);
    const tone = ctx.createOscillator();
    tone.type = 'sine';
    tone.frequency.value = freq;
    tone.connect(env);
    const overtone = ctx.createOscillator();
    const soft = ctx.createGain();
    soft.gain.value = 0.12;
    overtone.type = 'sine';
    overtone.frequency.value = freq * 2;
    overtone.connect(soft);
    soft.connect(env);
    for (const o of [tone, overtone]) { o.start(t + dt); o.stop(t + dt + 0.95); }
  }
  // Read by apaki/scripts/cdp-check.mjs to confirm a ding played.
  window.__apakiDings = (window.__apakiDings || 0) + 1;
  return true;
}
