/**
 * dsh-mcp-manager — import/export of the de-facto `mcpServers` JSON shape.
 *
 * Export is a read of the **raw** layers (`configuration().inherited` +
 * `override`), never the evaluated config, so a credential can only leave as the
 * expression that produced it. Every literal value whose name looks like a
 * credential is dropped from the export entirely: an export is a document the user
 * will paste around, and a literal token in it is a leak, not a feature.
 *
 * Import accepts the shapes other agents emit (`mcpServers` with `type`, `command`,
 * `args`, `env`, `url`, `headers`) and normalises them onto DSH's narrower Config:
 *
 *   - `streamableHttp` / `streamable-http` / `http` / `remote` → `streamable-http`
 *   - `sse` → `streamable-http` (DSH has no SSE transport) and the substitution is
 *     reported in `droppedFields`
 *   - no `type` + `command` → stdio; no `type` + `url` → `streamable-http`
 *   - a value of `!!js <expr>`, `${VAR}` or `$env:VAR` → `{__jsExpr: <expr>}`
 *     (for the brace/env forms the expression is `process.env.VAR`), anything else
 *     stays a literal
 *   - every field DSH's MCP Config does not have (`autoApprove`, `alwaysAllow`,
 *     `disabled`, `isActive`, `timeout`, ...) is dropped **and reported** in
 *     `droppedFields`, because silently discarding half of an imported server is how
 *     a user ends up with a server that looks imported but behaves differently.
 *
 * Each accepted server is created through `addManagedServer`, which means the same
 * lock, backup, atomic write, and post-write composition check as `POST /servers/add`
 * — an import cannot leave a half-written profile.
 */

import { ApiError } from './security.js';
import { MCP_CLIENT_PACKAGE, addManagedServer, jsExprOf } from './patch.js';
import { isSecretName } from './diagnostics.js';
import { validateServerInput } from './diagnostics.js';

/** Fields a DSH MCP row can actually hold. */
const SUPPORTED_IMPORT_FIELDS = new Set([
  'type',
  'transport',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'failOnStartupError',
  'maxInstructionBytes',
  'reconnect',
]);

/** The expression prefix the export uses, and the import recognises. */
export const JS_STRING_PREFIX = '!!js ';

/** One `env`/`headers` value as it appears in an exported document. */
export function exportValue(value, key, { header = false } = {}) {
  const expression = jsExprOf(value);
  if (expression !== null) return `${JS_STRING_PREFIX}${expression}`;
  if (isSecretName(key, { header })) return undefined; // a literal credential is never exported
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Map a raw env/header object into the exported string-valued form. */
function exportPairs(map, options) {
  const out = {};
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    const exported = exportValue(value, key, options);
    if (exported !== undefined) out[key] = exported;
  }
  return out;
}

/** One raw effective config as a `mcpServers` definition. */
export function exportDefinition(raw) {
  const transport = raw?.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  if (transport === 'stdio') {
    const out = { type: 'stdio', command: typeof raw?.command === 'string' ? raw.command : '' };
    if (Array.isArray(raw?.args) && raw.args.length > 0) out.args = raw.args.map(String);
    if (typeof raw?.cwd === 'string' && raw.cwd !== '') out.cwd = raw.cwd;
    const env = exportPairs(raw?.env);
    if (Object.keys(env).length > 0) out.env = env;
    if (typeof raw?.toolCallTimeoutMs === 'number') out.toolCallTimeoutMs = raw.toolCallTimeoutMs;
    if (typeof raw?.failOnStartupError === 'boolean') out.failOnStartupError = raw.failOnStartupError;
    if (typeof raw?.maxInstructionBytes === 'number') out.maxInstructionBytes = raw.maxInstructionBytes;
    if (raw?.reconnect !== null && typeof raw?.reconnect === 'object') out.reconnect = { ...raw.reconnect };
    return out;
  }
  const out = { type: 'http', url: typeof raw?.url === 'string' ? raw.url : '' };
  const headers = exportPairs(raw?.headers, { header: true });
  if (Object.keys(headers).length > 0) out.headers = headers;
  if (typeof raw?.toolCallTimeoutMs === 'number') out.toolCallTimeoutMs = raw.toolCallTimeoutMs;
  if (typeof raw?.failOnStartupError === 'boolean') out.failOnStartupError = raw.failOnStartupError;
  if (typeof raw?.maxInstructionBytes === 'number') out.maxInstructionBytes = raw.maxInstructionBytes;
  if (raw?.reconnect !== null && typeof raw?.reconnect === 'object') out.reconnect = { ...raw.reconnect };
  return out;
}

/**
 * Export every configured server as `{ mcpServers: { <serverName>: <definition> } }`.
 *
 * @param {object} ctx - plugin context (needs `configEditor`)
 */
export async function exportServers(ctx) {
  const editor = ctx.configEditor;
  if (editor === undefined) throw new Error('the config editor is not mounted in this host');
  const configuration = new Map((editor.configuration() ?? []).map((item) => [item.entry.id, item]));
  const mcpServers = {};
  for (const entry of editor.entries()) {
    if (entry.options?.name !== MCP_CLIENT_PACKAGE) continue;
    const layer = configuration.get(entry.id);
    const raw = { ...(layer?.inherited ?? {}), ...(layer?.override ?? {}) };
    const evaluatedName = typeof entry.options.config?.serverName === 'string' ? entry.options.config.serverName : null;
    const serverName = evaluatedName ?? (typeof raw.serverName === 'string' ? raw.serverName : null) ?? entry.options.id;
    if (typeof serverName !== 'string' || serverName === '') continue;
    mcpServers[serverName] = exportDefinition(raw);
  }
  return { mcpServers };
}

/**
 * Translate one imported `env`/`headers` value into the raw-layer value DSH stores.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function importValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const js = /^!!js\s+(.+)$/.exec(trimmed);
  if (js !== null) return { __jsExpr: js[1].trim() };
  const braced = /^\$\{(.+)\}$/.exec(trimmed);
  if (braced !== null) return { __jsExpr: asEnvExpression(braced[1].trim()) };
  const envForm = /^\$env:(.+)$/.exec(trimmed);
  if (envForm !== null) return { __jsExpr: asEnvExpression(envForm[1].trim()) };
  return value;
}

/** `${VAR}` / `$env:VAR` name a variable, so the expression is `process.env.VAR`. */
function asEnvExpression(name) {
  if (/^process\.env\./.test(name)) return name;
  return `process.env.${name}`;
}

/** Map a whole imported env/header object. */
function importPairs(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(map)) out[key] = importValue(value);
  return out;
}

/**
 * Normalize one imported definition onto a DSH server input.
 *
 * Returns `{ ok, server, dropped, errors }` where `dropped` names fields the import
 * discarded (unsupported keys and a transport substitution), so the caller can
 * report them instead of silently losing them.
 *
 * @param {string} serverName
 * @param {unknown} definition
 */
export function serverFromImportDefinition(serverName, definition) {
  const dropped = [];
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    return { ok: false, server: null, dropped, errors: [{ field: serverName, message: 'the definition must be an object' }] };
  }
  for (const key of Object.keys(definition)) {
    if (!SUPPORTED_IMPORT_FIELDS.has(key)) dropped.push(key);
  }

  const rawType = typeof definition.type === 'string' ? definition.type : typeof definition.transport === 'string' ? definition.transport : undefined;
  const errors = [];
  let transport;
  if (rawType === undefined) {
    transport = typeof definition.url === 'string' && definition.url !== '' ? 'streamable-http' : 'stdio';
  } else {
    const normalized = rawType.toLowerCase().replace(/\s+/g, '');
    if (normalized === 'stdio') {
      transport = 'stdio';
    } else if (['streamablehttp', 'streamable-http', 'http', 'remote'].includes(normalized)) {
      transport = 'streamable-http';
    } else if (normalized === 'sse') {
      // DSH's Config union has no SSE member; a streamable-http attempt is the
      // closest supported behaviour, and the substitution is reported.
      transport = 'streamable-http';
      dropped.push('transport:sse→streamable-http');
    } else {
      errors.push({ field: 'type', message: `unsupported transport "${rawType}"` });
      return { ok: false, server: null, dropped, errors };
    }
  }

  const input = { serverName, transport };
  if (transport === 'stdio') {
    input.command = definition.command;
    if (definition.args !== undefined) input.args = definition.args;
    if (definition.cwd !== undefined) input.cwd = definition.cwd;
    const env = importPairs(definition.env);
    if (env !== undefined) input.env = env;
  } else {
    input.url = definition.url;
    const headers = importPairs(definition.headers);
    if (headers !== undefined) input.headers = headers;
  }
  for (const key of ['toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect']) {
    if (definition[key] !== undefined) input[key] = definition[key];
  }

  const validation = validateServerInput(input);
  if (!validation.ok) return { ok: false, server: null, dropped, errors: validation.errors };
  return { ok: true, server: validation.server, dropped, errors: [] };
}

/**
 * Import a `mcpServers` document, one server at a time.
 *
 * `mode` is `'add'` only: the contract explicitly forbids overwriting an existing
 * name, so a duplicate is skipped and reported rather than merged.
 *
 * @param {object} ctx
 * @param {{ mcpServers?: unknown, mode?: string }} payload
 * @returns {Promise<{ added: object[], skipped: object[], errors: object[], droppedFields: object[] }>}
 */
export async function importServers(ctx, payload) {
  const mode = payload?.mode ?? 'add';
  if (mode !== 'add') throw new ApiError('bad-request', 'only mode "add" is supported');
  const map = payload?.mcpServers;
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw new ApiError('bad-request', '"mcpServers" must be an object keyed by server name');
  }

  const added = [];
  const skipped = [];
  const errors = [];
  const droppedFields = [];
  const seen = new Set();

  for (const [serverName, definition] of Object.entries(map)) {
    const mapped = serverFromImportDefinition(serverName, definition);
    if (mapped.dropped.length > 0) droppedFields.push({ serverName, fields: mapped.dropped });
    if (!mapped.ok) {
      errors.push({
        serverName,
        message: mapped.errors.map((entry) => (entry.field === undefined ? entry.message : `${entry.field}: ${entry.message}`)).join('; '),
      });
      continue;
    }
    if (seen.has(serverName)) {
      skipped.push({ serverName, reason: 'duplicate server name in the import payload' });
      continue;
    }
    seen.add(serverName);
    try {
      const result = await addManagedServer(ctx, mapped.server);
      added.push({ serverName, patchId: result.patchId });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        skipped.push({ serverName, reason: error.message });
      } else if (error instanceof ApiError && error.code === 'bad-request') {
        errors.push({ serverName, message: error.message });
      } else {
        errors.push({ serverName, message: String(error?.message ?? error) });
      }
    }
  }

  return { added, skipped, errors, droppedFields };
}
