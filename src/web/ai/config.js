/**
 * Create with AI - central configuration
 *
 * Everything model/endpoint related lives here so it can be changed in one place.
 */

export const AI_CONFIG = {
  // Default model used for label generation. Must support Structured Outputs (json_schema, strict).
  DEFAULT_MODEL: 'gpt-5-mini',
  // Shown as suggestions in the optional "Model" field (advanced settings).
  SUGGESTED_MODELS: ['gpt-5-mini', 'gpt-5', 'gpt-4.1', 'gpt-4.1-mini'],
  // OpenAI Responses API endpoint. The API key is only ever sent here.
  ENDPOINT: 'https://api.openai.com/v1/responses',
  // Abort a single request after this long (ms).
  REQUEST_TIMEOUT_MS: 120_000,
  // Includes reasoning tokens for reasoning models.
  MAX_OUTPUT_TOKENS: 16_000,
  // Reasoning effort for reasoning-capable models (gpt-5*, o*). Low keeps latency reasonable.
  REASONING_EFFORT: 'low',
  // Number of controlled repair requests when the model output fails validation.
  MAX_REPAIR_ATTEMPTS: 1,
  // Maximum length of the user's natural-language description.
  MAX_PROMPT_LENGTH: 4000,
};

export const AI_STORAGE_KEYS = {
  // Only written when the user explicitly ticks "Remember on this device".
  API_KEY: 'phomymo_openai_api_key',
  // Non-sensitive dialog preferences (model, direction, etc.). Never contains the key or prompt.
  PREFS: 'phomymo_ai_prefs',
};

/**
 * Whether a model accepts the `reasoning` request parameter.
 * @param {string} model
 * @returns {boolean}
 */
export function isReasoningModel(model) {
  return /^(gpt-5|o\d)/i.test(String(model || ''));
}

/**
 * Validate a user-supplied model id (advanced setting). Falls back to the default.
 * @param {string} model
 * @returns {string}
 */
export function resolveModel(model) {
  const trimmed = String(model || '').trim();
  return /^[A-Za-z0-9._:-]{1,64}$/.test(trimmed) ? trimmed : AI_CONFIG.DEFAULT_MODEL;
}
