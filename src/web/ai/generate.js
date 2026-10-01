/**
 * Create with AI - generation orchestrator
 *
 * Pipeline: prompt → OpenAI (structured output) → parse/migrate → schema + semantic +
 * layout validation/normalization → (one controlled repair request if unusable) →
 * conversion to native editor elements.
 *
 * Nothing here touches application state; the caller inserts the result transactionally.
 */

import { AI_CONFIG, resolveModel } from './config.js?v=1';
import { AIError, AIErrorCode, toAIError } from './errors.js?v=1';
import { buildSystemPrompt, buildUserMessage, buildRepairMessage } from './prompt.js?v=1';
import { buildRequestBody, callResponsesApi } from './client.js?v=1';
import { validateLabelDocument } from './validate.js?v=1';
import { documentToEditorElements } from './convert.js?v=1';

/**
 * Development diagnostics. Never logs the API key or prompt text — only metadata.
 * Enable with localStorage.setItem('phomymo_ai_debug', '1').
 */
function debugLog(event, details) {
  try {
    if (globalThis.localStorage?.getItem('phomymo_ai_debug') !== '1') return;
  } catch {
    return;
  }
  console.debug(`[Create with AI] ${event}`, details);
}

/**
 * Generate a label.
 * @param {Object} params
 * @param {string} params.apiKey
 * @param {string} params.prompt - User's natural-language description
 * @param {string} [params.model]
 * @param {Object} params.constraints - See buildUserMessage()/validateLabelDocument()
 * @param {Object} [params.env] - { measureTextWidth, barcodeProbe } for layout checks
 * @param {number} [params.zone=0] - Multi-label zone for created elements
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.fetchImpl] - Injectable fetch (tests)
 * @param {Function} [params.onProgress] - Called with 'generating' | 'repairing' | 'validating'
 * @returns {Promise<{ document: Object, elements: Array, labelSize: Object, issues: Array, attempts: number, model: string }>}
 */
export async function generateLabel({
  apiKey,
  prompt,
  model,
  constraints,
  env = {},
  zone = 0,
  signal,
  fetchImpl,
  onProgress,
}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new AIError(AIErrorCode.MISSING_API_KEY);
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw new AIError(AIErrorCode.EMPTY_PROMPT);
  if (text.length > AI_CONFIG.MAX_PROMPT_LENGTH) throw new AIError(AIErrorCode.PROMPT_TOO_LONG);

  const resolvedModel = resolveModel(model);
  const instructions = buildSystemPrompt();
  const messages = [{ role: 'user', content: buildUserMessage(text, constraints) }];
  const started = Date.now();
  debugLog('start', { model: resolvedModel, promptLength: text.length, constraints });

  try {
    for (let attempt = 0; ; attempt++) {
      onProgress?.(attempt === 0 ? 'generating' : 'repairing');
      const body = buildRequestBody({ model: resolvedModel, instructions, messages });
      const { text: output, usage } = await callResponsesApi({ apiKey: key, body, signal, fetchImpl });

      onProgress?.('validating');
      const result = validateLabelDocument(output, constraints, env);
      const errors = result.issues.filter(i => i.severity === 'error').map(i => i.message);
      debugLog('response', {
        attempt,
        ok: result.ok,
        usage,
        errors: errors.length,
        warnings: result.issues.filter(i => i.severity === 'warning').length,
        ms: Date.now() - started,
      });

      if (result.ok) {
        let converted;
        try {
          converted = documentToEditorElements(result.document, { zone });
        } catch (err) {
          throw new AIError(AIErrorCode.VALIDATION_FAILED, { detail: `Conversion failed: ${err?.message || err}` });
        }
        if (converted.elements.length === 0) {
          throw new AIError(AIErrorCode.VALIDATION_FAILED, { detail: 'No elements after conversion' });
        }
        return {
          document: result.document,
          elements: converted.elements,
          labelSize: converted.labelSize,
          issues: result.issues,
          attempts: attempt + 1,
          model: resolvedModel,
        };
      }

      if (attempt >= AI_CONFIG.MAX_REPAIR_ATTEMPTS) {
        throw new AIError(AIErrorCode.VALIDATION_FAILED, { detail: errors.slice(0, 10).join('; ') });
      }
      messages.push(
        { role: 'assistant', content: output },
        { role: 'user', content: buildRepairMessage(errors.length ? errors : ['The document was not usable.']) },
      );
    }
  } catch (err) {
    const aiError = toAIError(err);
    debugLog('error', { code: aiError.code, status: aiError.status, detail: aiError.detail });
    throw aiError;
  }
}
