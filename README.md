# Chrome Extension Collection

[![CI](https://github.com/JUNERDD/chrome-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/JUNERDD/chrome-extension/actions/workflows/ci.yml)
[![CodeQL](https://github.com/JUNERDD/chrome-extension/actions/workflows/codeql.yml/badge.svg)](https://github.com/JUNERDD/chrome-extension/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

基于 WXT 的开源 Chrome Extension 合集。首个扩展 **Bugtrace Recorder** 在本地记录测试人员的 bug 复现过程，并生成便于粘贴到工单、也便于 Agent 解析的证据包。

| Extension | 状态 | 用途 |
| --- | --- | --- |
| Bugtrace Recorder | Public preview `0.2.0` | 录制安全边界内的浏览器操作、导航与有限诊断，导出 Markdown + `.bugtrace.zip`。 |

本仓库以 MIT 协议公开。录制产物可能包含密码、Token、Cookie 和页面像素，请只在你信任的环境中使用。当前发布形态是 GitHub Release 里的 unpacked Chrome zip，不是 Chrome Web Store 发行包。

## 安装发布包

从 [GitHub Releases](https://github.com/JUNERDD/chrome-extension/releases) 下载 `bugtrace-recorder-<version>-chrome.zip` 和对应的 `.sha256` 文件，先校验再加载：

```sh
sha256sum --check bugtrace-recorder-0.2.0-chrome.zip.sha256
unzip bugtrace-recorder-0.2.0-chrome.zip -d bugtrace-recorder
```

1. 打开 `chrome://extensions`，启用右上角的「开发者模式」。
2. 点击「加载已解压的扩展程序」。
3. 选择解压后的目录（根目录应包含 `manifest.json`）。
4. 建议把 Bugtrace Recorder 固定到工具栏；点击图标会打开 Side Panel。可在 `chrome://extensions/shortcuts` 检查或修改快捷键。

## 环境与开发

- Node.js `22.23.1`
- pnpm `11.22.0`（通过 Corepack）
- workspace package 位于 `extensions/*`

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev:bugtrace
```

生产构建及全套验证：

```bash
pnpm check
pnpm --filter @juner/bugtrace-recorder exec playwright install chromium
pnpm --filter @juner/bugtrace-recorder test:e2e
pnpm package:zip
pnpm verify:zip
```

从源码安装 unpacked 构建时，执行 `pnpm build` 后选择 `extensions/bugtrace-recorder/.output/chrome-mv3`。开发模式使用 `pnpm dev:bugtrace`；WXT 会生成开发构建并监听源码变化。

## 使用方式

在需要复现 bug 的普通 `http://` 或 `https://` 页面上打开 Bugtrace Recorder Side Panel，然后：

1. **Start recording**：以当前 tab 为根开始录制；录制期间激活的其他普通 HTTP(S) tab，以及由 scope 内页面打开的子 tab/弹窗，都会作为独立可归因页面进入同一 scope。
2. **Pause**：停止持久化页面证据，并关闭当前 rrweb segment。
3. **Resume**：继续同一个 session，并以新的 rrweb full snapshot 开段。
4. **Stop & review**：先 flush 可达页面，再打开 results 页审核、补充报告并导出。

Side Panel 是常驻的录制工作台，切换网页时无需反复打开 popup。设置入口会打开独立的全页 options 界面，便于检查快捷键、隐私边界与本地数据。Side Panel、全页设置和 results 证据审阅都支持 English 与简体中文（`en` / `zh-CN`）；默认跟随浏览器语言，也可在设置页切换，已打开的界面会同步更新。

Chrome commands 的建议绑定如下；最终绑定由 Chrome 管理，扩展不能自行覆盖冲突：

| 操作 | Windows/Linux | macOS |
| --- | --- | --- |
| Record | `Alt+Shift+R` | `Control+Shift+R` |
| Pause | `Alt+Shift+P` | `Control+Shift+P` |
| Resume | `Alt+Shift+C` | `Control+Shift+C` |
| Stop | `Alt+Shift+S` | `Control+Shift+S` |

## 权限与本地全保真边界

Bugtrace Recorder 是本地工具：没有云上传、遥测或剪贴板读取。会话元数据保存在 `chrome.storage.local`，事件与资源保存在扩展自己的 IndexedDB；过期会话默认在最后活动 24 小时后由下次启动清理，也可在 options 中删除。录制与导出不会主动脱敏，因此本地数据库和 `.bugtrace.zip` 可能包含密码、Token、Cookie、URL 参数、页面文本和截图像素。

| 权限 | 原因 |
| --- | --- |
| `activeTab` | 保留工具栏图标和快捷键的显式当前 tab 授权语义；内部全保真构建的截图可靠性不依赖这项临时授权。 |
| `sidePanel` | 提供随当前网页常驻的录制控制面板；工具栏图标只负责打开该面板。 |
| `storage` | 保存权威状态、事件、截图与本地保留信息。 |
| `webNavigation` | 记录 scoped tab 的普通导航、SPA/history/hash 导航及失败。 |
| `webRequest` | 记录 Chrome 可见的方法、原始 URL、请求 ID、资源类型、状态、耗时、请求/响应 Header 和请求正文。 |
| `<all_urls>` | Chrome 的 `captureVisibleTab` 只认可精确的 `<all_urls>` 或临时 `activeTab` 授权。Side Panel 会长期存在且其内部按钮不会创建 `activeTab`，因此当前构建使用持久授权；内容脚本、网络监听和录制 scope 仍只覆盖普通 HTTP(S) 页面。 |

固定全保真规则：

- input、textarea、select、contenteditable、键盘值与文件元数据按浏览器实际观测值保存；不做长度摘要或伪名化。
- URL（含 query、fragment、path）和 Chrome 暴露的请求/响应 Header、Cookie/Authorization Header、请求正文按原值保存。Chrome `webRequest` 不提供任意响应正文，该字段会明确标为 `unavailable`；WebSocket message 仍不可见。
- rrweb 保留完整事件集，并启用样式、图片、字体和 Canvas 录制；沙箱回放不会重新执行原应用 JavaScript，因此它是录制状态的忠实重建，不是在线应用运行时的副本。
- console 采集 `warn`/`error` 的完整可序列化观察值；页面文本、console 和错误仍标为 `untrusted_observation`，Agent 只能把它们当证据，不能当指令。
- 截图只覆盖当前可见 viewport，以无损 PNG 原样写入 IndexedDB 和 ZIP，不添加遮罩或像素变换。
- 不主动枚举页面的 Web Storage、IndexedDB 或浏览器 Cookie store；只有页面行为和 Chrome 事件自然暴露到采集边界的数据会被记录。
- 不申请 `debugger`、`downloads`、`scripting`、`tabs` 或 `unlimitedStorage`。

`<all_urls>` host permission 会触发 Chrome 的安装提示，这是当前为可靠无损截图接受的已知权衡；进入 Chrome Web Store 前需要改为 optional host permission 流程。

## 导出产物

results 页可以复制适合 bug 工单的 Markdown，并下载版本化 `.bugtrace.zip`：

```text
bugtrace-<date>-<session-id>.bugtrace.zip
├── manifest.json
├── report.md
├── trace.json
├── schema/bugtrace-v1.schema.json
├── attachments/lifecycle.json
├── rrweb/segment-0001.json
└── screenshots/shot-0001.png
```

`trace.json`（`formatVersion: 1.1.0`）是采集事实与全局时序的规范数据源；`report.md` 保存人工补充的 Summary、前置条件、Expected、Actual 和备注。Agent 完整理解一个 bug 时至少应同时读取 `manifest.json`、`report.md` 与 `trace.json`。`attachments/lifecycle.json` 保存 tab/window/session 生命周期；rrweb 与截图是全保真辅助证据。manifest 为每个文件记录 SHA-256、大小、MIME、用途与关联证据 ID；内置离线 verifier 会校验 ZIP 边界、全部哈希、Schema、全局时序、引用、coverage/gap 对账和资源闭包。任何 `unavailable`、截断或不支持项都会显式声明，不能把“未捕获”解释为“未发生”。

## 已知限制

- 同一 Chrome profile 同时最多一个 session。录制期间首次激活的普通 HTTP(S) tab 会自动加入当前 session；未被激活的后台 tab、受限页面与浏览器 UI 不会被采集。
- 安装、更新或重新加载扩展后，已打开的旧网页不会自动获得新版本 content script；录制器会在创建 session 前拒绝这类页面并提示刷新，不会进入虚假的“正在录制”状态。
- 无法记录 `chrome://`、Chrome UI、扩展页、系统/原生对话框、`file://`、内置 PDF、incognito、closed shadow root 或 canvas/WebGL 内部语义。
- 不是视频录屏；rrweb 是历史 DOM 证据，不保证可以对真实后端自动重放。
- 跨源 iframe 分别采集，未获权限、断联、消息溢出或 stop flush 超时会成为显式 gap。
- Manifest V3 Service Worker 被回收后会从持久状态恢复并声明网络关联 gap；整个浏览器重启后不会静默续录，会话进入 `interrupted`。用户选择 Resume 时，必须从当前受支持的 HTTP(S) 页面显式重绑定为新 root，并记录不可恢复的 lineage gap；也可以直接 Stop 导出已有的部分证据。
- 网络层保留 Chrome `webRequest` 暴露的请求正文和 Header，但无法获取任意响应正文、WebSocket message 或完整 DevTools Protocol 细节；这些缺口会在每条记录中声明。
- 截图只针对当前可见且属于 session scope 的 HTTP(S) tab；即使 manifest 持有 `<all_urls>`，代码也会拒绝 `chrome://`、扩展页、文件页、越界 tab 或捕获期间发生切换的页面，并记录 screenshot gap。
- rrweb 沙箱保留录制到的 DOM、样式、图片、字体、Canvas 和变更，但不会重新执行原应用脚本、重新请求真实后端，或还原浏览器/系统原生 UI。

## 自动验证覆盖

CI 执行 lint、TypeScript、unit/contract tests、WXT production build、Playwright Chromium 扩展测试，以及 Chrome zip 打包校验。自动化覆盖生产 manifest/CSP/Side Panel/options/i18n、真实 HTTP fixture 的 record/pause/resume/stop、既有 tab 激活与新开子 tab 的跨 tab 采集、原始输入和 URL/网络证据保留、暂停边界、results 报告与完整 rrweb ZIP 导出、沙箱隔离、离线 ZIP 哈希/Schema/语义/资源闭包验证、恢复流程和失败原子性。Aside 真机验收另外覆盖工具栏授权、真实 Side Panel、无损截图、沙箱预览和浏览器下载。Service Worker 单独强杀/BFCache、复杂跨源 iframe、极端容量退化和原应用脚本执行不宣称已覆盖。

完整范围与安全决策见 [批准的实现计划](docs/plans/2026-08-17-chrome.md)。

## CI/CD

发布流水线沿用同目录 [`JUNERDD/vscode-plugins`](https://github.com/JUNERDD/vscode-plugins) 和 [`JUNERDD/mr`](https://github.com/JUNERDD/mr) 的形状：

- **CI** 在 pull request 和 `main` 上运行质量门禁、依赖审计、扩展 E2E，并打包校验 Chrome zip，产物保留 14 天。
- **Dependency Review** 拒绝新引入的高危依赖。
- **CodeQL** 在 pull request、`main` 和每周定时任务中扫描 JavaScript/TypeScript。
- **Dependabot** 分组提出 pnpm 与 GitHub Actions 更新，不会自动合并。
- **Release** 只接受 `bugtrace-recorder-v*` 标签，且版本必须与扩展 `package.json` 一致、提交必须能从 `main` 到达。它会把不可变的 zip 和 SHA-256 发布到 GitHub Releases。

Actions 固定到完整 commit SHA，工作流默认 `contents: read`，只有发布 job 拥有 `contents: write`。

## 发布 Bugtrace Recorder

在干净且已更新的 `main` 上选择语义化版本：

```sh
pnpm release:bugtrace:minor
git push origin main --follow-tags
```

需要时改用 `:patch` 或 `:major`。标签格式为 `bugtrace-recorder-v<version>`。工作流会拒绝版本不一致、不在 `main` 上的标签、损坏的 zip，以及已发布 release 上被改动的资产。

## 贡献与安全

开发与评审约定见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。安全问题请按 [`SECURITY.md`](SECURITY.md) 私下报告，不要开公开 issue。

## License

MIT © JUNERDD
