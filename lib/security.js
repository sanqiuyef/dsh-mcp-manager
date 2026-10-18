/**
 * dsh-mcp-manager — HTTP safety primitives shared by every host route.
 *
 * Three rules every host route has to obey live here so no route can forget one:
 *
 *   1. Every route asks `connection.requestRejection(request)` before anything
 *      else. That is the host's only authentication gate (login-token cookie) plus
 *      its Host/Origin fence against DNS rebinding and cross-site calls. A route
 *      that answers before asking is an unauthenticated local HTTP endpoint.
 *   2. Mutation bodies are bounded: POST only, `application/json`, <= 64 KiB.
 *      Without the cap a same-origin page (or a misbehaving client) can make the
 *      host buffer unbounded input into the plugin.
 *   3. Nothing written to a response may carry a credential value. This module
 *      owns the last line of defence (pattern redaction); the modules above it own
 *      the first (never placing evaluated config into a response).
 *
 * `ApiError` carries the contract's error code vocabulary (§5) and the matching HTTP
 * status, so a route never hand-assembles an error body.
 */

/** Body cap for every mutating route, quoted from the contract. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Contract error codes (§5) mapped to statuses.
 *
 * `probe-timeout` is the one code the contract allows on a 200 — the probe route
 * reports a failed probe as data, not as an HTTP error. It is listed here anyway so
 * an unexpected throw from the probe path degrades to 504 rather than 500.
 */
export const STATUS_BY_CODE = Object.freeze({
  'bad-request': 400,
  'not-found': 404,
  'not-manageable': 409,
  conflict: 409,
  'patch-invalid': 409,
  'probe-timeout': 504,
  'write-failed': 500,
});

/** A failure the contract can name: carries a frozen error code and an HTTP status. */
export class ApiError extends Error {
  /**
   * @param {string} code - one of the contract's error codes
   * @param {string} message - safe for the client (already contains no secret)
   * @param {{ status?: number, details?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = typeof options.status === 'number' ? options.status : STATUS_BY_CODE[code] ?? 500;
    this.details = options.details;
  }
}

/** Shorthand for the most common rejection. */
export const badRequest = (message, details) => new ApiError('bad-request', message, { details });

/**
 * Credential-shaped text matchers.
 *
 * These are deliberately generic rather than a list of this profile's own tokens:
 * a probe's stderr may quote any server's error, and a redactor that only knows
 * today's credentials is wrong tomorrow.
 */
const REDACTION_PATTERNS = [
  // GitHub: classic and fine-grained tokens.
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***'],
  // OpenAI-style and most compatible providers.
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, '***'],
  // AWS access key ids.
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '***'],
  // Slack.
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '***'],
  // `NAME: value` / `NAME=value` where the name looks like a credential.
  [
    /((?:[A-Za-z0-9_.-]*(?:KEY|PASSWORD|SECRET|TOKEN)[A-Za-z0-9_.-]*)\s*[:=]\s*)("[^"]{4,}"|'[^']{4,}'|[^\s,;]{4,})/gi,
    '$1***',
  ],
];

/**
 * Mask credentials in a string destined for a response.
 *
 * `values` are exact strings known to be secret in this request's scope — a probe's
 * literal `config.env` values, for instance. They are removed before the pattern
 * pass, so a value whose shape no pattern recognises is still masked.
 *
 * @param {unknown} text
 * @param {Iterable<unknown>} [values]
 * @returns {string}
 */
export function redact(text, values = []) {
  let out = String(text ?? '');
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 4) continue;
    out = out.split(value).join('***');
  }
  for (const [pattern, replacement] of REDACTION_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The contract's first line of every route: ask `connection` whether this request
 * may proceed at all.
 *
 * Returns `true` when the call was already refused (the response is finished), so a
 * handler reads `if (rejectUnauthorized(...)) return;`.
 *
 * A throwing `requestRejection` fails closed: the guard is what stands between an
 * unauthenticated caller and a config mutation, so an unusable guard must not be
 * read as permission.
 *
 * @param {object} ctx - plugin context (needs `connection`)
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @returns {boolean}
 */
export function rejectUnauthorized(ctx, request, response) {
  let rejection;
  try {
    rejection = ctx.connection?.requestRejection?.(request);
  } catch {
    rejection = 500;
  }
  if (rejection === undefined || rejection === null) return false;
  response.writeHead(Number(rejection) || 403, { 'cache-control': 'no-store' });
  response.end();
  return true;
}

/**
 * Send a JSON body. `no-store` is unconditional: every response here reflects live
 * host configuration, and a cached copy would outlive the change it describes.
 *
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/**
 * Send `{ error: { code, message, details? } }`, redacted.
 *
 * Unknown failures become `internal`/500: the contract's vocabulary describes the
 * failures the plugin can classify, and guessing a specific code for an unexpected
 * exception would mislead the client.
 *
 * @param {import('node:http').ServerResponse} response
 * @param {unknown} error
 */
export function sendError(response, error) {
  if (error instanceof ApiError) {
    const body = { error: { code: error.code, message: redact(error.message) } };
    if (error.details !== undefined) body.error.details = error.details;
    sendJson(response, error.status, body);
    return;
  }
  sendJson(response, 500, {
    error: { code: 'internal', message: redact(error?.message ?? String(error)) },
  });
}

/**
 * Enforce a route's method. GET routes also accept HEAD, as the host's own routes do.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {'GET'|'POST'} method
 * @returns {boolean}
 */
export function requireMethod(request, response, method) {
  if (request.method === method || (method === 'GET' && request.method === 'HEAD')) return true;
  response.writeHead(405, {
    allow: method === 'GET' ? 'GET, HEAD' : method,
    'cache-control': 'no-store',
  });
  response.end();
  return false;
}

/**
 * Require a JSON content type on a mutation.
 *
 * `text/plain` is the classic CSRF-friendly body type (a cross-site form can send
 * it without a preflight), so accepting only `application/json` is part of the
 * write-side fence, not just hygiene.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @returns {boolean}
 */
export function requireJson(request, response) {
  const type = String(request.headers['content-type'] ?? '').toLowerCase();
  if (type.startsWith('application/json')) return true;
  sendError(response, new ApiError('bad-request', 'mutating routes require application/json', { status: 415 }));
  return false;
}

/**
 * Read and parse a bounded JSON body.
 *
 * The size check happens per chunk while reading, so an oversized body is refused
 * before it is fully buffered. `413` is used for the cap and `400` for malformed
 * JSON; both carry the contract's `bad-request` code.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {number} [limit]
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new ApiError('bad-request', `request body exceeds ${limit} bytes`, { status: 413 });
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new ApiError('bad-request', 'a JSON body is required');
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ApiError('bad-request', `the request body is not valid JSON: ${error.message}`);
  }
}
