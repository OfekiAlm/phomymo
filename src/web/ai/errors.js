/**
 * Create with AI - error model and OpenAI error mapping
 *
 * All messages produced here are safe to show to users: secrets are redacted.
 */

export const AIErrorCode = {
  MISSING_API_KEY: 'MISSING_API_KEY',
  INVALID_API_KEY: 'INVALID_API_KEY',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  BAD_REQUEST: 'BAD_REQUEST',
  SERVICE_ERROR: 'SERVICE_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  REFUSAL: 'REFUSAL',
  INCOMPLETE: 'INCOMPLETE',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  EMPTY_PROMPT: 'EMPTY_PROMPT',
  PROMPT_TOO_LONG: 'PROMPT_TOO_LONG',
  INSERT_FAILED: 'INSERT_FAILED',
  UNKNOWN: 'UNKNOWN',
};

const USER_MESSAGES = {
  MISSING_API_KEY: 'Enter your OpenAI API key to generate a label.',
  INVALID_API_KEY: 'OpenAI rejected the API key. Check that it was copied correctly and has not been revoked.',
  PERMISSION_DENIED: 'This API key does not have permission to use the selected model or endpoint.',
  QUOTA_EXCEEDED: 'Your OpenAI account has run out of credits or reached its quota. Check billing at platform.openai.com.',
  RATE_LIMITED: 'OpenAI is rate-limiting requests. Wait a moment and try again.',
  MODEL_UNAVAILABLE: 'The selected model is not available for this API key. Try the default model.',
  BAD_REQUEST: 'OpenAI could not process the request.',
  SERVICE_ERROR: 'OpenAI is temporarily unavailable. Please try again shortly.',
  NETWORK_ERROR: 'Could not reach OpenAI. Check your internet connection and try again.',
  TIMEOUT: 'The request took too long and was stopped. Try again, or simplify the description.',
  CANCELLED: 'Generation cancelled.',
  REFUSAL: 'The model declined to create this label.',
  INCOMPLETE: 'The model ran out of room before finishing the label. Try a simpler description.',
  MALFORMED_RESPONSE: 'The AI returned a response that could not be read. Please try again.',
  VALIDATION_FAILED: 'The AI produced a label that could not be used, even after an automatic repair attempt. Please try again or rephrase the description.',
  EMPTY_PROMPT: 'Describe the label you want to create.',
  PROMPT_TOO_LONG: 'The description is too long. Please shorten it.',
  INSERT_FAILED: 'The generated label could not be added to the editor. Your current design was not changed.',
  UNKNOWN: 'Something went wrong while generating the label.',
};

const RETRYABLE = new Set([
  AIErrorCode.RATE_LIMITED,
  AIErrorCode.SERVICE_ERROR,
  AIErrorCode.NETWORK_ERROR,
  AIErrorCode.TIMEOUT,
  AIErrorCode.INCOMPLETE,
  AIErrorCode.MALFORMED_RESPONSE,
  AIErrorCode.VALIDATION_FAILED,
  AIErrorCode.CANCELLED,
  AIErrorCode.UNKNOWN,
]);

/**
 * Remove anything that looks like an API key or bearer token from a string.
 * @param {*} value
 * @returns {string}
 */
export function redactSecrets(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/sk-[A-Za-z0-9_\-*.]{4,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9_\-.*]+/gi, '******')
    .slice(0, 500);
}

export class AIError extends Error {
  /**
   * @param {string} code - AIErrorCode value
   * @param {Object} [options]
   * @param {string} [options.message] - Override user-facing message
   * @param {string} [options.detail] - Technical detail (redacted before storage)
   * @param {number} [options.status] - HTTP status, if any
   * @param {boolean} [options.retryable]
   */
  constructor(code, options = {}) {
    const known = Object.prototype.hasOwnProperty.call(USER_MESSAGES, code) ? code : AIErrorCode.UNKNOWN;
    super(redactSecrets(options.message || USER_MESSAGES[known]));
    this.name = 'AIError';
    this.code = known;
    this.detail = redactSecrets(options.detail || '');
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? RETRYABLE.has(known);
  }
}

/**
 * Map an OpenAI HTTP error response to an AIError.
 * @param {number} status - HTTP status
 * @param {Object|null} body - Parsed JSON body (may be null)
 * @returns {AIError}
 */
export function mapHttpError(status, body) {
  const err = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  const apiCode = typeof err.code === 'string' ? err.code : '';
  const apiType = typeof err.type === 'string' ? err.type : '';
  const apiMessage = typeof err.message === 'string' ? err.message : '';
  const detail = `HTTP ${status}${apiCode ? ` (${apiCode})` : ''}${apiMessage ? `: ${apiMessage}` : ''}`;

  if (status === 401) return new AIError(AIErrorCode.INVALID_API_KEY, { status, detail });
  if (status === 403) return new AIError(AIErrorCode.PERMISSION_DENIED, { status, detail });
  if (status === 429) {
    if (apiCode === 'insufficient_quota' || apiType === 'insufficient_quota' || /billing|quota/i.test(apiMessage)) {
      return new AIError(AIErrorCode.QUOTA_EXCEEDED, { status, detail, retryable: false });
    }
    return new AIError(AIErrorCode.RATE_LIMITED, { status, detail });
  }
  if (status === 404 || apiCode === 'model_not_found') {
    return new AIError(AIErrorCode.MODEL_UNAVAILABLE, { status, detail });
  }
  if (status === 400 || status === 422) {
    return new AIError(AIErrorCode.BAD_REQUEST, { status, detail });
  }
  if (status === 408) return new AIError(AIErrorCode.TIMEOUT, { status, detail });
  if (status >= 500) return new AIError(AIErrorCode.SERVICE_ERROR, { status, detail });
  return new AIError(AIErrorCode.UNKNOWN, { status, detail });
}

/**
 * Normalize any thrown value to an AIError.
 * @param {*} error
 * @returns {AIError}
 */
export function toAIError(error) {
  if (error instanceof AIError) return error;
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new AIError(AIErrorCode.UNKNOWN, { detail });
}
