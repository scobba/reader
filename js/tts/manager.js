import { listEngines, getEngineClass } from './engine.js';
import { settings } from '../core/settings.js';
import './system.js';   // side effect: registers SystemEngine
import './piper.js';    // side effect: registers PiperEngine

/* Keeps exactly one live engine instance and swaps between them. */

const instances = new Map();
let active = null;

export function availableEngines() {
  return listEngines().filter(C => typeof C.available !== 'function' || C.available());
}

export function activeEngine() { return active; }

/**
 * @param {string} id
 * @param {(pct:number,label:string)=>void} [onProgress]
 */
export async function setActiveEngine(id, onProgress) {
  const Cls = getEngineClass(id) || getEngineClass('system');
  if (!Cls) throw new Error('No speech engine is available in this browser');

  // A saved preference can name an engine that no longer exists — Kokoro was
  // removed once Piper superseded it. Correct the stored value rather than
  // leaving the settings dropdown pointing at nothing.
  if (Cls.id !== id) settings.set('engine', Cls.id);

  if (active && active.id === Cls.id) return active;

  let inst = instances.get(Cls.id);
  if (!inst) {
    inst = new Cls();
    instances.set(Cls.id, inst);
  }

  await inst.init(onProgress);

  if (active && active !== inst) active.cancel();
  active = inst;

  // A voice from the previous engine is meaningless to this one.
  const voices = await inst.voices();
  const want = settings.get('voice');
  if (!voices.some(v => v.id === want)) {
    settings.set('voice', voices[0]?.id || '');
  }
  return inst;
}

/** Best-effort start-up: fall back to the device voice if the saved choice
 *  cannot be loaded (typically the neural model with no connection).
 *  @returns {Promise<{engine:Object, fellBack:boolean, reason?:string}>} */
export async function bootEngine(onProgress) {
  const want = settings.get('engine') || 'system';
  try {
    return { engine: await setActiveEngine(want, onProgress), fellBack: false };
  } catch (err) {
    if (want === 'system') throw err;
    settings.set('engine', 'system');
    return {
      engine: await setActiveEngine('system'),
      fellBack: true,
      reason: err.message,
    };
  }
}
