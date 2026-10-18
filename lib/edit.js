/**
 * dsh-mcp-manager — editing one MCP row's configuration.
 *
 * The load-bearing fact (dsh-api-0.2.1.md §2.3, §9.1; contract §6.3): the callback
 * `ConfigEditor.edit` runs receives the **evaluated** config as its first argument —
 * `!!js` already expanded and credentials already in plaintext. Writing `{...current}`
 * back would serialise those values into the profile patch. This module therefore
 * never reads that argument; the merge base is always the second argument,
 * `inherited`, the raw layer where `!!js` is still `{__jsExpr}`.
 *
 * The browser's input is a partial raw-layer config: `{__jsExpr:'process.env.X'}`
 * marks an expression and the literal string is the user's explicit choice of a
 * literal. Both are handed to ConfigEditor unchanged — it converts `{__jsExpr}` back
 * into a `!!js` tag when it writes (`dsh-config-editor/lib/index.js:111-116`). No
 * expression is ever evaluated here.
 *
 * Two additions from the contract's appendix A:
 *   - `{__keep:true}` in an env/headers entry means "keep whatever the row already
 *     has under this name" — the UI's way to submit a form whose credential inputs
 *     are empty because it must not know the value. The replacement happens against
 *     the fresh inherited layer, and a name with no inherited value is a 400.
 *   - `migrateSecrets: true` rewrites literal credential-shaped values into
 *     `!!js process.env.<KEY>` references (key names unchanged). It moves no value;
 *     it only stops the patch from carrying one.
 */

import { ApiError, badRequest } from './security.js';
import { MCP_CLIENT_PACKAGE, jsExprOf } from './patch.js';
import { isSecretName, validateConfigPatch, validateEffectiveConfig } from './diagnostics.js';

/** `{__keep:true}` and nothing else. */
export function isKeepSentinel(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === '__keep' && value.__keep === true;
}

/**
 * Replace `{__keep:true}` entries in a patch's `env`/`headers` with the inherited
 * raw value for the same name.
 *
 * Runs twice by design: once before validation (so a missing inherited value is a
 * clean 400 before ConfigEditor is touched) and once inside `edit` against the
 * freshly read inherited layer.
 *
 * @param {object} inherited - raw inherited config from `configuration()`
 * @param {object} patch - caller-supplied raw config patch
 * @returns {{ config: object, missing: Array<{field: string, key: string}> }}
 */
export function resolveKeepSentinels(inherited, patch) {
  const config = { ...(patch ?? {}) };
  const missing = [];
  const base = inherited !== null && typeof inherited === 'object' ? inherited : {};
  for (const field of ['env', 'headers']) {
    const map = patch?.[field];
    if (map === null || typeof map !== 'object' || Array.isArray(map)) continue;
    const baseMap = base[field] !== null && typeof base[field] === 'object' ? base[field] : {};
    const next = {};
    for (const [key, value] of Object.entries(map)) {
      if (isKeepSentinel(value)) {
        if (baseMap[key] === undefined) {
          missing.push({ field, key });
          continue;
        }
        // Deep-clone so the inherited layer's object is never handed to the writer
        // by reference (ConfigEditor mutates nodes, not this value, but the clone
        // keeps the two paths independent).
        next[key] = structuredClone(baseMap[key]);
        continue;
      }
      next[key] = value;
    }
    config[field] = next;
  }
  return { config, missing };
}

/** Throw the contract's 400 when a `{__keep:true}` has nothing to keep. */
export function assertKeepResolved(missing) {
  if (missing.length === 0) return;
  throw new ApiError('bad-request', 'a {__keep:true} entry has no value to keep in this row', {
    details: missing.map(({ field, key }) => ({
      field: `${field}.${key}`,
      message: 'the row has no inherited value under this name; send a literal or a {__jsExpr} instead',
    })),
  });
}

/**
 * Rewrite literal credential-shaped values as `!!js process.env.<KEY>` references.
 *
 * Only names that are also valid env identifiers are migrated — `Authorization`
 * would become `process.env.Authorization` (syntactically valid JS, if unusual),
 * but a header name like `X-Api-Key` cannot be expressed as a member access, so it
 * is reported as skipped instead of producing an expression the loader cannot
 * evaluate.
 *
 * @param {object} config - mutable effective raw config
 * @returns {{ migrated: string[], skipped: string[] }}
 */
export function migrateSecretLiterals(config) {
  const migrated = [];
  const skipped = [];
  for (const field of ['env', 'headers']) {
    const map = config?.[field];
    if (map === null || typeof map !== 'object' || Array.isArray(map)) continue;
    const header = field === 'headers';
    for (const [key, value] of Object.entries(map)) {
      if (jsExprOf(value) !== null) continue;
      if (typeof value !== 'string' || value === '') continue;
      if (!isSecretName(key, { header })) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        skipped.push(key);
        continue;
      }
      map[key] = { __jsExpr: `process.env.${key}` };
      migrated.push(key);
    }
  }
  return { migrated, skipped };
}

/**
 * Keep only the fields an MCP row's Config accepts, and keep the two transport
 * unions disjoint.
 *
 * The shallow merge `{...inherited, ...patch}` (§6.3) is intentional: a patch that
 * omits a field keeps the inherited one. But when a row changes transport, the keys
 * that only belong to the previous union member would otherwise linger in the
 * written override, so they are dropped.
 */
export function sanitizeMerged(config) {
  const allowed = [
    'transport',
    'serverName',
    'command',
    'args',
    'env',
    'cwd',
    'url',
    'headers',
    'toolCallTimeoutMs',
    'maxInstructionBytes',
    'failOnStartupError',
    'reconnect',
  ];
  const out = {};
  for (const key of allowed) {
    if (config[key] === undefined) continue;
    out[key] = config[key];
  }
  const transport = out.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  if (transport === 'streamable-http') {
    for (const key of ['command', 'args', 'env', 'cwd']) Reflect.deleteProperty(out, key);
    out.headers = normalizeMapLiteralTypes(out.headers);
  } else {
    Reflect.deleteProperty(out, 'url');
    Reflect.deleteProperty(out, 'headers');
    out.env = normalizeMapLiteralTypes(out.env);
  }
  return out;
}

/** YAML may hand back numbers/booleans in a string map; the schema wants strings. */
function normalizeMapLiteralTypes(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return map;
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    if (jsExprOf(value) !== null) out[key] = value;
    else if (typeof value === 'string') out[key] = value;
    else if (value === null || value === undefined) out[key] = '';
    else out[key] = String(value);
  }
  return out;
}

/** Translate a ConfigEditor failure into the contract's error vocabulary. */
function translateEditError(error) {
  const message = String(error?.message ?? error);
  if (message.includes('no longer available') || message.includes('changed during reload')) {
    return new ApiError('not-found', message);
  }
  if (message.includes('overridden by a home patch') || message.includes('no longer active')) {
    return new ApiError('patch-invalid', `the host refused the configuration change: ${message}`);
  }
  return new ApiError('patch-invalid', `the host refused the configuration change: ${message}`);
}

/**
 * Apply one raw-layer config patch to an existing MCP row.
 *
 * @param {object} ctx - plugin context (needs `configEditor`)
 * @param {{ patchId: string, config?: object, migrateSecrets?: boolean }} input
 * @returns {Promise<{ changed: true, migrated: string[] }>}
 */
export async function updateServerConfig(ctx, input) {
  const { patchId, config, migrateSecrets } = input ?? {};
  if (typeof patchId !== 'string' || patchId === '') throw badRequest('"patchId" must be a non-empty string');
  const editor = ctx.configEditor;
  if (editor === undefined) throw new ApiError('patch-invalid', 'the config editor is not mounted in this host');

  const entry = editor
    .entries()
    .find((candidate) => candidate.options?.id === patchId && candidate.options?.name === MCP_CLIENT_PACKAGE);
  if (entry === undefined) throw new ApiError('not-found', `no MCP entry with patchId "${patchId}"`);

  const rawPatch = config === undefined || config === null ? {} : config;
  if (typeof rawPatch !== 'object' || Array.isArray(rawPatch)) throw badRequest('"config" must be an object');

  const layer = (editor.configuration() ?? []).find((candidate) => candidate.entry.id === entry.id);
  // The effective raw layer is `{...inherited, ...override}` (contract §2.3): a previous
  // edit lives in `override`, and the page shows those values, so `{__keep:true}` and
  // `migrateSecrets` must resolve against the same thing the user saw.
  const inheritedNow = layer?.inherited ?? {};
  const overrideNow = layer?.override ?? {};
  const effectiveNow = { ...structuredClone(inheritedNow), ...structuredClone(overrideNow) };

  // Validate before touching the editor so a malformed patch is a 400 with field
  // details, not a failed write.
  const resolvedNow = resolveKeepSentinels(effectiveNow, rawPatch);
  assertKeepResolved(resolvedNow.missing);
  const validation = validateConfigPatch(resolvedNow.config);
  if (!validation.ok) throw new ApiError('bad-request', 'invalid config', { details: validation.errors });

  let migrated = [];
  let migrateSkipped = [];
  const migrate = migrateSecrets === true;

  try {
    await editor.edit(entry, (_current, inherited) => {
      // The fresh inherited layer is the only legitimate merge base: the first
      // argument is the evaluated config and must never be read. The profile override
      // is re-read here (inside the editor's lock) so a previous edit's values are
      // part of the base rather than silently dropped.
      const currentLayer = (editor.configuration() ?? []).find((candidate) => candidate.entry.id === entry.id);
      const base = { ...structuredClone(inherited ?? {}), ...structuredClone(currentLayer?.override ?? overrideNow) };
      const fresh = resolveKeepSentinels(base, rawPatch);
      assertKeepResolved(fresh.missing);
      const merged = { ...base, ...fresh.config };
      if (migrate) {
        const outcome = migrateSecretLiterals(merged);
        migrated = outcome.migrated;
        migrateSkipped = outcome.skipped;
      }
      const effective = validateEffectiveConfig(merged);
      if (!effective.ok) {
        throw new ApiError('bad-request', 'the merged configuration is invalid', { details: effective.errors });
      }
      return sanitizeMerged(merged);
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw translateEditError(error);
  }

  return { changed: true, migrated, ...(migrate ? { migrateSkipped } : {}) };
}
