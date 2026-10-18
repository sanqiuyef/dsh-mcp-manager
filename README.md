# dsh-mcp-manager

**dsh-mcp-manager** is a plugin for **DeepSeek Harness (DSH)** that adds a **Settings → MCP Servers** page:
list, enable/disable, edit, add, remove, probe and import/export the profile's MCP servers without
hand-editing `cordis.patch.yml`. It installs into a DSH profile as a plugin bundle and registers the page
in the Settings sidebar. Licensed under MIT.

DSH（DeepSeek Harness）桌面端插件：**设置 → MCP 服务器** 管理面板。
不用再手改 `cordis.patch.yml`，在设置页里看清单、启停、编辑、新增、删除、测连接、导入导出。

- 目标宿主：**DSH 0.2.1-rc.2**（Electron 桌面版，profile=desktop）
- 依赖：`yaml`（读/写 profile 补丁）

## 它做什么

| 能力 | 走哪条官方通道 | 热生效 |
|---|---|---|
| 列出 profile 里所有 `@deepseek-ai/dsh-mcp-client` 服务器 + 工具数/启动相位 | `pluginManager.listPlugins()`、`ctx.tools.schemas()` | 只读 |
| 启用 / 停用 | `pluginManager.setPluginEnabled(entryId, enabled)` | ✅ |
| 编辑已有服务器（command/args/env/url/超时/…） | `configEditor.edit(entry, …)`（以**原始层** `inherited` 为基底，`!!js` 原样往返） | ✅（重连该服务器） |
| 连接测试 + 工具枚举 | `ctx.subprocess.spawn` 手写 MCP stdio JSON-RPC（initialize → tools/list）；http 走 `fetch` | 即时 |
| 新增 / 删除服务器 | 改写 profile `cordis.patch.yml`（只动本插件管理块，锁 + 原子写 + 备份 + 写后校验回滚） | ✅（HMR 监听补丁文件） |
| 导入 / 导出 | 标准 `{"mcpServers":{…}}`（Claude/Cursor/ZCode 通用形状） | — |
| 诊断 | serverName 正则/重名、command 是否存在、`!!js process.env.X` 变量是否缺失、YAML 错误 | — |

**密钥策略**：面板永不回传密钥值，只显示「已设置（字面量 / `!!js process.env.X`）」；
推荐的持久化形态是 `!!js process.env.VAR`，密钥留在宿主进程环境里，不落进补丁文件。

## 安装

宿主只对**真实目录**做 `@deepseek-ai/*` 模块拦截，所以请以 tarball 形式安装，不要直接拷贝源码目录：

```bash
git clone https://github.com/sanqiuyef/dsh-mcp-manager.git
cd dsh-mcp-manager
npm pack          # 生成 dsh-mcp-manager-<version>.tgz
```

再用 DSH 的插件管理器安装这个 tarball，任选一条：

- **Web GUI**：设置 → 插件 → 安装，选中刚生成的 `.tgz`；
- **宿主工具**：`plugin_manager({ action: 'install_bundle', target: '<abs>/dsh-mcp-manager-0.1.6.tgz' })`；
- **profile bundle 安装入口**：本包自带 `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch`），
  经 bundle 方式安装后会自动挂载 host 路由与设置页；
- **不自己构建**：直接从本仓库的 **Releases** 页下载已打好的 `dsh-mcp-manager-<version>.tgz`，
  再按上面任一方式安装。

装好后：设置 → 左侧出现「**MCP 服务器**」（order 30）。迭代流程：改源码 → 递增版本号 → 重新 `npm pack` → 重装 tarball。

## 测试

离线断言，不依赖运行中的宿主（需要 Node.js ≥ 20）：

```bash
node --check client/client.js   # 浏览器半区语法检查
node client/selfcheck.mjs       # 插件注册 / 本地化词典键集 / 导航装饰逻辑（假宿主）
node scripts/smoke.mjs          # YAML 渲染往返、探测、安全、导入导出
```

## 环境变量桥（0.1.3）

有些 MCP 行用 `!!js process.env.X` 引用凭据，但宿主进程环境可能拿不到（例如 DSH 由旧启动器拉起）。
插件在 `apply()` **最先**读 `<profile>/data/mcp-manager/secrets.json`，把**尚未设置**的键注入 `process.env`：

```json
{ "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "…" }
```

- 只读该文件（插件不创建/不改）；键名须 `^[A-Za-z_][A-Za-z0-9_]*$`、值须非空字符串；非法项跳过并在诊断里列出；
- 已存在的环境变量不覆盖；坏 JSON/读失败只 warn，不阻塞插件；
- `GET /servers` 顶层与诊断快照 `backend.envBridge` 只回**键名与状态**，绝不回显值；
- Windows 上建议用 ACL 限制该文件仅当前用户可读写（`icacls secrets.json /inheritance:r /grant:r "<user>:(R,W)"`）。

## 设置导航图标（0.1.4，临时装饰）

设置面板左侧导航的图标由外壳写死：`@deepseek-ai/dsh-client-ui-settings-general` 的 `navIcon(id)` 只认
`account / models / agent-presets / plugins / archived-sessions`，**未知 id 一律兜底成齿轮**；而
`settings.section` 的注册参数只有 `id / order / label`，插件没地方声明图标。于是本页（id `mcp-manager`）
在导航里和「设置」入口共用一个齿轮——不符合实际情况。

为此 `client/client.js` 在 `apply()` 里加了一个**防御式装饰** effect（`installNavGlyph`）：设置面板出现时，
只认 `[data-shortcut-modal="settings"]` 内、`span.navLabel` 文案与本插件 zh/en `nav` 文案完全相等的那一行，
把兜底齿轮 `display:none`，并在其前插入本插件自己的 16×16「服务器机架」图形（`viewBox 0 0 16 16`、
`stroke-width 1.3`，与 DSH Medium 图标同规格）。DOM 结构不符合预期就什么都不做（保留原齿轮、不抛错）；
缺 `document` / `MutationObserver` / `createElementNS` 的环境直接返回空清理函数，一行 DOM 都不碰。
effect 清理器会删除插入的图形、恢复齿轮显示、断开 observer。

**为什么要有这段代码**：这不是插件的正常功能，而是对外壳「导航图标按 id 写死」这一实现的适配；
它只碰自己的那一行、可整体删除，并且不修改 DSH 安装目录或 `app.asar`。

**移除条件（重要）**：一旦 `settings.section` 的注册参数支持 `icon`，就应**整段删除**
`NAV_PANEL_SELECTOR` / `NAV_GLYPH_ATTR` / `NAV_GLYPH` / `navGlyphElement` / `decorateNavRow` /
`installNavGlyph` 这 6 个定义与 `apply()` 里那个 `settings-nav glyph` effect，改为在注册参数里声明 `icon`。

**验证范围**：`client/selfcheck.mjs` 只离线断言「只装饰自己那一行 + 清理能还原」的逻辑，
**不是视觉验证**；本仓库不含浏览器视觉快照。

## 主题 token 修正（0.1.5）

设置页原先引用了两个 DSH 主题里**并不存在**的变量——CSS 变量名写错不会报错，只会让 `var()` 在计算值阶段
失效，`color` / `font-family` 静默回退成继承值（错误态只剩文案、危险按钮与普通按钮同色）：

| 原引用 | 主题里的正确 token | 本页处数 |
|---|---|---|
| `--dsw-alias-label-error` | `--dsw-alias-state-error-primary`（浅色 `--dsw-static-red-600` / 深色 `--dsw-static-red-400`；宿主设置页自用同款） | 13 |
| `--dsw-font-mono` | `--ds-font-family-code`（主题的等宽栈） | 9 |

现已全部替换为宿主 token，未引入字面量兜底。本包 `client/client.js` 里的每个 `var(--…)` 都应存在于
宿主主题的 token 定义中；**升级 DSH 后请重新核对**（把 `var(--…)` 名字与所装 DSH 的主题 token 定义逐一比对，
出现未定义的名字即为回归）。

## 结构

| 路径 | 说明 |
|---|---|
| `lib/index.js` | host 入口：`name` / `inject` / `apply`，注册 `/mcp-manager/api/*` 路由 |
| `lib/servers.js` | 列表与配置读取（`configuration()` 的 inherited/override） |
| `lib/toggle.js` / `lib/edit.js` | 启停、编辑（原始层基底） |
| `lib/patch.js` | 管理块增删：`withFileLock` + `writeFileAtomic` + 备份 + 写后校验 |
| `lib/probe.js` | stdio / streamable-http 探测（8s 超时、可取消、脱敏） |
| `lib/transfer.js` | 导入/导出 |
| `lib/diagnostics.js` | 配置体检 |
| `lib/security.js` | `requestRejection`、POST/JSON/64KiB/no-store |
| `lib/env-bridge.js` | 环境变量桥：`<profile>/data/mcp-manager/secrets.json` → `process.env`（只补缺失键） |
| `client/client.js` | 浏览器设置页（`settings.section`，手写 CJS，无构建） |
| `client/selfcheck.mjs` | 浏览器半区离线自检（假宿主） |
| `scripts/smoke.mjs` | host 半区离线断言（不依赖宿主） |

源码注释里出现的 `contract §N` 指本插件 HTTP 契约的内部小节编号（无外部文档，路由表见 `lib/index.js`）。

## 已知限制

- 宿主不暴露 MCP 连接状态：面板显示的是「工具数 + 上次探测结果」，不是实时连接态；
  `fiberPhase: 'active'` 只代表插件条目已激活。
- 编辑任一服务器都会让该条目整实例重挂（子进程重启、工具短暂消失），页面会提示。
- 新增/删除没有官方运行时 API，只能改 profile 补丁；写坏的文件在**下次启动**时会让组合失败，
  因此写前备份、写后校验、失败自动回滚，且删除对非本插件管理的行降级为「停用」。
- 设置导航图标依赖外壳 DOM 结构（见上节），外壳改版后装饰会静默失效（功能不受影响）。
- 不支持：云端同步、OAuth、官方 MCP 市场、workspace 作用域、工具浏览器/资源浏览。

## 卸载

`plugin_manager({ action: 'remove_bundle', target: 'dsh-mcp-manager' })`。
本插件通过管理块写入的服务器行会留在 profile 补丁里（可用外部编辑器手工清掉），这是刻意的：
卸载管理工具不应连带删除用户数据。

## License

MIT © 2026 sanqiuyef — 见 [LICENSE](./LICENSE)。
