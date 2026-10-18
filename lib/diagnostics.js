/**
 * dsh-mcp-manager — input validation and the diagnostics block.
 *
 * Two jobs, both about telling the truth before anything is written:
 *
 *   - `validateServerInput` / `validateConfigPatch` / `validateEffectiveConfig`
 *     reject a definition DSH's own Config schema would reject (dsh-mcp-client
 *     `lib/index.js:780-800`: a `serverName` pattern, a `stdio` union member that
 *     requires `command`, an http member that requires `url`, `args`/`env`/`headers`
 *     as string collections). The host validates again at load time, but a rejected
 *     request must not leave a broken row in the profile patch first.
 *   - `diagnose` explains the rows that already exist: illegal or duplicate
 *     `serverName`, a `command` that is not on disk, a `!!js process.env.X` whose X
 *     the host process does not have, a credential written as a literal, and a
 *     profile patch that does not parse at all.
 *
 * Neither function evaluates anything or returns a value that came out of a config:
 * diagnostics carry names, never secrets.
 */

import { existsSync } from 'node:fs';

import { jsExprOf, patchIdFor } from './patch.js';

/** DSH's `serverName` constraint, quoted from dsh-mcp-client. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** The transports dsh-mcp-client's Config union accepts. */
export const TRANSPORTS = Object.freeze(['stdio', 'streamable-http']);

/** dsh-subprocess' scrub heuristic, reused here to recognise credential-shaped names. */
export const SENSITIVE_NAME_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

/** Header names that carry credentials without containing a `KEY`-shaped word. */
const SECRET_HEADER_PATTERN = /authorization|cookie|api[-_]?key/i;

/** The largest delay the host's timer helpers accept. */
const MAX_TIMER_DELAY_MS = 2147483647;

/**
 * Whether a field name looks like it carries a credential.
 *
 * Header mode is wider: `Authorization` and `Cookie` are credentials even though
 * their names match none of the environment-variable words.
 */
export function isSecretName(name, { header = false } = {}) {
  if (SENSITIVE_NAME_PATTERN.test(name)) return true;
  return header && SECRET_HEADER_PATTERN.test(name);
}

const error = (field, message) => ({ field, message });

/** A key we are willing to render into YAML on one line. */
function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 128 && !/[\r\n]/.test(key);
}

/** Whether an expression is safe to hand to the loader as a `!!js` scalar. */
function isSafeExpression(expression) {
  return expression.trim() !== '' && !/[\r\n]/.test(expression);
}

/**
 * Normalize an `env`/`headers` mapping.
 *
 * Three value forms exist by contract (appendix A.2): a literal string, the
 * loader's inert `{__jsExpr}` representation, and a value the browser supplies as
 * `{__jsExpr: 'process.env.X'}`. Values are never evaluated here — the expression
 * text is passed through untouched so ConfigEditor can restore the `!!js` tag.
 */
function normalizeStringMap(value, field, errors) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(error(field, 'must be an object mapping names to strings or {__jsExpr} references'));
    return {};
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isSafeKey(key)) {
      errors.push(error(`${field}.${key}`, 'the name is not usable as a YAML key'));
      continue;
    }
    const expression = jsExprOf(raw);
    if (expression !== null) {
      if (!isSafeExpression(expression)) {
        errors.push(error(`${field}.${key}`, 'the JS expression must be a non-empty single line'));
        continue;
      }
      out[key] = { __jsExpr: expression };
      continue;
    }
    if (typeof raw === 'string') {
      out[key] = raw;
      continue;
    }
    if (raw === null || raw === undefined) {
      // A YAML key with no value is how a cleared credential comes back; treat it as
      // the empty literal the schema expects rather than dropping the key.
      out[key] = '';
      continue;
    }
    errors.push(error(`${field}.${key}`, 'must be a string or a {__jsExpr} reference'));
  }
  return out;
}

/** Validate the optional numeric/boolean knobs, returning only the keys supplied. */
function normalizeScalars(input, errors) {
  const out = {};
  if (input.toolCallTimeoutMs !== undefined) {
    const value = input.toolCallTimeoutMs;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      errors.push(error('toolCallTimeoutMs', 'must be a positive number of milliseconds'));
    } else {
      out.toolCallTimeoutMs = value;
    }
  }
  if (input.maxInstructionBytes !== undefined) {
    const value = input.maxInstructionBytes;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      errors.push(error('maxInstructionBytes', 'must be an integer >= 1'));
    } else {
      out.maxInstructionBytes = value;
    }
  }
  if (input.failOnStartupError !== undefined) {
    if (typeof input.failOnStartupError !== 'boolean') {
      errors.push(error('failOnStartupError', 'must be a boolean'));
    } else {
      out.failOnStartupError = input.failOnStartupError;
    }
  }
  if (input.reconnect !== undefined) {
    const reconnect = input.reconnect;
    if (reconnect === null || typeof reconnect !== 'object' || Array.isArray(reconnect)) {
      errors.push(error('reconnect', 'must be an object'));
    } else {
      const normalized = {};
      if (reconnect.enabled !== undefined) {
        if (typeof reconnect.enabled !== 'boolean') errors.push(error('reconnect.enabled', 'must be a boolean'));
        else normalized.enabled = reconnect.enabled;
      }
      for (const key of ['initialDelayMs', 'maxDelayMs']) {
        if (reconnect[key] === undefined) continue;
        const value = reconnect[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
          errors.push(error(`reconnect.${key}`, `must be a number between 1 and ${MAX_TIMER_DELAY_MS}`));
        } else {
          normalized[key] = value;
        }
      }
      if (reconnect.maxAttempts !== undefined) {
        const value = reconnect.maxAttempts;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
          errors.push(error('reconnect.maxAttempts', 'must be an integer >= 1'));
        } else {
          normalized.maxAttempts = value;
        }
      }
      out.reconnect = normalized;
    }
  }
  return out;
}

/**
 * Validate a full server definition (`POST /servers/add`, `POST /probe` body,
 * `POST /import` entries).
 *
 * Unknown fields are ignored rather than rejected: the browser may echo a whole row
 * back. `id`, when present, must be the derived row id (contract §6.1 rule 2).
 *
 * @returns {{ ok: boolean, errors: Array<{field: string, message: string}>, server: object|null }}
 */
export function validateServerInput(input) {
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [error('server', 'must be an object')], server: null };
  }

  const serverName = input.serverName;
  if (typeof serverName !== 'string' || serverName === '') {
    errors.push(error('serverName', 'is required'));
  } else if (!SERVER_NAME_PATTERN.test(serverName)) {
    errors.push(error('serverName', `must match ${String(SERVER_NAME_PATTERN)}`));
  }

  const transport = input.transport ?? (typeof input.url === 'string' && input.url !== '' ? 'streamable-http' : 'stdio');
  if (!TRANSPORTS.includes(transport)) {
    errors.push(error('transport', `must be one of ${TRANSPORTS.join(' | ')}`));
  }

  const server = { serverName, transport, args: [], env: {}, headers: {}, cwd: '' };

  if (transport === 'stdio') {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      errors.push(error('command', 'stdio transport requires a command'));
    } else {
      server.command = input.command;
    }
    if (input.args !== undefined) {
      if (!Array.isArray(input.args)) errors.push(error('args', 'must be an array of strings'));
      else server.args = input.args.map((arg) => (typeof arg === 'string' ? arg : String(arg)));
    }
    if (input.cwd !== undefined) {
      if (typeof input.cwd !== 'string') errors.push(error('cwd', 'must be a string'));
      else server.cwd = input.cwd;
    }
    const env = normalizeStringMap(input.env, 'env', errors);
    if (env !== undefined) server.env = env;
  } else {
    if (typeof input.url !== 'string' || input.url.trim() === '') {
      errors.push(error('url', 'streamable-http transport requires a url'));
    } else {
      try {
        const parsed = new URL(input.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push(error('url', 'must be an http:// or https:// url'));
        } else {
          server.url = input.url;
        }
      } catch {
        errors.push(error('url', 'is not a valid URL'));
      }
    }
    const headers = normalizeStringMap(input.headers, 'headers', errors);
    if (headers !== undefined) server.headers = headers;
  }

  Object.assign(server, normalizeScalars(input, errors));

  if (input.id !== undefined) {
    const derived = typeof serverName === 'string' ? patchIdFor(serverName) : null;
    if (typeof input.id !== 'string' || input.id !== derived) {
      errors.push(error('id', `must equal "${derived ?? 'mcp-client-<serverName>'}" — the patch row id is derived from serverName`));
    }
  }

  return { ok: errors.length === 0, errors, server: errors.length === 0 ? server : null };
}

/**
 * Validate the partial raw-layer config `POST /servers/update` accepts.
 *
 * Only supplied keys are normalized; the caller merges them over `inherited`. Unknown
 * keys are dropped without error (see `validateServerInput`).
 */
export function validateConfigPatch(input) {
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [error('config', 'must be an object')], config: null };
  }
  const config = {};

  if (input.transport !== undefined) {
    if (!TRANSPORTS.includes(input.transport)) errors.push(error('transport', `must be one of ${TRANSPORTS.join(' | ')}`));
    else config.transport = input.transport;
  }
  if (input.serverName !== undefined) {
    if (typeof input.serverName !== 'string' || !SERVER_NAME_PATTERN.test(input.serverName)) {
      errors.push(error('serverName', `must match ${String(SERVER_NAME_PATTERN)}`));
    } else {
      config.serverName = input.serverName;
    }
  }
  if (input.command !== undefined) {
    if (typeof input.command !== 'string' || input.command.trim() === '') errors.push(error('command', 'must be a non-empty string'));
    else config.command = input.command;
  }
  if (input.args !== undefined) {
    if (!Array.isArray(input.args)) errors.push(error('args', 'must be an array of strings'));
    else config.args = input.args.map((arg) => (typeof arg === 'string' ? arg : String(arg)));
  }
  if (input.cwd !== undefined) {
    if (typeof input.cwd !== 'string') errors.push(error('cwd', 'must be a string'));
    else config.cwd = input.cwd;
  }
  if (input.url !== undefined) {
    if (typeof input.url !== 'string' || input.url.trim() === '') {
      errors.push(error('url', 'must be a non-empty string'));
    } else {
      try {
        new URL(input.url);
        config.url = input.url;
      } catch {
        errors.push(error('url', 'is not a valid URL'));
      }
    }
  }
  if (input.env !== undefined) {
    const env = normalizeStringMap(input.env, 'env', errors);
    if (env !== undefined) config.env = env;
  }
  if (input.headers !== undefined) {
    const headers = normalizeStringMap(input.headers, 'headers', errors);
    if (headers !== undefined) config.headers = headers;
  }
  Object.assign(config, normalizeScalars(input, errors));

  return { ok: errors.length === 0, errors, config: errors.length === 0 ? config : null };
}

/**
 * Validate a merged effective config (what ConfigEditor is about to persist).
 *
 * The partial-patch validator cannot check cross-field requirements (`transport:
 * stdio` needs a `command`, and that `command` may come from `inherited`), so the
 * merged result is checked here before `edit` runs.
 */
export function validateEffectiveConfig(config) {
  const errors = [];
  const serverName = config.serverName;
  if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) {
    errors.push(error('serverName', `must match ${String(SERVER_NAME_PATTERN)}`));
  }
  const transport = config.transport ?? 'stdio';
  if (!TRANSPORTS.includes(transport)) {
    errors.push(error('transport', `must be one of ${TRANSPORTS.join(' | ')}`));
  } else if (transport === 'stdio') {
    if (typeof config.command !== 'string' || config.command.trim() === '') {
      errors.push(error('command', 'stdio transport requires a command'));
    }
    if (config.args !== undefined && !Array.isArray(config.args)) errors.push(error('args', 'must be an array'));
    if (config.env !== undefined && (config.env === null || typeof config.env !== 'object' || Array.isArray(config.env))) {
      errors.push(error('env', 'must be an object'));
    }
    for (const key of Object.keys(config.env ?? {})) {
      if (!isSafeKey(key)) errors.push(error(`env.${key}`, 'the name is not usable as a YAML key'));
    }
  } else {
    if (typeof config.url !== 'string' || config.url.trim() === '') {
      errors.push(error('url', 'streamable-http transport requires a url'));
    }
    for (const key of Object.keys(config.headers ?? {})) {
      if (!isSafeKey(key)) errors.push(error(`headers.${key}`, 'the name is not usable as a YAML key'));
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Build the `problems` array for `GET /servers` (contract §6.7 + appendix A.5).
 *
 * @param {Array<object>} rows - rows from `inspectPatch` (facts only, no values)
 * @param {{
 *   patchOk?: boolean, patchError?: string|null,
 *   env?: Record<string, string|undefined>,
 *   exists?: (path: string) => boolean,
 * }} [options]
 * @returns {Array<{ level: 'error'|'warn', serverName: string|null, message: string }>}
 */
export function diagnose(rows, options = {}) {
  const { patchOk = true, patchError = null, env = process.env, exists = existsSync } = options;
  const problems = [];
  if (!patchOk) {
    problems.push({
      level: 'error',
      serverName: null,
      message: `the profile patch is not valid YAML: ${patchError ?? 'unknown parse error'}`,
    });
    return problems;
  }

  const seen = new Map();
  for (const row of rows) {
    if (!row.isMcpClient) continue;
    const serverName = typeof row.serverName === 'string' && row.serverName !== '' ? row.serverName : row.patchId;

    if (typeof row.serverName !== 'string' || row.serverName === '') {
      problems.push({ level: 'error', serverName: row.patchId, message: 'the row declares no serverName' });
    } else if (!SERVER_NAME_PATTERN.test(row.serverName)) {
      problems.push({
        level: 'error',
        serverName,
        message: `serverName "${row.serverName}" violates ${String(SERVER_NAME_PATTERN)}`,
      });
    }

    if (seen.has(row.serverName)) {
      problems.push({
        level: 'error',
        serverName,
        message: `serverName "${row.serverName}" is also used by row "${seen.get(row.serverName)}" — the host rejects the second instance`,
      });
    } else {
      seen.set(row.serverName, row.patchId);
    }

    if (row.transport === 'stdio') {
      if (typeof row.command !== 'string' || row.command === '') {
        problems.push({ level: 'error', serverName, message: 'stdio transport requires a command' });
      } else if (!exists(row.command)) {
        problems.push({
          level: 'warn',
          serverName,
          message: `command not found on disk: ${row.command} (a PATH-resolved command may still work)`,
        });
      }
    } else if (row.transport === 'streamable-http') {
      if (typeof row.url !== 'string' || row.url === '') {
        problems.push({ level: 'error', serverName, message: 'streamable-http transport requires a url' });
      }
    } else {
      problems.push({ level: 'error', serverName, message: `unknown transport "${String(row.transport)}"` });
    }

    for (const info of row.envKeys ?? []) {
      if (!info.isJsExpr) continue;
      const match = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(info.jsExpr ?? '');
      if (match !== null && env[match[1]] === undefined) {
        problems.push({
          level: 'warn',
          serverName,
          message: `env "${info.key}" references process.env.${match[1]}, which is not set in the host process — the value will be empty`,
        });
      }
    }

    for (const key of row.envLiteralKeys ?? []) {
      if (!isSecretName(key)) continue;
      problems.push({
        level: 'warn',
        serverName,
        message: `env "${key}" holds a literal value; prefer an unevaluated !!js process.env.${key} reference`,
      });
    }
    for (const key of row.headerLiteralKeys ?? []) {
      if (!isSecretName(key, { header: true })) continue;
      problems.push({
        level: 'warn',
        serverName,
        message: `header "${key}" holds a literal value; prefer an unevaluated !!js expression`,
      });
    }
  }

  return problems;
}
