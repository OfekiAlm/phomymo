/**
 * Create with AI - dialog controller
 *
 * Loaded lazily the first time the user opens "Create with AI". The dialog markup lives in
 * index.html (like every other dialog); this module wires its behaviour. The application
 * passes a small host API so this module never reaches into editor internals:
 *
 *   host.getContext()       → { widthMm, heightMm, round, multiLabel, hasElements, dpi, printer }
 *   host.applyDesign(opts)  → inserts elements as one undoable operation (throws on failure)
 *   host.measureTextWidth(text, cssFont) → number
 *   host.barcodeProbe(data, format)      → boolean
 *   host.showToast(message, type, durationMs)
 */

import { AI_CONFIG } from './config.js?v=1';
import { AIError, AIErrorCode, toAIError } from './errors.js?v=1';
import { generateLabel } from './generate.js?v=1';
import { getApiKey, hasSavedApiKey, setApiKey, forgetApiKey, loadPrefs, savePrefs } from './key-store.js?v=1';

const SIZE_LIMITS = { minWidthMm: 10, maxWidthMm: 100, minHeightMm: 10, maxHeightMm: 200 };

const PROGRESS_TEXT = {
  generating: 'Designing your label…',
  repairing: 'Fixing layout problems…',
  validating: 'Checking the layout…',
};

let host = null;
let wired = false;
let controller = null;
let busy = false;

const $ = (sel) => document.querySelector(sel);

function show(el, visible) {
  el?.classList.toggle('hidden', !visible);
}

function setBusy(value, stage = 'generating') {
  busy = value;
  const form = $('#ai-form');
  form.querySelectorAll('input, textarea, select').forEach(el => { el.disabled = value; });
  $('#ai-generate').disabled = value;
  $('#ai-key-toggle').disabled = value;
  $('#ai-forget-key').disabled = value;
  $('#ai-generate').textContent = value ? 'Generating…' : $('#ai-generate').dataset.idleLabel || 'Generate';
  $('#ai-cancel').textContent = value ? 'Stop' : 'Cancel';
  $('#ai-progress-text').textContent = PROGRESS_TEXT[stage] || PROGRESS_TEXT.generating;
  show($('#ai-progress'), value);
  if (!value && host) updateSizeUi();
}

function clearError() {
  show($('#ai-error'), false);
  $('#ai-error-message').textContent = '';
  $('#ai-error-details').textContent = '';
  $('#ai-generate').dataset.idleLabel = 'Generate';
  $('#ai-generate').textContent = 'Generate';
}

function showError(error) {
  // textContent only: messages may contain model/API supplied text.
  $('#ai-error-message').textContent = error.message;
  const details = [error.code, error.status ? `HTTP ${error.status}` : '', error.detail].filter(Boolean).join(' · ');
  $('#ai-error-details').textContent = details;
  show($('#ai-error-details-wrap'), !!details);
  show($('#ai-error'), true);
  const label = error.retryable ? 'Retry' : 'Generate';
  $('#ai-generate').dataset.idleLabel = label;
  $('#ai-generate').textContent = label;
}

function updateKeyUi() {
  const saved = hasSavedApiKey();
  show($('#ai-forget-key'), saved);
  $('#ai-remember-key').checked = saved;
}

function updateSizeUi() {
  const ctx = host.getContext();
  const mode = $('#ai-size-mode').value;
  $('#ai-size-current').textContent = `Current label (${ctx.widthMm} × ${ctx.heightMm} mm${ctx.round ? ', round' : ''})`;
  $('#ai-size-mode').disabled = busy || ctx.multiLabel;
  if (ctx.multiLabel) $('#ai-size-mode').value = 'current';
  show($('#ai-custom-size'), !ctx.multiLabel && mode === 'custom');
  show($('#ai-multilabel-note'), ctx.multiLabel);
}

function readInt(input, min, max, fallback) {
  const n = Math.round(Number(input.value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Build generation constraints from the dialog and current editor context.
 * @returns {{ constraints: Object, applySize: boolean }}
 */
function buildConstraints(ctx) {
  const orientationValue = $('#ai-orientation').value;
  const orientation = orientationValue === 'portrait' || orientationValue === 'landscape' ? orientationValue : 'any';
  const direction = ['ltr', 'rtl'].includes($('#ai-direction').value) ? $('#ai-direction').value : 'auto';
  const base = { orientation, direction, dpi: ctx.dpi || 203, printer: ctx.printer || '', limits: { ...SIZE_LIMITS } };
  const mode = ctx.multiLabel ? 'current' : $('#ai-size-mode').value;

  if (mode === 'custom') {
    const round = $('#ai-round').checked;
    let widthMm = readInt($('#ai-width'), SIZE_LIMITS.minWidthMm, SIZE_LIMITS.maxWidthMm, ctx.widthMm);
    let heightMm = readInt($('#ai-height'), SIZE_LIMITS.minHeightMm, SIZE_LIMITS.maxHeightMm, ctx.heightMm);
    if (round) heightMm = widthMm = Math.min(widthMm, heightMm);
    else if ((orientation === 'portrait' && widthMm > heightMm) || (orientation === 'landscape' && heightMm > widthMm)) {
      if (heightMm <= SIZE_LIMITS.maxWidthMm) [widthMm, heightMm] = [heightMm, widthMm];
    }
    return { constraints: { ...base, sizeMode: 'fixed', canvas: { widthMm, heightMm, round } }, applySize: true };
  }
  const canvas = { widthMm: ctx.widthMm, heightMm: ctx.heightMm, round: !!ctx.round };
  if (mode === 'auto') return { constraints: { ...base, sizeMode: 'flexible', canvas }, applySize: true };
  return { constraints: { ...base, sizeMode: 'fixed', canvas }, applySize: false };
}

function currentPrefs() {
  return {
    model: $('#ai-model').value.trim(),
    direction: $('#ai-direction').value,
    orientation: $('#ai-orientation').value,
    sizeMode: $('#ai-size-mode').value,
    keepExisting: $('#ai-keep-existing').checked,
  };
}

function summarizeIssues(issues) {
  const warnings = issues.filter(i => i.severity === 'warning' || i.severity === 'error');
  if (warnings.length === 0) return '';
  const first = warnings[0].message;
  return warnings.length === 1 ? ` (adjusted: ${first})` : ` (${warnings.length} layout adjustments made)`;
}

async function handleGenerate(event) {
  event?.preventDefault();
  if (busy) return;
  clearError();

  const apiKey = $('#ai-api-key').value.trim();
  const prompt = $('#ai-prompt').value.trim();
  if (!apiKey) {
    showError(new AIError(AIErrorCode.MISSING_API_KEY, { retryable: false }));
    $('#ai-api-key').focus();
    return;
  }
  if (!prompt) {
    showError(new AIError(AIErrorCode.EMPTY_PROMPT, { retryable: false }));
    $('#ai-prompt').focus();
    return;
  }

  const remember = $('#ai-remember-key').checked;
  // Unticking "Remember" removes a previously saved key; the key stays in memory for this session.
  if (!remember && hasSavedApiKey()) forgetApiKey();
  if (!setApiKey(apiKey, remember)) {
    host.showToast('Could not save the API key on this device; it will be used for this session only', 'warning');
  }
  updateKeyUi();
  const prefs = currentPrefs();
  savePrefs(prefs);

  const ctx = host.getContext();
  const keepExisting = prefs.keepExisting;
  const { constraints, applySize } = buildConstraints(ctx);

  controller = new AbortController();
  setBusy(true);
  let result;
  try {
    result = await generateLabel({
      apiKey,
      prompt,
      model: prefs.model || undefined,
      constraints,
      env: { measureTextWidth: host.measureTextWidth, barcodeProbe: host.barcodeProbe },
      zone: ctx.zone || 0,
      signal: controller.signal,
      onProgress: (stage) => { $('#ai-progress-text').textContent = PROGRESS_TEXT[stage] || PROGRESS_TEXT.generating; },
    });
  } catch (err) {
    const aiError = toAIError(err);
    setBusy(false);
    controller = null;
    if (aiError.code === AIErrorCode.CANCELLED) {
      host.showToast('Generation cancelled', 'info');
      return;
    }
    showError(aiError);
    return;
  }
  controller = null;

  try {
    host.applyDesign({
      elements: result.elements,
      labelSize: result.labelSize,
      applySize,
      keepExisting,
    });
  } catch (err) {
    setBusy(false);
    showError(new AIError(AIErrorCode.INSERT_FAILED, { detail: err?.message || String(err) }));
    return;
  }

  setBusy(false);
  closeDialog();
  $('#ai-prompt').value = '';
  const replaced = !keepExisting && ctx.hasElements;
  host.showToast(
    `Label created${summarizeIssues(result.issues)}.${replaced ? ' Press Undo to restore your previous design.' : ''}`,
    'success',
    5000,
  );
}

function closeDialog() {
  if (busy) {
    controller?.abort();
    return;
  }
  show($('#ai-dialog'), false);
  document.removeEventListener('keydown', onKeyDown, true);
}

function onKeyDown(e) {
  if (e.key === 'Escape' && !$('#ai-dialog').classList.contains('hidden')) {
    e.stopPropagation();
    e.preventDefault();
    closeDialog();
  }
}

function wire() {
  const datalist = $('#ai-model-options');
  datalist.replaceChildren(...AI_CONFIG.SUGGESTED_MODELS.map(m => {
    const option = document.createElement('option');
    option.value = m;
    return option;
  }));
  $('#ai-model').placeholder = `${AI_CONFIG.DEFAULT_MODEL} (default)`;

  const prefs = loadPrefs();
  $('#ai-model').value = prefs.model;
  if (['auto', 'ltr', 'rtl'].includes(prefs.direction)) $('#ai-direction').value = prefs.direction;
  if (['auto', 'portrait', 'landscape'].includes(prefs.orientation)) $('#ai-orientation').value = prefs.orientation;
  if (['current', 'auto', 'custom'].includes(prefs.sizeMode)) $('#ai-size-mode').value = prefs.sizeMode;
  $('#ai-keep-existing').checked = prefs.keepExisting;

  $('#ai-form').addEventListener('submit', handleGenerate);
  $('#ai-close').addEventListener('click', closeDialog);
  $('#ai-cancel').addEventListener('click', closeDialog);
  $('#ai-dialog').addEventListener('click', (e) => {
    if (e.target === e.currentTarget && !busy) closeDialog();
  });
  $('#ai-size-mode').addEventListener('change', updateSizeUi);
  $('#ai-key-toggle').addEventListener('click', () => {
    const input = $('#ai-api-key');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    $('#ai-key-toggle').textContent = reveal ? 'Hide' : 'Show';
    $('#ai-key-toggle').setAttribute('aria-pressed', String(reveal));
  });
  $('#ai-forget-key').addEventListener('click', () => {
    forgetApiKey();
    $('#ai-api-key').value = '';
    updateKeyUi();
    host.showToast('Saved API key removed from this device', 'info');
  });
  wired = true;
}

/**
 * Open the Create with AI dialog.
 * @param {Object} hostApi - See module header
 */
export function openCreateWithAIDialog(hostApi) {
  host = hostApi;
  if (!wired) wire();
  if (busy) {
    show($('#ai-dialog'), true);
    return;
  }
  clearError();
  $('#ai-api-key').value = getApiKey();
  $('#ai-api-key').type = 'password';
  $('#ai-key-toggle').textContent = 'Show';
  $('#ai-key-toggle').setAttribute('aria-pressed', 'false');
  updateKeyUi();
  const ctx = host.getContext();
  if (!$('#ai-custom-size').dataset.initialized) {
    $('#ai-width').value = ctx.widthMm;
    $('#ai-height').value = ctx.heightMm;
    $('#ai-round').checked = !!ctx.round;
    $('#ai-custom-size').dataset.initialized = '1';
  }
  updateSizeUi();
  show($('#ai-dialog'), true);
  document.addEventListener('keydown', onKeyDown, true);
  ($('#ai-api-key').value ? $('#ai-prompt') : $('#ai-api-key')).focus();
}
