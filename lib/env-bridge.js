/**
 * dsh-mcp-manager — the environment-variable bridge.
 *
 * MCP rows express credentials as `!!js process.env.NAME`, which the loader evaluates
 * in the host process when the row loads. That only works if `NAME` is actually in
 * `process.env` — but on this machine the desktop app is started by a launcher
 * (DeskGo) whose environment is an old snapshot, so a variable exported today never
 * reaches the host. The bridge closes that gap without touching the launcher:
 *
 *   `<profileDir>/data/mcp-manager/secrets.json`  →  `process.env`
 *
 * Design constraints, all deliberate:
 *
 *   - **Read-only.** This plugin never creates or edits the file; the operator (or a
 *     future settings action) owns it, and on Windows can ACL it to the current user.
 *     A missing file is simply "nothing to inject".
 *   - **Never overwrite.** A variable that already exists in the process environment
 *     wins; the bridge only fills gaps, so it cannot silently change a value the
 *     launcher or the operator set. Those names are reported as `already-set`.
 *   - **Synchronous and early.** `apply` calls this before registering any route or
 *     tool, so a later `!!js` evaluation (and the first server list) sees the values.
 *     The file is tiny; the read happens once per mount.
 *   - **Values never leave this module.** The result contains key names, a path, and
 *     skip reasons — never a value. Logs and diagnostics follow the same rule.
 *   - **Failure is not fatal.** Missing file, unreadable file, malformed JSON, wrong
 *     shape: a warning and an `error` field, never a throw that would prevent the
 *     plugin — and the whole MCP manager — from mounting.
 *
 * The last result is kept in module state so `GET /servers` and the diagnostics
 * snapshot can report what the bridge did without re-reading the file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { profileDirOf } from './patch.js';

/** File name under `<profileDir>/data/mcp-manager/`. */
export const SECRETS_FILE = 'secrets.json';

/** The only key names the bridge accepts: a process environment variable name. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The result of the most recent bridge run (or `null` before the first `apply`). */
let lastResult = null;

/** The full path the bridge reads for a profile directory. */
export function secretsPathFor(profileDir) {
  return join(profileDir, 'data', 'mcp-manager', SECRETS_FILE);
}

/** The last bridge result, for `GET /servers` and the diagnostics snapshot. */
export function envBridgeSnapshot() {
  return lastResult;
}

/** Clear module state (tests / a disposed plugin). */
export function resetEnvBridge() {
  lastResult = null;
}

/** Warning through the host logger when available; never throws. */
function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.(message);
  } catch {
    /* a logger that throws must not fail the bridge */
  }
  if (ctx?.logger === undefined || ctx.logger === null) {
    // No logger in this composition (or a test double); keep the diagnostic visible.
    try {
      console.warn(message);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read `secrets.json` and fill the missing process environment variables.
 *
 * Synchronous by contract: `apply` runs it before anything else and must not await.
 *
 * @param {object} ctx - plugin context (only `logger` is used, optionally)
 * @param {{ file?: string, profileDir?: string }} [options] - explicit paths (tests, diagnostics)
 * @returns {{
 *   file: string,
 *   exists: boolean,
 *   error: string | null,
 *   configured: string[],
 *   injected: string[],
 *   skipped: Array<{ key: string, reason: 'invalid-key'|'invalid-value'|'already-set' }>
 * }}
 */
export function applyEnvBridge(ctx, options = {}) {
  const profileDir =
    typeof options.profileDir === 'string' && options.profileDir !== ''
      ? options.profileDir
      : profileDirOf(ctx);
  const file = typeof options.file === 'string' && options.file !== '' ? options.file : secretsPathFor(profileDir);
  const result = { file, exists: false, error: null, configured: [], injected: [], skipped: [] };

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // ENOENT is the normal "no secrets configured" case; anything else is a real
    // diagnostic but still just a warning. The error code is reported, not the message
    // (a message can contain a path, and this result is served to the browser).
    if (error?.code !== 'ENOENT') {
      result.error = `cannot read ${file} (${error?.code ?? 'read-failed'})`;
      warn(ctx, `[dsh-mcp-manager] env bridge: ${result.error}; no variables injected`);
    }
    lastResult = result;
    return result;
  }
  result.exists = true;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Deliberately not echoing the parser message: it can quote part of the file.
    result.error = `${file} is not valid JSON`;
    warn(ctx, `[dsh-mcp-manager] env bridge: ${result.error}; no variables injected`);
    lastResult = result;
    return result;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    result.error = `${file} must contain a JSON object of ENV_NAME: "value" pairs`;
    warn(ctx, `[dsh-mcp-manager] env bridge: ${result.error}; no variables injected`);
    lastResult = result;
    return result;
  }

  for (const [key, value] of Object.entries(data)) {
    if (!ENV_NAME_PATTERN.test(key)) {
      result.skipped.push({ key, reason: 'invalid-key' });
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      result.skipped.push({ key, reason: 'invalid-value' });
      continue;
    }
    result.configured.push(key);
    if (process.env[key] === undefined) {
      process.env[key] = value;
      result.injected.push(key);
    } else {
      // Never overwrite what the launcher/operator already provided.
      result.skipped.push({ key, reason: 'already-set' });
    }
  }

  result.configured.sort();
  result.injected.sort();
  result.skipped.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  if (result.skipped.length > 0) {
    const summary = result.skipped.map((entry) => `${entry.key} (${entry.reason})`).join(', ');
    warn(ctx, `[dsh-mcp-manager] env bridge: skipped ${result.skipped.length} entr${result.skipped.length === 1 ? 'y' : 'ies'} in ${file}: ${summary}`);
  }
  lastResult = result;
  return result;
}
