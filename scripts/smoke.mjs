/**
 * dsh-mcp-manager host-half smoke test — offline, no host, no plugin install.
 *
 * The host half's risky logic is almost entirely pure: rendering YAML the loader will
 * accept, splicing exactly one managed region, deriving a raw-layer edit from an
 * `inherited` base, mapping foreign `mcpServers` shapes, framing JSON-RPC on a stream.
 * This file exercises all of it with fakes, so a defect shows up here instead of in
 * the desktop profile.
 *
 * What is asserted, in order:
 *   A. YAML round-trip        — quoting, backslashes, `!!js` preservation, block shape
 *   B. managed-block splicing — created/replaced/removed, outside bytes untouched,
 *                               top-level override cleanup, sentinel refusal
 *   C. file plumbing          — lock, atomic write, backup, parse errors
 *   D. validation             — serverName, transports, env value forms, effective config
 *   E. import/export mapping  — transport aliases, sse substitution, `$env:` forms,
 *                               dropped fields, no literal credential in an export
 *   F. probe wire protocol    — frame assembly, request/response correlation,
 *                               malformed-line tolerance, abort timeout
 *   G. list view              — joins live inventory + raw layers + tool namespaces,
 *                               `source`, no evaluated value in the response
 *   H. toggle                 — application outcomes and failure classification
 *   I. update                 — inherited base (never evaluated), `{__keep}`, migration
 *   J. add/remove end to end  — real file writes in a temp profile, compose simulation,
 *                               rollback when the host never composes the row
 *   K. security/HTTP helpers  — rejection gate, method, content type, body cap, redaction
 *   L. diagnostics            — duplicate/invalid names, missing command/env, literal secret
 *   M. the real profile       — read-only dry run (skipped when unreachable)
 *
 * Run:  D:\nodejs\node.exe packages\dsh-mcp-manager\scripts\smoke.mjs
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MANAGED_BEGIN,
  MANAGED_END,
  MCP_CLIENT_PACKAGE,
  addManagedServer,
  backupPatchText,
  inspectPatch,
  managedSpan,
  parsePatch,
  patchIdFor,
  planAdd,
  planRemove,
  readManagedRows,
  readPatchText,
  removeManagedServer,
  removeTopLevelRowsById,
  renderManagedBlock,
  renderServerRow,
  writePatchText,
  withPatchLock,
} from '../lib/patch.js';
import {
  ApiError,
  rejectUnauthorized,
  requireJson,
  requireMethod,
  sendError,
  sendJson,
  readJsonBody,
  redact,
} from '../lib/security.js';
import {
  SERVER_NAME_PATTERN,
  diagnose,
  isSecretName,
  validateConfigPatch,
  validateEffectiveConfig,
  validateServerInput,
} from '../lib/diagnostics.js';
import {
  clearProbes,
  createProbeChannel,
  lastProbeOf,
  normalizeTools,
  parseMcpHttpBody,
  probeFrames,
  rememberProbe,
  resolveExpressionMap,
  scrubEnv,
} from '../lib/probe.js';
import {
  exportDefinition,
  importServers,
  importValue,
  serverFromImportDefinition,
} from '../lib/transfer.js';
import { assertKeepResolved, migrateSecretLiterals, resolveKeepSentinels, sanitizeMerged, updateServerConfig } from '../lib/edit.js';
import { setServerEnabled } from '../lib/toggle.js';
import { listServers } from '../lib/servers.js';
import { apply, inject as injectedServices, name as pluginName } from '../lib/index.js';
import { captureSnapshot, lastSnapshotPath, scheduleSnapshot } from '../lib/snapshot.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const section = (title) => console.log(`\n--- ${title} ---`);

/** Parse a patch document with the loader's `!!js` tag and return its data. */
const patchData = (text) => parsePatch(text).toJS();

const mockResponse = () => ({
  statusCode: 0,
  headers: {},
  body: '',
  ended: false,
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers ?? {};
    return this;
  },
  end(body) {
    if (body !== undefined) this.body += String(body);
    this.ended = true;
  },
});

const sampleServer = (overrides = {}) => ({
  serverName: 'demo',
  transport: 'stdio',
  command: 'D:\\anaconda3\\python.exe',
  args: ['-X', 'utf8', '-m', 'demo_server'],
  cwd: 'D:\\work\\demo',
  env: {
    KMP_DUPLICATE_LIB_OK: 'TRUE',
    LANCEDB_OCR: '1',
    API_KEY: { __jsExpr: 'process.env.DEMO_API_KEY' },
  },
  ...overrides,
});

const main = async () => {
  // ------------------------------------------------------------------ A. rendering
  section('A. YAML rendering round-trip');
  {
    const server = sampleServer({ toolCallTimeoutMs: 60000, failOnStartupError: true });
    const rowText = renderServerRow(server);
    const block = renderManagedBlock([rowText]);
    check('the block starts with the begin sentinel', block.startsWith(MANAGED_BEGIN));
    check('the block ends with the end sentinel', block.trimEnd().endsWith(MANAGED_END));

    const data = patchData(block);
    check('the block is a top-level array with one patch row', Array.isArray(data) && data.length === 1, `len=${data?.length}`);
    const rows = data?.[0]?.insert ?? [];
    check('the patch row is an insert list', Array.isArray(rows));
    check('one server becomes one row', rows.length === 1, `rows=${rows.length}`);
    const row = rows[0] ?? {};
    check('the row id is derived from serverName', row.id === 'mcp-client-demo', String(row.id));
    check('the row names the mcp-client package', row.name === MCP_CLIENT_PACKAGE);
    check('the transport survives', row.config?.transport === 'stdio');
    check('the serverName survives', row.config?.serverName === 'demo');
    check('windows paths keep their backslashes', row.config?.command === 'D:\\anaconda3\\python.exe', String(row.config?.command));
    check('args keep their order and count', JSON.stringify(row.config?.args) === JSON.stringify(['-X', 'utf8', '-m', 'demo_server']));
    check('cwd survives', row.config?.cwd === 'D:\\work\\demo');
    check('a value that looks like a boolean stays a string', row.config?.env?.KMP_DUPLICATE_LIB_OK === 'TRUE', JSON.stringify(row.config?.env?.KMP_DUPLICATE_LIB_OK));
    check('a numeric-looking value stays a string', row.config?.env?.LANCEDB_OCR === '1', JSON.stringify(row.config?.env?.LANCEDB_OCR));
    check('a credential is emitted as an unevaluated !!js expression', row.config?.env?.API_KEY?.__jsExpr === 'process.env.DEMO_API_KEY', JSON.stringify(row.config?.env?.API_KEY));
    check('toolCallTimeoutMs is a number', row.config?.toolCallTimeoutMs === 60000);
    check('failOnStartupError is a boolean', row.config?.failOnStartupError === true);
    check('an empty block is a valid empty insert list', JSON.stringify(patchData(renderManagedBlock([]))) === JSON.stringify([{ insert: [] }]));

    const httpRow = renderServerRow({
      serverName: 'remote',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: { __jsExpr: 'process.env.REMOTE_TOKEN' } },
    });
    const httpData = patchData(renderManagedBlock([httpRow]));
    const httpConfig = httpData[0].insert[0].config;
    check('an http row carries its url', httpConfig.url === 'https://example.test/mcp');
    check('an http header can be an expression', httpConfig.headers?.Authorization?.__jsExpr === 'process.env.REMOTE_TOKEN');
    check('an http row carries no stdio keys', httpConfig.command === undefined && httpConfig.env === undefined);
  }

  // ----------------------------------------------------------- B. block splicing
  section('B. managed-block splicing');
  {
    const base = [
      '# profile patch (stand-in)',
      '- id: ui-theme',
      '  name: "@deepseek-ai/dsh-client-ui-theme"',
      '  config:',
      '    preference: light',
      '- insert:',
      '    - id: mcp-client-handwritten',
      '      name: \'@deepseek-ai/dsh-mcp-client\'',
      '      config:',
      '        transport: stdio',
      '        serverName: \'handwritten\'',
      '        command: \'D:\\bin\\hand.exe\'',
      '',
    ].join('\n');

    const created = planAdd(base, sampleServer());
    check('a first add creates the managed block', created.mode === 'created' && created.next.includes(MANAGED_BEGIN));
    check('an add appends without touching the original bytes', created.next.startsWith(base));
    check('the document still parses', inspectPatch(created.next).ok);

    const found = inspectPatch(created.next).rows;
    const handwritten = found.find((row) => row.patchId === 'mcp-client-handwritten');
    const managed = found.find((row) => row.patchId === 'mcp-client-demo');
    check('the hand-written row is reported outside the managed block', handwritten?.managed === false);
    check('the new row is reported inside the managed block', managed?.managed === true);
    check('only the new row is managed', inspectPatch(created.next).managedIds.length === 1);

    const second = planAdd(created.next, sampleServer({ serverName: 'second' }));
    const createdPrefix = created.next.slice(0, created.next.indexOf(MANAGED_BEGIN));
    const createdSuffix = created.next.slice(created.next.indexOf(MANAGED_END) + MANAGED_END.length);
    check('a later add replaces just the managed block', second.mode === 'replaced');
    check('the prefix before the block is byte-identical', second.next.slice(0, second.next.indexOf(MANAGED_BEGIN)) === createdPrefix);
    check('the suffix after the block is byte-identical', second.next.endsWith(createdSuffix));

    const removed = planRemove(second.next, patchIdFor('demo'));
    check('a removal changes the document', removed.changed === true);
    check('the removed row is gone', !removed.next.includes('mcp-client-demo'));
    check('the sibling managed row survives', removed.next.includes('mcp-client-second'));
    check('the hand-written row survives', removed.next.includes('mcp-client-handwritten'));
    check('removal keeps the prefix byte-identical', removed.next.slice(0, removed.next.indexOf(MANAGED_BEGIN)) === createdPrefix);
    check('after removal the document still parses', inspectPatch(removed.next).ok);

    let notManageable = 'no-error';
    try {
      planRemove(created.next, 'mcp-client-handwritten');
    } catch (error) {
      notManageable = `${error.code}: ${error.message}`;
    }
    check('deleting a hand-written row is refused as not-manageable', notManageable.startsWith('not-manageable'), notManageable);

    // Top-level override rows for the same id are removed with it (contract §6.2).
    const withOverride = `${second.next}
- id: mcp-client-demo
  disabled: true
- id: plugin-market
  config:
    indexes: []
`;
    const cleaned = planRemove(withOverride, patchIdFor('demo'));
    check('the same-id top-level override row is cleaned up', !/^- id: mcp-client-demo$/m.test(cleaned.next), cleaned.removedOverrides);
    check('an unrelated top-level row is untouched', cleaned.next.includes('- id: plugin-market'));

    const lines = '- id: keep-a\n  disabled: false\n- id: drop-me\n  disabled: true\n- id: keep-b\n  disabled: false\n';
    const stripped = removeTopLevelRowsById(lines, 'drop-me');
    check('targeted top-level removal removes one row', stripped.removed === 1);
    check('targeted top-level removal keeps the others', stripped.text === '- id: keep-a\n  disabled: false\n- id: keep-b\n  disabled: false\n', JSON.stringify(stripped.text));

    let halfBlock = 'no-error';
    try {
      planAdd(`${MANAGED_BEGIN}\n- insert: []\n`, sampleServer());
    } catch (error) {
      halfBlock = `${error.code}: ${error.message}`;
    }
    check('a begin marker without an end marker is refused', halfBlock.startsWith('patch-invalid'), halfBlock);

    let strayEnd = 'no-error';
    try {
      managedSpan(`${MANAGED_END}\n`);
    } catch (error) {
      strayEnd = `${error.code}: ${error.message}`;
    }
    check('an end marker without a begin marker is refused', strayEnd.startsWith('patch-invalid'), strayEnd);

    let brokenYaml = 'no-error';
    try {
      planAdd('- id: [unclosed\n', sampleServer());
    } catch (error) {
      brokenYaml = `${error.code}: ${error.message}`;
    }
    check('adding to a document that does not parse is refused', brokenYaml.startsWith('patch-invalid'), brokenYaml);
    check('managed row ids are readable from text', JSON.stringify(readManagedRows(second.next).rows.map((row) => row.id)) === JSON.stringify(['mcp-client-demo', 'mcp-client-second']));
  }

  // -------------------------------------------------------------- C. file plumbing
  section('C. lock / atomic write / backup');
  {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-files-'));
    try {
      const path = join(dir, 'cordis.patch.yml');
      check('a missing patch file reads as empty text', (await readPatchText(path)) === '');
      await writePatchText(path, 'hello\n');
      check('a write is readable back', (await readPatchText(path)) === 'hello\n');
      await writePatchText(path, 'hello again\n');
      check('a second atomic write replaces the content', (await readPatchText(path)) === 'hello again\n');

      let ran = false;
      await withPatchLock(dir, async () => {
        ran = true;
      });
      check('the profile lock runs the operation', ran);
      check('the lock file is removed afterwards', !existsSync(join(dir, 'package.json.lock')));

      const backup = await backupPatchText(path, 'hello again\n');
      check('a backup is written under data/mcp-manager', backup.includes(join('data', 'mcp-manager')) && backup.includes('backup-'));
      check('the backup holds the pre-write text', (await readFile(backup, 'utf8')) === 'hello again\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- D. validation
  section('D. input validation');
  {
    check('the serverName pattern matches the host rule', SERVER_NAME_PATTERN.test('a-b_1') && !SERVER_NAME_PATTERN.test('has space') && !SERVER_NAME_PATTERN.test('x'.repeat(33)));

    const good = validateServerInput({ serverName: 'alpha', transport: 'stdio', command: 'python', args: ['-m', 'x'], env: { A: '1', B: { __jsExpr: 'process.env.B' } } });
    check('a valid stdio definition is accepted', good.ok === true, JSON.stringify(good.errors));
    check('an expression env value is preserved raw', good.server?.env?.B?.__jsExpr === 'process.env.B');

    const badName = validateServerInput({ serverName: 'bad name', command: 'x' });
    check('an illegal serverName is rejected', badName.ok === false && badName.errors.some((entry) => entry.field === 'serverName'));
    const noCommand = validateServerInput({ serverName: 'alpha', transport: 'stdio' });
    check('stdio without a command is rejected', noCommand.ok === false && noCommand.errors.some((entry) => entry.field === 'command'));
    const badUrl = validateServerInput({ serverName: 'alpha', transport: 'streamable-http', url: 'not a url' });
    check('an http row without a valid url is rejected', badUrl.ok === false && badUrl.errors.some((entry) => entry.field === 'url'));
    const goodHttp = validateServerInput({ serverName: 'alpha', transport: 'streamable-http', url: 'https://x.test/mcp' });
    check('a valid http definition is accepted', goodHttp.ok === true);
    const badEnv = validateServerInput({ serverName: 'alpha', command: 'x', env: { K: 5 } });
    check('a non-string env value is rejected', badEnv.ok === false && badEnv.errors.some((entry) => entry.field === 'env.K'));
    const badArgs = validateServerInput({ serverName: 'alpha', command: 'x', args: 'not-an-array' });
    check('a non-array args is rejected', badArgs.ok === false && badArgs.errors.some((entry) => entry.field === 'args'));
    const wrongId = validateServerInput({ serverName: 'alpha', command: 'x', id: 'custom-id' });
    check('an id that is not the derived patch id is rejected', wrongId.ok === false && wrongId.errors.some((entry) => entry.field === 'id'));
    const rightId = validateServerInput({ serverName: 'alpha', command: 'x', id: 'mcp-client-alpha' });
    check('the derived patch id is accepted', rightId.ok === true);

    const partial = validateConfigPatch({ toolCallTimeoutMs: 1234, unknown_field: 'ignored' });
    check('a partial config patch validates', partial.ok === true && partial.config?.toolCallTimeoutMs === 1234);
    const badTimeout = validateConfigPatch({ toolCallTimeoutMs: -1 });
    check('a non-positive timeout is rejected', badTimeout.ok === false);

    const mergedNoCommand = validateEffectiveConfig({ transport: 'stdio', serverName: 'alpha' });
    check('an effective config missing its command is rejected', mergedNoCommand.ok === false);
    const mergedHttp = validateEffectiveConfig({ transport: 'streamable-http', serverName: 'alpha', url: 'https://x.test' });
    check('a valid effective http config passes', mergedHttp.ok === true);
  }

  // ------------------------------------------------------- E. import / export map
  section('E. import/export mapping');
  {
    check('an expression exports as an !!js string', exportDefinition({ transport: 'stdio', command: 'x', env: { TOKEN: { __jsExpr: 'process.env.T' } } }).env?.TOKEN === '!!js process.env.T');
    check('a literal non-secret env value exports as-is', exportDefinition({ transport: 'stdio', command: 'x', env: { FLAG: '1' } }).env?.FLAG === '1');
    const secretExport = exportDefinition({ transport: 'stdio', command: 'x', env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_literalvalue' } });
    check('a literal credential is never exported', secretExport.env?.GITHUB_PERSONAL_ACCESS_TOKEN === undefined, JSON.stringify(secretExport.env));
    const headerExport = exportDefinition({ transport: 'streamable-http', url: 'https://x.test', headers: { Authorization: 'Bearer abc', 'X-Trace': 'yes' } });
    check('a literal Authorization header is never exported', headerExport.headers?.Authorization === undefined);
    check('a non-secret header is exported', headerExport.headers?.['X-Trace'] === 'yes');
    check('the http export uses type "http"', headerExport.type === 'http');

    check('the ${VAR} form becomes an env expression', importValue('${DEMO_KEY}')?.__jsExpr === 'process.env.DEMO_KEY');
    check('the ${process.env.X} form is kept verbatim', importValue('${process.env.DEMO_KEY}')?.__jsExpr === 'process.env.DEMO_KEY');
    check('the $env: form becomes an env expression', importValue('$env:DEMO_KEY')?.__jsExpr === 'process.env.DEMO_KEY');
    check('the !!js form is kept verbatim', importValue('!!js myExpr()')?.__jsExpr === 'myExpr()');
    check('a plain string stays a literal', importValue('plain') === 'plain');

    const aliases = ['streamableHttp', 'http', 'remote', 'streamable-http'];
    check('every http alias maps to streamable-http', aliases.every((type) => serverFromImportDefinition('s', { type, url: 'https://x.test' }).server?.transport === 'streamable-http'));
    const sse = serverFromImportDefinition('s', { type: 'sse', url: 'https://x.test' });
    check('sse maps to streamable-http and is reported', sse.server?.transport === 'streamable-http' && sse.dropped.includes('transport:sse→streamable-http'), JSON.stringify(sse.dropped));
    check('missing type + command is stdio', serverFromImportDefinition('s', { command: 'x' }).server?.transport === 'stdio');
    check('missing type + url is streamable-http', serverFromImportDefinition('s', { url: 'https://x.test' }).server?.transport === 'streamable-http');
    const dropped = serverFromImportDefinition('s', { command: 'x', autoApprove: ['*'], timeout: 30, disabled: false });
    check('unsupported fields are reported, not silently dropped', JSON.stringify(dropped.dropped) === JSON.stringify(['autoApprove', 'timeout', 'disabled']), JSON.stringify(dropped.dropped));
    const unknownType = serverFromImportDefinition('s', { type: 'websocket', url: 'ws://x' });
    check('an unknown transport is an error', unknownType.ok === false && unknownType.errors.length > 0);
  }

  // --------------------------------------------------------------- F. probe wire
  section('F. probe framing');
  {
    const frames = probeFrames();
    check('initialize is id 1 with the 2025-06-18 revision', frames.initialize.id === 1 && frames.initialize.method === 'initialize' && frames.initialize.params.protocolVersion === '2025-06-18');
    check('initialized is a notification', frames.initialized.method === 'notifications/initialized' && frames.initialized.id === undefined);
    check('tools/list is id 2', frames.toolsList.id === 2 && frames.toolsList.method === 'tools/list');

    const written = [];
    const channel = createProbeChannel({ write: (line) => written.push(JSON.parse(line.trim())) });
    const pending = channel.request(frames.initialize);
    channel.push('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"fake"}}}\n');
    const init = await pending;
    check('a response frame resolves the matching request', init.result?.serverInfo?.name === 'fake');
    check('the request was written as one newline-delimited line', written.length === 1 && written[0].id === 1);
    channel.notify(frames.initialized);
    check('a notification is written without an id', written[1].method === 'notifications/initialized' && written[1].id === undefined);

    const second = channel.request(frames.toolsList);
    channel.push('this line is not json\n');
    channel.push('{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"one","description":"d"},{"name":"two"},{"bogus":true}]}}\n');
    const listed = await second;
    check('a malformed line is ignored, not fatal', normalizeTools(listed.result.tools).length === 2, JSON.stringify(normalizeTools(listed.result.tools)));
    check('tool entries are reduced to name/description', normalizeTools(listed.result.tools)[0].name === 'one' && normalizeTools(listed.result.tools)[1].description === '');

    const controller = new AbortController();
    const aborting = createProbeChannel({ write: () => {}, signal: controller.signal, timeoutMs: 8000 });
    const pendingAbort = aborting.request(frames.toolsList);
    controller.abort();
    let abortMessage = '';
    try {
      await pendingAbort;
    } catch (error) {
      abortMessage = error.message;
    }
    check('an abort rejects the pending request as a timeout', abortMessage.includes('timed out after 8000 ms'), abortMessage);

    const errorChannel = createProbeChannel({ write: () => {} });
    const failing = errorChannel.request(frames.initialize);
    errorChannel.push('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}}\n');
    let errorMessage = '';
    try {
      await failing;
    } catch (error) {
      errorMessage = error.message;
    }
    check('a JSON-RPC error response rejects with its message', errorMessage.includes('bad params'), errorMessage);

    check('the scrub drops credential-shaped and DSH_ names', scrubEnv({ PATH: '/bin', GITHUB_TOKEN: 'x', DSH_PROFILE: 'desktop', HOME: '/h' }) && JSON.stringify(Object.keys(scrubEnv({ PATH: '/bin', GITHUB_TOKEN: 'x', DSH_PROFILE: 'desktop', HOME: '/h' }))) === JSON.stringify(['PATH', 'HOME']));
    const resolved = resolveExpressionMap({ A: { __jsExpr: 'process.env.PATH' }, B: { __jsExpr: 'someFunction()' }, C: 'literal' });
    check('process.env references resolve for the probe child', typeof resolved.values.A === 'string' && resolved.values.A.length > 0);
    check('an arbitrary expression is skipped, not evaluated', resolved.skipped.includes('B') === true && resolved.values.B === undefined);
    check('a literal passes through', resolved.values.C === 'literal');

    check('a plain JSON body parses', parseMcpHttpBody('{"result":{"a":1}}', 'application/json')?.result?.a === 1);
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n';
    check('an SSE body parses to its last data payload', parseMcpHttpBody(sse, 'text/event-stream')?.result?.protocolVersion === '2025-06-18');
  }

  // -------------------------------------------------------------- G. list view
  section('G. list view joins live + raw + tools');
  {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-list-'));
    try {
      const patchPath = join(dir, 'cordis.patch.yml');
      const alphaRow = renderServerRow({
        serverName: 'alpha',
        transport: 'stdio',
        command: 'python',
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_literalvalue1234567890',
          SAFE_FLAG: '1',
          DEMO_KEY: { __jsExpr: 'process.env.DEMO_KEY' },
        },
        toolCallTimeoutMs: 60000,
      });
      const betaRow = renderServerRow({ serverName: 'beta', transport: 'stdio', command: 'node' });
      const document = `${renderManagedBlock([alphaRow])}\n- insert:\n${betaRow}\n- id: plugin-market\n  config:\n    indexes: []\n`;
      await writeFile(patchPath, document, 'utf8');

      const entryAlpha = {
        id: 'include:mcp-client-alpha',
        options: {
          id: 'mcp-client-alpha',
          name: MCP_CLIENT_PACKAGE,
          // The evaluated config: a secret in plaintext. It must never reach the response.
          config: { transport: 'stdio', serverName: 'alpha', env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_literalvalue1234567890' } },
        },
      };
      const rawAlpha = {
        transport: 'stdio',
        serverName: 'alpha',
        command: 'python',
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_literalvalue1234567890',
          SAFE_FLAG: '1',
          DEMO_KEY: { __jsExpr: 'process.env.DEMO_KEY' },
        },
        toolCallTimeoutMs: 60000,
      };
      const ctx = {
        configEditor: {
          documentPath: patchPath,
          entries: () => [entryAlpha],
          configuration: () => [{ entry: entryAlpha, inherited: rawAlpha, override: {} }],
        },
        pluginManager: {
          listPlugins: async () => [
            { entryId: entryAlpha.id, patchId: 'mcp-client-alpha', moduleName: MCP_CLIENT_PACKAGE, enabled: true, fiberPhase: 'active' },
          ],
        },
        tools: {
          schemas: () => [{ name: 'mcp__alpha__one' }, { name: 'mcp__alpha__two' }, { name: 'other_tool' }],
        },
      };

      rememberProbe('alpha', { ok: true, durationMs: 12, tools: [{ name: 'one', description: '' }] });
      const view = await listServers(ctx);
      const alpha = view.servers.find((row) => row.serverName === 'alpha');
      const beta = view.servers.find((row) => row.serverName === 'beta');

      check('the live row is listed', alpha !== undefined);
      check('the patch-only row is listed too', beta !== undefined);
      check('the managed row is source=managed', alpha?.source === 'managed');
      check('the hand-written row is source=handwritten', beta?.source === 'handwritten');
      check('the live enablement is reported', alpha?.enabled === true);
      check('the fiber phase is reported', alpha?.fiberPhase === 'active');
      check('the tool count comes from the namespace', alpha?.toolCount === 2, String(alpha?.toolCount));
      check('the patch-only row has no tool namespace', beta?.toolCount === 0);
      check('env keys are names with expression flags', alpha?.envKeys.find((entry) => entry.key === 'DEMO_KEY')?.isJsExpr === true);
      check('a literal env key is reported as not an expression', alpha?.envKeys.find((entry) => entry.key === 'SAFE_FLAG')?.isJsExpr === false);
      check('envKeys carry no value field', alpha?.envKeys.every((entry) => Object.keys(entry).sort().join(',') === 'isJsExpr,jsExpr,key'));
      check('lastProbe is attached from the cache', alpha?.lastProbe?.toolCount === 1 && alpha?.lastProbe?.ok === true);
      check('toolCallTimeoutMs is reported', alpha?.toolCallTimeoutMs === 60000);
      check('source and managed agree', alpha?.managed === true && beta?.managed === false);
      check('totals count servers, enabled, active and tools', view.totals.servers === 2 && view.totals.enabled === 1 && view.totals.active === 1 && view.totals.tools === 2, JSON.stringify(view.totals));
      check('the patch path is reported', view.patch.path === patchPath && view.patch.ok === true);
      check('a plaintext credential is diagnosed', view.problems.some((problem) => problem.level === 'warn' && problem.message.includes('GITHUB_PERSONAL_ACCESS_TOKEN')));
      check('the response never contains the plaintext credential', !JSON.stringify(view).includes('ghp_literalvalue1234567890'));
      check('the response never contains the evaluated secret', !JSON.stringify(view).includes('EVALUATED'));
      clearProbes();
      check('clearProbes empties the cache', lastProbeOf('alpha') === null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------ H. toggle
  section('H. enable/disable');
  {
    const ctx = {
      pluginManager: {
        listPlugins: async () => [
          { entryId: 'include:a', patchId: 'mcp-client-a', moduleName: MCP_CLIENT_PACKAGE, enabled: true, fiberPhase: 'active' },
          { entryId: 'include:locked', readOnlyReason: 'management-required', moduleName: MCP_CLIENT_PACKAGE, enabled: true, fiberPhase: 'active' },
          { entryId: 'include:other', patchId: 'other', moduleName: '@deepseek-ai/something-else', enabled: true, fiberPhase: 'active' },
        ],
        setPluginEnabled: async () => ({ changed: true, application: 'applied', enabled: false }),
      },
    };
    const applied = await setServerEnabled(ctx, 'include:a', false);
    check('a hot change reports application=applied', applied.application === 'applied' && applied.changed === true);

    const failingCtx = {
      pluginManager: {
        listPlugins: async () => [{ entryId: 'include:a', patchId: 'mcp-client-a', moduleName: MCP_CLIENT_PACKAGE, enabled: true }],
        setPluginEnabled: async () => ({ changed: false, application: 'failed', error: { code: 'unknown-plugin' } }),
      },
    };
    let failedMessage = '';
    try {
      await setServerEnabled(failingCtx, 'include:a', false);
    } catch (error) {
      failedMessage = `${error.code}: ${error.message}`;
    }
    check('a failed application becomes a conflict', failedMessage.startsWith('conflict'), failedMessage);

    let missing = '';
    try {
      await setServerEnabled(ctx, 'include:missing', false);
    } catch (error) {
      missing = `${error.code}: ${error.message}`;
    }
    check('an unknown entry is not-found', missing.startsWith('not-found'), missing);

    let locked = '';
    try {
      await setServerEnabled(ctx, 'include:locked', false);
    } catch (error) {
      locked = `${error.code}: ${error.message}`;
    }
    check('a row without a patchId is not-manageable', locked.startsWith('not-manageable'), locked);

    let notMcp = '';
    try {
      await setServerEnabled(ctx, 'include:other', false);
    } catch (error) {
      notMcp = `${error.code}: ${error.message}`;
    }
    check('a non-MCP entry is not-manageable', notMcp.startsWith('not-manageable'), notMcp);
  }

  // ------------------------------------------------------------------ I. update
  section('I. raw-layer edit');
  {
    const inherited = {
      transport: 'stdio',
      serverName: 'alpha',
      command: 'python',
      env: {
        API_KEY: 'literal-secret-value',
        KEEP_ME: { __jsExpr: 'process.env.KEEP_ME' },
      },
    };
    const entry = { id: 'include:mcp-client-alpha', options: { id: 'mcp-client-alpha', name: MCP_CLIENT_PACKAGE } };
    let captured = null;
    const makeCtx = (override = {}) => ({
      configEditor: {
        entries: () => [entry],
        configuration: () => [{ entry, inherited, override }],
        edit: async (_entry, change) => {
          // The evaluated config a real ConfigEditor passes first: plaintext, defaults
          // materialised. If the implementation ever reads it, these values leak.
          const evaluated = {
            transport: 'stdio',
            serverName: 'alpha',
            command: 'python',
            env: { API_KEY: 'EVALUATED-PLAINTEXT', KEEP_ME: 'EVALUATED-KEEP' },
          };
          captured = change(evaluated, inherited);
        },
      },
    });

    const updated = await updateServerConfig(makeCtx(), { patchId: 'mcp-client-alpha', config: { toolCallTimeoutMs: 120000 } });
    check('an update reports changed', updated.changed === true);
    check('the inherited command is preserved', captured?.command === 'python');
    check('the new field is applied', captured?.toolCallTimeoutMs === 120000);
    check('a literal credential is kept from inherited, not from the evaluated config', captured?.env?.API_KEY === 'literal-secret-value');
    check('the evaluated config is never read', captured?.env?.API_KEY !== 'EVALUATED-PLAINTEXT');

    const kept = await updateServerConfig(makeCtx(), {
      patchId: 'mcp-client-alpha',
      config: { env: { KEEP_ME: { __keep: true }, API_KEY: { __keep: true } } },
    });
    check('{__keep:true} restores the inherited value', captured?.env?.KEEP_ME?.__jsExpr === 'process.env.KEEP_ME');
    check('every {__keep:true} key is restored from the inherited layer', captured?.env?.API_KEY === 'literal-secret-value');
    check('a keep-only update still reports changed', kept.changed === true);

    let missingKeep = '';
    try {
      await updateServerConfig(makeCtx(), { patchId: 'mcp-client-alpha', config: { env: { ABSENT: { __keep: true } } } });
    } catch (error) {
      missingKeep = `${error.code}: ${JSON.stringify(error.details)}`;
    }
    check('a {__keep} with no inherited value is a 400 naming the key', missingKeep.startsWith('bad-request') && missingKeep.includes('env.ABSENT'), missingKeep);

    const resolved = resolveKeepSentinels(inherited, { env: { KEEP_ME: { __keep: true } } });
    check('keep resolution reports nothing missing when the key exists', resolved.missing.length === 0);
    check('assertKeepResolved is a no-op when nothing is missing', assertKeepResolved([]) === undefined);

    const migrated = await updateServerConfig(makeCtx(), { patchId: 'mcp-client-alpha', migrateSecrets: true });
    check('migrateSecrets rewrites a literal credential as a reference', captured?.env?.API_KEY?.__jsExpr === 'process.env.API_KEY', JSON.stringify(captured?.env?.API_KEY));
    check('migrateSecrets reports the migrated keys', JSON.stringify(migrated.migrated) === JSON.stringify(['API_KEY']), JSON.stringify(migrated.migrated));
    check('migrateSecrets moves no value', !JSON.stringify(captured).includes('literal-secret-value'));

    const literalMap = { env: { TOKEN: 'abc', SAFE: 'x', ALREADY: { __jsExpr: 'process.env.ALREADY' } } };
    const migratedMap = migrateSecretLiterals(literalMap);
    check('only credential-shaped literals migrate', JSON.stringify(migratedMap.migrated) === JSON.stringify(['TOKEN']));
    check('non-secret literals are untouched', literalMap.env.SAFE === 'x');

    const switched = sanitizeMerged({ transport: 'streamable-http', serverName: 'alpha', url: 'https://x.test', command: 'python', args: ['-m'], env: { A: '1' }, cwd: '/tmp' });
    check('switching to http drops the stdio-only keys', switched.command === undefined && switched.env === undefined && switched.url === 'https://x.test');
    const switchedBack = sanitizeMerged({ transport: 'stdio', serverName: 'alpha', command: 'python', url: 'https://x.test', headers: { A: 'b' } });
    check('switching to stdio drops the http-only keys', switchedBack.url === undefined && switchedBack.headers === undefined && switchedBack.command === 'python');

    // A previous edit lands in the profile override; the effective raw layer (what the
    // page displayed) is `{...inherited, ...override}`, so `{__keep}` and migration must
    // resolve against that layer, not against the base bundle alone.
    const overrideLayer = {
      transport: 'stdio',
      serverName: 'alpha',
      command: 'python',
      env: {
        API_KEY: 'from-override',
        OVERRIDE_ONLY: { __jsExpr: 'process.env.OVERRIDE_ONLY' },
      },
    };
    await updateServerConfig(makeCtx(overrideLayer), {
      patchId: 'mcp-client-alpha',
      config: { env: { API_KEY: { __keep: true } } },
    });
    check('{__keep:true} resolves a value that lives in the profile override', captured?.env?.API_KEY === 'from-override');
    await updateServerConfig(makeCtx(overrideLayer), { patchId: 'mcp-client-alpha', migrateSecrets: true });
    check('migrateSecrets sees the profile override values', captured?.env?.API_KEY?.__jsExpr === 'process.env.API_KEY', JSON.stringify(captured?.env));
    check('migrateSecrets leaves override expressions alone', captured?.env?.OVERRIDE_ONLY?.__jsExpr === 'process.env.OVERRIDE_ONLY');
  }

  // ------------------------------------------------------- J. add/remove on disk
  section('J. add / remove against a temp profile');
  {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-flow-'));
    try {
      const patchPath = join(dir, 'cordis.patch.yml');
      const original = '# stand-in profile patch\n- id: ui-theme\n  config:\n    preference: light\n';
      await writeFile(patchPath, original, 'utf8');

      // A manager that behaves like the host: it reads the patch file and reports a
      // live row for each managed row that parses — i.e. it "composes" whatever was
      // written, which is what HMR does for the real profile.
      const composeLike = () => ({
        listPlugins: async () => {
          const text = await readFile(patchPath, 'utf8');
          return inspectPatch(text)
            .rows.filter((row) => row.managed && row.isMcpClient)
            .map((row) => ({
              entryId: `include:${row.patchId}`,
              patchId: row.patchId,
              moduleName: MCP_CLIENT_PACKAGE,
              enabled: true,
              fiberPhase: 'active',
            }));
        },
      });

      const added = await addManagedServer({ configEditor: { documentPath: patchPath }, pluginManager: composeLike() }, sampleServer());
      check('an add returns its derived patchId', added.patchId === 'mcp-client-demo');
      check('an add reports applied', added.applied === 'applied');
      const afterAdd = await readFile(patchPath, 'utf8');
      check('the original document bytes are preserved', afterAdd.startsWith(original));
      check('the managed block exists on disk', afterAdd.includes(MANAGED_BEGIN));
      check('the new row is inside the managed block', inspectPatch(afterAdd).managedIds.includes('mcp-client-demo'));
      check('the add made a backup', existsSync(join(dir, 'data', 'mcp-manager')));

      const removed = await removeManagedServer({ configEditor: { documentPath: patchPath }, pluginManager: composeLike() }, 'mcp-client-demo');
      check('a remove reports removed', removed.removed === true);
      const afterRemove = await readFile(patchPath, 'utf8');
      check('removal keeps the original bytes', afterRemove.startsWith(original));
      check('the row is gone from the block', !afterRemove.includes('mcp-client-demo'));
      check('the block survives as an empty insert list', afterRemove.includes('- insert: []'));

      // Rollback: a host that never composes the row must not leave it behind.
      const neverComposes = { configEditor: { documentPath: patchPath }, pluginManager: { listPlugins: async () => [] } };
      let rollbackError = '';
      try {
        await addManagedServer(neverComposes, sampleServer({ serverName: 'ghost' }));
      } catch (error) {
        rollbackError = `${error.code}: ${error.message}`;
      }
      check('an uncomposed add is a write-failed error', rollbackError.startsWith('write-failed'), rollbackError);
      const afterRollback = await readFile(patchPath, 'utf8');
      check('the rollback restored the document', afterRollback === afterRemove);
      check('the rolled-back row is absent', !afterRollback.includes('mcp-client-ghost'));

      // A hand-written row is never deleted physically.
      let outside = '';
      try {
        await removeManagedServer({ configEditor: { documentPath: patchPath }, pluginManager: composeLike() }, 'mcp-client-handwritten');
      } catch (error) {
        outside = `${error.code}: ${error.message}`;
      }
      check('deleting an unknown/hand-written row is refused', outside.startsWith('not-found'), outside);

      // Import end to end: the contract's mapping plus the reported drops.
      const importCtx = { configEditor: { documentPath: patchPath }, pluginManager: composeLike() };
      const payload = {
        mode: 'add',
        mcpServers: {
          'imp-http': { type: 'sse', url: 'https://example.test/mcp', autoApprove: ['*'] },
          'imp-stdio': { command: 'python', args: ['-m', 'imp'], env: { API_KEY: '${IMP_KEY}' } },
        },
      };
      const imported = await importServers(importCtx, payload);
      check('import adds every valid server', imported.added.length === 2, JSON.stringify(imported.added));
      check(
        'import reports the sse substitution and the dropped fields',
        imported.droppedFields.some(
          (entry) => entry.serverName === 'imp-http' && entry.fields.includes('transport:sse→streamable-http') && entry.fields.includes('autoApprove'),
        ),
        JSON.stringify(imported.droppedFields),
      );
      const afterImport = inspectPatch(await readFile(patchPath, 'utf8'));
      const stdioRow = afterImport.rows.find((row) => row.serverName === 'imp-stdio');
      check(
        'an imported ${VAR} becomes an unevaluated env expression',
        stdioRow?.envKeys.some((entry) => entry.key === 'API_KEY' && entry.isJsExpr === true && entry.jsExpr === 'process.env.IMP_KEY'),
        JSON.stringify(stdioRow?.envKeys),
      );
      check('imported rows live in the managed block', afterImport.managedIds.length === 2, JSON.stringify(afterImport.managedIds));

      const again = await importServers(importCtx, payload);
      check('re-importing the same names is skipped, not duplicated', again.added.length === 0 && again.skipped.length === 2, JSON.stringify(again.skipped));
      let badMode = '';
      try {
        await importServers(importCtx, { mode: 'overwrite', mcpServers: {} });
      } catch (error) {
        badMode = `${error.code}: ${error.message}`;
      }
      check('an unsupported import mode is a bad-request', badMode.startsWith('bad-request'), badMode);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // -------------------------------------------------- K. security/HTTP helpers
  section('K. HTTP security helpers');
  {
    const denied = mockResponse();
    const deniedResult = rejectUnauthorized({ connection: { requestRejection: () => 401 } }, {}, denied);
    check('a rejection finishes the response with its status', deniedResult === true && denied.statusCode === 401 && denied.ended);

    const allowed = mockResponse();
    check('an allowed request passes the gate', rejectUnauthorized({ connection: { requestRejection: () => undefined } }, {}, allowed) === false);

    const failingGate = mockResponse();
    check('a throwing gate fails closed', rejectUnauthorized({ connection: { requestRejection: () => { throw new Error('boom'); } } }, {}, failingGate) === true && failingGate.statusCode === 500);

    const method = mockResponse();
    check('a wrong method is refused with allow', requireMethod({ method: 'GET' }, method, 'POST') === false && method.statusCode === 405 && method.headers.allow === 'POST');

    const notJson = mockResponse();
    check('a non-JSON mutation body is refused', requireJson({ headers: { 'content-type': 'text/plain' } }, notJson) === false && notJson.statusCode === 415);

    const jsonOk = mockResponse();
    check('a JSON content type is accepted', requireJson({ headers: { 'content-type': 'application/json; charset=utf-8' } }, jsonOk) === true);

    async function* body(text) {
      yield Buffer.from(text, 'utf8');
    }
    const parsed = await readJsonBody(body('{"a":1}'));
    check('a bounded JSON body parses', parsed.a === 1);

    let tooLarge = '';
    try {
      await readJsonBody({ async *[Symbol.asyncIterator]() { yield Buffer.alloc(70 * 1024); } });
    } catch (error) {
      tooLarge = `${error.code}: ${error.status}`;
    }
    check('an oversized body is refused with 413', tooLarge === 'bad-request: 413', tooLarge);

    let badJson = '';
    try {
      await readJsonBody(body('{oops'));
    } catch (error) {
      badJson = error.code;
    }
    check('malformed JSON is a bad-request', badJson === 'bad-request');

    const sent = mockResponse();
    sendJson(sent, 201, { ok: true });
    check('JSON responses are no-store', sent.statusCode === 201 && sent.headers['cache-control'] === 'no-store');
    check('JSON responses carry a content length', Number(sent.headers['content-length']) > 0);

    const errored = mockResponse();
    sendError(errored, new ApiError('conflict', 'nope'));
    check('contract codes map to their status', errored.statusCode === 409 && JSON.parse(errored.body).error.code === 'conflict');

    const masked = redact('token ghp_abcdefghijklmnopqrstuvwxyz0123 and GITHUB_TOKEN: hunter2 and sk-abcdefghijklmnopqrstu', ['hunter2']);
    check('github tokens are masked', !masked.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), masked);
    check('known secret values are masked', !masked.includes('hunter2'));
    check('sk-style tokens are masked', !masked.includes('sk-abcdefghijklmnopqrstu'));
  }

  // --------------------------------------------------------------- L. diagnostics
  section('L. diagnostics');
  {
    const rows = [
      { isMcpClient: true, patchId: 'mcp-client-a', serverName: 'alpha', transport: 'stdio', command: 'python', envKeys: [{ key: 'DEMO_KEY', isJsExpr: true, jsExpr: 'process.env.DEMO_UNSET_VAR' }], envLiteralKeys: [], headerLiteralKeys: [] },
      { isMcpClient: true, patchId: 'mcp-client-b', serverName: 'alpha', transport: 'stdio', command: 'python', envKeys: [], envLiteralKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'], headerLiteralKeys: [] },
      { isMcpClient: true, patchId: 'mcp-client-c', serverName: 'bad name', transport: 'stdio', command: 'missing-binary', envKeys: [], envLiteralKeys: [], headerLiteralKeys: [] },
    ];
    const problems = diagnose(rows, { env: {}, exists: () => false });
    check('a duplicate serverName is an error', problems.some((problem) => problem.level === 'error' && problem.message.includes('also used by')));
    check('an illegal serverName is an error', problems.some((problem) => problem.level === 'error' && problem.message.includes('violates')));
    check('a missing command is a warning', problems.some((problem) => problem.level === 'warn' && problem.message.includes('command not found')));
    check('an unset env reference is a warning', problems.some((problem) => problem.level === 'warn' && problem.message.includes('DEMO_UNSET_VAR')));
    check('a literal credential is a warning', problems.some((problem) => problem.level === 'warn' && problem.message.includes('GITHUB_PERSONAL_ACCESS_TOKEN')));
    check('a broken patch is a global error', diagnose([], { patchOk: false, patchError: 'bad yaml' }).some((problem) => problem.level === 'error' && problem.message.includes('bad yaml')));
    check('isSecretName recognises header credentials', isSecretName('Authorization', { header: true }) && !isSecretName('Authorization'));
  }

  // ------------------------------------------------------ M. real profile dry run
  section('M. real profile (read-only)');
  {
    const real = 'C:\\Users\\PC\\.dsh\\profiles\\desktop\\cordis.patch.yml';
    try {
      const before = await readFile(real, 'utf8');
      const info = inspectPatch(before);
      check('the real profile patch parses', info.ok, info.error ?? '');
      const mcpRows = info.rows.filter((row) => row.isMcpClient);
      check('the real profile declares MCP rows', mcpRows.length >= 10, `rows=${mcpRows.length}`);
      check('every real MCP row carries a serverName', mcpRows.every((row) => typeof row.serverName === 'string' && row.serverName !== ''));
      check('every real MCP row names the mcp-client package', mcpRows.every((row) => row.name === MCP_CLIENT_PACKAGE));
      check('no real MCP row is inside a managed block yet (first install)', info.managedIds.length === 0, info.managedIds.join(','));
      const planned = planAdd(before, sampleServer({ serverName: 'smoke-dry-run' }));
      check('a dry-run add keeps every existing byte', planned.next.startsWith(before));
      check('the dry-run result parses', inspectPatch(planned.next).ok);
      check('the dry run wrote nothing', (await readFile(real, 'utf8')) === before);
      console.log('       (read-only: the real profile was not modified)');
    } catch (error) {
      console.log(`SKIP  real profile not reachable: ${error?.message ?? error}`);
    }
  }

  // ------------------------------------------------------ N. route registration
  section('N. route wiring');
  {
    check('the plugin is named as the patch row expects', pluginName === 'mcp-manager');
    check(
      'the plugin injects the six services its routes use',
      JSON.stringify(injectedServices) ===
        JSON.stringify(['webServer', 'connection', 'pluginManager', 'configEditor', 'subprocess', 'tools']),
      JSON.stringify(injectedServices),
    );

    const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-routes-'));
    try {
      const patchPath = join(dir, 'cordis.patch.yml');
      await writeFile(patchPath, '- id: ui-theme\n  config: {}\n', 'utf8');
      const routes = [];
      const disposers = [];
      let rejection = undefined;
      const ctx = {
        effect(fn) {
          const dispose = fn();
          disposers.push(dispose);
          return dispose;
        },
        webServer: {
          register(route) {
            routes.push(route);
            return () => {
              route.disposed = true;
            };
          },
        },
        connection: {
          requestRejection: () => rejection,
        },
        pluginManager: {
          listPlugins: async () => [],
        },
        configEditor: {
          documentPath: patchPath,
          entries: () => [],
          configuration: () => [],
        },
        subprocess: {},
        tools: { schemas: () => [] },
      };
      apply(ctx);

      const paths = routes.map((route) => route.path).sort();
      check(
        'all eight contract routes are registered',
        JSON.stringify(paths) ===
          JSON.stringify(
            [
              '/mcp-manager/api/export',
              '/mcp-manager/api/import',
              '/mcp-manager/api/probe',
              '/mcp-manager/api/servers',
              '/mcp-manager/api/servers/add',
              '/mcp-manager/api/servers/remove',
              '/mcp-manager/api/servers/toggle',
              '/mcp-manager/api/servers/update',
            ].sort(),
          ),
        JSON.stringify(paths),
      );
      check('every route is an exact path registration', routes.every((route) => route.kind === 'exact'));

      const getRoute = routes.find((route) => route.path === '/mcp-manager/api/servers');
      const okResponse = mockResponse();
      await getRoute.handler({ method: 'GET', headers: {} }, okResponse);
      const okBody = JSON.parse(okResponse.body || '{}');
      check('GET /servers answers 200 with the contract envelope', okResponse.statusCode === 200 && Array.isArray(okBody.servers) && okBody.patch?.path === patchPath && Array.isArray(okBody.problems) && okBody.totals?.servers === 0, okResponse.body.slice(0, 160));
      check('GET /servers exposes the last snapshot path', 'snapshotPath' in okBody, Object.keys(okBody).join(','));

      rejection = 401;
      const deniedResponse = mockResponse();
      await getRoute.handler({ method: 'GET', headers: {} }, deniedResponse);
      check('an unauthenticated request is refused before any work', deniedResponse.statusCode === 401 && deniedResponse.body === '');
      rejection = undefined;

      const toggle = routes.find((route) => route.path === '/mcp-manager/api/servers/toggle');
      const wrongMethod = mockResponse();
      await toggle.handler({ method: 'GET', headers: {} }, wrongMethod);
      check('a mutation route refuses GET with 405', wrongMethod.statusCode === 405);

      const plainText = mockResponse();
      await toggle.handler({ method: 'POST', headers: { 'content-type': 'text/plain' } }, plainText);
      check('a mutation route refuses a non-JSON body with 415', plainText.statusCode === 415);

      const unknownToggle = mockResponse();
      await toggle.handler(
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"entryId":"include:nope","enabled":false}', 'utf8');
          },
        },
        unknownToggle,
      );
      check('a mutation route answers a classified error', unknownToggle.statusCode === 404 && JSON.parse(unknownToggle.body).error.code === 'not-found', unknownToggle.body);

      const badJson = mockResponse();
      await toggle.handler(
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{bad', 'utf8');
          },
        },
        badJson,
      );
      check('malformed JSON is a 400 through the route', badJson.statusCode === 400);

      for (const dispose of disposers.splice(0)) dispose();
      check('disposal unregisters every route', routes.every((route) => route.disposed === true));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------- O. startup diagnostics snapshot
  section('O. startup diagnostics snapshot');
  {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-snapshot-'));
    const previousHome = process.env.DSH_HOME;
    const previousProfile = process.env.DSH_PROFILE;
    process.env.DSH_HOME = dir;
    process.env.DSH_PROFILE = 'desktop';
    try {
      const patchPath = join(dir, 'cordis.patch.yml');
      await writeFile(patchPath, '- id: ui-theme\n  config: {}\n', 'utf8');

      const entry = {
        id: 'include:mcp-client-alpha',
        options: { id: 'mcp-client-alpha', name: MCP_CLIENT_PACKAGE, config: { serverName: 'alpha' } },
      };
      const snapshotCtx = {
        configEditor: {
          documentPath: patchPath,
          entries: () => [entry],
          configuration: () => [
            {
              entry,
              inherited: {
                transport: 'stdio',
                serverName: 'alpha',
                command: 'python',
                env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_snapshotsecret1234567890', SAFE_FLAG: '1' },
              },
              override: {},
            },
          ],
        },
        pluginManager: {
          listPlugins: async () => [
            { entryId: entry.id, patchId: 'mcp-client-alpha', moduleName: MCP_CLIENT_PACKAGE, enabled: true, fiberPhase: 'active' },
          ],
        },
        tools: { schemas: () => [{ name: 'mcp__alpha__one' }] },
        subprocess: { spawn: () => {} },
      };

      const snapshot = await captureSnapshot(snapshotCtx);
      check('a snapshot is written under data/mcp-manager', snapshot.includes(join('data', 'mcp-manager')) && snapshot.endsWith('.json'), snapshot);
      const text = await readFile(snapshot, 'utf8');
      const parsed = JSON.parse(text);
      check(
        'the snapshot carries the full list response',
        Array.isArray(parsed.servers) &&
          parsed.servers.length === 1 &&
          parsed.servers[0].serverName === 'alpha' &&
          parsed.patch?.path === patchPath &&
          parsed.totals?.servers === 1,
        Object.keys(parsed).join(','),
      );
      check(
        'the snapshot records the writer backend',
        parsed.backend?.atomicWrite === 'used' || parsed.backend?.atomicWrite === 'fallback',
        JSON.stringify(parsed.backend),
      );
      check('the snapshot records the subprocess capability', parsed.backend?.subprocess === 'function', parsed.backend?.subprocess);
      check('the snapshot records the probe cache size', typeof parsed.backend?.probeCache === 'number');
      check('the snapshot contains no literal credential', !text.includes('ghp_snapshotsecret1234567890'));
      check('the snapshot exposes no evaluated config object', !text.includes('EVALUATED'));
      check('the last snapshot path is exposed for the route layer', lastSnapshotPath() === snapshot);

      // Retention: only the newest ten files survive, and pruning keeps valid JSON.
      const all = [];
      for (let index = 0; index < 12; index += 1) all.push(await captureSnapshot(snapshotCtx));
      const directory = join(dir, 'data', 'mcp-manager');
      const kept = (await readdir(directory)).filter((name) => name.startsWith('snapshot-') && name.endsWith('.json')).sort();
      check('only the newest ten snapshots are kept', kept.length === 10, String(kept.length));
      check('the newest snapshot survives pruning', kept.includes(lastSnapshotPath().split('\\').pop().split('/').pop()));
      check('the oldest snapshot is pruned', !kept.includes(all[0].split('\\').pop().split('/').pop()));
      check('every retained snapshot still parses', (await Promise.all(kept.map((name) => readFile(join(directory, name), 'utf8')))).every((body) => {
        try {
          JSON.parse(body);
          return true;
        } catch {
          return false;
        }
      }));

      // Scheduling is fire-and-forget: it returns a cancel handle immediately and the
      // read itself happens later.
      const beforePath = lastSnapshotPath();
      const beforeCount = (await readdir(directory)).filter((name) => name.startsWith('snapshot-')).length;
      const cancel = scheduleSnapshot(snapshotCtx, 0);
      check('scheduling returns a cancel handle without writing yet', typeof cancel === 'function');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const afterCount = (await readdir(directory)).filter((name) => name.startsWith('snapshot-')).length;
      check('the scheduled snapshot runs and becomes the latest', lastSnapshotPath() !== beforePath && lastSnapshotPath() !== null, `${beforeCount}->${afterCount}`);
      check('retention still bounds the scheduled snapshot', afterCount >= 1 && afterCount <= 10, String(afterCount));
      cancel();

      // Without a config editor the profile directory is reconstructed from
      // DSH_HOME/DSH_PROFILE, which is what an early or degraded mount looks like.
      const fallbackPath = await captureSnapshot({
        pluginManager: { listPlugins: async () => [] },
        tools: { schemas: () => [] },
        subprocess: { spawn: () => {} },
      });
      check(
        'without a patch path the profile dir falls back to DSH_HOME/profiles/DSH_PROFILE',
        fallbackPath.startsWith(join(dir, 'profiles', 'desktop')),
        fallbackPath,
      );
      check('the fallback snapshot still parses', JSON.parse(await readFile(fallbackPath, 'utf8')).backend?.atomicWrite !== undefined);
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      if (previousProfile === undefined) delete process.env.DSH_PROFILE;
      else process.env.DSH_PROFILE = previousProfile;
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
};

main().catch((error) => {
  console.error('SMOKE CRASHED', error);
  process.exitCode = 1;
});
