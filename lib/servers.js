/**
 * dsh-mcp-manager — the server list the settings page renders.
 *
 * Three sources are joined, and keeping them distinct is the whole design:
 *
 *   1. `pluginManager.listPlugins()` — the live Loader inventory: `entryId`,
 *      `patchId`, `enabled`, `fiberPhase`. This is the only source for enablement
 *      and startup phase.
 *   2. `configEditor.configuration()` — the **raw** layers. `inherited` is the
 *      bundled/insert row, `override` the last profile row for that id; top-level
 *      shallow merge gives the effective raw config, where `!!js` is still
 *      `{__jsExpr}`. This is where transport/command/url/env key names come from.
 *   3. `ctx.tools.schemas()` — the `mcp__<serverName>__*` namespace, whose size is
 *      the only cheap "did this server ever synchronise" signal. It is not
 *      liveness, and the UI is told so.
 *
 * `entry.options.config` is read for exactly one field: `serverName`. That object is
 * the evaluated config (`!!js` expanded, credentials plaintext) and must never be
 * serialised into a response. Everything else in a row comes from source 2.
 *
 * Probe results come from `probe.js`'s in-memory cache: an observation with a
 * timestamp, never presented as connection state.
 */

import { MCP_CLIENT_PACKAGE, describeKeyMap, inspectPatch, patchPathOf, readPatchText } from './patch.js';
import { diagnose } from './diagnostics.js';
import { lastProbeOf } from './probe.js';

/** The host's plugin manager, or `undefined`. */
function pluginManagerOf(ctx) {
  return ctx.pluginManager ?? (typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined);
}

/** The host's config editor, or `undefined`. */
function configEditorOf(ctx) {
  return ctx.configEditor ?? (typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined);
}

/** Every tool name the host currently exposes, tolerant of a missing/renamed service. */
function toolNames(ctx) {
  try {
    const schemas = ctx.tools?.schemas?.();
    if (!Array.isArray(schemas)) return [];
    return schemas.map((schema) => (typeof schema === 'string' ? schema : schema?.name)).filter((name) => typeof name === 'string');
  } catch {
    return [];
  }
}

/** `command arg1 arg2`, shortened so a long launcher path cannot dominate the row. */
function summarizeTarget(command, args) {
  const parts = [command, ...(Array.isArray(args) ? args : [])].filter((part) => typeof part === 'string' && part !== '');
  const text = parts.join(' ');
  return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
}

/**
 * Assemble one row of the contract's server model (§4 + appendix A.4/A.7).
 */
function buildServer({ entryId, patchId, serverName, raw, patched, live, toolNames: names }) {
  const transport = (raw.transport ?? patched?.transport) === 'streamable-http' ? 'streamable-http' : 'stdio';
  const command = typeof raw.command === 'string' ? raw.command : patched?.command ?? '';
  const args = Array.isArray(raw.args) ? raw.args.map(String) : patched?.args ?? [];
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : patched?.cwd ?? '';
  const url = typeof raw.url === 'string' ? raw.url : patched?.url ?? '';
  const envKeys = raw.env !== null && typeof raw.env === 'object' ? describeKeyMap(raw.env) : patched?.envKeys ?? [];
  const headerKeys =
    raw.headers !== null && typeof raw.headers === 'object' ? describeKeyMap(raw.headers) : patched?.headerKeys ?? [];
  const prefix = `mcp__${serverName}__`;
  const managed = patched?.managed === true;
  return {
    entryId: entryId ?? null,
    patchId: patchId ?? null,
    serverName,
    transport,
    target: transport === 'stdio' ? summarizeTarget(command, args) : url,
    command,
    args,
    cwd,
    url,
    envKeys,
    headerKeys,
    toolCallTimeoutMs:
      typeof raw.toolCallTimeoutMs === 'number' ? raw.toolCallTimeoutMs : patched?.toolCallTimeoutMs ?? null,
    failOnStartupError:
      typeof raw.failOnStartupError === 'boolean' ? raw.failOnStartupError : patched?.failOnStartupError ?? null,
    maxInstructionBytes:
      typeof raw.maxInstructionBytes === 'number' ? raw.maxInstructionBytes : patched?.maxInstructionBytes ?? null,
    reconnect:
      raw.reconnect !== null && typeof raw.reconnect === 'object' && !Array.isArray(raw.reconnect)
        ? { ...raw.reconnect }
        : patched?.reconnect ?? null,
    enabled: live !== undefined && live.enabled === true,
    fiberPhase: typeof live?.fiberPhase === 'string' ? live.fiberPhase : null,
    toolCount: names.filter((name) => name.startsWith(prefix)).length,
    managed,
    // The UI needs one word to decide whether physical deletion is offered
    // (appendix A.7); `managed` is kept as the contract's boolean equivalent.
    source: managed ? 'managed' : 'handwritten',
    lastProbe: lastProbeOf(serverName),
  };
}

/**
 * Build the `GET /servers` response: `{ servers, patch, problems, totals }`.
 *
 * @param {object} ctx
 * @returns {Promise<{ servers: object[], patch: object, problems: object[], totals: object }>}
 */
export async function listServers(ctx) {
  const problems = [];
  const patchPath = patchPathOf(ctx);

  let text = '';
  let patch;
  if (patchPath === null) {
    patch = { path: null, ok: false, error: 'the config editor is not mounted in this host' };
  } else {
    try {
      text = await readPatchText(patchPath);
      patch = { path: patchPath, ok: true, error: null };
    } catch (error) {
      patch = { path: patchPath, ok: false, error: String(error?.message ?? error) };
    }
  }

  const info = patch.ok
    ? inspectPatch(text)
    : { ok: false, error: patch.error, rows: [], managedIds: [], block: null };
  if (!info.ok) patch = { ...patch, ok: false, error: info.error };

  // Live inventory. A missing manager is reported, not thrown: the list is still
  // useful without enablement/phase.
  const manager = pluginManagerOf(ctx);
  let liveRows = [];
  if (manager === undefined) {
    problems.push({ level: 'error', serverName: null, message: 'the plugin manager is not mounted; live state is unavailable' });
  } else {
    try {
      liveRows = (await manager.listPlugins()).filter((row) => row.moduleName === MCP_CLIENT_PACKAGE);
    } catch (error) {
      problems.push({
        level: 'error',
        serverName: null,
        message: `pluginManager.listPlugins() failed: ${error?.message ?? error}`,
      });
    }
  }

  // Raw layers. `entries()` and `configuration()` are the readable half; the
  // evaluated half stays unread (except serverName).
  const editor = configEditorOf(ctx);
  let entries = [];
  const configuration = new Map();
  if (editor === undefined) {
    problems.push({ level: 'error', serverName: null, message: 'the config editor is not mounted; configuration cannot be read' });
  } else {
    try {
      entries = editor.entries().filter((entry) => entry.options?.name === MCP_CLIENT_PACKAGE);
    } catch (error) {
      problems.push({ level: 'error', serverName: null, message: `configEditor.entries() failed: ${error?.message ?? error}` });
    }
    try {
      for (const item of editor.configuration() ?? []) configuration.set(item.entry.id, item);
    } catch (error) {
      problems.push({
        level: 'error',
        serverName: null,
        message: `configEditor.configuration() failed: ${error?.message ?? error}`,
      });
    }
  }

  const names = toolNames(ctx);
  const patchRows = new Map();
  for (const row of info.rows) if (row.isMcpClient) patchRows.set(row.patchId, row);
  const liveByEntryId = new Map(liveRows.map((row) => [String(row.entryId), row]));
  const liveByPatchId = new Map(liveRows.filter((row) => row.patchId !== undefined).map((row) => [row.patchId, row]));

  const servers = [];
  const seen = new Set();

  for (const entry of entries) {
    const entryId = String(entry.id);
    const patchId = typeof entry.options.id === 'string' ? entry.options.id : null;
    if (patchId !== null) {
      if (seen.has(patchId)) continue;
      seen.add(patchId);
    }
    const layer = configuration.get(entry.id);
    const raw = { ...(layer?.inherited ?? {}), ...(layer?.override ?? {}) };
    const patched = patchId !== null ? patchRows.get(patchId) : undefined;
    const live = liveByEntryId.get(entryId) ?? (patchId !== null ? liveByPatchId.get(patchId) : undefined);
    // The single permitted read of the evaluated config: serverName is not a secret
    // and is the only stable identity the evaluated layer offers.
    const evaluatedName = typeof entry.options.config?.serverName === 'string' ? entry.options.config.serverName : null;
    const serverName = evaluatedName ?? (typeof raw.serverName === 'string' ? raw.serverName : null) ?? patched?.serverName ?? patchId ?? entryId;
    servers.push(buildServer({ entryId, patchId, serverName, raw, patched, live, toolNames: names }));
  }

  // Rows declared in the patch but not composed into an entry. Normally that is the
  // instant between a write and HMR's compose; persistently it means the row did not
  // load, and hiding it would leave the page unable to explain what it just wrote.
  for (const patched of patchRows.values()) {
    if (patched.patchId === null || seen.has(patched.patchId)) continue;
    seen.add(patched.patchId);
    const live = liveByPatchId.get(patched.patchId);
    servers.push(
      buildServer({
        entryId: live !== undefined ? String(live.entryId) : null,
        patchId: patched.patchId,
        serverName: patched.serverName ?? patched.patchId,
        raw: {},
        patched,
        live,
        toolNames: names,
      }),
    );
  }

  problems.push(...diagnose(info.ok ? info.rows : [], { patchOk: patch.ok, patchError: patch.error }));

  const totals = {
    servers: servers.length,
    enabled: servers.filter((server) => server.enabled).length,
    active: servers.filter((server) => server.fiberPhase === 'active').length,
    tools: servers.reduce((sum, server) => sum + server.toolCount, 0),
  };

  return { servers, patch, problems, totals };
}
