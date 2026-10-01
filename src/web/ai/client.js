/**
 * Create with AI - OpenAI Responses API client
 *
 * Uses plain fetch against the official REST endpoint instead of the OpenAI SDK: the app
 * has no bundler and only needs one call, so a CDN-loaded SDK would add weight and a
 * third-party script without benefit. The API key is sent only in the Authorization
 * header of requests to AI_CONFIG.ENDPOINT and is never logged.
 */

import { AI_CONFIG, isReasoningModel, resolveModel } from './config.js?v=1';
import { AIError, AIErrorCode, mapHttpError, redactSecrets } from './errors.js?v=1';
import { LABEL_DOCUMENT_JSON_SCHEMA, LABEL_DOCUMENT_FORMAT_NAME } from './schema.js?v=1';

/**
 * Build the request body for a structured label generation call.
 * @param {Object} params
 * @param {string} params.model
 * @param {string} params.instructions - System/developer prompt
 * @param {Array<{role: string, content: string}>} params.messages - Conversation input
 * @returns {Object}
 */
export function buildRequestBody({ model, instructions, messages }) {
  const resolvedModel = resolveModel(model);
  const body = {
    model: resolvedModel,
    instructions,
    input: messages.map(m => ({ role: m.role, content: m.content })),
    text: {
      format: {
        type: 'json_schema',
        name: LABEL_DOCUMENT_FORMAT_NAME,
        schema: LABEL_DOCUMENT_JSON_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: AI_CONFIG.MAX_OUTPUT_TOKENS,
    // Prompts may contain private data; ask OpenAI not to retain the response object.
    store: false,
  };
  if (isReasoningModel(resolvedModel)) {
    body.reasoning = { effort: AI_CONFIG.REASONING_EFFORT };
  } else {
    // Deterministic-leaning output for layout work on non-reasoning models.
    body.temperature = 0.4;
  }
  return body;
}

/**
 * Extract the structured text output from a Responses API payload.
 * @param {Object} data
 * @returns {string}
 */
export function extractOutputText(data) {
  if (!data || typeof data !== 'object') {
    throw new AIError(AIErrorCode.MALFORMED_RESPONSE, { detail: 'Response body is not an object' });
  }
  if (data.status === 'incomplete') {
    const reason = data.incomplete_details?.reason || 'unknown';
    throw new AIError(AIErrorCode.INCOMPLETE, { detail: `Response incomplete: ${reason}` });
  }
  if (data.status === 'failed' || data.error) {
    throw new AIError(AIErrorCode.SERVICE_ERROR, { detail: `Response failed: ${data.error?.message || data.error?.code || 'unknown'}` });
  }

  const parts = [];
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part?.type === 'refusal') {
          throw new AIError(AIErrorCode.REFUSAL, {
            message: `The model declined to create this label${part.refusal ? `: ${String(part.refusal).slice(0, 200)}` : '.'}`,
            detail: 'refusal',
            retryable: false,
          });
        }
        if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
      }
    }
  }
  if (parts.length === 0 && typeof data.output_text === 'string') parts.push(data.output_text);

  const text = parts.join('');
  if (!text.trim()) {
    throw new AIError(AIErrorCode.MALFORMED_RESPONSE, { detail: 'No output_text in response' });
  }
  return text;
}

/**
 * Call the Responses API.
 * @param {Object} params
 * @param {string} params.apiKey
 * @param {Object} params.body - From buildRequestBody
 * @param {AbortSignal} [params.signal] - User cancellation
 * @param {Function} [params.fetchImpl] - Injected fetch (tests)
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{text: string, usage: Object|null, id: string|null}>}
 */
export async function callResponsesApi({ apiKey, body, signal, fetchImpl, timeoutMs = AI_CONFIG.REQUEST_TIMEOUT_MS }) {
  const key = String(apiKey || '').trim();
  if (!key) throw new AIError(AIErrorCode.MISSING_API_KEY, { retryable: false });

  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onUserAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onUserAbort, { once: true });
  }

  let response;
  try {
    response = await doFetch(AI_CONFIG.ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': ['Bearer', key].join(' '),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch (e) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onUserAbort);
    if (timedOut) throw new AIError(AIErrorCode.TIMEOUT, { detail: `No response after ${timeoutMs} ms` });
    if (signal?.aborted || e?.name === 'AbortError') throw new AIError(AIErrorCode.CANCELLED);
    throw new AIError(AIErrorCode.NETWORK_ERROR, { detail: redactSecrets(e?.message || e) });
  }

  let payload = null;
  let rawText = '';
  try {
    rawText = await response.text();
    payload = rawText ? JSON.parse(rawText) : null;
  } catch (e) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onUserAbort);
    if (timedOut) throw new AIError(AIErrorCode.TIMEOUT);
    if (signal?.aborted) throw new AIError(AIErrorCode.CANCELLED);
    if (!response.ok) throw mapHttpError(response.status, null);
    throw new AIError(AIErrorCode.MALFORMED_RESPONSE, { detail: 'Response was not valid JSON' });
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', onUserAbort);

  if (!response.ok) throw mapHttpError(response.status, payload);

  return {
    text: extractOutputText(payload),
    usage: payload?.usage || null,
    id: typeof payload?.id === 'string' ? payload.id : null,
  };
}
