/**
 * dsh-mcp-manager — browser half (no build step, no JSX).
 *
 * Registers one `settings.section` entry (`id: 'mcp-manager'`, order 30) that
 * renders the MCP server management page. Everything talks to the Host through
 * `/mcp-manager/api/*` only; the page never reads the profile patch itself.
 *
 * Framework facts this file relies on (verified against DSH 0.2.1-rc.2):
 *  - `window.__ModuleLoader__.load({ id, factory })`, factory returns
 *    `{ inject, apply }`.
 *  - `ctx.slots.inject(name, () => ctx.slots.register(options, Component))`
 *    registers into a slot declared by another plugin.
 *  - `options.locale` makes the framework bind `t` for the component.
 *  - `settings.section` owner props are `{ close }` only.
 *  - `ctx.locale.register(ns, { zh, en })` returns a disposer; `ctx.effect`
 *    owns it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-manager',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useCallback = React.useCallback

    const PLUGIN_ID = 'dsh-mcp-manager'
    const NS = 'mcpManager'
    const API_BASE = '/mcp-manager/api'
    const STYLE_ID = PLUGIN_ID + '/styles'
    const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
    const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
    const KEY_PATTERN = /^\S+$/

    /* ------------------------------------------------------------------ *
     * Copy (zh + en, identical key sets)
     * ------------------------------------------------------------------ */

    const en = {
      nav: 'MCP Servers',
      title: 'MCP servers',
      subtitle: 'Manage the MCP servers of this profile. Changes are written to the profile patch and applied hot.',
      totals: '{servers} servers · {enabled} enabled · {tools} tools',
      sourceDirHint: 'Local MCP server sources live wherever you keep them.',

      'toolbar.refresh': 'Refresh',
      'toolbar.add': 'Add',
      'toolbar.import': 'Import',
      'toolbar.export': 'Export',

      'state.loading': 'Loading MCP servers…',
      'state.errorTitle': 'Could not load MCP servers',

      'error.retry': 'Retry',
      'error.unreachable': 'The MCP manager service is unreachable. The plugin host route may not be loaded.',
      'error.routeMissing': 'The MCP manager API returned an unexpected (non-JSON) response.',
      'error.invalidResponse': 'The MCP manager API returned an unexpected response.',
      'error.unknown': 'Unexpected error.',
      'error.withDetail': '{base} ({detail})',
      'error.aborted': 'Request cancelled.',
      'error.unauthorized': 'The session is not authorized for the MCP manager. Reload the page.',
      'error.notManageable': 'This row is not inside the manager block.',
      'error.conflict': 'Conflict: that name or patch row is already in use.',
      'error.notFound': 'Not found.',
      'error.badRequest': 'Invalid request.',
      'error.patchInvalid': 'The profile patch file is invalid.',
      'error.writeFailed': 'Writing the profile patch failed; the change was rolled back.',
      'error.probeTimeout': 'The probe timed out.',
      'error.httpStatus': 'Request failed (HTTP {status}).',

      'empty.title': 'No MCP servers yet',
      'empty.desc': 'Add a server to expose its tools to the agent. MCP servers live in this profile’s cordis.patch.yml.',
      'empty.add': 'Add MCP server',
      'empty.import': 'Import mcpServers JSON',

      'diag.summary': '{count} configuration problems ({errors} errors, {warns} warnings)',
      'diag.expand': 'Show',
      'diag.collapse': 'Hide',
      'diag.patchBroken': 'The profile patch could not be parsed',
      'diag.patchPath': 'File: {path}',

      'badge.managed': 'managed',
      'badge.external': 'outer row',
      'badge.noPatch': 'read-only',
      'badge.disabled': 'disabled',

      'row.tools': '{count} tools',
      'row.phase': 'phase: {phase}',
      'phase.pending': 'pending',
      'phase.loading': 'loading',
      'phase.active': 'active',
      'phase.failed': 'failed',
      'phase.unloading': 'unloading',
      'phase.none': 'not loaded',

      'probe.never': 'last probe: never',
      'probe.running': 'probing…',
      'probe.lineOk': 'last probe: ok · {duration} · {tools} tools',
      'probe.lineFail': 'last probe: failed · {duration}',
      'probe.detailShow': 'Details',
      'probe.detailHide': 'Hide details',
      'probe.cancel': 'Cancel probe',
      'probe.protocol': 'Protocol',
      'probe.server': 'Server',
      'probe.duration': 'Duration',
      'probe.at': 'Probed at',
      'probe.toolsHeader': 'Tools ({count})',
      'probe.toolsEmpty': 'The server reported no tools.',
      'probe.errorHeader': 'Error detail',
      'probe.disabledHint': 'Probe unavailable: no patch row and secrets cannot be read',
      'probe.inlineUnavailable': 'Cannot probe this server: it has no patch row and its secrets are write-only.',

      'action.test': 'Test connection',
      'action.edit': 'Edit',
      'action.editDisabled': 'Read-only: this server has no patch row',
      'action.view': 'View',
      'action.delete': 'Delete',
      'action.deleteDisabled': 'This row has no profile patch row, so it cannot be deleted; disable it instead.',
      'action.enable': 'Enable',
      'action.disable': 'Disable',

      'dot.ok': 'Enabled, with tools',
      'dot.error': 'Enabled, last probe failed',
      'dot.off': 'Disabled',
      'dot.unknown': 'Enabled, not probed yet',

      'toast.toggleOn': 'Server enabled (hot-applied).',
      'toast.toggleOff': 'Server disabled (hot-applied).',
      'toast.togglePending': 'Saved. A host restart may be required.',
      'toast.toggleRestart': 'Saved. Restart required: {reason}',
      'toast.saved': 'Saved. The server is reconnecting.',
      'toast.migrated': 'Migrated {count} secret(s) to environment references.',
      'toast.migrateSkipped': 'Migrated {migrated} secret(s); {skipped} could not be expressed as env names.',
      'toast.added': 'Server added.',
      'toast.addPending': 'Server written; waiting for the hot apply to be observed.',
      'toast.deleted': 'Deleted {name}.',
      'toast.deletedWithBackup': 'Deleted {name} (backup: {backup}).',
      'toast.probeOk': 'Probe succeeded ({tools} tools).',
      'toast.probeFail': 'Probe failed.',
      'toast.probeCancelled': 'Probe cancelled.',
      'toast.exported': 'Exported the mcpServers JSON.',
      'toast.exportEmpty': 'There are no servers to export.',
      'toast.imported': 'Import finished.',
      'toast.dismiss': 'Dismiss',

      'confirm.deleteTitle': 'Delete MCP server',
      'confirm.deleteBodyManaged': 'Remove the server row “{name}” from the plugin manager block; applied hot. The patch is backed up first.',
      'confirm.deleteBodyHandwritten': 'Delete the hand-written row “{name}” from the profile patch (including same-id disabled/config override rows); applied hot. The patch is backed up first.',
      'confirm.deleteConsequences': 'This unloads the server and unregisters its tools.',
      'confirm.delete': 'Delete',
      'confirm.cancel': 'Cancel',
      'confirm.discardTitle': 'Discard changes?',
      'confirm.discardBody': 'This server form has unsaved changes.',
      'confirm.discard': 'Discard',
      'confirm.keepEditing': 'Keep editing',

      'form.addTitle': 'Add MCP server',
      'form.editTitle': 'Edit MCP server',
      'form.viewTitle': 'Server details',
      'form.extrasTitle': 'Advanced settings (read-only)',
      'form.subtitleAdd': 'New servers are written to the manager block of the profile patch.',
      'form.subtitleEdit': 'Saving reconnects {name}; its tools disappear briefly.',
      'form.copyLabel': 'Copy settings from',
      'form.copyPlaceholder': 'Start from scratch',
      'form.copyHint': 'Copies transport, command, args, cwd, url, headers and environment references. Plain-text secrets are never readable and must be re-entered.',
      'form.serverName': 'Server name',
      'form.serverNameHint': 'Must match ^[A-Za-z0-9_-]{1,32}$ and be unique. Tool names become mcp__<name>__*.',
      'form.serverNameLocked': 'Renaming requires deleting and recreating the server.',
      'form.patchRowHint': 'Patch row id: {patchId} — hand-written row; deleting it also removes same-id override rows.',
      'form.transport': 'Transport',
      'form.transport.stdio': 'stdio',
      'form.transport.http': 'Streamable HTTP',
      'form.command': 'Command',
      'form.commandPlaceholder': 'npx',
      'form.args': 'Arguments',
      'form.argsHint': 'One argument per line (a JSON string array is also accepted). Line breaks keep paths and flags intact.',
      'form.cwd': 'Working directory',
      'form.cwdHint': 'Optional. Inherits the host working directory when empty.',
      'form.url': 'URL',
      'form.urlPlaceholder': 'https://mcp.example.com/mcp',
      'form.env': 'Environment variables',
      'form.headers': 'HTTP headers',
      'form.envHint': 'Values are write-only: existing plain-text values are never sent back to the browser. Reference mode writes !!js process.env.NAME.',
      'form.headersHint': 'Values are write-only. Literal mode stores the header value in the profile patch.',
      'form.emptyKeys': 'None configured.',
      'form.addEnv': 'Add environment variable',
      'form.addHeader': 'Add header',
      'form.keyPlaceholder': 'NAME',
      'form.exprPlaceholder': 'process.env.NAME',
      'form.valuePlaceholder': 'value',
      'form.modeRef': 'Env reference',
      'form.modeLiteral': 'Literal',
      'form.modeKeep': 'Keep original',
      'form.keepRefHint': 'Keeps the stored expression.',
      'form.keepLiteralHint': 'Set (plain text, not readable) · migrating to an env reference is recommended.',
      'form.migrate': 'Migrate to reference',
      'form.migrateUnavailable': 'This name is not a valid env identifier; it cannot be migrated.',
      'form.removeKey': 'Remove',
      'form.timeout': 'Tool call timeout (ms)',
      'form.timeoutPlaceholder': '60000',
      'form.timeoutHint': 'Optional; the host default is 60000. An already-set timeout cannot be cleared, only changed.',
      'form.failOnStartup': 'Fail on startup error',
      'form.failOnStartup.inherit': 'Not set (host default)',
      'form.failOnStartup.on': 'true',
      'form.failOnStartup.off': 'false',
      'form.failOnStartupHint': 'Controls whether a startup failure marks the plugin fiber failed.',
      'form.reconnectNotice': 'Saving reconnects this server: its tools disappear briefly.',
      'form.save': 'Save',
      'form.saving': 'Saving…',
      'form.close': 'Close',
      'form.cancel': 'Cancel',
      'form.readOnlyHint': 'This row has no profile patch row, so it is read-only here.',
      'form.secretsWarning': '{count} plain-text secret(s) cannot be read back. Keep them unchanged or migrate them.',

      'validate.nameRequired': 'Name is required.',
      'validate.namePattern': 'Use 1–32 letters, digits, “_” or “-”.',
      'validate.nameTaken': 'Another MCP server already uses this name.',
      'validate.commandRequired': 'Command is required for stdio.',
      'validate.urlRequired': 'URL is required for Streamable HTTP.',
      'validate.timeout': 'Enter a positive integer (milliseconds).',
      'validate.timeoutRequired': 'This server has a timeout set; enter a value to keep or change it.',
      'validate.keyRequired': 'Name is required.',
      'validate.keyPattern': 'Use letters, digits and “_” (must not start with a digit).',
      'validate.keyDuplicate': 'Duplicate name.',
      'validate.exprRequired': 'Enter process.env.NAME or an expression.',
      'validate.literalRequired': 'Enter the value.',
      'validate.argsJson': 'Arguments look like a JSON array but could not be parsed.',

      'import.title': 'Import MCP servers',
      'import.desc': 'Paste a standard mcpServers JSON document or load a .json file. Existing names are skipped, never overwritten.',
      'import.placeholder': '{"mcpServers":{"my-server":{"type":"stdio","command":"npx","args":["-y","pkg"]}}}',
      'import.file': 'Load JSON file',
      'import.submit': 'Import',
      'import.submitting': 'Importing…',
      'import.invalidJson': 'That is not valid JSON.',
      'import.empty': 'No mcpServers entries were found.',
      'import.fileError': 'Could not read that file.',
      'import.result': 'Added {added} · skipped {skipped} · errors {errors}',
      'import.sectionAdded': 'Added',
      'import.sectionSkipped': 'Skipped',
      'import.sectionErrors': 'Errors',
      'import.sectionDropped': 'Unsupported fields dropped',
      'import.done': 'Done',
      'import.again': 'Import more',
      'import.dropHint': 'These fields from other agents are not supported by DSH and were dropped.',

      'export.busy': 'Exporting…',

      'a11y.close': 'Close',
      'a11y.dismiss': 'Dismiss',
      'a11y.expand': 'Expand',
      'a11y.collapse': 'Collapse',
    }

    const zh = {
      nav: 'MCP 服务器',
      title: 'MCP 服务器',
      subtitle: '管理本 profile 的 MCP 服务器。改动会写入 profile 补丁并热应用。',
      totals: '共 {servers} 台 · 已启用 {enabled} 台 · 工具 {tools} 个',
      sourceDirHint: '本机 MCP 服务器源码目录由使用者自行维护。',

      'toolbar.refresh': '刷新',
      'toolbar.add': '新增',
      'toolbar.import': '导入',
      'toolbar.export': '导出',

      'state.loading': '正在加载 MCP 服务器…',
      'state.errorTitle': '无法加载 MCP 服务器',

      'error.retry': '重试',
      'error.unreachable': '无法连接 MCP 管理服务：插件宿主路由可能尚未加载。',
      'error.routeMissing': 'MCP 管理接口返回了非 JSON 响应（路由不可用）。',
      'error.invalidResponse': 'MCP 管理接口返回了异常响应。',
      'error.unknown': '发生未知错误。',
      'error.withDetail': '{base}（{detail}）',
      'error.aborted': '请求已取消。',
      'error.unauthorized': '当前会话无权访问 MCP 管理接口，请重新加载页面。',
      'error.notManageable': '该行不在管理块内。',
      'error.conflict': '冲突：该名称或补丁行已被占用。',
      'error.notFound': '未找到。',
      'error.badRequest': '请求参数不合法。',
      'error.patchInvalid': 'profile 补丁文件解析失败。',
      'error.writeFailed': '写入 profile 补丁失败，改动已回滚。',
      'error.probeTimeout': '探测超时。',
      'error.httpStatus': '请求失败（HTTP {status}）。',

      'empty.title': '还没有 MCP 服务器',
      'empty.desc': '新增一台服务器，把它的工具暴露给 Agent。MCP 服务器位于本 profile 的 cordis.patch.yml。',
      'empty.add': '新增 MCP 服务器',
      'empty.import': '导入 mcpServers JSON',

      'diag.summary': '{count} 个配置问题（{errors} 个错误，{warns} 个警告）',
      'diag.expand': '展开',
      'diag.collapse': '收起',
      'diag.patchBroken': 'profile 补丁解析失败',
      'diag.patchPath': '文件：{path}',

      'badge.managed': '管理块',
      'badge.external': '补丁行',
      'badge.noPatch': '只读',
      'badge.disabled': '已停用',

      'row.tools': '工具 {count} 个',
      'row.phase': '相位：{phase}',
      'phase.pending': '等待加载',
      'phase.loading': '加载中',
      'phase.active': '已激活',
      'phase.failed': '加载失败',
      'phase.unloading': '卸载中',
      'phase.none': '未加载',

      'probe.never': '上次探测：未探测',
      'probe.running': '探测中…',
      'probe.lineOk': '上次探测：成功 · {duration} · 工具 {tools} 个',
      'probe.lineFail': '上次探测：失败 · {duration}',
      'probe.detailShow': '详情',
      'probe.detailHide': '收起详情',
      'probe.cancel': '取消探测',
      'probe.protocol': '协议版本',
      'probe.server': '服务器',
      'probe.duration': '耗时',
      'probe.at': '探测时间',
      'probe.toolsHeader': '工具清单（{count}）',
      'probe.toolsEmpty': '该服务器没有上报工具。',
      'probe.errorHeader': '错误详情',
      'probe.disabledHint': '不可探测：该行无补丁行，且密钥不可读取',
      'probe.inlineUnavailable': '无法探测该服务器：它没有 profile 补丁行，且密钥只写不读。',

      'action.test': '测试连接',
      'action.edit': '编辑',
      'action.editDisabled': '只读：该服务器没有 profile 补丁行',
      'action.view': '查看',
      'action.delete': '删除',
      'action.deleteDisabled': '该行没有 profile 补丁行，不可寻址；请使用停用。',
      'action.enable': '启用',
      'action.disable': '停用',

      'dot.ok': '已启用，且有工具',
      'dot.error': '已启用，但上次探测失败',
      'dot.off': '已停用',
      'dot.unknown': '已启用，尚未探测',

      'toast.toggleOn': '已启用（热生效）。',
      'toast.toggleOff': '已停用（热生效）。',
      'toast.togglePending': '已保存，可能需要重启宿主生效。',
      'toast.toggleRestart': '已保存，需要重启：{reason}',
      'toast.saved': '已保存，该服务器正在重连。',
      'toast.migrated': '已迁移 {count} 项密钥为环境变量引用。',
      'toast.migrateSkipped': '已迁移 {migrated} 项；{skipped} 项无法转换为环境变量名。',
      'toast.added': '服务器已新增。',
      'toast.addPending': '已写入，正在等待热应用被观察到。',
      'toast.deleted': '已删除 {name}。',
      'toast.deletedWithBackup': '已删除 {name}（备份：{backup}）。',
      'toast.probeOk': '探测成功（工具 {tools} 个）。',
      'toast.probeFail': '探测失败。',
      'toast.probeCancelled': '已取消探测。',
      'toast.exported': '已导出 mcpServers JSON。',
      'toast.exportEmpty': '没有可导出的服务器。',
      'toast.imported': '导入完成。',
      'toast.dismiss': '关闭提示',

      'confirm.deleteTitle': '删除 MCP 服务器',
      'confirm.deleteBodyManaged': '将从插件管理块中移除该服务器行「{name}」，热生效；删除前自动备份补丁。',
      'confirm.deleteBodyHandwritten': '将删除 profile 补丁里这行手写配置「{name}」（含同 id 的 disabled/config 覆盖行），热生效；删除前自动备份补丁。',
      'confirm.deleteConsequences': '该操作会卸载该服务器并注销其工具。',
      'confirm.delete': '删除',
      'confirm.cancel': '取消',
      'confirm.discardTitle': '放弃未保存的更改？',
      'confirm.discardBody': '该服务器表单有未保存的更改。',
      'confirm.discard': '放弃更改',
      'confirm.keepEditing': '继续编辑',

      'form.addTitle': '新增 MCP 服务器',
      'form.editTitle': '编辑 MCP 服务器',
      'form.viewTitle': '服务器详情',
      'form.extrasTitle': '高级设置（只读）',
      'form.subtitleAdd': '新服务器会写入 profile 补丁的管理块。',
      'form.subtitleEdit': '保存会重连 {name}，其工具会短暂消失。',
      'form.copyLabel': '复制现有配置',
      'form.copyPlaceholder': '从空白开始',
      'form.copyHint': '复制传输方式、命令、参数、工作目录、URL、headers 与环境变量引用。明文密钥不可读取，需要重新输入。',
      'form.serverName': '服务器名称',
      'form.serverNameHint': '需匹配 ^[A-Za-z0-9_-]{1,32}$ 且唯一。工具名将变为 mcp__<name>__*。',
      'form.serverNameLocked': '重命名需要先删除再重建该服务器。',
      'form.patchRowHint': '补丁行 id：{patchId}（手写行；删除时连同 id 的覆盖行一起清理）。',
      'form.transport': '传输方式',
      'form.transport.stdio': 'stdio',
      'form.transport.http': 'Streamable HTTP',
      'form.command': '命令',
      'form.commandPlaceholder': 'npx',
      'form.args': '参数',
      'form.argsHint': '一行一个参数（也接受 JSON 字符串数组）。用换行可保真路径与 --flag=value。',
      'form.cwd': '工作目录',
      'form.cwdHint': '可选。留空则继承宿主工作目录。',
      'form.url': 'URL',
      'form.urlPlaceholder': 'https://mcp.example.com/mcp',
      'form.env': '环境变量',
      'form.headers': 'HTTP headers',
      'form.envHint': '值只写不读：已有的明文值不会回传到浏览器。引用模式写入 !!js process.env.NAME。',
      'form.headersHint': '值只写不读。字面量模式会把 header 值写入 profile 补丁。',
      'form.emptyKeys': '未配置。',
      'form.addEnv': '新增环境变量',
      'form.addHeader': '新增 header',
      'form.keyPlaceholder': 'NAME',
      'form.exprPlaceholder': 'process.env.NAME',
      'form.valuePlaceholder': '值',
      'form.modeRef': '环境变量引用',
      'form.modeLiteral': '字面量',
      'form.modeKeep': '保持原值',
      'form.keepRefHint': '保持已存储的表达式不变。',
      'form.keepLiteralHint': '已设置（明文，不可读取）·建议迁移为环境变量引用。',
      'form.migrate': '迁移为引用',
      'form.migrateUnavailable': '该名称不是合法的环境变量名，无法迁移。',
      'form.removeKey': '移除',
      'form.timeout': '工具调用超时（毫秒）',
      'form.timeoutPlaceholder': '60000',
      'form.timeoutHint': '可选；宿主默认 60000。已设置的超时无法留空清除，只能改成别的值。',
      'form.failOnStartup': '启动失败即报错',
      'form.failOnStartup.inherit': '未设置（宿主默认）',
      'form.failOnStartup.on': 'true',
      'form.failOnStartup.off': 'false',
      'form.failOnStartupHint': '控制启动失败时是否把插件 fiber 标记为失败。',
      'form.reconnectNotice': '保存会重连该服务器，工具会短暂消失。',
      'form.save': '保存',
      'form.saving': '保存中…',
      'form.close': '关闭',
      'form.cancel': '取消',
      'form.readOnlyHint': '该行没有 profile 补丁行，因此在这里只读。',
      'form.secretsWarning': '{count} 个明文密钥不可读取，请保持原值或迁移为引用。',

      'validate.nameRequired': '名称必填。',
      'validate.namePattern': '仅允许 1–32 位字母、数字、“_”或“-”。',
      'validate.nameTaken': '已有同名 MCP 服务器。',
      'validate.commandRequired': 'stdio 传输必须填写命令。',
      'validate.urlRequired': 'Streamable HTTP 必须填写 URL。',
      'validate.timeout': '请输入正整数（毫秒）。',
      'validate.timeoutRequired': '该服务器已设置超时，请填写值以保留或修改。',
      'validate.keyRequired': '名称必填。',
      'validate.keyPattern': '仅允许字母、数字与“_”，且不能以数字开头。',
      'validate.keyDuplicate': '名称重复。',
      'validate.exprRequired': '请填写 process.env.NAME 或表达式。',
      'validate.literalRequired': '请填写值。',
      'validate.argsJson': '参数看起来是 JSON 数组，但解析失败。',

      'import.title': '导入 MCP 服务器',
      'import.desc': '粘贴标准 mcpServers JSON，或加载 .json 文件。已存在的名称会被跳过，绝不覆盖。',
      'import.placeholder': '{"mcpServers":{"my-server":{"type":"stdio","command":"npx","args":["-y","pkg"]}}}',
      'import.file': '加载 JSON 文件',
      'import.submit': '导入',
      'import.submitting': '导入中…',
      'import.invalidJson': '不是有效的 JSON。',
      'import.empty': '没有找到 mcpServers 条目。',
      'import.fileError': '无法读取该文件。',
      'import.result': '新增 {added} · 跳过 {skipped} · 失败 {errors}',
      'import.sectionAdded': '已新增',
      'import.sectionSkipped': '已跳过',
      'import.sectionErrors': '失败',
      'import.sectionDropped': '已丢弃不支持字段',
      'import.done': '完成',
      'import.again': '继续导入',
      'import.dropHint': '这些来自其他 agent 的字段 DSH 不支持，已被丢弃。',

      'export.busy': '导出中…',

      'a11y.close': '关闭',
      'a11y.dismiss': '关闭提示',
      'a11y.expand': '展开',
      'a11y.collapse': '收起',
    }

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    function translate(dict) {
      return function (key, vars) {
        const raw = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
        if (!vars) return raw
        return String(raw).replace(/\{(\w+)\}/g, function (match, name) {
          return vars[name] == null ? match : String(vars[name])
        })
      }
    }

    const fallbackT = translate(zh)

    function cx() {
      const out = []
      for (let i = 0; i < arguments.length; i++) {
        if (arguments[i]) out.push(arguments[i])
      }
      return out.join(' ')
    }

    function isObj(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value)
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function str(value) {
      return typeof value === 'string' ? value : value == null ? '' : String(value)
    }

    function trim(value) {
      return str(value).trim()
    }

    function numOr(value, fallback) {
      return typeof value === 'number' && isFinite(value) ? value : fallback
    }

    function clone(value) {
      return value == null ? value : JSON.parse(JSON.stringify(value))
    }

    function formatDuration(ms) {
      const value = Number(ms)
      if (!isFinite(value) || value < 0) return ''
      if (value < 1000) return Math.round(value) + 'ms'
      return (value / 1000).toFixed(value < 10000 ? 1 : 0) + 's'
    }

    function formatTime(at) {
      if (!at) return ''
      try {
        const date = new Date(at)
        if (isNaN(date.getTime())) return str(at)
        return date.toLocaleTimeString()
      } catch (error) {
        return str(at)
      }
    }

    function stamp() {
      try {
        return new Date().toISOString().replace(/[:.]/g, '-')
      } catch (error) {
        return String(Date.now())
      }
    }

    /** Last path segment of a host-side file path (Windows or POSIX separators). */
    function baseName(filePath) {
      const raw = str(filePath)
      if (!raw) return ''
      const parts = raw.split(/[\\/]+/).filter(function (part) {
        return part.length > 0
      })
      return parts.length ? parts[parts.length - 1] : ''
    }

    /* ------------------------------------------------------------------ *
     * HTTP (the page only ever talks to /mcp-manager/api)
     * ------------------------------------------------------------------ */

    function ApiError(code, message, status) {
      this.name = 'ApiError'
      this.code = code || 'unknown'
      this.message = message || this.code
      this.status = status
    }
    ApiError.prototype = Object.create(Error.prototype)
    ApiError.prototype.constructor = ApiError

    function isAbortError(error) {
      return !!error && (error.name === 'AbortError' || error.code === 'aborted' || error.code === 'cancelled')
    }

    async function apiRequest(path, options) {
      const opts = options || {}
      const method = opts.method || 'GET'
      const init = { method: method, credentials: 'same-origin', headers: {} }
      if (method !== 'GET' && method !== 'HEAD') {
        init.headers['content-type'] = 'application/json'
        if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
      }
      let controller = null
      let timer = null
      if (opts.signal) {
        init.signal = opts.signal
      } else if (opts.timeoutMs) {
        controller = typeof AbortController !== 'undefined' ? new AbortController() : null
        if (controller) {
          init.signal = controller.signal
          timer = setTimeout(function () {
            controller.abort()
          }, opts.timeoutMs)
        }
      }
      let response
      try {
        response = await fetch(API_BASE + path, init)
      } catch (error) {
        if (timer) clearTimeout(timer)
        if (isAbortError(error)) throw new ApiError('aborted', 'request aborted')
        throw new ApiError('unreachable', error && error.message ? error.message : 'network error')
      }
      if (timer) clearTimeout(timer)
      let contentType = ''
      try {
        contentType = response.headers && response.headers.get ? (response.headers.get('content-type') || '') : ''
      } catch (error) {
        contentType = ''
      }
      let payload = null
      let parsed = false
      let raw = ''
      if (contentType.indexOf('application/json') >= 0) {
        try {
          payload = await response.json()
          parsed = true
        } catch (error) {
          parsed = false
        }
      } else {
        try {
          raw = await response.text()
        } catch (error) {
          raw = ''
        }
        if (raw) {
          try {
            payload = JSON.parse(raw)
            parsed = true
          } catch (error) {
            parsed = false
          }
        }
      }
      if (!response.ok) {
        const errorObject = parsed && isObj(payload) && isObj(payload.error) ? payload.error : null
        const code = errorObject && errorObject.code ? str(errorObject.code) : 'http-' + response.status
        const message = errorObject && errorObject.message ? str(errorObject.message) : raw ? raw.slice(0, 400) : ''
        throw new ApiError(code, message, response.status)
      }
      if (!parsed || payload === null) {
        throw new ApiError(contentType.indexOf('application/json') >= 0 ? 'invalid-response' : 'route-missing')
      }
      return payload
    }

    const KNOWN_ERROR_KEYS = {
      'not-manageable': 'error.notManageable',
      conflict: 'error.conflict',
      'not-found': 'error.notFound',
      'bad-request': 'error.badRequest',
      'patch-invalid': 'error.patchInvalid',
      'write-failed': 'error.writeFailed',
      'probe-timeout': 'error.probeTimeout',
    }

    function describeError(t, error) {
      if (!error) return t('error.unknown')
      const code = error.code || 'unknown'
      if (code === 'unreachable') return t('error.unreachable')
      if (code === 'route-missing' || code === 'invalid-response') return t('error.routeMissing')
      if (code === 'aborted') return t('error.aborted')
      if (code === 'http-401' || code === 'http-403') return t('error.unauthorized')
      const baseKey = KNOWN_ERROR_KEYS[code]
      const detail = error.message && error.message !== code ? error.message : ''
      if (baseKey) {
        return detail ? t('error.withDetail', { base: t(baseKey), detail: detail }) : t(baseKey)
      }
      if (code.indexOf('http-') === 0) {
        const status = str(error.status || code.slice(5))
        return detail ? t('error.withDetail', { base: t('error.httpStatus', { status: status }), detail: detail }) : t('error.httpStatus', { status: status })
      }
      return detail || t('error.unknown')
    }

    /* ------------------------------------------------------------------ *
     * Response normalization (defensive: tolerate missing optional fields)
     * ------------------------------------------------------------------ */

    function normalizeEnvKeys(value) {
      const out = []
      asArray(value).forEach(function (item) {
        if (typeof item === 'string') {
          if (item) out.push({ key: item, isJsExpr: false, jsExpr: null })
          return
        }
        if (!isObj(item)) return
        const key = str(item.key)
        if (!key) return
        out.push({
          key: key,
          isJsExpr: item.isJsExpr === true,
          jsExpr: item.jsExpr != null ? str(item.jsExpr) : null,
        })
      })
      return out
    }

    function normalizeProbe(value) {
      if (!isObj(value)) return null
      const tools = []
      asArray(value.tools).forEach(function (tool) {
        if (typeof tool === 'string') {
          if (tool) tools.push({ name: tool, description: '' })
          return
        }
        if (!isObj(tool)) return
        const name = str(tool.name)
        if (name) tools.push({ name: name, description: str(tool.description) })
      })
      return {
        ok: value.ok === true,
        at: value.at != null ? str(value.at) : null,
        durationMs: typeof value.durationMs === 'number' ? value.durationMs : null,
        toolCount: typeof value.toolCount === 'number' ? value.toolCount : tools.length,
        tools: tools,
        protocolVersion: value.protocolVersion != null ? str(value.protocolVersion) : null,
        serverInfo: isObj(value.serverInfo)
          ? { name: str(value.serverInfo.name), version: str(value.serverInfo.version) }
          : null,
        error: value.error != null ? str(value.error) : null,
      }
    }

    function normalizeServer(input) {
      const source = isObj(input) ? input : {}
      const transport = source.transport === 'streamable-http' || source.transport === 'http' ? 'streamable-http' : 'stdio'
      const args = asArray(source.args).map(str)
      const command = str(source.command)
      const url = str(source.url)
      let target = str(source.target)
      if (!target) {
        target = transport === 'stdio' ? [command].concat(args).filter(Boolean).join(' ') : url
      }
      return {
        entryId: str(source.entryId),
        patchId: source.patchId == null ? null : str(source.patchId),
        serverName: str(source.serverName),
        transport: transport,
        target: target,
        command: command,
        args: args,
        cwd: str(source.cwd),
        url: url,
        envKeys: normalizeEnvKeys(source.envKeys),
        headerKeys: normalizeEnvKeys(source.headerKeys),
        toolCallTimeoutMs: typeof source.toolCallTimeoutMs === 'number' ? source.toolCallTimeoutMs : null,
        enabled: source.enabled !== false,
        fiberPhase: source.fiberPhase == null ? null : str(source.fiberPhase),
        toolCount: typeof source.toolCount === 'number' ? source.toolCount : 0,
        managed: source.managed === true,
        source: source.source === 'managed' || source.source === 'handwritten' ? source.source : null,
        lastProbe: normalizeProbe(source.lastProbe),
        failOnStartupError: typeof source.failOnStartupError === 'boolean' ? source.failOnStartupError : null,
        maxInstructionBytes: typeof source.maxInstructionBytes === 'number' ? source.maxInstructionBytes : null,
        reconnect: isObj(source.reconnect) ? source.reconnect : null,
      }
    }

    /** Physical deletion is only offered for rows created by the manager block. */
    function isManagedRow(row) {
      if (!row) return false
      if (row.source) return row.source === 'managed'
      return row.managed === true
    }

    function normalizeProblems(value) {
      const out = []
      asArray(value).forEach(function (item) {
        if (typeof item === 'string') {
          out.push({ level: 'warn', serverName: '', message: item })
          return
        }
        if (!isObj(item)) return
        const message = str(item.message)
        if (!message) return
        out.push({
          level: item.level === 'error' ? 'error' : 'warn',
          serverName: str(item.serverName),
          message: message,
        })
      })
      return out
    }

    function normalizePayload(raw) {
      const source = isObj(raw) ? raw : {}
      const servers = asArray(source.servers).map(normalizeServer)
      let totals = null
      if (isObj(source.totals)) {
        totals = {
          servers: numOr(source.totals.servers, servers.length),
          enabled: numOr(source.totals.enabled, servers.filter(function (s) { return s.enabled }).length),
          active: numOr(source.totals.active, 0),
          tools: numOr(source.totals.tools, servers.reduce(function (sum, s) { return sum + s.toolCount }, 0)),
        }
      }
      return {
        servers: servers,
        patch: isObj(source.patch)
          ? {
              path: str(source.patch.path),
              ok: source.patch.ok !== false,
              error: source.patch.error != null ? str(source.patch.error) : null,
            }
          : null,
        problems: normalizeProblems(source.problems),
        totals: totals,
      }
    }

    /* ------------------------------------------------------------------ *
     * Draft model for the editor
     * ------------------------------------------------------------------ */

    let rowSequence = 0
    function nextRowId() {
      rowSequence += 1
      return 'mw' + rowSequence
    }

    function keyRowFromKey(item, copying) {
      const key = str(item && item.key)
      if (item && item.isJsExpr) {
        const expr = str(item.jsExpr) || 'process.env.' + key
        return {
          rid: nextRowId(),
          key: key,
          mode: 'ref',
          value: expr,
          origin: 'js',
          originalExpr: expr,
          migrate: false,
        }
      }
      if (copying) {
        return {
          rid: nextRowId(),
          key: key,
          mode: 'literal',
          value: '',
          origin: 'literal',
          originalExpr: null,
          needsValue: true,
          migrate: false,
        }
      }
      return {
        rid: nextRowId(),
        key: key,
        mode: 'keep',
        value: '',
        origin: 'literal',
        originalExpr: null,
        migrate: false,
      }
    }

    function emptyDraft() {
      return {
        serverName: '',
        transport: 'stdio',
        command: '',
        argsText: '',
        cwd: '',
        url: '',
        env: [],
        headers: [],
        toolCallTimeoutMs: '',
        failOnStartupError: 'inherit',
      }
    }

    function draftFromRow(row, copying) {
      const draft = emptyDraft()
      if (!row) return draft
      draft.serverName = copying ? '' : row.serverName
      draft.transport = row.transport
      draft.command = str(row.command)
      draft.argsText = asArray(row.args).join('\n')
      draft.cwd = str(row.cwd)
      draft.url = str(row.url)
      draft.env = asArray(row.envKeys).map(function (item) {
        return keyRowFromKey(item, copying)
      })
      draft.headers = asArray(row.headerKeys).map(function (item) {
        return keyRowFromKey(item, copying)
      })
      draft.toolCallTimeoutMs = row.toolCallTimeoutMs == null ? '' : String(row.toolCallTimeoutMs)
      draft.failOnStartupError = row.failOnStartupError == null ? 'inherit' : String(row.failOnStartupError)
      return draft
    }

    function normalizeExpr(value, key) {
      const raw = trim(value)
      if (!raw) return 'process.env.' + key
      if (IDENTIFIER_PATTERN.test(raw)) return 'process.env.' + raw
      return raw
    }

    function serializeKeyRows(rows, allowKeep) {
      const out = {}
      let migrated = false
      asArray(rows).forEach(function (row) {
        const key = trim(row.key)
        if (!key) return
        if (row.mode === 'keep') {
          if (allowKeep) {
            /* Host contract: `__keep` preserves the inherited value for this key
             * (both `!!js` expressions and write-only literal secrets). */
            out[key] = { __keep: true }
          }
          return
        }
        if (row.mode === 'ref') {
          out[key] = { __jsExpr: normalizeExpr(row.value, key) }
          if (row.origin === 'literal' && row.migrate === true) migrated = true
          return
        }
        out[key] = str(row.value)
      })
      return { rows: out, migrated: migrated }
    }

    function countPlainSecrets(rows) {
      return asArray(rows).filter(function (row) {
        return row.origin === 'literal' && row.mode === 'keep'
      }).length
    }

    function validateKeyRows(rows, kind, errors) {
      const seen = {}
      asArray(rows).forEach(function (row) {
        const key = trim(row.key)
        const problems = []
        if (!key) problems.push('validate.keyRequired')
        else if (!KEY_PATTERN.test(key)) problems.push('validate.keyPattern')
        else if (seen[key]) problems.push('validate.keyDuplicate')
        if (key) seen[key] = true
        if (row.mode === 'ref' && !trim(row.value)) problems.push('validate.exprRequired')
        if (row.mode === 'literal' && !trim(row.value)) problems.push('validate.literalRequired')
        if (row.mode === 'literal' && row.needsValue && !trim(row.value)) {
          if (problems.indexOf('validate.literalRequired') < 0) problems.push('validate.literalRequired')
        }
        if (problems.length) {
          if (!errors[kind]) errors[kind] = {}
          errors[kind][row.rid] = problems[0]
        }
      })
    }

    function validateDraft(form, context) {
      const errors = {}
      const name = trim(form.serverName)
      if (!name) errors.serverName = 'validate.nameRequired'
      else if (!NAME_PATTERN.test(name)) errors.serverName = 'validate.namePattern'
      else if (context.mode !== 'edit') {
        const duplicate = asArray(context.servers).some(function (server) {
          return server.serverName === name
        })
        if (duplicate) errors.serverName = 'validate.nameTaken'
      }

      if (form.transport === 'stdio') {
        if (!trim(form.command)) errors.command = 'validate.commandRequired'
      } else if (!trim(form.url)) {
        errors.url = 'validate.urlRequired'
      }

      const timeoutText = trim(form.toolCallTimeoutMs)
      let timeout = null
      if (timeoutText) {
        if (!/^\d+$/.test(timeoutText) || Number(timeoutText) <= 0) errors.toolCallTimeoutMs = 'validate.timeout'
        else timeout = Number(timeoutText)
      } else if (context.mode === 'edit' && context.initialTimeout != null) {
        errors.toolCallTimeoutMs = 'validate.timeoutRequired'
      }

      const isEdit = context.mode === 'edit'
      const isStdio = form.transport === 'stdio'
      if (isStdio) validateKeyRows(form.env, 'env', errors)
      else validateKeyRows(form.headers, 'headers', errors)

      let args = []
      const argsText = trim(form.argsText)
      if (isStdio && argsText) {
        if (argsText.charAt(0) === '[') {
          try {
            const parsed = JSON.parse(argsText)
            if (!Array.isArray(parsed)) throw new Error('not an array')
            args = parsed.map(str)
          } catch (error) {
            errors.argsText = 'validate.argsJson'
          }
        } else {
          args = argsText
            .split(/\r?\n/)
            .map(function (line) { return line.trim() })
            .filter(function (line) { return line.length > 0 })
        }
      }

      const envChanged = context.envChanged === true
      const headersChanged = context.headersChanged === true

      if (Object.keys(errors).length) return { ok: false, errors: errors }

      const config = { transport: form.transport, serverName: name }
      if (isStdio) {
        config.command = trim(form.command)
        if (args.length) config.args = args
        else if (isEdit) config.args = []
        if (trim(form.cwd)) config.cwd = trim(form.cwd)
        else if (isEdit) config.cwd = ''
      } else {
        config.url = trim(form.url)
      }

      const envResult = serializeKeyRows(form.env, isEdit)
      const headerResult = serializeKeyRows(form.headers, isEdit)
      if (isStdio) {
        if (isEdit) {
          if (envChanged) config.env = envResult.rows
        } else if (Object.keys(envResult.rows).length) {
          config.env = envResult.rows
        }
      } else if (isEdit) {
        if (headersChanged) config.headers = headerResult.rows
      } else if (Object.keys(headerResult.rows).length) {
        config.headers = headerResult.rows
      }

      if (timeout != null) config.toolCallTimeoutMs = timeout
      if (form.failOnStartupError === 'true') config.failOnStartupError = true
      else if (form.failOnStartupError === 'false') config.failOnStartupError = false

      return {
        ok: true,
        payload: {
          serverName: name,
          config: config,
          migrateSecrets: envResult.migrated || headerResult.migrated,
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Inline SVG icons (no external assets)
     * ------------------------------------------------------------------ */

    function iconFrame(size, children) {
      return h(
        'svg',
        {
          width: size || 14,
          height: size || 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      )
    }

    function IconRefresh(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.5-3.6' }),
        h('path', { key: 'b', d: 'M13.4 3v3h-3' }),
      ])
    }

    function IconPlus(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M8 3.2v9.6' }),
        h('path', { key: 'b', d: 'M3.2 8h9.6' }),
      ])
    }

    function IconImport(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M8 10.5V2.8' }),
        h('path', { key: 'b', d: 'M4.8 6 8 2.8 11.2 6' }),
        h('path', { key: 'c', d: 'M2.8 13.2h10.4' }),
      ])
    }

    function IconExport(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M8 2.8v7.7' }),
        h('path', { key: 'b', d: 'M4.8 7.3 8 10.5 11.2 7.3' }),
        h('path', { key: 'c', d: 'M2.8 13.2h10.4' }),
      ])
    }

    function IconEdit(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M10.4 2.6 13.4 5.6 6.2 12.8 3 13 3.2 9.8z' }),
      ])
    }

    function IconTrash(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M2.8 4.4h10.4' }),
        h('path', { key: 'b', d: 'M6.2 4.4V2.8h3.6v1.6' }),
        h('path', { key: 'c', d: 'M4.2 4.6 4.7 13.2h6.6l.5-8.6' }),
      ])
    }

    function IconProbe(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M5.6 2.2v3.4' }),
        h('path', { key: 'b', d: 'M10.4 2.2v3.4' }),
        h('path', { key: 'c', d: 'M4.4 5.6h7.2v1.6a3.6 3.6 0 0 1-7.2 0z' }),
        h('path', { key: 'd', d: 'M8 10.8v3' }),
      ])
    }

    function IconClose(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M4 4l8 8' }),
        h('path', { key: 'b', d: 'M12 4l-8 8' }),
      ])
    }

    function IconChevron(props) {
      return iconFrame(props && props.size, [h('path', { key: 'a', d: 'M4 6.2 8 10.2l4-4' })])
    }

    function IconAlert(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M8 2.4 14.4 13.2H1.6z' }),
        h('path', { key: 'b', d: 'M8 6.4v3.4' }),
        h('path', { key: 'c', d: 'M8 11.6v.2' }),
      ])
    }

    function IconCheck(props) {
      return iconFrame(props && props.size, [h('path', { key: 'a', d: 'M2.8 8.4 6.2 11.8 13.2 4.6' })])
    }

    function IconInfo(props) {
      return iconFrame(props && props.size, [
        h('circle', { key: 'a', cx: 8, cy: 8, r: 6 }),
        h('path', { key: 'b', d: 'M8 7.2v4' }),
        h('path', { key: 'c', d: 'M8 4.9v.2' }),
      ])
    }

    function Spinner(props) {
      const size = (props && props.size) || 14
      return h('span', {
        className: 'mw-spinner',
        style: { width: size + 'px', height: size + 'px' },
        'aria-hidden': 'true',
      })
    }

    /* ------------------------------------------------------------------ *
     * Settings-nav glyph
     *
     * DSH's settings shell picks its nav glyph by section id and falls back to
     * the generic settings gear for ids it does not know
     * (`dsh-client-ui-settings-general`: `navIcon(id)`), and
     * `settings.section` exposes no `icon` option — so this page would render a
     * second gear right beside the Settings row's own gear. Until the harness
     * ships an icon option, this decorator swaps that fallback glyph for this
     * plugin's own artwork.
     *
     * Deliberately defensive: an unexpected panel shape leaves the shipped gear
     * untouched, a missing DOM keeps the plugin bootable, and the effect
     * disposer restores the original nodes. Delete it — together with
     * NAV_PANEL_SELECTOR / NAV_GLYPH_ATTR / NAV_GLYPH — once
     * `settings.section` accepts an icon.
     * ------------------------------------------------------------------ */

    const NAV_PANEL_SELECTOR = '[data-shortcut-modal="settings"]'
    const NAV_GLYPH_ATTR = 'data-' + PLUGIN_ID + '-nav-glyph'

    /* 两台"机架单元"：状态灯 + 槽位线，表达"已连接的 MCP 服务器"。 */
    const NAV_GLYPH = [
      ['rect', { x: 2.7, y: 2.7, width: 10.6, height: 4.3, rx: 1.5 }],
      ['path', { d: 'M4.9 4.85h0.01' }],
      ['path', { d: 'M7.4 4.85h3.7' }],
      ['rect', { x: 2.7, y: 9, width: 10.6, height: 4.3, rx: 1.5 }],
      ['path', { d: 'M4.9 11.15h0.01' }],
      ['path', { d: 'M7.4 11.15h3.7' }],
    ]

    function navGlyphElement(doc) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.3')      // == ICON_MEDIUM_STROKE
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('focusable', 'false')
      svg.setAttribute(NAV_GLYPH_ATTR, '1')
      NAV_GLYPH.forEach(function (spec) {
        const node = doc.createElementNS('http://www.w3.org/2000/svg', spec[0])
        Object.keys(spec[1]).forEach(function (name) {
          node.setAttribute(name, String(spec[1][name]))
        })
        svg.appendChild(node)
      })
      return svg
    }

    /**
     * Hide the fallback gear of this plugin's own settings-nav row and put our
     * glyph in its place. Returns how many rows are decorated; a row that is
     * already ours is only re-asserted when the shell re-rendered its gear, so
     * the mutation observer stays quiet.
     */
    function decorateNavRow(doc, labels) {
      const panel = doc.querySelector(NAV_PANEL_SELECTOR)
      if (!panel) return 0
      const rows = panel.querySelectorAll('nav button')
      let decorated = 0
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]
        const mine = row.querySelector('svg[' + NAV_GLYPH_ATTR + ']')
        // Shipped row: [svg gear, span label]. Decorated row: [our svg, svg
        // gear, span label] — React keeps its own gear node, we only hide it.
        let gear
        let label
        if (mine && row.children.length === 3) {
          gear = row.children[1]
          label = row.children[2]
        } else if (row.children.length === 2) {
          gear = row.children[0]
          label = row.children[1]
        } else {
          continue
        }
        if (String(gear.tagName).toLowerCase() !== 'svg') continue
        if (!mine && labels.indexOf(String(label.textContent).trim()) < 0) continue
        if (!mine) {
          const glyph = navGlyphElement(doc)
          glyph.setAttribute('class', gear.getAttribute('class') || '')
          row.insertBefore(glyph, gear)
          row.setAttribute(NAV_GLYPH_ATTR, '1')
        }
        if (gear.style.display !== 'none') gear.style.display = 'none'
        decorated += 1
      }
      return decorated
    }

    /**
     * Keep this plugin's nav glyph in place while the settings panel lives.
     * Returns a disposer that restores the shipped gear and removes our nodes.
     */
    function installNavGlyph(labels) {
      if (typeof document === 'undefined' || !document.body) return function () {}
      if (typeof MutationObserver === 'undefined') return function () {}
      if (typeof document.createElementNS !== 'function') return function () {}
      const doc = document
      const run = function () {
        try {
          decorateNavRow(doc, labels)
        } catch (error) {
          /* A presentation nicety must never break the settings shell. */
        }
      }
      run()
      const observer = new MutationObserver(run)
      // childList over the whole tree costs one attribute query per mutation
      // batch and is the only way to notice the portaled panel appearing.
      observer.observe(doc.body, { childList: true, subtree: true })
      return function dispose() {
        observer.disconnect()
        const marked = doc.querySelectorAll('[' + NAV_GLYPH_ATTR + ']')
        for (let i = 0; i < marked.length; i += 1) {
          const row = marked[i]
          if (String(row.tagName).toLowerCase() !== 'button') continue
          const glyph = row.querySelector('svg[' + NAV_GLYPH_ATTR + ']')
          if (glyph && glyph.parentNode) glyph.parentNode.removeChild(glyph)
          const gear = row.children[0]
          if (gear && gear.style && gear.style.display === 'none') gear.style.display = ''
          row.removeAttribute(NAV_GLYPH_ATTR)
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * Primitive controls (host theme variables only)
     * ------------------------------------------------------------------ */

    function Btn(props) {
      const icon = props.icon
      return h(
        'button',
        {
          type: 'button',
          className: cx(
            'mw-btn',
            props.variant === 'primary' && 'mw-btn-primary',
            props.variant === 'danger' && 'mw-btn-danger',
            props.variant === 'ghost' && 'mw-btn-ghost',
            props.size === 'sm' && 'mw-btn-sm',
            props.className,
          ),
          disabled: !!props.disabled,
          title: props.title,
          'aria-label': props['aria-label'],
          'aria-busy': props.busy ? 'true' : undefined,
          autoFocus: props.autoFocus === true ? true : undefined,
          onClick: props.onClick,
        },
        icon ? h(icon, { size: props.size === 'sm' ? 13 : 14 }) : null,
        props.children != null ? h('span', { className: 'mw-btn-label' }, props.children) : null,
        props.busy ? h(Spinner, { size: 13 }) : null,
      )
    }

    function IconButton(props) {
      const icon = props.icon
      return h(
        'button',
        {
          type: 'button',
          className: cx('mw-icon-btn', props.danger && 'mw-icon-btn-danger', props.className),
          disabled: !!props.disabled,
          title: props.title,
          'aria-label': props.label || props.title,
          onClick: props.onClick,
        },
        props.spinning ? h(Spinner, { size: 13 }) : icon ? h(icon, { size: 14 }) : null,
      )
    }

    function Field(props) {
      return h(
        'div',
        { className: cx('mw-field', props.className) },
        h(
          'div',
          { className: 'mw-field-head' },
          props.id
            ? h('label', { className: 'mw-label', htmlFor: props.id }, props.label)
            : h('span', { className: 'mw-label' }, props.label),
          props.aside || null,
        ),
        props.children,
        props.hint ? h('div', { className: 'mw-hint' }, props.hint) : null,
        props.error ? h('div', { className: 'mw-err', role: 'alert' }, props.error) : null,
      )
    }

    function TextInput(props) {
      return h('input', {
        id: props.id,
        className: cx('mw-input', props.invalid && 'mw-input-invalid', props.mono && 'mw-mono', props.className),
        type: props.type || 'text',
        value: props.value == null ? '' : props.value,
        placeholder: props.placeholder,
        disabled: !!props.disabled,
        readOnly: !!props.readOnly,
        spellCheck: false,
        autoComplete: 'off',
        inputMode: props.inputMode,
        'aria-invalid': props.invalid ? 'true' : undefined,
        onChange: props.onChange
          ? function (event) {
              props.onChange(event.target.value)
            }
          : undefined,
        onKeyDown: props.onKeyDown,
      })
    }

    function TextArea(props) {
      return h('textarea', {
        id: props.id,
        className: cx('mw-input', 'mw-textarea', props.invalid && 'mw-input-invalid', props.className),
        value: props.value == null ? '' : props.value,
        placeholder: props.placeholder,
        disabled: !!props.disabled,
        readOnly: !!props.readOnly,
        spellCheck: false,
        rows: props.rows || 4,
        'aria-invalid': props.invalid ? 'true' : undefined,
        onChange: props.onChange
          ? function (event) {
              props.onChange(event.target.value)
            }
          : undefined,
      })
    }

    function Select(props) {
      return h(
        'select',
        {
          id: props.id,
          className: cx('mw-input', 'mw-select', props.invalid && 'mw-input-invalid', props.className),
          value: props.value,
          disabled: !!props.disabled,
          'aria-invalid': props.invalid ? 'true' : undefined,
          onChange: props.onChange
            ? function (event) {
                props.onChange(event.target.value)
              }
            : undefined,
        },
        asArray(props.options).map(function (option) {
          return h('option', { key: option.value, value: option.value }, option.label)
        }),
      )
    }

    function Segmented(props) {
      return h(
        'div',
        { className: 'mw-seg', role: 'group', 'aria-label': props['aria-label'] },
        asArray(props.options).map(function (option) {
          const active = option.value === props.value
          return h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: cx('mw-seg-item', active && 'mw-seg-active'),
              'aria-pressed': active ? 'true' : 'false',
              disabled: !!props.disabled,
              onClick: function () {
                if (!active && props.onChange) props.onChange(option.value)
              },
            },
            option.label,
          )
        }),
      )
    }

    function Toggle(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: cx('mw-switch', props.checked && 'mw-switch-on'),
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          title: props.label,
          disabled: !!props.disabled,
          'aria-busy': props.busy ? 'true' : undefined,
          onClick: function () {
            if (props.disabled) return
            props.onChange(!props.checked)
          },
        },
        h('span', { className: 'mw-switch-knob', 'aria-hidden': 'true' }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Toasts
     * ------------------------------------------------------------------ */

    function Toasts(props) {
      const list = props.toasts || []
      if (!list.length) return null
      return h(
        'div',
        { className: 'mw-toasts', role: 'status', 'aria-live': 'polite' },
        list.map(function (item) {
          return h(
            'div',
            { key: item.id, className: cx('mw-toast', 'mw-toast-' + (item.tone || 'info')) },
            h(
              'span',
              { className: 'mw-toast-icon' },
              item.tone === 'success' ? h(IconCheck, { size: 13 }) : item.tone === 'error' ? h(IconAlert, { size: 13 }) : h(IconInfo, { size: 13 }),
            ),
            h('span', { className: 'mw-toast-text' }, item.text),
            props.onDismiss
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'mw-toast-close',
                    'aria-label': props.closeLabel || 'Dismiss',
                    title: props.closeLabel || 'Dismiss',
                    onClick: function () {
                      props.onDismiss(item.id)
                    },
                  },
                  h(IconClose, { size: 12 }),
                )
              : null,
          )
        }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Status / probe presentation
     * ------------------------------------------------------------------ */

    function rowStatus(row) {
      if (!row.enabled) return 'off'
      if (row.lastProbe && row.lastProbe.ok === false) return 'error'
      if (row.fiberPhase === 'failed') return 'error'
      if (row.toolCount > 0) return 'ok'
      if (row.lastProbe && row.lastProbe.ok === true) return 'ok'
      return 'unknown'
    }

    /** Stable per-row key: a patch row can exist before the loader composes its entry. */
    function rowKey(row) {
      if (!row) return ''
      return str(row.entryId) || str(row.patchId) || str(row.serverName)
    }

    function phaseLabel(t, phase) {
      switch (phase) {
        case 'pending':
          return t('phase.pending')
        case 'loading':
          return t('phase.loading')
        case 'active':
          return t('phase.active')
        case 'failed':
          return t('phase.failed')
        case 'unloading':
          return t('phase.unloading')
        default:
          return t('phase.none')
      }
    }

    function probeSummary(t, row) {
      const probe = row.lastProbe
      if (!probe) return t('probe.never')
      const duration = probe.durationMs == null ? '' : formatDuration(probe.durationMs)
      if (probe.ok) {
        return t('probe.lineOk', {
          duration: duration || '—',
          tools: probe.toolCount == null ? 0 : probe.toolCount,
        })
      }
      return t('probe.lineFail', { duration: duration || '—' })
    }

    function ProbeDetails(props) {
      const t = props.t
      const probe = props.probe
      if (!probe) return null
      const rows = []
      if (probe.protocolVersion) rows.push([t('probe.protocol'), probe.protocolVersion])
      if (probe.serverInfo && (probe.serverInfo.name || probe.serverInfo.version)) {
        rows.push([t('probe.server'), [probe.serverInfo.name, probe.serverInfo.version].filter(Boolean).join(' ')])
      }
      if (probe.durationMs != null) rows.push([t('probe.duration'), formatDuration(probe.durationMs)])
      if (probe.at) rows.push([t('probe.at'), formatTime(probe.at)])

      return h(
        'div',
        { className: 'mw-probe-detail' },
        rows.length
          ? h(
              'dl',
              { className: 'mw-kv-static-list' },
              rows.map(function (pair) {
                return h(
                  'div',
                  { key: pair[0], className: 'mw-kv-static-item' },
                  h('dt', null, pair[0]),
                  h('dd', null, pair[1]),
                )
              }),
            )
          : null,
        probe.error
          ? h(
              'div',
              { className: 'mw-probe-section' },
              h('div', { className: 'mw-probe-section-title' }, t('probe.errorHeader')),
              h('pre', { className: 'mw-pre' }, probe.error),
            )
          : null,
        probe.ok
          ? h(
              'div',
              { className: 'mw-probe-section' },
              h(
                'div',
                { className: 'mw-probe-section-title' },
                t('probe.toolsHeader', { count: probe.toolCount == null ? probe.tools.length : probe.toolCount }),
              ),
              asArray(probe.tools).length === 0
                ? h('div', { className: 'mw-hint' }, t('probe.toolsEmpty'))
                : h(
                    'ul',
                    { className: 'mw-tools' },
                    probe.tools.map(function (tool, index) {
                      return h(
                        'li',
                        { key: tool.name + ':' + index, className: 'mw-tool' },
                        h('code', { className: 'mw-tool-name' }, tool.name),
                        tool.description ? h('span', { className: 'mw-tool-desc' }, tool.description) : null,
                      )
                    }),
                  ),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * List row
     * ------------------------------------------------------------------ */

    function ServerRow(props) {
      const t = props.t
      const row = props.row
      const status = rowStatus(row)
      const probeState = props.probe || null
      const running = !!(probeState && probeState.running)
      const detailOpen = props.detailOpen === true
      const canEdit = !!row.patchId
      // Both manager-block and hand-written patch rows are deletable; only a row
      // with no patch id at all is unaddressable and falls back to "disable".
      const canDelete = !!row.patchId
      const canProbe = props.canProbe === true
      const key = props.rowKey || rowKey(row)

      const meta = []
      meta.push(t('row.tools', { count: row.toolCount }))
      meta.push(t('row.phase', { phase: phaseLabel(t, row.fiberPhase) }))
      meta.push(running ? t('probe.running') : probeSummary(t, row))

      const probeTitle = running ? t('probe.cancel') : canProbe ? t('action.test') : t('probe.disabledHint')

      return h(
        'div',
        { className: 'mw-row', 'data-status': status },
        h('span', { className: cx('mw-dot', 'mw-dot-' + status), title: t('dot.' + status) }),
        h(
          'div',
          { className: 'mw-row-main' },
          h(
            'div',
            { className: 'mw-row-title' },
            h('span', { className: 'mw-name', title: row.serverName }, row.serverName),
            isManagedRow(row) ? h('span', { className: 'mw-tag' }, t('badge.managed')) : null,
            !isManagedRow(row) && row.patchId ? h('span', { className: 'mw-tag mw-tag-muted' }, t('badge.external')) : null,
            !row.patchId ? h('span', { className: 'mw-tag mw-tag-muted' }, t('badge.noPatch')) : null,
            !row.enabled ? h('span', { className: 'mw-tag mw-tag-muted' }, t('badge.disabled')) : null,
          ),
          h(
            'div',
            { className: 'mw-row-meta mw-row-target', title: row.target },
            (row.transport === 'stdio' ? 'stdio' : 'streamable-http') + ' · ' + (row.target || '—'),
          ),
          h(
            'div',
            { className: 'mw-row-meta' },
            meta.map(function (part, index) {
              return h('span', { key: 'm' + index, className: 'mw-meta-part' }, index === 0 ? null : h('span', { className: 'mw-dot-sep' }, '·'), part)
            }),
          ),
          row.lastProbe
            ? h(
                'div',
                { className: 'mw-row-sub' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mw-link-btn',
                    onClick: function () {
                      props.onToggleDetail(key)
                    },
                    'aria-expanded': detailOpen ? 'true' : 'false',
                  },
                  detailOpen ? t('probe.detailHide') : t('probe.detailShow'),
                ),
              )
            : null,
          detailOpen && row.lastProbe ? h(ProbeDetails, { t: t, probe: row.lastProbe }) : null,
        ),
        h(
          'div',
          { className: 'mw-row-actions' },
          h(IconButton, {
            icon: running ? IconClose : IconProbe,
            spinning: false,
            danger: running,
            title: probeTitle,
            label: probeTitle,
            disabled: !running && (!canProbe || props.busyKind === 'toggle'),
            onClick: function () {
              if (running) props.onCancelProbe(row)
              else props.onProbe(row)
            },
          }),
          h(IconButton, {
            icon: IconEdit,
            title: canEdit ? t('action.edit') : t('action.view'),
            label: canEdit ? t('action.edit') : t('action.view'),
            disabled: !!props.busyKind || running,
            onClick: function () {
              if (canEdit) props.onEdit(row)
              else props.onView(row)
            },
          }),
          h(IconButton, {
            icon: IconTrash,
            danger: true,
            title: canDelete ? t('action.delete') : t('action.deleteDisabled'),
            label: canDelete ? t('action.delete') : t('action.deleteDisabled'),
            disabled: !canDelete || !!props.busyKind || running,
            onClick: function () {
              if (canDelete) props.onDelete(row)
            },
          }),
          h(Toggle, {
            checked: row.enabled,
            busy: props.busyKind === 'toggle',
            disabled: !row.entryId || (!!props.busyKind && props.busyKind !== 'toggle'),
            label: row.enabled ? t('action.disable') : t('action.enable'),
            onChange: function (next) {
              props.onToggle(row, next)
            },
          }),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Banners / empty / loading
     * ------------------------------------------------------------------ */

    function PatchBanner(props) {
      const t = props.t
      const patch = props.patch
      if (!patch || patch.ok !== false) return null
      return h(
        'div',
        { className: 'mw-banner mw-banner-error', role: 'alert' },
        h('span', { className: 'mw-banner-icon' }, h(IconAlert, { size: 14 })),
        h(
          'div',
          { className: 'mw-banner-body' },
          h('div', { className: 'mw-banner-title' }, t('diag.patchBroken')),
          patch.path ? h('div', { className: 'mw-hint' }, t('diag.patchPath', { path: patch.path })) : null,
          patch.error ? h('pre', { className: 'mw-pre' }, patch.error) : null,
        ),
      )
    }

    function DiagBar(props) {
      const t = props.t
      const problems = props.problems || []
      if (!problems.length) return null
      const errors = problems.filter(function (problem) { return problem.level === 'error' }).length
      const warns = problems.length - errors
      return h(
        'div',
        { className: cx('mw-banner', 'mw-banner-warn', 'mw-diag') },
        h('span', { className: 'mw-banner-icon' }, h(IconAlert, { size: 14 })),
        h(
          'div',
          { className: 'mw-banner-body' },
          h(
            'div',
            { className: 'mw-diag-head' },
            h('span', null, t('diag.summary', { count: problems.length, errors: errors, warns: warns })),
            h(
              'button',
              {
                type: 'button',
                className: 'mw-link-btn',
                'aria-expanded': props.open ? 'true' : 'false',
                onClick: props.onToggle,
              },
              props.open ? t('diag.collapse') : t('diag.expand'),
            ),
          ),
          props.open
            ? h(
                'ul',
                { className: 'mw-diag-list' },
                problems.map(function (problem, index) {
                  return h(
                    'li',
                    { key: 'p' + index, className: 'mw-diag-item' },
                    h(
                      'span',
                      { className: cx('mw-diag-level', problem.level === 'error' && 'mw-diag-level-error'), 'aria-hidden': 'true' },
                      problem.level === 'error' ? '●' : '○',
                    ),
                    problem.serverName ? h('code', { className: 'mw-code' }, problem.serverName) : null,
                    h('span', null, problem.message),
                  )
                }),
              )
            : null,
        ),
      )
    }

    function ErrorBanner(props) {
      const t = props.t
      return h(
        'div',
        { className: cx('mw-banner', 'mw-banner-error', props.compact && 'mw-banner-compact'), role: 'alert' },
        h('span', { className: 'mw-banner-icon' }, h(IconAlert, { size: 14 })),
        h(
          'div',
          { className: 'mw-banner-body' },
          props.title ? h('div', { className: 'mw-banner-title' }, props.title) : null,
          h('div', { className: 'mw-banner-text' }, describeError(t, props.error)),
        ),
        props.onRetry
          ? h(
              Btn,
              {
                size: 'sm',
                onClick: props.onRetry,
                disabled: props.retrying,
                children: t('error.retry'),
              },
            )
          : null,
      )
    }

    function LoadingState(props) {
      const rows = []
      for (let i = 0; i < 4; i++) rows.push(h('div', { key: 's' + i, className: 'mw-skeleton-row' }))
      return h(
        'div',
        { className: 'mw-loading', 'aria-busy': 'true' },
        h('div', { className: 'mw-loading-text' }, h(Spinner, { size: 13 }), h('span', null, props.t('state.loading'))),
        rows,
      )
    }

    function ErrorState(props) {
      const t = props.t
      return h(
        'div',
        { className: 'mw-empty mw-empty-error', role: 'alert' },
        h('div', { className: 'mw-empty-icon' }, h(IconAlert, { size: 22 })),
        h('div', { className: 'mw-empty-title' }, t('state.errorTitle')),
        h('div', { className: 'mw-empty-desc' }, describeError(t, props.error)),
        h(
          'div',
          { className: 'mw-empty-actions' },
          h(Btn, { variant: 'primary', icon: IconRefresh, onClick: props.onRetry, children: t('error.retry') }),
        ),
      )
    }

    function EmptyState(props) {
      const t = props.t
      return h(
        'div',
        { className: 'mw-empty' },
        h('div', { className: 'mw-empty-title' }, t('empty.title')),
        h('div', { className: 'mw-empty-desc' }, t('empty.desc')),
        h(
          'div',
          { className: 'mw-empty-actions' },
          h(Btn, { variant: 'primary', icon: IconPlus, onClick: props.onAdd, children: t('empty.add') }),
          h(Btn, { icon: IconImport, onClick: props.onImport, children: t('empty.import') }),
        ),
        h('div', { className: 'mw-empty-hint' }, t('sourceDirHint')),
      )
    }

    /* ------------------------------------------------------------------ *
     * Key/value editor (env & headers)
     * ------------------------------------------------------------------ */

    function KeyValuesEditor(props) {
      const t = props.t
      const kind = props.kind
      const rows = props.rows || []
      const rowErrors = (props.errors && props.errors[kind]) || {}
      const allowKeep = props.allowKeep === true
      const disabled = props.disabled === true

      function modeOptions(row) {
        const options = [
          { value: 'ref', label: t('form.modeRef') },
          { value: 'literal', label: t('form.modeLiteral') },
        ]
        if (allowKeep && row.origin !== 'new') options.push({ value: 'keep', label: t('form.modeKeep') })
        return options
      }

      return h(
        'div',
        { className: 'mw-kv' },
        rows.length === 0 ? h('div', { className: 'mw-hint' }, t('form.emptyKeys')) : null,
        rows.map(function (row) {
          const error = rowErrors[row.rid]
          const invalid = !!error
          const keepLiteral = row.mode === 'keep' && row.origin === 'literal'
          return h(
            'div',
            { key: row.rid, className: cx('mw-kv-block', invalid && 'mw-kv-invalid') },
            h(
              'div',
              { className: 'mw-kv-row' },
              h(TextInput, {
                className: 'mw-kv-key',
                value: row.key,
                placeholder: t('form.keyPlaceholder'),
                mono: true,
                invalid: error === 'validate.keyRequired' || error === 'validate.keyPattern' || error === 'validate.keyDuplicate',
                disabled: disabled,
                onChange: function (value) {
                  props.onChangeRow(row.rid, { key: value })
                },
              }),
              h(Select, {
                className: 'mw-kv-mode',
                value: row.mode,
                options: modeOptions(row),
                disabled: disabled,
                onChange: function (value) {
                  props.onChangeRow(row.rid, { mode: value })
                },
              }),
              row.mode === 'keep'
                ? h(
                    'div',
                    { className: 'mw-kv-static' },
                    keepLiteral
                      ? h(
                          'span',
                          { className: 'mw-kv-static-text' },
                          h('span', { className: 'mw-hint' }, t('form.keepLiteralHint')),
                          IDENTIFIER_PATTERN.test(trim(row.key))
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'mw-link-btn',
                                  disabled: disabled,
                                  onClick: function () {
                                    props.onChangeRow(row.rid, {
                                      mode: 'ref',
                                      value: 'process.env.' + trim(row.key),
                                      migrate: true,
                                    })
                                  },
                                },
                                t('form.migrate'),
                              )
                            : h('span', { className: 'mw-hint' }, t('form.migrateUnavailable')),
                        )
                      : h('code', { className: 'mw-code mw-kv-static-text' }, row.originalExpr || ''),
                  )
                : h(TextInput, {
                    value: row.value,
                    placeholder: row.mode === 'ref' ? t('form.exprPlaceholder') : t('form.valuePlaceholder'),
                    mono: true,
                    invalid: invalid && error !== 'validate.keyRequired',
                    disabled: disabled,
                    onChange: function (value) {
                      props.onChangeRow(row.rid, { value: value, migrate: false })
                    },
                  }),
              h(IconButton, {
                icon: IconClose,
                className: 'mw-kv-remove',
                title: t('form.removeKey'),
                label: t('form.removeKey'),
                disabled: disabled,
                onClick: function () {
                  props.onRemoveRow(row.rid)
                },
              }),
            ),
            error ? h('div', { className: 'mw-err mw-kv-err', role: 'alert' }, t(error)) : null,
          )
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'mw-link-btn mw-add-key',
            disabled: disabled,
            onClick: props.onAddRow,
          },
          h(IconPlus, { size: 12 }),
          h('span', null, t(kind === 'env' ? 'form.addEnv' : 'form.addHeader')),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Drawer / modal shells
     * ------------------------------------------------------------------ */

    function useEscape(enabled, handler) {
      useEffect(
        function () {
          if (!enabled) return undefined
          if (typeof document === 'undefined') return undefined
          function onKeyDown(event) {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            handler()
          }
          document.addEventListener('keydown', onKeyDown, true)
          return function () {
            document.removeEventListener('keydown', onKeyDown, true)
          }
        },
        [enabled, handler],
      )
    }

    function Drawer(props) {
      const t = props.t
      useEscape(!props.busy && !props.escapeBlocked, props.onRequestClose)
      return h(
        'div',
        {
          className: 'mw-overlay',
          role: 'presentation',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget && !props.busy) props.onRequestClose()
          },
        },
        h(
          'aside',
          {
            className: 'mw-drawer',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': props.title,
            onMouseDown: function (event) {
              event.stopPropagation()
            },
          },
          h(
            'header',
            { className: 'mw-drawer-head' },
            h(
              'div',
              { className: 'mw-drawer-head-text' },
              h('h3', { className: 'mw-drawer-title' }, props.title),
              props.subtitle ? h('div', { className: 'mw-hint' }, props.subtitle) : null,
            ),
            h(IconButton, {
              icon: IconClose,
              title: t('a11y.close'),
              label: t('a11y.close'),
              disabled: !!props.busy,
              onClick: props.onRequestClose,
            }),
          ),
          h('div', { className: 'mw-drawer-body' }, props.children),
        ),
      )
    }

    function Modal(props) {
      const t = props.t
      useEscape(!props.busy, props.onCancel)
      return h(
        'div',
        {
          className: 'mw-overlay mw-overlay-center',
          role: 'presentation',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget && !props.busy) props.onCancel()
          },
        },
        h(
          'div',
          { className: cx('mw-modal', props.wide && 'mw-modal-wide'), role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
          h(
            'div',
            { className: 'mw-modal-head' },
            h('h3', { className: 'mw-modal-title' }, props.title),
            h(IconButton, {
              icon: IconClose,
              title: t('a11y.close'),
              label: t('a11y.close'),
              disabled: !!props.busy,
              onClick: props.onCancel,
            }),
          ),
          h('div', { className: 'mw-modal-body' }, props.children),
          props.footer ? h('div', { className: 'mw-modal-foot' }, props.footer) : null,
        ),
      )
    }

    function ConfirmDialog(props) {
      const t = props.t
      return h(Modal, {
        t: t,
        title: props.title,
        busy: props.busy,
        onCancel: props.onCancel,
        footer: [
          // Safe default: a destructive confirmation opens focused on Cancel.
          h(Btn, {
            key: 'cancel',
            autoFocus: true,
            onClick: props.onCancel,
            disabled: props.busy,
            children: props.cancelLabel || t('confirm.cancel'),
          }),
          h(Btn, {
            key: 'confirm',
            variant: props.danger ? 'danger' : 'primary',
            busy: props.busy,
            disabled: props.busy,
            onClick: props.onConfirm,
            children: props.confirmLabel || t('confirm.delete'),
          }),
        ],
        children: h('div', { className: 'mw-modal-text' }, props.body),
      })
    }

    /* ------------------------------------------------------------------ *
     * Server form (add / edit / view)
     * ------------------------------------------------------------------ */

    function ServerFormDrawer(props) {
      const t = props.t
      const mode = props.mode
      const readOnly = mode === 'view'
      const isEdit = mode === 'edit'
      const [form, setForm] = useState(function () {
        return clone(props.initial)
      })
      const [errors, setErrors] = useState({})
      const [copyId, setCopyId] = useState('')
      const initialJson = useMemo(function () {
        return JSON.stringify(props.initial)
      }, [props.initial])
      const formJson = JSON.stringify(form)
      const dirty = formJson !== initialJson

      useEffect(
        function () {
          if (props.onDirtyChange) props.onDirtyChange(dirty)
        },
        [dirty],
      )

      function updateField(key, value) {
        setForm(function (previous) {
          const next = Object.assign({}, previous)
          next[key] = value
          return next
        })
        setErrors(function (previous) {
          if (!previous[key]) return previous
          const next = Object.assign({}, previous)
          delete next[key]
          return next
        })
      }

      function updateRows(kind, rows) {
        updateField(kind, rows)
        setErrors(function (previous) {
          if (!previous[kind]) return previous
          const next = Object.assign({}, previous)
          delete next[kind]
          return next
        })
      }

      function changeRow(kind, rid, patch) {
        const rows = asArray(form[kind]).map(function (row) {
          return row.rid === rid ? Object.assign({}, row, patch) : row
        })
        updateRows(kind, rows)
      }

      function addRow(kind) {
        const rows = asArray(form[kind]).concat([
          { rid: nextRowId(), key: '', mode: 'ref', value: '', origin: 'new', migrate: false },
        ])
        updateRows(kind, rows)
      }

      function removeRow(kind, rid) {
        updateRows(
          kind,
          asArray(form[kind]).filter(function (row) {
            return row.rid !== rid
          }),
        )
      }

      function applyCopy(id) {
        setCopyId(id)
        if (!id) {
          setForm(clone(emptyDraft()))
          setErrors({})
          return
        }
        const source = asArray(props.servers).filter(function (server) {
          return server.entryId === id || server.serverName === id
        })[0]
        if (!source) return
        setForm(draftFromRow(source, true))
        setErrors({})
      }

      function submit() {
        if (readOnly) return
        const initialRow = props.row || null
        const result = validateDraft(form, {
          mode: mode,
          servers: props.servers,
          initialTimeout: isEdit && initialRow ? initialRow.toolCallTimeoutMs : null,
          envChanged: isEdit && JSON.stringify(form.env) !== JSON.stringify(props.initial.env),
          headersChanged: isEdit && JSON.stringify(form.headers) !== JSON.stringify(props.initial.headers),
        })
        if (!result.ok) {
          setErrors(result.errors)
          return
        }
        setErrors({})
        props.onSubmit(result.payload)
      }

      const plainSecrets = countPlainSecrets(form.transport === 'stdio' ? form.env : form.headers)
      const extras = []
      if (isEdit && props.row) {
        if (props.row.maxInstructionBytes != null) extras.push('maxInstructionBytes: ' + props.row.maxInstructionBytes)
        if (props.row.reconnect) extras.push('reconnect: ' + JSON.stringify(props.row.reconnect))
      }
      const copyOptions = [{ value: '', label: t('form.copyPlaceholder') }].concat(
        asArray(props.servers).map(function (server) {
          return {
            value: server.entryId || server.serverName,
            label: server.serverName + ' · ' + (server.transport === 'stdio' ? 'stdio' : 'http'),
          }
        }),
      )

      return h(
        Drawer,
        {
          t: t,
          title: isEdit ? t('form.editTitle') : readOnly ? t('form.viewTitle') : t('form.addTitle'),
          subtitle: isEdit && props.row ? t('form.subtitleEdit', { name: props.row.serverName }) : readOnly ? null : t('form.subtitleAdd'),
          busy: !!props.busy,
          escapeBlocked: !!props.escapeBlocked,
          onRequestClose: props.onRequestClose,
        },
        h(
          'div',
          { className: 'mw-form' },
          props.error ? h(ErrorBanner, { t: t, error: props.error, compact: true }) : null,
          readOnly ? h('div', { className: 'mw-banner mw-banner-info' }, h('span', { className: 'mw-banner-icon' }, h(IconInfo, { size: 14 })), h('span', null, t('form.readOnlyHint'))) : null,
          isEdit && props.row && props.row.patchId && !isManagedRow(props.row)
            ? h('div', { className: 'mw-hint' }, t('form.patchRowHint', { patchId: props.row.patchId }))
            : null,
          plainSecrets > 0
            ? h('div', { className: 'mw-banner mw-banner-warn' }, h('span', { className: 'mw-banner-icon' }, h(IconAlert, { size: 14 })), h('span', null, t('form.secretsWarning', { count: plainSecrets })))
            : null,

          !isEdit && !readOnly
            ? h(
                Field,
                {
                  label: t('form.copyLabel'),
                  hint: t('form.copyHint'),
                },
                h(Select, {
                  value: copyId,
                  options: copyOptions,
                  onChange: applyCopy,
                }),
              )
            : null,

          h(
            Field,
            {
              id: 'mw-server-name',
              label: t('form.serverName'),
              hint: isEdit ? t('form.serverNameLocked') : t('form.serverNameHint'),
              error: errors.serverName ? t(errors.serverName) : null,
            },
            h(TextInput, {
              id: 'mw-server-name',
              value: form.serverName,
              placeholder: 'my-server',
              mono: true,
              invalid: !!errors.serverName,
              disabled: isEdit || readOnly,
              onChange: function (value) {
                updateField('serverName', value)
              },
            }),
          ),

          h(
            Field,
            { label: t('form.transport') },
            h(Segmented, {
              value: form.transport,
              disabled: readOnly,
              'aria-label': t('form.transport'),
              options: [
                { value: 'stdio', label: t('form.transport.stdio') },
                { value: 'streamable-http', label: t('form.transport.http') },
              ],
              onChange: function (value) {
                updateField('transport', value)
              },
            }),
          ),

          form.transport === 'stdio'
            ? [
                h(
                  Field,
                  { key: 'command', id: 'mw-command', label: t('form.command'), error: errors.command ? t(errors.command) : null },
                  h(TextInput, {
                    id: 'mw-command',
                    value: form.command,
                    placeholder: t('form.commandPlaceholder'),
                    mono: true,
                    invalid: !!errors.command,
                    disabled: readOnly,
                    onChange: function (value) {
                      updateField('command', value)
                    },
                  }),
                ),
                h(
                  Field,
                  { key: 'args', id: 'mw-args', label: t('form.args'), hint: t('form.argsHint'), error: errors.argsText ? t(errors.argsText) : null },
                  h(TextArea, {
                    id: 'mw-args',
                    value: form.argsText,
                    rows: 4,
                    placeholder: '-y\n@modelcontextprotocol/server-filesystem',
                    invalid: !!errors.argsText,
                    disabled: readOnly,
                    onChange: function (value) {
                      updateField('argsText', value)
                    },
                  }),
                ),
                h(
                  Field,
                  { key: 'cwd', id: 'mw-cwd', label: t('form.cwd'), hint: t('form.cwdHint') },
                  h(TextInput, {
                    id: 'mw-cwd',
                    value: form.cwd,
                    mono: true,
                    placeholder: '%USERPROFILE%\\mcp-servers\\my-server',
                    disabled: readOnly,
                    onChange: function (value) {
                      updateField('cwd', value)
                    },
                  }),
                ),
              ]
            : [
                h(
                  Field,
                  { key: 'url', id: 'mw-url', label: t('form.url'), error: errors.url ? t(errors.url) : null },
                  h(TextInput, {
                    id: 'mw-url',
                    value: form.url,
                    mono: true,
                    placeholder: t('form.urlPlaceholder'),
                    invalid: !!errors.url,
                    disabled: readOnly,
                    onChange: function (value) {
                      updateField('url', value)
                    },
                  }),
                ),
              ],

          form.transport === 'stdio'
            ? h(
                Field,
                { label: t('form.env'), hint: t('form.envHint') },
                h(KeyValuesEditor, {
                  t: t,
                  kind: 'env',
                  rows: form.env,
                  errors: errors,
                  allowKeep: isEdit,
                  disabled: readOnly,
                  onChangeRow: function (rid, patch) {
                    changeRow('env', rid, patch)
                  },
                  onAddRow: function () {
                    addRow('env')
                  },
                  onRemoveRow: function (rid) {
                    removeRow('env', rid)
                  },
                }),
              )
            : null,

          form.transport === 'streamable-http'
            ? h(
                Field,
                { label: t('form.headers'), hint: t('form.headersHint') },
                h(KeyValuesEditor, {
                  t: t,
                  kind: 'headers',
                  rows: form.headers,
                  errors: errors,
                  allowKeep: isEdit,
                  disabled: readOnly,
                  onChangeRow: function (rid, patch) {
                    changeRow('headers', rid, patch)
                  },
                  onAddRow: function () {
                    addRow('headers')
                  },
                  onRemoveRow: function (rid) {
                    removeRow('headers', rid)
                  },
                }),
              )
            : null,

          h(
            Field,
            {
              id: 'mw-timeout',
              label: t('form.timeout'),
              hint: t('form.timeoutHint'),
              error: errors.toolCallTimeoutMs ? t(errors.toolCallTimeoutMs) : null,
            },
            h(TextInput, {
              id: 'mw-timeout',
              type: 'number',
              inputMode: 'numeric',
              value: form.toolCallTimeoutMs,
              placeholder: t('form.timeoutPlaceholder'),
              mono: true,
              invalid: !!errors.toolCallTimeoutMs,
              disabled: readOnly,
              onChange: function (value) {
                updateField('toolCallTimeoutMs', value)
              },
            }),
          ),

          h(
            Field,
            { label: t('form.failOnStartup'), hint: t('form.failOnStartupHint') },
            h(Select, {
              value: form.failOnStartupError,
              disabled: readOnly,
              options: [
                { value: 'inherit', label: t('form.failOnStartup.inherit') },
                { value: 'true', label: t('form.failOnStartup.on') },
                { value: 'false', label: t('form.failOnStartup.off') },
              ],
              onChange: function (value) {
                updateField('failOnStartupError', value)
              },
            }),
          ),

          extras.length
            ? h(Field, { label: t('form.extrasTitle') }, h('pre', { className: 'mw-pre' }, extras.join('\n')))
            : null,

          h(
            'div',
            { className: 'mw-form-foot' },
            h('div', { className: 'mw-hint mw-form-foot-hint' }, readOnly ? t('form.readOnlyHint') : t('form.reconnectNotice')),
            h(
              'div',
              { className: 'mw-form-foot-actions' },
              h(Btn, {
                key: 'cancel',
                onClick: props.onRequestClose,
                disabled: !!props.busy,
                children: readOnly ? t('form.close') : t('form.cancel'),
              }),
              readOnly
                ? null
                : h(Btn, {
                    key: 'save',
                    variant: 'primary',
                    busy: !!props.busy,
                    disabled: !!props.busy,
                    onClick: submit,
                    children: props.busy ? t('form.saving') : t('form.save'),
                  }),
            ),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Import dialog
     * ------------------------------------------------------------------ */

    function normalizeDropped(value) {
      const out = []
      if (Array.isArray(value)) {
        value.forEach(function (item) {
          if (typeof item === 'string') {
            out.push({ serverName: '', fields: [item] })
            return
          }
          if (!isObj(item)) return
          const serverName = str(item.serverName || item.name)
          const fields = asArray(item.fields || item.dropped || item.droppedFields).map(str)
          if (serverName || fields.length) out.push({ serverName: serverName, fields: fields })
        })
        return out
      }
      if (isObj(value)) {
        Object.keys(value).forEach(function (key) {
          const fields = asArray(value[key]).map(str)
          out.push({ serverName: key, fields: fields })
        })
      }
      return out
    }

    function ImportDialog(props) {
      const t = props.t
      const [text, setText] = useState('')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [fileName, setFileName] = useState('')

      function readFile(file) {
        if (!file) return
        setFileName(file.name)
        setError(null)
        try {
          const reader = new FileReader()
          reader.onload = function () {
            setText(str(reader.result))
          }
          reader.onerror = function () {
            setError('import.fileError')
          }
          reader.readAsText(file)
        } catch (readerError) {
          setError('import.fileError')
        }
      }

      function submit() {
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch (parseError) {
          setError('import.invalidJson')
          return
        }
        let mcpServers = null
        if (isObj(parsed) && isObj(parsed.mcpServers)) mcpServers = parsed.mcpServers
        else if (isObj(parsed) && !Array.isArray(parsed)) mcpServers = parsed
        if (!mcpServers || Object.keys(mcpServers).length === 0) {
          setError('import.empty')
          return
        }
        setError(null)
        setBusy(true)
        props
          .onImport({ mcpServers: mcpServers, mode: 'add' })
          .then(function (response) {
            setResult(response || {})
          })
          .catch(function (requestError) {
            setError(requestError)
          })
          .then(function () {
            setBusy(false)
          })
      }

      if (result) {
        const added = asArray(result.added)
        const skipped = asArray(result.skipped)
        const failures = asArray(result.errors)
        const dropped = normalizeDropped(result.droppedFields)
        function section(title, items, renderItem) {
          if (!items.length) return null
          return h(
            'div',
            { className: 'mw-import-section' },
            h('div', { className: 'mw-import-section-title' }, title + ' (' + items.length + ')'),
            h(
              'ul',
              { className: 'mw-import-list' },
              items.map(function (item, index) {
                return h('li', { key: 'i' + index }, renderItem(item, index))
              }),
            ),
          )
        }
        return h(Modal, {
          t: t,
          title: t('import.title'),
          wide: true,
          onCancel: props.onClose,
          footer: [
            h(Btn, { key: 'again', onClick: function () { setResult(null); setText(''); setFileName('') }, children: t('import.again') }),
            h(Btn, { key: 'done', variant: 'primary', onClick: props.onClose, children: t('import.done') }),
          ],
          children: h(
            'div',
            { className: 'mw-import-result' },
            h('div', { className: 'mw-import-summary' }, t('import.result', { added: added.length, skipped: skipped.length, errors: failures.length })),
            section(t('import.sectionAdded'), added, function (item) {
              return h('span', null, h('code', { className: 'mw-code' }, str(item.serverName)), item.patchId ? h('span', { className: 'mw-hint' }, ' · ' + str(item.patchId)) : null)
            }),
            section(t('import.sectionSkipped'), skipped, function (item) {
              return h('span', null, h('code', { className: 'mw-code' }, str(item.serverName)), h('span', { className: 'mw-hint' }, ' · ' + str(item.reason)))
            }),
            section(t('import.sectionErrors'), failures, function (item) {
              return h('span', null, h('code', { className: 'mw-code' }, str(item.serverName)), h('span', { className: 'mw-err-inline' }, ' · ' + str(item.message)))
            }),
            dropped.length
              ? h(
                  'div',
                  { className: 'mw-import-section' },
                  h('div', { className: 'mw-import-section-title' }, t('import.sectionDropped')),
                  h('div', { className: 'mw-hint' }, t('import.dropHint')),
                  h(
                    'ul',
                    { className: 'mw-import-list' },
                    dropped.map(function (item, index) {
                      return h(
                        'li',
                        { key: 'd' + index },
                        item.serverName ? h('code', { className: 'mw-code' }, item.serverName) : null,
                        h('span', null, ' ' + item.fields.join(', ')),
                      )
                    }),
                  ),
                )
              : null,
          ),
        })
      }

      return h(Modal, {
        t: t,
        title: t('import.title'),
        wide: true,
        busy: busy,
        onCancel: props.onClose,
        footer: [
          h(Btn, { key: 'cancel', onClick: props.onClose, disabled: busy, children: t('form.cancel') }),
          h(Btn, { key: 'submit', variant: 'primary', busy: busy, disabled: busy || !trim(text), onClick: submit, children: busy ? t('import.submitting') : t('import.submit') }),
        ],
        children: h(
          'div',
          { className: 'mw-form' },
          h('div', { className: 'mw-hint' }, t('import.desc')),
          error
            ? h(
                'div',
                { className: 'mw-banner mw-banner-error mw-banner-compact', role: 'alert' },
                h('span', { className: 'mw-banner-icon' }, h(IconAlert, { size: 14 })),
                h('span', null, typeof error === 'string' ? t(error) : describeError(t, error)),
              )
            : null,
          h(TextArea, {
            value: text,
            rows: 10,
            placeholder: t('import.placeholder'),
            invalid: !!error,
            onChange: function (value) {
              setText(value)
              if (error) setError(null)
            },
          }),
          h(
            'div',
            { className: 'mw-import-file-row' },
            h(
              'label',
              { className: 'mw-btn mw-btn-sm mw-file-label' },
              h(IconImport, { size: 13 }),
              h('span', null, t('import.file')),
              h('input', {
                type: 'file',
                accept: '.json,application/json,text/plain',
                className: 'mw-file-input',
                onChange: function (event) {
                  const file = event.target.files && event.target.files[0]
                  readFile(file)
                  event.target.value = ''
                },
              }),
            ),
            fileName ? h('span', { className: 'mw-hint mw-mono' }, fileName) : null,
          ),
        ),
      })
    }

    /* ------------------------------------------------------------------ *
     * Page
     * ------------------------------------------------------------------ */

    function Page(props) {
      const t0 = typeof props.t === 'function' ? props.t : fallbackT
      const t = function (key, vars) {
        return t0(key, vars)
      }

      const [model, setModel] = useState({ status: 'loading', data: null, error: null })
      const [busy, setBusy] = useState({})
      const [probes, setProbes] = useState({})
      const [detailOpen, setDetailOpen] = useState({})
      const [diagOpen, setDiagOpen] = useState(false)
      const [editor, setEditor] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [importOpen, setImportOpen] = useState(false)
      const [exporting, setExporting] = useState(false)
      const [toasts, setToasts] = useState([])

      const mounted = useRef(true)
      const probeControllers = useRef({})
      const toastTimers = useRef([])
      const toastSequence = useRef(0)

      useEffect(function () {
        mounted.current = true
        return function () {
          mounted.current = false
          Object.keys(probeControllers.current).forEach(function (key) {
            try {
              probeControllers.current[key].abort()
            } catch (error) {}
          })
          toastTimers.current.forEach(function (timer) {
            clearTimeout(timer)
          })
          toastTimers.current = []
        }
      }, [])

      const load = useCallback(function () {
        setModel(function (previous) {
          return { status: previous.data ? 'refreshing' : 'loading', data: previous.data, error: null }
        })
        return apiRequest('/servers', { timeoutMs: 20000 })
          .then(function (raw) {
            if (!mounted.current) return
            setModel({ status: 'ready', data: normalizePayload(raw), error: null })
          })
          .catch(function (error) {
            if (!mounted.current) return
            setModel(function (previous) {
              return { status: 'error', data: previous.data, error: error }
            })
          })
      }, [])

      useEffect(function () {
        load()
      }, [load])

      function pushToast(text, tone) {
        toastSequence.current += 1
        const id = toastSequence.current
        setToasts(function (list) {
          return list.concat([{ id: id, text: text, tone: tone || 'info' }])
        })
        const timer = setTimeout(function () {
          toastTimers.current = toastTimers.current.filter(function (item) {
            return item !== timer
          })
          setToasts(function (list) {
            return list.filter(function (item) {
              return item.id !== id
            })
          })
        }, 5200)
        toastTimers.current.push(timer)
      }

      function dismissToast(id) {
        setToasts(function (list) {
          return list.filter(function (item) {
            return item.id !== id
          })
        })
      }

      function setBusyKind(entryId, kind) {
        setBusy(function (previous) {
          const next = Object.assign({}, previous)
          if (kind) next[entryId] = kind
          else delete next[entryId]
          return next
        })
      }

      function patchRow(key, patch) {
        setModel(function (previous) {
          if (!previous.data) return previous
          return {
            status: previous.status,
            error: previous.error,
            data: {
              servers: previous.data.servers.map(function (server) {
                return rowKey(server) === key ? Object.assign({}, server, patch) : server
              }),
              patch: previous.data.patch,
              problems: previous.data.problems,
              totals: previous.data.totals,
            },
          }
        })
      }

      function inlineProbeBody(row) {
        /* Host contract: entryId lets the Host read the raw layer itself, so any
         * loaded entry is probeable (including rows without a patch id). */
        if (row.entryId) return { entryId: row.entryId }
        if (row.patchId) return { patchId: row.patchId }
        if (row.envKeys.length > 0 || row.headerKeys.length > 0) return null
        const server = { transport: row.transport, serverName: row.serverName }
        if (row.transport === 'stdio') {
          if (!row.command) return null
          server.command = row.command
          if (row.args.length) server.args = row.args
          if (row.cwd) server.cwd = row.cwd
        } else {
          if (!row.url) return null
          server.url = row.url
        }
        return { server: server }
      }

      function handleProbe(row) {
        const body = inlineProbeBody(row)
        if (!body) {
          pushToast(t('probe.inlineUnavailable'), 'error')
          return
        }
        const key = rowKey(row)
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
        if (controller) probeControllers.current[key] = controller
        setProbes(function (previous) {
          const next = Object.assign({}, previous)
          next[key] = { running: true }
          return next
        })
        apiRequest('/probe', { method: 'POST', body: body, signal: controller ? controller.signal : undefined })
          .then(function (response) {
            const probe = normalizeProbe(response)
            if (!probe) throw new ApiError('invalid-response')
            if (!probe.at) probe.at = new Date().toISOString()
            if (!mounted.current) return
            patchRow(key, { lastProbe: probe })
            setDetailOpen(function (previous) {
              const next = Object.assign({}, previous)
              next[key] = true
              return next
            })
            setProbes(function (previous) {
              const next = Object.assign({}, previous)
              delete next[key]
              return next
            })
            pushToast(probe.ok ? t('toast.probeOk', { tools: probe.toolCount == null ? 0 : probe.toolCount }) : t('toast.probeFail'), probe.ok ? 'success' : 'error')
          })
          .catch(function (error) {
            if (!mounted.current) return
            setProbes(function (previous) {
              const next = Object.assign({}, previous)
              delete next[key]
              return next
            })
            if (isAbortError(error)) {
              pushToast(t('toast.probeCancelled'), 'info')
              return
            }
            pushToast(describeError(t, error), 'error')
          })
          .then(function () {
            delete probeControllers.current[key]
          })
      }

      function handleCancelProbe(row) {
        const controller = probeControllers.current[rowKey(row)]
        if (controller) controller.abort()
      }

      function handleToggle(row, next) {
        if (busy[row.entryId]) return
        setBusyKind(row.entryId, 'toggle')
        apiRequest('/servers/toggle', { method: 'POST', body: { entryId: row.entryId, enabled: !!next } })
          .then(function (response) {
            if (!mounted.current) return
            const application = response && response.application
            if (application === 'applied') {
              pushToast(next ? t('toast.toggleOn') : t('toast.toggleOff'), 'success')
            } else if (response && response.restartReason) {
              pushToast(t('toast.toggleRestart', { reason: response.restartReason }), 'info')
            } else {
              pushToast(t('toast.togglePending'), 'info')
            }
            return load()
          })
          .catch(function (error) {
            if (!mounted.current) return
            pushToast(describeError(t, error), 'error')
          })
          .then(function () {
            if (mounted.current) setBusyKind(row.entryId, null)
          })
      }

      function requestCloseEditor() {
        if (!editor || editor.busy) return
        if (editor.dirty) {
          setConfirm({ kind: 'discard' })
          return
        }
        setEditor(null)
      }

      function closeEditor() {
        setConfirm(null)
        setEditor(null)
      }

      function openAdd() {
        setEditor({ mode: 'add', row: null, initial: emptyDraft(), dirty: false, busy: false, error: null })
      }

      function openEdit(row) {
        if (!row.patchId) return
        setEditor({ mode: 'edit', row: row, initial: draftFromRow(row, false), dirty: false, busy: false, error: null })
      }

      function openView(row) {
        setEditor({ mode: 'view', row: row, initial: draftFromRow(row, false), dirty: false, busy: false, error: null })
      }

      function handleDirtyChange(dirty) {
        setEditor(function (previous) {
          if (!previous || previous.dirty === dirty) return previous
          return Object.assign({}, previous, { dirty: dirty })
        })
      }

      function handleSave(payload) {
        if (!editor) return
        const current = editor
        setEditor(function (previous) {
          return previous ? Object.assign({}, previous, { busy: true, error: null }) : previous
        })
        let request
        if (current.mode === 'edit') {
          const body = { patchId: current.row.patchId, config: payload.config }
          if (payload.migrateSecrets) body.migrateSecrets = true
          request = apiRequest('/servers/update', { method: 'POST', body: body })
        } else {
          request = apiRequest('/servers/add', { method: 'POST', body: { server: payload.config } })
        }
        request
          .then(function (response) {
            if (!mounted.current) return
            setEditor(null)
            const migrated = response && Array.isArray(response.migrated) ? response.migrated : []
            const migrateSkipped = response && Array.isArray(response.migrateSkipped) ? response.migrateSkipped : []
            if (current.mode === 'edit') {
              if (migrateSkipped.length) pushToast(t('toast.migrateSkipped', { migrated: migrated.length, skipped: migrateSkipped.length }), 'info')
              else if (migrated.length) pushToast(t('toast.migrated', { count: migrated.length }), 'success')
              else pushToast(t('toast.saved'), 'success')
            } else if (response && response.applied === 'observed-pending') {
              pushToast(t('toast.addPending'), 'info')
            } else {
              pushToast(t('toast.added'), 'success')
            }
            return load()
          })
          .catch(function (error) {
            if (!mounted.current) return
            setEditor(function (previous) {
              return previous ? Object.assign({}, previous, { busy: false, error: error }) : previous
            })
          })
      }

      function askDelete(row) {
        setConfirm({ kind: 'delete', row: row, busy: false })
      }

      function doDelete() {
        if (!confirm || confirm.kind !== 'delete') return
        const row = confirm.row
        if (!row.patchId) {
          setConfirm(null)
          pushToast(t('action.deleteDisabled'), 'error')
          return
        }
        setConfirm(function (previous) {
          return previous ? Object.assign({}, previous, { busy: true }) : previous
        })
        apiRequest('/servers/remove', { method: 'POST', body: { patchId: row.patchId } })
          .then(function (response) {
            if (!mounted.current) return
            setConfirm(null)
            const backup = response && typeof response.backupPath === 'string' ? baseName(response.backupPath) : ''
            if (backup) pushToast(t('toast.deletedWithBackup', { name: row.serverName, backup: backup }), 'success')
            else pushToast(t('toast.deleted', { name: row.serverName }), 'success')
            return load()
          })
          .catch(function (error) {
            if (!mounted.current) return
            setConfirm(null)
            pushToast(describeError(t, error), 'error')
          })
      }

      function handleExport() {
        if (exporting) return
        setExporting(true)
        apiRequest('/export', { timeoutMs: 30000 })
          .then(function (response) {
            if (!mounted.current) return
            const mcpServers = response && isObj(response.mcpServers) ? response.mcpServers : {}
            if (!Object.keys(mcpServers).length) {
              pushToast(t('toast.exportEmpty'), 'info')
              return
            }
            downloadJson('mcp-servers-' + stamp() + '.json', { mcpServers: mcpServers })
            pushToast(t('toast.exported'), 'success')
          })
          .catch(function (error) {
            if (!mounted.current) return
            pushToast(describeError(t, error), 'error')
          })
          .then(function () {
            if (mounted.current) setExporting(false)
          })
      }

      function handleImport(payload) {
        return apiRequest('/import', { method: 'POST', body: payload, timeoutMs: 120000 }).then(function (response) {
          if (mounted.current) load()
          return response
        })
      }

      const data = model.data
      const servers = data ? data.servers : []
      const problems = data ? data.problems : []
      const errorProblemCount = problems.filter(function (problem) {
        return problem.level === 'error'
      }).length
      useEffect(
        function () {
          if (errorProblemCount > 0) setDiagOpen(true)
        },
        [errorProblemCount],
      )
      const totals = data ? data.totals : null
      const counts =
        totals ||
        {
          servers: servers.length,
          enabled: servers.filter(function (server) { return server.enabled }).length,
          tools: servers.reduce(function (sum, server) { return sum + server.toolCount }, 0),
        }

      const loading = model.status === 'loading'
      const refreshing = model.status === 'refreshing'
      const hasData = !!data

      const rows = servers.map(function (row) {
        const key = rowKey(row)
        return h(ServerRow, {
          key: key,
          t: t,
          row: row,
          rowKey: key,
          probe: probes[key] || null,
          busyKind: busy[row.entryId] || null,
          detailOpen: detailOpen[key] === true,
          canProbe: !!inlineProbeBody(row),
          onProbe: handleProbe,
          onCancelProbe: handleCancelProbe,
          onToggle: handleToggle,
          onEdit: function (target) {
            openEdit(target)
          },
          onView: function (target) {
            openView(target)
          },
          onDelete: function (target) {
            askDelete(target)
          },
          onToggleDetail: function (detailKey) {
            setDetailOpen(function (previous) {
              const next = Object.assign({}, previous)
              next[detailKey] = !next[detailKey]
              return next
            })
          },
        })
      })

      return h(
        'section',
        { className: 'mw-section' },
        h(
          'div',
          { className: 'mw-head' },
          h(
            'div',
            { className: 'mw-head-text' },
            h('h2', { className: 'mw-title' }, t('title')),
            h('div', { className: 'mw-sub' }, t('subtitle')),
            hasData ? h('div', { className: 'mw-totals' }, t('totals', { servers: counts.servers, enabled: counts.enabled, tools: counts.tools })) : null,
          ),
          h(
            'div',
            { className: 'mw-toolbar' },
            h(Btn, {
              icon: IconRefresh,
              busy: refreshing,
              disabled: loading || refreshing,
              onClick: function () {
                load()
              },
              children: t('toolbar.refresh'),
            }),
            h(Btn, { icon: IconPlus, variant: 'primary', onClick: openAdd, children: t('toolbar.add') }),
            h(Btn, {
              icon: IconImport,
              onClick: function () {
                setImportOpen(true)
              },
              children: t('toolbar.import'),
            }),
            h(Btn, {
              icon: IconExport,
              busy: exporting,
              disabled: exporting,
              onClick: handleExport,
              children: exporting ? t('export.busy') : t('toolbar.export'),
            }),
          ),
        ),

        hasData ? h(PatchBanner, { t: t, patch: data.patch }) : null,
        h(DiagBar, {
          t: t,
          problems: problems,
          open: diagOpen,
          onToggle: function () {
            setDiagOpen(!diagOpen)
          },
        }),

        model.error && hasData
          ? h(ErrorBanner, {
              t: t,
              error: model.error,
              compact: true,
              onRetry: function () {
                load()
              },
              retrying: refreshing,
            })
          : null,

        loading && !hasData ? h(LoadingState, { t: t }) : null,
        model.status === 'error' && !hasData
          ? h(ErrorState, {
              t: t,
              error: model.error,
              onRetry: function () {
                load()
              },
            })
          : null,

        hasData && !servers.length && !model.error
          ? h(EmptyState, {
              t: t,
              onAdd: openAdd,
              onImport: function () {
                setImportOpen(true)
              },
            })
          : null,

        hasData && servers.length
          ? h('div', { className: cx('mw-list', refreshing && 'mw-list-refreshing') }, rows)
          : null,

        h('div', { className: 'mw-source-hint' }, t('sourceDirHint')),

        editor
          ? h(ServerFormDrawer, {
              t: t,
              mode: editor.mode,
              row: editor.row,
              initial: editor.initial,
              servers: servers,
              busy: !!editor.busy,
              escapeBlocked: !!confirm,
              error: editor.error,
              onDirtyChange: handleDirtyChange,
              onRequestClose: requestCloseEditor,
              onSubmit: handleSave,
            })
          : null,

        confirm
          ? h(ConfirmDialog, {
              t: t,
              title: confirm.kind === 'discard' ? t('confirm.discardTitle') : t('confirm.deleteTitle'),
              body:
                confirm.kind === 'discard'
                  ? t('confirm.discardBody')
                  : h(
                      'div',
                      null,
                      h(
                        'p',
                        { className: 'mw-modal-text' },
                        t(isManagedRow(confirm.row) ? 'confirm.deleteBodyManaged' : 'confirm.deleteBodyHandwritten', {
                          name: confirm.row.serverName,
                        }),
                      ),
                      h('p', { className: 'mw-hint' }, t('confirm.deleteConsequences')),
                    ),
              confirmLabel: confirm.kind === 'discard' ? t('confirm.discard') : t('confirm.delete'),
              cancelLabel: confirm.kind === 'discard' ? t('confirm.keepEditing') : t('confirm.cancel'),
              danger: true,
              busy: !!confirm.busy,
              onConfirm: confirm.kind === 'discard' ? closeEditor : doDelete,
              onCancel: function () {
                setConfirm(null)
              },
            })
          : null,

        importOpen
          ? h(ImportDialog, {
              t: t,
              onImport: handleImport,
              onClose: function () {
                setImportOpen(false)
              },
            })
          : null,

        h(Toasts, {
          toasts: toasts,
          onDismiss: dismissToast,
          closeLabel: t('toast.dismiss'),
        }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Download helper (export)
     * ------------------------------------------------------------------ */

    function downloadJson(fileName, payload) {
      try {
        const text = JSON.stringify(payload, null, 2) + '\n'
        const blob = new Blob([text], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = fileName
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        setTimeout(function () {
          URL.revokeObjectURL(url)
        }, 1000)
      } catch (error) {
        /* The caller reports the failure through the toast channel. */
        throw new ApiError('export-failed', error && error.message ? error.message : 'export failed')
      }
    }

    /* ------------------------------------------------------------------ *
     * Styles (single self-contained block, host theme variables only)
     * ------------------------------------------------------------------ */

    const CSS = `
.mw-section{display:flex;flex-direction:column;gap:16px;padding:8px 0 28px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;min-width:0}
.mw-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.mw-head-text{min-width:0;flex:1 1 260px}
.mw-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.mw-sub{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.mw-totals{margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.mw-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.mw-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.mw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mw-btn:disabled{opacity:.45;cursor:default}
.mw-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);border-color:transparent}
.mw-btn-primary:hover:not(:disabled){background:var(--dsw-alias-label-primary);opacity:.88}
.mw-btn-danger{color:var(--dsw-alias-state-error-primary)}
.mw-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.mw-btn-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.mw-btn-sm{height:28px;padding:0 10px;font-size:12px}
.mw-btn-label{overflow:hidden;text-overflow:ellipsis}
.mw-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:8px;border:.5px solid transparent;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.mw-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mw-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mw-icon-btn:disabled{opacity:.35;cursor:default}
.mw-icon-btn-danger{color:var(--dsw-alias-state-error-primary)}
.mw-icon-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}

.mw-list{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l2)}
.mw-list-refreshing{opacity:.72}
.mw-row{display:flex;gap:12px;padding:14px 4px;border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:flex-start;min-width:0}
.mw-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mw-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-top:7px;box-sizing:border-box}
.mw-dot-ok{background:var(--dsw-alias-state-success-primary)}
.mw-dot-error{background:var(--dsw-alias-state-error-primary)}
.mw-dot-off{background:var(--dsw-alias-label-tertiary);opacity:.55}
.mw-dot-unknown{background:transparent;border:1px solid var(--dsw-alias-label-tertiary)}
.mw-row-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.mw-row-title{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.mw-name{font-size:14px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.mw-tag{font-size:11px;line-height:16px;padding:0 6px;border-radius:5px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3);white-space:nowrap}
.mw-tag-muted{opacity:.8}
.mw-row-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.mw-row-target{color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px}
.mw-meta-part{white-space:nowrap}
.mw-dot-sep{margin:0 6px;opacity:.6}
.mw-row-sub{margin-top:2px}
.mw-row-actions{margin-left:auto;display:flex;align-items:center;gap:2px;flex:none}
.mw-mono{font-family:var(--ds-font-family-code)}
.mw-code{font-family:var(--ds-font-family-code);font-size:12px;background:var(--dsw-alias-bg-layer-3);border-radius:4px;padding:1px 5px}

.mw-switch{position:relative;width:36px;height:20px;border-radius:10px;border:none;flex:none;margin-left:6px;cursor:pointer;background:var(--dsw-alias-border-l4);transition:background .16s;padding:0}
.mw-switch:disabled{opacity:.45;cursor:default}
.mw-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mw-switch-on{background:var(--dsw-alias-brand-primary)}
.mw-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .16s}
.mw-switch-on .mw-switch-knob{transform:translateX(16px)}
@media (prefers-reduced-motion:reduce){.mw-switch,.mw-switch-knob{transition:none}}

.mw-banner{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font-size:13px;line-height:20px}
.mw-banner-compact{padding:8px 10px;font-size:12px;line-height:18px}
.mw-banner-icon{flex:none;margin-top:3px;color:var(--dsw-alias-label-tertiary)}
.mw-banner-error{border-color:var(--dsw-alias-state-error-primary)}
.mw-banner-error .mw-banner-icon,.mw-banner-error .mw-banner-title{color:var(--dsw-alias-state-error-primary)}
.mw-banner-warn{border-color:var(--dsw-alias-state-warn-primary)}
.mw-banner-warn .mw-banner-icon,.mw-banner-warn .mw-banner-title{color:var(--dsw-alias-state-warn-primary)}
.mw-banner-info .mw-banner-icon{color:var(--dsw-alias-state-business-primary)}
.mw-banner-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}
.mw-banner-title{font-weight:600}
.mw-banner-text{overflow-wrap:anywhere;min-width:0}
.mw-diag-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mw-diag-list{margin:2px 0 0;padding:0 0 0 2px;list-style:none;display:flex;flex-direction:column;gap:4px}
.mw-diag-item{display:flex;align-items:baseline;gap:6px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.mw-diag-level{color:var(--dsw-alias-label-tertiary);flex:none;font-size:10px}
.mw-diag-level-error{color:var(--dsw-alias-state-error-primary)}
.mw-link-btn{appearance:none;border:none;background:0 0;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-link);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.mw-link-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.mw-link-btn:disabled{opacity:.5;cursor:default}
.mw-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.mw-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.mw-err-inline{color:var(--dsw-alias-state-error-primary)}
.mw-pre{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}

.mw-empty{border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;padding:28px 20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px}
.mw-empty-title{font-size:15px;font-weight:600;line-height:22px}
.mw-empty-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;max-width:460px}
.mw-empty-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px}
.mw-empty-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:4px;font-family:var(--ds-font-family-code);overflow-wrap:anywhere}
.mw-empty-icon{color:var(--dsw-alias-state-error-primary)}
.mw-empty-error{border-color:var(--dsw-alias-state-error-primary);border-style:solid}

.mw-loading{display:flex;flex-direction:column;gap:10px}
.mw-loading-text{display:inline-flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.mw-skeleton-row{height:52px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);animation:mw-pulse 1.6s ease-in-out infinite}
@keyframes mw-pulse{0%,100%{opacity:.55}50%{opacity:.9}}
@media (prefers-reduced-motion:reduce){.mw-skeleton-row{animation:none}}

.mw-spinner{display:inline-block;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:mw-spin .8s linear infinite;flex:none}
@keyframes mw-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mw-spinner{animation:none;border-right-color:currentColor;opacity:.6}}

.mw-probe-detail{margin-top:8px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);display:flex;flex-direction:column;gap:8px}
.mw-kv-static-list{margin:0;display:flex;flex-wrap:wrap;gap:4px 18px}
.mw-kv-static-item{display:flex;gap:6px;font-size:12px;line-height:18px;min-width:0}
.mw-kv-static-item dt{color:var(--dsw-alias-label-tertiary);margin:0}
.mw-kv-static-item dd{margin:0;font-family:var(--ds-font-family-code);overflow-wrap:anywhere}
.mw-probe-section{display:flex;flex-direction:column;gap:4px}
.mw-probe-section-title{font-size:12px;font-weight:600;line-height:18px}
.mw-tools{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}
.mw-tool{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:18px;min-width:0}
.mw-tool-name{font-family:var(--ds-font-family-code);flex:none;color:var(--dsw-alias-label-primary)}
.mw-tool-desc{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.mw-source-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:var(--ds-font-family-code);overflow-wrap:anywhere;opacity:.85}

.mw-overlay{position:fixed;inset:0;z-index:1100;display:flex;justify-content:flex-end;background:var(--dsw-alias-bg-mask-1)}
.mw-overlay-center{align-items:center;justify-content:center;padding:24px;z-index:1200}
.mw-drawer{width:min(560px,100%);height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border-left:.5px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-prominent)}
.mw-drawer-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.mw-drawer-head-text{min-width:0;flex:1}
.mw-drawer-title{margin:0;font-size:16px;font-weight:600;line-height:24px;overflow-wrap:anywhere}
.mw-drawer-body{flex:1;min-height:0;overflow-y:auto;padding:0 20px 20px}
.mw-modal{width:min(420px,100%);max-height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border-radius:16px;box-shadow:var(--dsw-elevation-prominent);border:.5px solid var(--dsw-alias-border-l2)}
.mw-modal-wide{width:min(560px,100%)}
.mw-modal-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 10px}
.mw-modal-title{margin:0;font-size:16px;font-weight:600;line-height:24px;flex:1;min-width:0}
.mw-modal-body{padding:0 20px;overflow-y:auto;min-height:0}
.mw-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px 18px}
.mw-modal-text{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.mw-modal-text p{margin:0 0 8px}

.mw-form{display:flex;flex-direction:column;padding-top:4px}
.mw-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.mw-field:last-of-type{border-bottom:none}
.mw-field-head{display:flex;align-items:center;gap:8px}
.mw-label{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.mw-input{box-sizing:border-box;height:34px;width:100%;min-width:0;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font:inherit;font-size:13px;line-height:20px}
.mw-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.mw-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.mw-input:disabled,.mw-input[readonly]{color:var(--dsw-alias-label-secondary);cursor:default}
.mw-input-invalid{border-color:var(--dsw-alias-state-error-primary)}
.mw-textarea{height:auto;min-height:76px;padding:8px 10px;resize:vertical;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}
.mw-select{cursor:pointer;padding-right:6px}
.mw-seg{display:inline-flex;align-self:flex-start;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:2px;gap:2px}
.mw-seg-item{appearance:none;border:none;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:2px 10px;border-radius:6px;cursor:pointer}
.mw-seg-item:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.mw-seg-item:disabled{cursor:default;opacity:.6}
.mw-seg-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mw-seg-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}
.mw-form-foot{position:sticky;bottom:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 0 4px;background:var(--dsw-alias-bg-layer-2);border-top:.5px solid var(--dsw-alias-border-l2);margin-top:4px}
.mw-form-foot-hint{flex:1;min-width:180px}
.mw-form-foot-actions{display:flex;gap:8px;margin-left:auto}

.mw-kv{display:flex;flex-direction:column;gap:8px}
.mw-kv-block{display:flex;flex-direction:column;gap:4px}
.mw-kv-row{display:flex;gap:6px;align-items:center;min-width:0}
.mw-kv-key{flex:1 1 34%}
.mw-kv-mode{flex:0 0 132px;width:132px}
.mw-kv-static{flex:1 1 40%;min-width:0;display:flex;flex-direction:column;gap:2px;align-items:flex-start}
.mw-kv-static-text{overflow-wrap:anywhere;max-width:100%}
.mw-kv-remove{flex:none}
.mw-kv-err{padding-left:2px}
.mw-add-key{display:inline-flex;align-items:center;gap:4px;align-self:flex-start;text-decoration:none}
.mw-add-key:hover:not(:disabled){text-decoration:underline}

.mw-import-file-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 0 4px}
.mw-file-label{cursor:pointer;position:relative;overflow:hidden}
.mw-file-input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}
.mw-import-result{display:flex;flex-direction:column;gap:12px;padding:4px 0 8px}
.mw-import-summary{font-size:13px;font-weight:600;line-height:20px}
.mw-import-section{display:flex;flex-direction:column;gap:4px}
.mw-import-section-title{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mw-import-list{margin:0;padding:0 0 0 2px;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:18px;overflow-wrap:anywhere}

@media (max-width:640px){
.mw-row{flex-wrap:wrap}
.mw-row-actions{width:100%;justify-content:flex-end;padding-top:6px;margin-left:0}
.mw-kv-row{flex-wrap:wrap}
.mw-kv-key{flex:1 1 100%}
.mw-kv-mode{flex:1 1 auto;width:auto}
.mw-kv-static{flex:1 1 100%}
.mw-drawer{width:100%}
.mw-toolbar{margin-left:0}
}

.mw-toasts{position:fixed;right:20px;bottom:20px;z-index:1300;display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 40px));pointer-events:none}
.mw-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.mw-toast-icon{flex:none;margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.mw-toast-success .mw-toast-icon{color:var(--dsw-alias-state-success-primary)}
.mw-toast-error .mw-toast-icon{color:var(--dsw-alias-state-error-primary)}
.mw-toast-info .mw-toast-icon{color:var(--dsw-alias-state-business-primary)}
.mw-toast-text{flex:1;min-width:0;overflow-wrap:anywhere}
.mw-toast-close{appearance:none;border:none;background:0 0;padding:0;margin-top:1px;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none;display:inline-flex}
.mw-toast-close:hover{color:var(--dsw-alias-label-primary)}
`

    function ensureStyles() {
      if (typeof document === 'undefined') return function () {}
      const existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
      if (existing) return function () {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      if (document.head) document.head.appendChild(tag)
      // Deliberately not removed on dispose: an HMR reload mounts a new module
      // instance whose dedupe query finds this tag, so a stale disposer removing it
      // would leave the reloaded UI unstyled.
      return function () {}
    }

    /* ------------------------------------------------------------------ *
     * Plugin face
     * ------------------------------------------------------------------ */

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh, en })
      }, PLUGIN_ID + ': dictionaries')
      ctx.effect(function () {
        return ensureStyles()
      }, PLUGIN_ID + ': styles')
      ctx.effect(function () {
        return installNavGlyph([zh.nav, en.nav])
      }, PLUGIN_ID + ': settings-nav glyph')
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'mcp-manager',
            order: 30,
            label: function () {
              return t('nav')
            },
            locale: NS,
          },
          Page,
        )
      })
    }

    const module = { exports: {} }
    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  },
})
