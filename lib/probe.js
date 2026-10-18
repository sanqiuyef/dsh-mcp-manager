/**
 * dsh-mcp-manager — connection probing.
 *
 * The host exposes no MCP connection state (dsh-api-0.2.1.md §5.1): `dsh-mcp-client`
 * registers tools and logs, but publishes nothing queryable, and `fiberPhase:
 * 'active'` only says `apply` resolved — with the default `failOnStartupError:
 * false` a failed connection still ends up active. The only honest way to answer
 * "does this server work" is to ask it.
 *
 * This module therefore speaks just enough MCP over stdio by hand: newline-delimited
 * JSON-RPC, `initialize` → `notifications/initialized` → `tools/list`. It deliberately
 * does not import `@modelcontextprotocol/client`: that package is reachable only as a
 * transitive dependency of `dsh-mcp-client`, not a public contract (dsh-api-0.2.1.md
 * §9.3), while `ctx.subprocess.spawn` is a real service. For `streamable-http` the
 * probe is a plain `fetch` that accepts either a JSON or an SSE response.
 *
 * Two rules keep a probe from leaking a credential:
 *   - the child environment is the host's own scrub (`/KEY|PASSWORD|SECRET|TOKEN/i`
 *     plus every `DSH_*`) with the row's config env layered on top — never the raw
 *     ambient environment;
 *   - a `!!js` expression is resolved only in the two shapes this plugin can
 *     honestly reproduce (`process.env.NAME`); anything else is skipped and reported
 *     by name, because evaluating arbitrary host expressions from a probe would be a
 *     code-execution surface.
 */

import { ApiError, redact } from './security.js';
import { MCP_CLIENT_PACKAGE, jsExprOf } from './patch.js';

/** The 2025-era protocol revision the hand-written probe speaks. */
export const PROTOCOL_VERSION = '2025-06-18';

/** What the probe reports as itself; servers may log it. */
export const CLIENT_INFO = Object.freeze({ name: 'dsh-mcp-manager', version: '0.1.0' });

/** Per-probe deadline (contract §6.4). */
export const PROBE_TIMEOUT_MS = 8000;

/** How much of a failed server's stderr is kept as error detail. */
export const STDERR_TAIL_BYTES = 2048;

/** dsh-subprocess' scrub heuristic, mirrored so a probe child starts from the same base. */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

/**
 * The ambient environment minus credential-shaped names and every `DSH_*` name.
 *
 * This mirrors `scrubbedParentEnv()` from `@deepseek-ai/dsh-subprocess` exactly,
 * including its unanchored match: a variable whose name merely *contains* `KEY` is
 * dropped, which is why a credential must arrive through the config's `env` layer
 * (merged after the scrub) rather than by inheritance.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string>}
 */
export function scrubEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    if (key.toUpperCase().startsWith('DSH_')) continue;
    out[key] = value;
  }
  return out;
}

/** The three frames a stdio probe writes, in order. */
export function probeFrames() {
  return {
    initialize: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { ...CLIENT_INFO },
      },
    },
    initialized: { jsonrpc: '2.0', method: 'notifications/initialized' },
    toolsList: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  };
}

/** A failure the probe path classifies as a timeout. */
function timeoutError(timeoutMs) {
  const error = new Error(`the probe timed out after ${timeoutMs} ms`);
  error.code = 'probe-timeout';
  return error;
}

/**
 * A line-framed JSON-RPC channel over one writable sink.
 *
 * Splitting the wire protocol from `ctx.subprocess` is what makes the framing
 * testable offline (see `scripts/smoke.mjs`): the smoke test drives this with a fake
 * sink and canned server output, no host and no child process involved.
 *
 * @param {{
 *   write: (line: string) => unknown,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export function createProbeChannel({ write, timeoutMs = PROBE_TIMEOUT_MS, signal }) {
  const pending = new Map();
  let buffer = '';
  let failure = null;

  const fail = (error) => {
    if (failure !== null) return;
    failure = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  const onAbort = () => fail(timeoutError(timeoutMs));
  if (signal !== undefined) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const settle = (message) => {
    if (message === null || typeof message !== 'object') return;
    const id = message.id;
    if (id === undefined || id === null) return;
    const waiter = pending.get(id);
    if (waiter === undefined) return;
    pending.delete(id);
    if (message.error !== undefined && message.error !== null) {
      const detail =
        typeof message.error === 'object' && typeof message.error.message === 'string'
          ? message.error.message
          : JSON.stringify(message.error);
      waiter.reject(new Error(`the server rejected ${waiter.method}: ${detail}`));
      return;
    }
    waiter.resolve(message);
  };

  return {
    /** Feed raw stdout text; complete lines are parsed, a partial line is buffered. */
    push(chunk) {
      buffer += String(chunk);
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== '') {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            // A server that logs to stdout instead of stderr is common; skip the line
            // rather than failing a probe that may still answer correctly.
            message = null;
          }
          if (message !== null) settle(message);
        }
        index = buffer.indexOf('\n');
      }
    },
    /** Send a notification (no id, no answer expected). */
    notify(frame) {
      if (failure !== null) return;
      try {
        write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        fail(error);
      }
    },
    /** Send a request and resolve with its matching response frame. */
    request(frame) {
      if (failure !== null) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        pending.set(frame.id, { resolve, reject, method: frame.method });
        try {
          write(`${JSON.stringify(frame)}\n`);
        } catch (error) {
          pending.delete(frame.id);
          reject(error);
        }
      });
    },
    /** Fail every pending request (used when the child exits). */
    fail,
    /** Number of requests still waiting for an answer. */
    get pendingCount() {
      return pending.size;
    },
  };
}

/** Normalize a `tools/list` result into the safe `{name, description}` shape. */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      if (tool === null || typeof tool !== 'object') return null;
      if (typeof tool.name !== 'string') return null;
      return {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description.slice(0, 400) : '',
      };
    })
    .filter((tool) => tool !== null);
}

/**
 * Resolve one env/header value.
 *
 * Literal strings pass through. `{__jsExpr: 'process.env.NAME'}` reads the host's
 * own environment, which is exactly what the loader would evaluate it to for that
 * shape. Any other expression returns `undefined` (skipped, reported by name).
 */
export function resolveExpressionValue(value) {
  const expression = jsExprOf(value);
  if (expression === null) {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
  }
  const match = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expression.trim());
  if (match === null) return undefined;
  return process.env[match[1]] ?? '';
}

/**
 * Resolve a mapping for the probe child.
 *
 * @returns {{ values: Record<string, string>, skipped: string[] }}
 */
export function resolveExpressionMap(map) {
  const values = {};
  const skipped = [];
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return { values, skipped };
  for (const [key, raw] of Object.entries(map)) {
    const resolved = resolveExpressionValue(raw);
    if (resolved === undefined) skipped.push(key);
    else values[key] = resolved;
  }
  return { values, skipped };
}

/** Literal (non-expression) values in a mapping — the redaction list for probe errors. */
function literalValues(map) {
  const values = [];
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return values;
  for (const raw of Object.values(map)) {
    if (jsExprOf(raw) !== null) continue;
    if (typeof raw === 'string' && raw.length >= 4) values.push(raw);
  }
  return values;
}

/** Turn a raw-layer config into the probe input the transport probes accept. */
export function probeInputFromConfig(raw) {
  const transport = raw?.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  if (transport === 'stdio') {
    return {
      transport,
      command: typeof raw?.command === 'string' ? raw.command : '',
      args: Array.isArray(raw?.args) ? raw.args.map(String) : [],
      cwd: typeof raw?.cwd === 'string' ? raw.cwd : '',
      env: raw?.env !== null && typeof raw?.env === 'object' ? raw.env : {},
    };
  }
  return {
    transport,
    url: typeof raw?.url === 'string' ? raw.url : '',
    headers: raw?.headers !== null && typeof raw?.headers === 'object' ? raw.headers : {},
  };
}

// ------------------------------------------------------------------ last probe

/**
 * Last probe per server name. In memory only: the contract is explicit that a probe
 * result is an observation, not host state, and it must not outlive the host.
 */
const LAST_PROBES = new Map();

/** Record a probe result for `lastProbe` in the list response. */
export function rememberProbe(serverName, result) {
  if (typeof serverName !== 'string' || serverName === '') return null;
  const tools = Array.isArray(result?.tools) ? result.tools.slice(0, 500) : [];
  const record = {
    ok: result?.ok === true,
    at: new Date().toISOString(),
    durationMs: typeof result?.durationMs === 'number' ? result.durationMs : 0,
    toolCount: tools.length,
    tools,
  };
  if (typeof result?.error === 'string') record.error = result.error;
  LAST_PROBES.set(serverName, record);
  return record;
}

/** The cached last probe for one server, or `null`. */
export function lastProbeOf(serverName) {
  return LAST_PROBES.get(serverName) ?? null;
}

/** Drop every cached probe result (plugin disposal). */
export function clearProbes() {
  LAST_PROBES.clear();
}

/** How many probe results are cached — the diagnostics snapshot reports this. */
export function probeCacheSize() {
  return LAST_PROBES.size;
}

// ------------------------------------------------------------------- transports

/**
 * Probe one stdio server: spawn it, run the three frames, terminate it.
 *
 * Failure is a value, not a throw: `POST /probe` answers 200 with `ok: false` for
 * every probe outcome (contract §5 row 6).
 *
 * @param {object} ctx - plugin context (needs `subprocess`)
 * @param {{ command: string, args?: string[], cwd?: string, env?: object }} input
 * @returns {Promise<object>}
 */
export async function probeStdio(ctx, input, options = {}) {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const started = Date.now();
  const frames = probeFrames();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const environment = resolveExpressionMap(input.env);
  // Redact both the literal config values and whatever a `!!js process.env.X` resolved
  // to: either can surface in a server's stderr, and the resolved one is a real secret
  // even though it never lived in the patch.
  const secrets = [...literalValues(input.env), ...Object.values(environment.values)];
  const base = { transport: 'stdio', unresolvedEnvKeys: environment.skipped };

  if (typeof input.command !== 'string' || input.command === '') {
    clearTimeout(timer);
    return { ok: false, ...base, durationMs: 0, tools: [], error: 'stdio transport requires a command' };
  }

  let handle;
  let stderrTail = '';
  try {
    handle = ctx.subprocess.spawn({
      argv: [input.command, ...(input.args ?? [])],
      cwd: typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 2000,
      signal: controller.signal,
      env: { ...scrubEnv(process.env), ...environment.values },
    });

    const channel = createProbeChannel({
      write: (line) => handle.stdin.write(line),
      timeoutMs,
      signal: controller.signal,
    });

    const stdout = handle.stdout;
    if (stdout !== null && typeof stdout?.on === 'function') {
      if (typeof stdout.setEncoding === 'function') stdout.setEncoding('utf8');
      stdout.on('data', (chunk) => channel.push(chunk));
      stdout.on('end', () => channel.fail(new Error('the server closed stdout before answering')));
    }
    const stderr = handle.stderr;
    if (stderr !== null && typeof stderr?.on === 'function') {
      if (typeof stderr.setEncoding === 'function') stderr.setEncoding('utf8');
      stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES);
      });
    }
    // An early exit must reject pending requests instead of hanging to the deadline.
    if (handle.done !== undefined && typeof handle.done.then === 'function') {
      handle.done.then(
        () => channel.fail(new Error('the server exited before answering')),
        (error) => channel.fail(error instanceof Error ? error : new Error(String(error))),
      );
    }

    const init = await channel.request(frames.initialize);
    channel.notify(frames.initialized);
    const listed = await channel.request(frames.toolsList);
    const tools = normalizeTools(listed?.result?.tools);
    const result = init?.result ?? {};
    return {
      ok: true,
      ...base,
      durationMs: Date.now() - started,
      protocolVersion: typeof result.protocolVersion === 'string' ? result.protocolVersion : null,
      serverInfo: result.serverInfo !== null && typeof result.serverInfo === 'object' ? result.serverInfo : null,
      tools,
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    const message = aborted ? timeoutError(timeoutMs).message : redactProbeError(error, secrets);
    return {
      ok: false,
      ...base,
      durationMs: Date.now() - started,
      tools: [],
      error: appendStderr(message, stderrTail, secrets),
    };
  } finally {
    clearTimeout(timer);
    try {
      handle?.terminate?.();
    } catch {
      /* termination is best-effort; the deadline already killed it when it fired */
    }
    try {
      await handle?.waitForExit?.();
    } catch {
      /* an exit we cannot observe is not a probe failure */
    }
  }
}

/** Redact a thrown probe failure with the request's literal secrets. */
function redactProbeError(error, secrets) {
  return redact(error?.message ?? String(error), secrets);
}

/** Append a redacted stderr tail to a probe error message. */
function appendStderr(message, stderrTail, secrets) {
  if (typeof stderrTail !== 'string' || stderrTail.trim() === '') return message;
  const tail = redact(stderrTail.trim(), secrets).slice(-STDERR_TAIL_BYTES);
  return `${message}\nstderr: ${tail}`;
}

/** The `type`/`data:` framing of an SSE body, reduced to the last JSON payload. */
export function parseEventStream(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const payloads = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload !== '' && payload !== '[DONE]') payloads.push(payload);
  }
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(payloads[index]);
    } catch {
      /* try an earlier event */
    }
  }
  return null;
}

/** Parse an MCP http response body: plain JSON or an SSE frame carrying JSON. */
export function parseMcpHttpBody(text, contentType = '') {
  const body = String(text ?? '').trim();
  if (body === '') return null;
  const looksLikeSse = /text\/event-stream/i.test(contentType) || body.startsWith('event:') || body.includes('\ndata:');
  if (looksLikeSse) return parseEventStream(body);
  try {
    return JSON.parse(body);
  } catch {
    return parseEventStream(body);
  }
}

/** The headers the http probe sends: config headers resolved, never echoed back. */
function httpHeaders(input) {
  const resolved = resolveExpressionMap(input.headers);
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...resolved.values,
  };
  return { headers, skipped: resolved.skipped, values: resolved.values };
}

/**
 * Probe one streamable-http server: `initialize`, then `tools/list` when the server
 * handed out an `mcp-session-id` (contract §6.4 — P0 only needs connectivity).
 *
 * @param {{ url: string, headers?: object }} input
 * @returns {Promise<object>}
 */
export async function probeHttp(input, options = {}) {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const started = Date.now();
  const frames = probeFrames();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { headers, skipped, values: resolvedHeaderValues } = httpHeaders(input);
  const secrets = [...literalValues(input.headers), ...Object.values(resolvedHeaderValues)];
  const base = { transport: 'streamable-http', unresolvedHeaderKeys: skipped };

  const post = (body, extraHeaders = {}) =>
    fetch(input.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { ...headers, ...extraHeaders },
      body: JSON.stringify(body),
    });

  try {
    if (typeof input.url !== 'string' || input.url === '') {
      return { ok: false, ...base, durationMs: 0, tools: [], error: 'streamable-http transport requires a url' };
    }
    const response = await post(frames.initialize);
    const text = await response.text();
    if (!response.ok) {
      const snippet = redact(text.slice(0, 400), secrets);
      return {
        ok: false,
        ...base,
        durationMs: Date.now() - started,
        status: response.status,
        tools: [],
        error: `HTTP ${response.status}${snippet === '' ? '' : `: ${snippet}`}`,
      };
    }
    const payload = parseMcpHttpBody(text, String(response.headers.get('content-type') ?? ''));
    if (payload === null || typeof payload !== 'object') {
      return {
        ok: false,
        ...base,
        durationMs: Date.now() - started,
        tools: [],
        error: 'the server did not return a parseable JSON-RPC response',
      };
    }
    if (payload.error !== undefined) {
      return {
        ok: false,
        ...base,
        durationMs: Date.now() - started,
        tools: [],
        error: `the server rejected initialize: ${redact(JSON.stringify(payload.error), secrets)}`,
      };
    }

    const result = payload.result ?? {};
    const sessionId = response.headers.get('mcp-session-id');
    let tools = [];
    let warning = null;
    if (typeof sessionId === 'string' && sessionId !== '') {
      try {
        await post(frames.initialized, { 'mcp-session-id': sessionId });
        const listedResponse = await post(frames.toolsList, { 'mcp-session-id': sessionId });
        const listedText = await listedResponse.text();
        const listed = parseMcpHttpBody(listedText, String(listedResponse.headers.get('content-type') ?? ''));
        tools = normalizeTools(listed?.result?.tools);
      } catch (error) {
        // tools/list is optional for P0 connectivity; report it without failing.
        warning = `tools/list failed: ${redact(error?.message ?? String(error), secrets)}`;
      }
    }

    return {
      ok: true,
      ...base,
      durationMs: Date.now() - started,
      status: response.status,
      protocolVersion: typeof result.protocolVersion === 'string' ? result.protocolVersion : null,
      serverInfo: result.serverInfo !== null && typeof result.serverInfo === 'object' ? result.serverInfo : null,
      tools,
      ...(warning === null ? {} : { warning }),
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      ...base,
      durationMs: Date.now() - started,
      tools: [],
      error: aborted ? timeoutError(timeoutMs).message : redact(error?.message ?? String(error), secrets),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a Loader entry to a probe target using the **raw** layers.
 *
 * Never `entry.options.config`: that object is evaluated (`!!js` expanded, secrets in
 * plaintext), and reading it here would be the exact mistake the contract's review
 * red line names. The raw layer keeps `{__jsExpr}` markers, which
 * `resolveExpressionMap` turns into the child environment only.
 */
function probeTargetFromEntry(ctx, entry) {
  const editor = ctx.configEditor;
  const layer = (editor.configuration() ?? []).find((candidate) => candidate.entry.id === entry.id);
  const raw = { ...(layer?.inherited ?? {}), ...(layer?.override ?? {}) };
  const serverName =
    typeof entry.options.config?.serverName === 'string' ? entry.options.config.serverName : raw.serverName ?? null;
  return { serverName: typeof serverName === 'string' ? serverName : null, input: probeInputFromConfig(raw) };
}

/** Resolve `{patchId}`: the loader row id, which is stable across reloads. */
export function probeTargetForPatch(ctx, patchId) {
  const editor = ctx.configEditor;
  if (editor === undefined) throw new ApiError('not-found', 'the config editor is not mounted in this host');
  const entry = editor
    .entries()
    .find((candidate) => candidate.options?.id === patchId && candidate.options?.name === MCP_CLIENT_PACKAGE);
  if (entry === undefined) throw new ApiError('not-found', `no MCP entry with patchId "${patchId}"`);
  return probeTargetFromEntry(ctx, entry);
}

/**
 * Resolve `{entryId}`: the composed Loader entry id. The client may hold this rather
 * than the patch row id (it is what `POST /servers/toggle` takes), so the probe
 * accepts it too and resolves the same way.
 */
export function probeTargetForEntry(ctx, entryId) {
  const editor = ctx.configEditor;
  if (editor === undefined) throw new ApiError('not-found', 'the config editor is not mounted in this host');
  const entry = editor
    .entries()
    .find((candidate) => String(candidate.id) === entryId && candidate.options?.name === MCP_CLIENT_PACKAGE);
  if (entry === undefined) throw new ApiError('not-found', `no MCP entry with id "${entryId}"`);
  return probeTargetFromEntry(ctx, entry);
}
