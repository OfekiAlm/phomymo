/**
 * Create with AI - API key and preference storage
 *
 * The key is held in memory for the page session. It is written to localStorage only when
 * the user explicitly ticks "Remember on this device", and can be removed at any time.
 * localStorage is readable by any script running on this origin, which is why saving is
 * opt-in and the UI explains it.
 */

import { AI_STORAGE_KEYS } from './config.js?v=1';

let sessionKey = '';

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** @returns {string} Saved key, or '' */
export function getSavedApiKey() {
  try {
    const value = storage()?.getItem(AI_STORAGE_KEYS.API_KEY);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** @returns {boolean} */
export function hasSavedApiKey() {
  return getSavedApiKey() !== '';
}

/**
 * Key to pre-fill: the in-memory session key, else the saved key.
 * @returns {string}
 */
export function getApiKey() {
  return sessionKey || getSavedApiKey();
}

/**
 * Remember the key for this page session and optionally persist it.
 * @param {string} key
 * @param {boolean} persist
 * @returns {boolean} Whether persistence succeeded (true when not requested)
 */
export function setApiKey(key, persist) {
  sessionKey = String(key || '').trim();
  if (!persist) return true;
  try {
    storage()?.setItem(AI_STORAGE_KEYS.API_KEY, sessionKey);
    return true;
  } catch {
    return false;
  }
}

/** Remove the saved key from this device and memory. */
export function forgetApiKey() {
  sessionKey = '';
  try {
    storage()?.removeItem(AI_STORAGE_KEYS.API_KEY);
  } catch {
    // Storage unavailable - nothing persisted
  }
}

const PREF_DEFAULTS = Object.freeze({
  model: '',
  direction: 'auto',
  orientation: 'auto',
  sizeMode: 'current',
  keepExisting: false,
});

/** @returns {Object} Non-sensitive dialog preferences */
export function loadPrefs() {
  try {
    const raw = storage()?.getItem(AI_STORAGE_KEYS.PREFS);
    const parsed = raw ? JSON.parse(raw) : null;
    const prefs = { ...PREF_DEFAULTS };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const k of Object.keys(PREF_DEFAULTS)) {
        if (Object.prototype.hasOwnProperty.call(parsed, k) && typeof parsed[k] === typeof PREF_DEFAULTS[k]) {
          prefs[k] = parsed[k];
        }
      }
    }
    return prefs;
  } catch {
    return { ...PREF_DEFAULTS };
  }
}

/** @param {Object} prefs */
export function savePrefs(prefs) {
  const out = {};
  for (const k of Object.keys(PREF_DEFAULTS)) {
    if (prefs && typeof prefs[k] === typeof PREF_DEFAULTS[k]) out[k] = prefs[k];
  }
  try {
    storage()?.setItem(AI_STORAGE_KEYS.PREFS, JSON.stringify(out));
  } catch {
    // Non-critical
  }
}
