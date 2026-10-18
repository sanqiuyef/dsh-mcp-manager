/**
 * dsh-mcp-manager — the profile-patch writer for managed MCP rows.
 *
 * The host has no API to create or physically delete a loader entry:
 * `ConfigEditor.edit` can only address rows that already exist, and `pluginManager`
 * has no create/remove. Adding or deleting a server therefore means rewriting the
 * profile patch (`configEditor.documentPath`) — a file the Electron GUI, HMR, and
 * `pluginManager` all write to.
 *
 * The ownership rule that makes that safe: this plugin owns exactly one delimited
 * region of the document, between two sentinel comments. Everything outside the
 * sentinels is preserved byte for byte, and rows inside it are the only rows this
 * module ever physically creates or deletes. A row a user hand-wrote in some other
 * `insert:` block is reported `not-manageable`; the UI downgrades that to "disable".
 *
 * Write protocol (contract §6.1, §9):
 *   1. take the shared profile lock (`<profile>/package.json`, the same lock
 *      `ConfigEditor` and `pluginManager` use) so a read-modify-write cycle cannot
 *      resurrect a state another writer just replaced;
 *   2. read the document, parse it with the loader's `!!js` tag, splice only the
 *      managed region;
 *   3. copy the original to `profiles/<profile>/data/mcp-manager/backup-<ts>.yml`;
 *   4. write atomically (same-directory temp + rename);
 *   5. release the lock, then ask `pluginManager.listPlugins()` whether the host
 *      actually composed the change; on failure write the backup back.
 *
 * Step 5 deliberately runs outside the lock: composing the new tree is what HMR
 * does, and HMR itself takes that lock — holding it while waiting for HMR would
 * deadlock. The 250 ms observation point from the contract is the first poll; the
 * poll keeps going for a bounded 2.5 s because a cold compose can outlive 250 ms,
 * and a premature rollback would be worse than a late one.
 */

import { open, readFile, readdir, rename, rm, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';

import { ApiError } from './security.js';

/** Opening sentinel of the region this plugin owns. Kept byte-identical to the contract. */
export const MANAGED_BEGIN =
  '# >>> dsh-mcp-manager — managed block. Rows here are regenerated; edit outside it.';
/** Closing sentinel. */
export const MANAGED_END = '# <<< dsh-mcp-manager — end of managed block';

/** The loader row name every managed server uses. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/** Prefix of the loader row id this plugin derives for a managed server (§6.1 rule 2). */
export const PATCH_ID_PREFIX = 'mcp-client-';

/** Derived patch row id for one server. */
export function patchIdFor(serverName) {
  return `${PATCH_ID_PREFIX}${serverName}`;
}

/**
 * The YAML tag the loader uses for an unevaluated `!!js` expression.
 *
 * Resolving it to the loader's own `{__jsExpr}` wire shape (cordis-plugin-include
 * `JsExpr`) lets the document be parsed and re-emitted without ever evaluating an
 * expression — which is what keeps a credential from being materialised here.
 */
export const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value) => ({ __jsExpr: String(value) }),
};

/** Poll cadence and bound for the post-write observation. */
const VERIFY_FIRST_DELAY_MS = 250;
const VERIFY_POLL_MS = 150;
const VERIFY_DEADLINE_MS = 2500;

/** How many backups are kept; older ones are pruned. */
const BACKUP_KEEP = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const patchInvalid = (message) => new ApiError('patch-invalid', message);

/** Parse a patch document the way the loader does; throws `patch-invalid` on a YAML error. */
export function parsePatch(text) {
  const document = parseDocument(String(text ?? ''), { customTags: [JS_TAG] });
  if (document.errors.length > 0) {
    throw patchInvalid(`the profile patch is not valid YAML: ${document.errors[0].message}`);
  }
  return document;
}

/** The profile patch this plugin writes, or `null` when no config editor is mounted. */
export function patchPathOf(ctx) {
  const path = ctx.configEditor?.documentPath;
  return typeof path === 'string' && path !== '' ? path : null;
}

/**
 * The profile directory — shared by the patch writer and the diagnostics snapshot.
 *
 * The patch file's own directory is authoritative, because that is the file both this
 * plugin and the host rewrite. When no config editor is mounted (a composition
 * without it, or an early snapshot), the same value is reconstructed the way
 * `dsh-home-paths` does: `$DSH_HOME ?? ~/.dsh` plus `$DSH_PROFILE ?? desktop`.
 *
 * @param {object} ctx
 * @returns {string}
 */
export function profileDirOf(ctx) {
  const patchPath = patchPathOf(ctx);
  if (patchPath !== null) return dirname(patchPath);
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  const profile =
    typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== '' ? process.env.DSH_PROFILE : 'desktop';
  return join(home, 'profiles', profile);
}

/** The patch file's text, or `''` when it does not exist yet. */
export async function readPatchText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Locate the managed region in the raw text.
 *
 * Throws rather than guessing when one sentinel is present without the other: a
 * half-edited block means the document is in a state this writer does not
 * understand, and silently "fixing" it would destroy whatever the user was doing.
 *
 * @returns {{ begin: number, end: number } | null} character span covering both sentinels
 */
export function managedSpan(text) {
  const source = String(text ?? '');
  const begin = source.indexOf(MANAGED_BEGIN);
  if (begin < 0) {
    if (source.includes(MANAGED_END)) {
      throw patchInvalid('the patch contains the managed end marker without its begin marker; refusing to guess');
    }
    return null;
  }
  const end = source.indexOf(MANAGED_END, begin);
  if (end < 0) {
    throw patchInvalid('the managed block has no end marker; refusing to rewrite the document');
  }
  return { begin, end: end + MANAGED_END.length };
}

/**
 * The managed block's rows, verbatim.
 *
 * Rows are sliced as text rather than re-rendered from parsed data on purpose:
 * re-emitting an existing row must not lose a field, a comment, or a quoting style
 * the user chose, and the only bytes this writer is allowed to touch are the ones
 * that actually change.
 *
 * @returns {{ rows: Array<{ id: string, text: string }>, span: { begin: number, end: number } | null }}
 */
export function readManagedRows(text) {
  const source = String(text ?? '');
  const span = managedSpan(source);
  if (span === null) return { rows: [], span: null };
  const inner = source.slice(span.begin + MANAGED_BEGIN.length, span.end - MANAGED_END.length);
  const rows = [];
  let current = null;
  for (const line of inner.split('\n')) {
    const match = /^ {4}- id:\s*(.+?)\s*$/.exec(line);
    if (match !== null) {
      if (current !== null) rows.push(current);
      current = { id: unquote(match[1]), lines: [line] };
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  if (current !== null) rows.push(current);
  return {
    rows: rows.map((row) => {
      const lines = [...row.lines];
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      return { id: row.id, text: lines.join('\n') };
    }),
    span,
  };
}

/** Strip one layer of YAML quotes from a scalar written by this module. */
function unquote(raw) {
  const value = String(raw).trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

/** A value that is the loader's inert `!!js` representation, or `null`. */
export function jsExprOf(value) {
  if (value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string') return value.__jsExpr;
  return null;
}

/**
 * Single-quote a scalar.
 *
 * Single quotes are used rather than bare output because YAML 1.2 resolves bare
 * `TRUE`/`no`/`on` to booleans and `1.0` to a number, while every one of these
 * values is a string by schema (`z.dict(String)`, `z.array(String)`, `z.string()`).
 * A bare `KMP_DUPLICATE_LIB_OK: TRUE` would silently become a boolean and be
 * rejected at load. Inside single quotes a backslash is literal, so Windows paths
 * need no escaping — only an embedded `'` is doubled.
 */
function quoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** A mapping key: bare when it is a plain identifier, quoted otherwise. */
function yamlKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : quoted(key);
}

/** Render `env:`/`headers:` entries, keeping `!!js` expressions unevaluated. */
function renderPairs(lines, indent, pairs) {
  for (const [key, value] of Object.entries(pairs)) {
    const expression = jsExprOf(value);
    if (expression !== null) lines.push(`${indent}${yamlKey(key)}: !!js ${expression}`);
    else lines.push(`${indent}${yamlKey(key)}: ${quoted(value)}`);
  }
}

/**
 * Render one server as one `insert:` list entry (contract §6.1 rule 5).
 *
 * @param {object} server - normalized server definition; `patchId` defaults to the derived id
 * @returns {string}
 */
export function renderServerRow(server) {
  const id = typeof server.patchId === 'string' && server.patchId !== '' ? server.patchId : patchIdFor(server.serverName);
  const transport = server.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  const lines = [];
  lines.push(`    - id: ${id}`);
  lines.push(`      name: '${MCP_CLIENT_PACKAGE}'`);
  if (server.enabled === false) lines.push('      disabled: true');
  lines.push('      config:');
  lines.push(`        transport: ${transport}`);
  lines.push(`        serverName: ${quoted(server.serverName)}`);

  if (transport === 'stdio') {
    lines.push(`        command: ${quoted(server.command)}`);
    if (Array.isArray(server.args) && server.args.length > 0) {
      lines.push(`        args: [${server.args.map(quoted).join(', ')}]`);
    }
    if (typeof server.cwd === 'string' && server.cwd.length > 0) {
      lines.push(`        cwd: ${quoted(server.cwd)}`);
    }
    if (server.env !== null && typeof server.env === 'object' && Object.keys(server.env).length > 0) {
      lines.push('        env:');
      renderPairs(lines, '          ', server.env);
    }
  } else {
    lines.push(`        url: ${quoted(server.url)}`);
    if (server.headers !== null && typeof server.headers === 'object' && Object.keys(server.headers).length > 0) {
      lines.push('        headers:');
      renderPairs(lines, '          ', server.headers);
    }
  }

  // Only non-default values are emitted; the Config schema supplies the rest.
  if (typeof server.toolCallTimeoutMs === 'number' && Number.isFinite(server.toolCallTimeoutMs)) {
    lines.push(`        toolCallTimeoutMs: ${server.toolCallTimeoutMs}`);
  }
  if (typeof server.maxInstructionBytes === 'number' && Number.isFinite(server.maxInstructionBytes)) {
    lines.push(`        maxInstructionBytes: ${server.maxInstructionBytes}`);
  }
  if (typeof server.failOnStartupError === 'boolean') {
    lines.push(`        failOnStartupError: ${server.failOnStartupError}`);
  }
  if (server.reconnect !== null && typeof server.reconnect === 'object') {
    const keys = ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'];
    const present = keys.filter((key) => server.reconnect[key] !== undefined);
    if (present.length > 0) {
      lines.push('        reconnect:');
      for (const key of present) {
        const value = server.reconnect[key];
        lines.push(`          ${key}: ${typeof value === 'boolean' ? String(value) : value}`);
      }
    }
  }

  return lines.join('\n');
}

/** Render the whole managed region, sentinels included. */
export function renderManagedBlock(rowTexts = []) {
  const body = rowTexts.length === 0 ? '- insert: []' : ['- insert:', ...rowTexts].join('\n');
  return [MANAGED_BEGIN, body, MANAGED_END].join('\n');
}

/** Keys an MCP row's config may carry; anything else is not a DSH MCP field. */
export const MCP_CONFIG_KEYS = Object.freeze([
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
]);

/** Every loader row id in the document, with the facts the conflict check needs. */
function collectRows(document) {
  let data;
  try {
    data = document.toJS();
  } catch (error) {
    throw patchInvalid(`the profile patch cannot be converted to data: ${error?.message ?? error}`);
  }
  const rows = [];
  const visit = (row, nested) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return;
    if (typeof row.id !== 'string') return;
    const config = row.config !== null && typeof row.config === 'object' ? row.config : {};
    rows.push({ raw: row, config, nested });
  };
  for (const item of Array.isArray(data) ? data : []) {
    if (item !== null && typeof item === 'object' && Array.isArray(item.insert)) {
      for (const row of item.insert) visit(row, true);
    } else {
      visit(item, false);
    }
  }
  return rows;
}

/**
 * Safe env/header key facts: names and whether each value is an expression — never a
 * value. This shape is what leaves the host half after the list route, so it is the
 * single place where a mapping is reduced to non-secret facts.
 */
export function describeKeyMap(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map).map(([key, value]) => {
    const expression = jsExprOf(value);
    return { key, isJsExpr: expression !== null, jsExpr: expression };
  });
}

/** Key names whose value is a non-empty literal — the plaintext-credential diagnostic's input. */
function literalKeys(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return [];
  const keys = [];
  for (const [key, value] of Object.entries(map)) {
    if (jsExprOf(value) !== null) continue;
    if (typeof value === 'string' && value !== '') keys.push(key);
  }
  return keys;
}

/**
 * Read a patch document into the facts the rest of the host half needs.
 *
 * Returns `ok: false` with the parse error instead of throwing, because the list
 * route must still answer when the file on disk is broken: reporting the broken
 * patch is exactly what the diagnostics block is for.
 *
 * @returns {{
 *   ok: boolean, error: string | null,
 *   rows: Array<object>, managedIds: string[],
 *   block: { begin: number, end: number } | null
 * }}
 */
export function inspectPatch(text) {
  const source = String(text ?? '');
  let span = null;
  try {
    span = managedSpan(source);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), rows: [], managedIds: [], block: null };
  }

  let document;
  try {
    document = parsePatch(source);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), rows: [], managedIds: [], block: span };
  }

  let managedIds = [];
  try {
    managedIds = readManagedRows(source).rows.map((row) => row.id);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), rows: [], managedIds: [], block: span };
  }

  let collected;
  try {
    collected = collectRows(document);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), rows: [], managedIds, block: span };
  }

  const managedSet = new Set(managedIds);
  const rows = collected.map(({ raw, config, nested }) => {
    const env = config.env !== null && typeof config.env === 'object' ? config.env : {};
    const headers = config.headers !== null && typeof config.headers === 'object' ? config.headers : {};
    return {
      patchId: raw.id,
      name: typeof raw.name === 'string' ? raw.name : null,
      isMcpClient: raw.name === MCP_CLIENT_PACKAGE,
      serverName: typeof config.serverName === 'string' ? config.serverName : null,
      transport: config.transport === 'streamable-http' ? 'streamable-http' : typeof config.transport === 'string' ? config.transport : null,
      command: typeof config.command === 'string' ? config.command : '',
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      cwd: typeof config.cwd === 'string' ? config.cwd : '',
      url: typeof config.url === 'string' ? config.url : '',
      toolCallTimeoutMs: typeof config.toolCallTimeoutMs === 'number' ? config.toolCallTimeoutMs : null,
      failOnStartupError: typeof config.failOnStartupError === 'boolean' ? config.failOnStartupError : null,
      maxInstructionBytes: typeof config.maxInstructionBytes === 'number' ? config.maxInstructionBytes : null,
      reconnect:
        config.reconnect !== null && typeof config.reconnect === 'object' && !Array.isArray(config.reconnect)
          ? { ...config.reconnect }
          : null,
      disabled: raw.disabled === true,
      managed: managedSet.has(raw.id),
      nested,
      envKeys: describeKeyMap(env),
      headerKeys: describeKeyMap(headers),
      // Internal facts for diagnostics; never serialized into a response.
      envLiteralKeys: literalKeys(env),
      headerLiteralKeys: literalKeys(headers),
    };
  });

  return { ok: true, error: null, rows, managedIds, block: span };
}

/**
 * Remove top-level rows addressed by `patchId` (the loader's `disabled`/`config`
 * override rows), leaving every other byte alone.
 *
 * Only top-level sequence items match: the managed block's rows are indented under
 * its own `- insert:`, so they can never match this pattern. The scan stops at the
 * next top-level item or comment line so a comment belonging to the following row
 * survives.
 */
export function removeTopLevelRowsById(text, patchId) {
  const escaped = String(patchId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startPattern = new RegExp(`^- id:\\s*(?:'${escaped}'|"${escaped}"|${escaped})\\s*$`);
  const lines = String(text).split('\n');
  const kept = [];
  let removed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!startPattern.test(lines[index])) {
      kept.push(lines[index]);
      continue;
    }
    removed += 1;
    let next = index + 1;
    while (next < lines.length && !/^- /.test(lines[next]) && !/^#/.test(lines[next])) next += 1;
    index = next - 1;
  }
  return { text: kept.join('\n'), removed };
}

/**
 * Plan an add: append one row inside the managed block, creating the block when the
 * document does not have one yet.
 *
 * The result is parsed back before it is returned, so a renderer defect becomes a
 * rejected request instead of a profile patch the host cannot compose.
 *
 * @returns {{ next: string, mode: 'created'|'replaced', changed: boolean, rowText: string }}
 */
export function planAdd(text, server) {
  const source = String(text ?? '');
  parsePatch(source);
  const rowText = renderServerRow(server);
  const span = managedSpan(source);
  let next;
  let mode;
  if (span === null) {
    // Keep the document's own bytes; only add a separating blank line when needed.
    const separator = source.length === 0 ? '' : source.endsWith('\n') ? '\n' : '\n\n';
    next = `${source}${separator}${renderManagedBlock([rowText])}\n`;
    mode = 'created';
  } else {
    const existing = readManagedRows(source).rows.map((row) => row.text);
    const block = renderManagedBlock([...existing, rowText]);
    next = source.slice(0, span.begin) + block + source.slice(span.end);
    mode = 'replaced';
  }
  parsePatch(next);
  return { next, mode, changed: next !== source, rowText };
}

/**
 * Plan a removal: drop one row from the managed block and clean up the top-level
 * override rows that addressed the same id (contract §6.2).
 *
 * Throws `not-manageable` when the id is not inside the managed block — a
 * hand-written row is never physically deleted by this plugin.
 *
 * @returns {{ next: string, changed: boolean, removedOverrides: number }}
 */
export function planRemove(text, patchId) {
  const source = String(text ?? '');
  const span = managedSpan(source);
  if (span === null) {
    throw new ApiError('not-manageable', `row "${patchId}" is not inside the managed block; disable it instead`);
  }
  const { rows } = readManagedRows(source);
  const index = rows.findIndex((row) => row.id === patchId);
  if (index < 0) {
    throw new ApiError('not-manageable', `row "${patchId}" is not inside the managed block; disable it instead`);
  }
  const block = renderManagedBlock(rows.filter((_row, position) => position !== index).map((row) => row.text));
  const spliced = source.slice(0, span.begin) + block + source.slice(span.end);
  const { text: next, removed } = removeTopLevelRowsById(spliced, patchId);
  parsePatch(next);
  return { next, changed: next !== source, removedOverrides: removed };
}

// ------------------------------------------------- hand-written row removal

/** The start offset of the line containing `offset`. */
function lineStartOf(text, offset) {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/**
 * Character span of the complete source lines one YAML node occupies.
 *
 * The yaml Document API gives each node a `range` into the original source: for a
 * block-sequence item the range starts at the item's first key (after the `- `) and
 * ends after the newline of its last line. Widening the start to the line start
 * captures the `- ` marker and indentation; widening the end to the next newline
 * captures a trailing line whose range stopped before it. Everything between is
 * exactly the row, so deleting the span cannot touch a neighbouring byte — which is
 * the only reason a hand-written row's comments, ordering, and quoting survive.
 */
function nodeLineSpan(text, node) {
  const range = node?.range;
  if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') {
    throw patchInvalid('cannot locate a row in the profile patch text; refusing to rewrite the document');
  }
  const start = lineStartOf(text, range[0]);
  let end = range[1];
  if (end < text.length && text[end - 1] !== '\n') {
    const newline = text.indexOf('\n', end);
    end = newline < 0 ? text.length : newline + 1;
  }
  if (end <= start) throw patchInvalid('cannot locate a row in the profile patch text; refusing to rewrite the document');
  return { start, end };
}

/**
 * Plan the removal of a row that lives outside the managed block.
 *
 * Until now that case was refused (`not-manageable`) and the UI downgraded it to
 * "disable", which users correctly read as "this manager cannot manage my servers".
 * A hand-written row is perfectly removable — it just has to be removed from the
 * document it was written in, not from a region this plugin owns.
 *
 * The edit is text surgery driven by node ranges, never a whole-document
 * re-serialisation: the document is parsed with the loader's `!!js` tag purely to
 * locate nodes, and only the target row's lines (plus same-id top-level override
 * rows) are cut out. If an `insert:` list becomes empty, its line is turned into
 * `- insert: []`, because a bare `insert:` with no value would compose as `null`
 * rather than as an empty list.
 *
 * @param {string} text - the patch document as it is on disk
 * @param {string} patchId - the loader row id to delete
 * @returns {{ next: string, changed: boolean, removedRows: number, emptiedInsertLists: number }}
 */
export function planRemoveHandwrittenRow(text, patchId) {
  const source = String(text ?? '');
  const document = parsePatch(source);
  if (!isSeq(document.contents)) throw patchInvalid('the profile patch must be a YAML sequence');

  const rowSpans = [];
  const emptied = [];

  for (const item of document.contents.items) {
    if (!isMap(item)) continue;
    const insertPair = item.items.find((pair) => pair?.key?.value === 'insert');
    if (insertPair !== undefined) {
      const sequence = insertPair.value;
      if (!isSeq(sequence) || sequence.items.length === 0) continue;
      const matching = sequence.items.filter((row) => isMap(row) && row.get('id') === patchId);
      if (matching.length === 0) continue;
      // A one-line flow list (`- insert: [{...}, {...}]`) cannot be edited by cutting
      // lines: the whole line is every row. Refuse rather than take the neighbours with
      // it; the profile patch is block-style, so this only guards hand-written oddities.
      if (sequence.flow === true) {
        throw new ApiError(
          'not-manageable',
          `the insert list holding "${patchId}" is written in flow style; refusing line-based surgery on it`,
        );
      }
      for (const row of matching) rowSpans.push(nodeLineSpan(source, row));
      // Only a list that this removal empties needs the `[]` rewrite.
      if (matching.length === sequence.items.length) emptied.push({ pair: insertPair, sequence });
      continue;
    }
    // A top-level row addressed by the same id is the loader's `disabled`/`config`
    // override for that server; it must go too or it would be left dangling.
    if (item.get('id') === patchId) rowSpans.push(nodeLineSpan(source, item));
  }

  if (rowSpans.length === 0) {
    throw new ApiError('not-manageable', `row "${patchId}" has no insert-list definition to delete`);
  }

  const replacements = emptied.map(({ pair, sequence }) => {
    const start = lineStartOf(source, pair.key.range[0]);
    const colon = source.indexOf(':', pair.key.range[1]);
    const insertKeyLine = source.slice(start, colon + 1); // e.g. "- insert:"
    const last = nodeLineSpan(source, sequence.items[sequence.items.length - 1]);
    return { start, end: last.end, text: `${insertKeyLine} []\n` };
  });
  const insideReplacement = (span) => replacements.some((replacement) => span.start >= replacement.start && span.end <= replacement.end);
  const edits = [...replacements, ...rowSpans.filter((span) => !insideReplacement(span))].sort((left, right) => right.start - left.start);

  let next = source;
  for (const edit of edits) next = `${next.slice(0, edit.start)}${edit.text ?? ''}${next.slice(edit.end)}`;

  parsePatch(next);

  // Invariant, checked before the write: exactly the target id's rows disappeared,
  // and every other row id survives in its original order. A renderer defect must
  // become a refused request, not a profile rewrite that drops a neighbour.
  const before = inspectPatch(source);
  const after = inspectPatch(next);
  if (!after.ok) throw patchInvalid(`the rewritten patch does not parse: ${after.error}`);
  const beforeIds = before.rows.map((row) => row.patchId);
  const afterIds = after.rows.map((row) => row.patchId);
  const expected = beforeIds.filter((id) => id !== patchId);
  if (afterIds.length !== expected.length || afterIds.some((id, index) => id !== expected[index])) {
    throw patchInvalid('the removal would have changed rows it does not own; refusing to write');
  }
  if (afterIds.includes(patchId)) throw patchInvalid(`row "${patchId}" survived the rewrite`);

  return { next, changed: next !== source, removedRows: rowSpans.length, emptiedInsertLists: replacements.length };
}

// ---------------------------------------------------------------- lock + write

/**
 * `@deepseek-ai/dsh-atomic-write` is the lock and atomic-write implementation the
 * host itself uses, and sharing its lock file is what keeps `ConfigEditor`,
 * `pluginManager`, and this plugin from interleaving. It is resolved at runtime
 * through the host's installation routing, so the import is
 * dynamic; when that resolution fails the module falls back to an equivalent local
 * implementation and says so once, rather than failing the request.
 */
let atomicModule;
let warnedFallback = false;

async function loadAtomicWrite() {
  if (atomicModule !== undefined) return atomicModule;
  try {
    atomicModule = await import('@deepseek-ai/dsh-atomic-write');
  } catch (error) {
    atomicModule = null;
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(
        `[dsh-mcp-manager] @deepseek-ai/dsh-atomic-write is not resolvable (${error?.message ?? error}); ` +
          'using the bundled lock/atomic-write fallback',
      );
    }
  }
  return atomicModule;
}

/**
 * Which writer backend is actually available, for the diagnostics snapshot.
 *
 * Probing the import here (rather than reporting "untried") is deliberate: the whole
 * point of the snapshot is to tell an operator, on a real install, whether this plugin
 * is sharing the host's lock or running its bundled fallback. The import has no side
 * effect beyond resolving the module.
 *
 * @returns {Promise<'used'|'fallback'>}
 */
export async function atomicWriteBackend() {
  const module = await loadAtomicWrite();
  return typeof module?.withFileLock === 'function' && typeof module?.writeFileAtomic === 'function' ? 'used' : 'fallback';
}

const LOCK_RETRY_INITIAL_MS = 20;
const LOCK_RETRY_MAX_MS = 200;
const DEFAULT_LOCK_WAIT_MS = 5000;

/** Whether an exclusive create found an existing lock (EEXIST, or Windows' EPERM with the file present). */
async function isLockContention(error, lockPath) {
  if (error?.code === 'EEXIST') return true;
  if (error?.code !== 'EPERM') return false;
  try {
    await readFile(lockPath, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Whether the pid recorded in a lock file is provably gone. */
function holderExited(record) {
  if (!/^\d+\n$/.test(record)) return false;
  const pid = Number(record.trim());
  if (pid === 0 || pid > 2147483647 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/** Read a lock file's recorded holder, or `undefined`. */
async function readLockRecord(lockPath) {
  try {
    return await readFile(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Remove the lock of a holder that exited, serialized through a claim file named
 * after the record so two contenders cannot both remove a successor's fresh lock.
 */
async function takeOverExitedLock(lockPath) {
  const record = await readLockRecord(lockPath);
  if (record === undefined || !holderExited(record)) return false;
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`;
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM') return false;
    throw error;
  }
  try {
    if ((await readLockRecord(lockPath)) !== record || !holderExited(record)) return false;
    try {
      await rm(lockPath, { force: true });
    } catch {
      return false;
    }
    return true;
  } finally {
    await rm(claim, { force: true }).catch(() => {});
  }
}

/** The bundled lock, used only when the host's module cannot be resolved. */
async function fallbackWithFileLock(filename, operation, options = {}) {
  const lockPath = `${filename}.lock`;
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_LOCK_WAIT_MS);
  let delay = LOCK_RETRY_INITIAL_MS;
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, 'wx');
      break;
    } catch (error) {
      if (!(await isLockContention(error, lockPath))) throw error;
      if (await takeOverExitedLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for the writer lock at ${lockPath}`);
      await sleep(delay);
      delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);

/** Rename with bounded retries for transient Windows interference (mirrors dsh-atomic-write). */
async function renameAtomicTemp(temp, target) {
  let delay = 20;
  for (let retries = 0; ; retries += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      const transient = process.platform === 'win32' && WINDOWS_TRANSIENT_RENAME_ERRORS.has(error?.code ?? '');
      if (!transient || retries >= 8) throw error;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 200);
  }
}

/** The bundled atomic write, used only when the host's module cannot be resolved. */
async function fallbackWriteFileAtomic(filename, content, options = {}) {
  await mkdir(dirname(filename), { recursive: true });
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { mode: options.mode ?? 0o600, flag: 'wx' });
    await renameAtomicTemp(temp, filename);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Run `operation` while holding the shared profile writer lock.
 *
 * The lock target is `<profile>/package.json` on purpose: that is the file
 * `ConfigEditor.edit` and `pluginManager.setPluginEnabled` lock, so this plugin's
 * patch rewrite is serialized against both of them.
 *
 * @param {string} profileDir - the profile directory (parent of the patch file)
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 * @template T
 */
export async function withPatchLock(profileDir, operation) {
  const lockTarget = join(profileDir, 'package.json');
  const atomic = await loadAtomicWrite();
  if (typeof atomic?.withFileLock === 'function') {
    return atomic.withFileLock(lockTarget, operation, { waitMs: DEFAULT_LOCK_WAIT_MS });
  }
  return fallbackWithFileLock(lockTarget, operation);
}

/**
 * Replace the patch file atomically (same-directory temp + rename), so a reader
 * observes either the old or the new complete document.
 */
export async function writePatchText(path, text) {
  const atomic = await loadAtomicWrite();
  if (typeof atomic?.writeFileAtomic === 'function') {
    await atomic.writeFileAtomic(path, text, { mode: 0o600 });
    return;
  }
  await fallbackWriteFileAtomic(path, text, { mode: 0o600 });
}

/**
 * Copy the current document into `profiles/<profile>/data/mcp-manager/` before a
 * write. Returns the backup path; the caller rolls back from this file.
 */
export async function backupPatchText(patchPath, text) {
  const directory = join(dirname(patchPath), 'data', 'mcp-manager');
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(directory, `backup-${stamp}.yml`);
  await writeFile(path, text, { mode: 0o600 });
  await pruneBackups(directory);
  return path;
}

/** Keep the backup directory bounded; pruning failures must never fail a write. */
async function pruneBackups(directory) {
  try {
    const entries = (await readdir(directory)).filter((name) => name.startsWith('backup-') && name.endsWith('.yml')).sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - BACKUP_KEEP))) {
      await rm(join(directory, name), { force: true });
    }
  } catch {
    /* a backup directory that cannot be pruned is not a reason to refuse the write */
  }
}

// -------------------------------------------------------------- write + verify

/** The host's plugin manager, or `undefined` when this composition has none. */
function pluginManagerOf(ctx) {
  return ctx.pluginManager ?? (typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined);
}

/** The live row for one patch id, or `undefined`. */
async function findLiveRow(ctx, patchId) {
  const manager = pluginManagerOf(ctx);
  if (manager === undefined) return { available: false, row: undefined };
  const rows = await manager.listPlugins();
  return { available: true, row: rows.find((row) => row.patchId === patchId) };
}

/**
 * Observe the host until the written patch is composed (or definitively is not).
 *
 * The first check happens at the contract's 250 ms mark; polls continue to a
 * bounded deadline so a cold compose is not mistaken for a failed write. `failed`
 * is treated as final immediately: a plugin that failed to start is not going to
 * become active by waiting.
 */
async function waitForComposed(ctx, patchId, expectPresent) {
  await sleep(VERIFY_FIRST_DELAY_MS);
  const deadline = Date.now() + VERIFY_DEADLINE_MS;
  for (;;) {
    const { available, row } = await findLiveRow(ctx, patchId);
    if (!available) return { available: false, row: undefined };
    const present = row !== undefined;
    if (expectPresent ? present : !present) return { available: true, row };
    if (Date.now() >= deadline) return { available: true, row };
    await sleep(VERIFY_POLL_MS);
  }
}

/** Put the pre-write document back, still under the profile lock. */
async function rollbackPatch(patchPath, previousText) {
  await withPatchLock(dirname(patchPath), async () => {
    await writePatchText(patchPath, previousText);
  });
}

/**
 * Create one managed server row, then verify the host actually composed it.
 *
 * Verification is skipped only when the composition has no `pluginManager` at all
 * (there is nothing to ask); the response then reports `observed-pending` rather
 * than claiming an application it did not confirm.
 *
 * @returns {Promise<{ patchId: string, applied: 'applied'|'observed-pending' }>}
 */
export async function addManagedServer(ctx, server) {
  const patchPath = patchPathOf(ctx);
  if (patchPath === null) throw new Error('configEditor.documentPath is unavailable; cannot write the profile patch');
  const patchId = patchIdFor(server.serverName);
  let previous = null;
  let backupPath = null;

  await withPatchLock(dirname(patchPath), async () => {
    previous = await readPatchText(patchPath);
    const info = inspectPatch(previous);
    if (!info.ok) throw patchInvalid(`refusing to edit a patch that does not parse: ${info.error}`);
    if (info.rows.some((row) => row.patchId === patchId)) {
      throw new ApiError('conflict', `the patch already declares a row with id "${patchId}"`);
    }
    const clash = info.rows.find((row) => row.isMcpClient && row.serverName === server.serverName);
    if (clash !== undefined) {
      throw new ApiError('conflict', `serverName "${server.serverName}" is already used by row "${clash.patchId}"`);
    }
    const plan = planAdd(previous, { ...server, patchId });
    backupPath = await backupPatchText(patchPath, previous);
    await writePatchText(patchPath, plan.next);
  });

  const observed = await waitForComposed(ctx, patchId, true);
  if (!observed.available) return { patchId, applied: 'observed-pending' };
  if (observed.row === undefined) {
    if (previous !== null) await rollbackPatch(patchPath, previous);
    throw new ApiError(
      'write-failed',
      `the host did not compose the new entry "${patchId}" after the patch write; the change was rolled back` +
        (backupPath === null ? '' : ` (backup: ${backupPath})`),
      { status: 500 },
    );
  }
  if (observed.row.fiberPhase === 'failed') {
    if (previous !== null) await rollbackPatch(patchPath, previous);
    throw new ApiError(
      'write-failed',
      `the host composed the new entry "${patchId}" but its plugin failed to start; the change was rolled back` +
        (backupPath === null ? '' : ` (backup: ${backupPath})`),
      { status: 500 },
    );
  }
  return { patchId, applied: observed.row.fiberPhase === 'active' ? 'applied' : 'observed-pending' };
}

/**
 * Physically delete one MCP server row from the profile patch.
 *
 * Two targets are supported, and the caller learns which one it was:
 *
 *   - a row **inside the managed block** — the block is rewritten, exactly as before;
 *   - a row **outside it** — a hand-written `insert:` row is cut out by node ranges,
 *     together with any top-level override rows for the same id. Everything else in
 *     the document keeps its bytes: comments, ordering, indentation, quoting.
 *
 * The pre-flight is deliberately strict (task requirement): the id must resolve to a
 * row that is actually defined in an `insert:` list *and* whose `name` is
 * `@deepseek-ai/dsh-mcp-client`. Something else — an unknown id, a non-MCP row, or a
 * lone `disabled`/`config` override with no definition — is refused with the error the
 * contract vocabulary can express, rather than guessed at.
 *
 * Guards are the same as every other write: the shared profile lock, a backup, an
 * atomic write, a post-write textual check (the document parses and the row is gone
 * from disk), the 2.5 s compose observation, and a rollback on any failure.
 *
 * @returns {Promise<{ removed: true, source: 'managed'|'handwritten', backupPath: string }>}
 */
export async function removeManagedServer(ctx, patchId) {
  const patchPath = patchPathOf(ctx);
  if (patchPath === null) throw new Error('configEditor.documentPath is unavailable; cannot write the profile patch');
  let previous = null;
  let backupPath = null;
  let source = 'managed';

  await withPatchLock(dirname(patchPath), async () => {
    previous = await readPatchText(patchPath);
    const info = inspectPatch(previous);
    if (!info.ok) throw patchInvalid(`refusing to edit a patch that does not parse: ${info.error}`);

    // The definition is the row nested in an insert list; a top-level row with the
    // same id is only this row's override and is removed along with it.
    const definition = info.rows.find((candidate) => candidate.patchId === patchId && candidate.nested === true);
    if (definition === undefined) {
      const orphan = info.rows.find((candidate) => candidate.patchId === patchId);
      if (orphan === undefined) {
        throw new ApiError('not-found', `no insert row with id "${patchId}" in the profile patch`);
      }
      throw new ApiError(
        'not-manageable',
        `row "${patchId}" has only an override entry and no insert-list definition; refusing to guess what to delete`,
      );
    }
    if (definition.name !== MCP_CLIENT_PACKAGE) {
      throw new ApiError(
        'not-manageable',
        `row "${patchId}" defines "${definition.name ?? 'an unnamed module'}", not an MCP client row`,
      );
    }

    source = definition.managed === true ? 'managed' : 'handwritten';
    const plan = source === 'managed' ? planRemove(previous, patchId) : planRemoveHandwrittenRow(previous, patchId);
    backupPath = await backupPatchText(patchPath, previous);
    await writePatchText(patchPath, plan.next);
  });

  // Textual check before the slower compose observation: the file must still parse and
  // must no longer declare the row. A rewrite that fails either invariant is rolled
  // back rather than left for the host to choke on at the next start.
  const afterWrite = inspectPatch(await readPatchText(patchPath));
  if (!afterWrite.ok || afterWrite.rows.some((row) => row.patchId === patchId)) {
    if (previous !== null) await rollbackPatch(patchPath, previous);
    throw new ApiError(
      'write-failed',
      `the rewritten patch did not remove row "${patchId}" cleanly; the change was rolled back` +
        (backupPath === null ? '' : ` (backup: ${backupPath})`),
      { status: 500 },
    );
  }

  let observed;
  try {
    observed = await waitForComposed(ctx, patchId, false);
  } catch (error) {
    if (previous !== null) await rollbackPatch(patchPath, previous);
    throw new ApiError(
      'write-failed',
      `verification after removing "${patchId}" failed (${error?.message ?? error}); the change was rolled back` +
        (backupPath === null ? '' : ` (backup: ${backupPath})`),
      { status: 500 },
    );
  }

  if (!observed.available) return { removed: true, source, backupPath };
  if (observed.row !== undefined) {
    if (previous !== null) await rollbackPatch(patchPath, previous);
    throw new ApiError(
      'write-failed',
      `the host still reports entry "${patchId}" after the removal; the change was rolled back` +
        (backupPath === null ? '' : ` (backup: ${backupPath})`),
      { status: 500 },
    );
  }
  return { removed: true, source, backupPath };
}
