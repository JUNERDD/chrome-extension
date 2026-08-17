# Chrome Extension Collection

这是一个基于 WXT 的私有 Chrome Extension 合集。首个扩展 **Bugtrace Recorder** 用于记录测试人员的 bug 复现过程，并生成便于粘贴到工单、也便于 Agent 解析的本地证据包。

| Extension | 状态 | 用途 |
| --- | --- | --- |
| Bugtrace Recorder | Internal MVP | 录制安全边界内的浏览器操作、导航与有限诊断，导出 Markdown + `.bugtrace.zip`。 |

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
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @juner/bugtrace-recorder exec playwright install chromium
pnpm --filter @juner/bugtrace-recorder test:e2e
```

## 安装到 Chrome（load unpacked）

1. 执行 `pnpm build`。
2. 打开 `chrome://extensions`，启用右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择 `extensions/bugtrace-recorder/.output/chrome-mv3`。
5. 建议把 Bugtrace Recorder 固定到工具栏，并在 `chrome://extensions/shortcuts` 检查或修改快捷键。

开发模式使用 `pnpm dev:bugtrace`；WXT 会生成开发构建并监听源码变化。该项目目前只面向私有仓库和 unpacked/internal 使用，不是 Chrome Web Store 发行包。

## 使用方式

在需要复现 bug 的普通 `http://` 或 `https://` 页面上打开 popup，然后：

1. **Start recording**：以当前 tab 为根开始录制；由该 tab 打开的子 tab/弹窗也会进入 scope。
2. **Pause**：停止持久化页面证据，并关闭当前 rrweb segment。
3. **Resume**：继续同一个 session，并以新的 rrweb full snapshot 开段。
4. **Stop & review**：先 flush 可达页面，再打开 results 页审核、补充报告并导出。

Chrome commands 的建议绑定如下；最终绑定由 Chrome 管理，扩展不能自行覆盖冲突：

| 操作 | Windows/Linux | macOS |
| --- | --- | --- |
| Record | `Alt+Shift+R` | `Control+Shift+R` |
| Pause | `Alt+Shift+P` | `Control+Shift+P` |
| Resume | `Alt+Shift+C` | `Control+Shift+C` |
| Stop | `Alt+Shift+S` | `Control+Shift+S` |

## 权限与隐私边界

Bugtrace Recorder 是本地工具：没有云上传、遥测或剪贴板读取。会话元数据保存在 `chrome.storage.local`，事件与资源保存在扩展自己的 IndexedDB；过期会话默认在最后活动 24 小时后由下次启动清理，也可在 options 中删除。

| 权限 | 原因 |
| --- | --- |
| `activeTab` | 在用户通过 popup 或快捷键授权的当前 tab 上生成已遮罩的可见区域截图。 |
| `storage` | 保存权威状态、事件、截图与本地保留信息。 |
| `webNavigation` | 记录 scoped tab 的普通导航、SPA/history/hash 导航及失败。 |
| `webRequest` | 记录方法、脱敏 URL、资源类型、状态、耗时和少量安全响应 header。 |
| `http://*/*`, `https://*/*` | 在获准网页中注入休眠采集器，并仅在当前 session scope 内启用。 |

固定隐私规则：

- 所有 input、textarea、select 和 contenteditable 的值均不保存，只记录脱敏状态、类型及粗粒度长度范围。
- URL query value 与 fragment 被遮蔽；敏感或高熵 path segment 使用会话内不可逆伪名。
- 不读取 Cookie、Web Storage、IndexedDB、Authorization、请求/响应 body 或 WebSocket message。
- console 只采集限额后的 `warn`/`error`；页面文本、console 和错误均标为 `untrusted_observation`。
- 截图只覆盖当前可见 viewport；输入和显式敏感区域会在写入 IndexedDB 前以纯色遮罩。
- 不申请 `debugger`、`downloads`、`scripting`、`tabs` 或 `unlimitedStorage`。

宽泛 HTTP(S) host permission 会触发 Chrome 的安装提示，这是 internal MVP 的已知权衡；公开发布前需要改为 optional host permission 流程。

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
└── screenshots/shot-0001.webp
```

`trace.json`（`formatVersion: 1.0.0`）是 Agent 的规范数据源；`report.md` 是可直接粘贴的摘要；`attachments/lifecycle.json` 保存映射后的 tab/window/session 生命周期；rrweb 与截图只是经过脱敏的辅助证据。manifest 为每个文件记录 SHA-256、大小、MIME 和用途。coverage 与 capture gaps 会明确声明缺失、截断或不支持的证据，不能把“未捕获”解释为“未发生”。

## 已知限制

- 只覆盖一个根 tab 及其后代，不记录无关 tab；同一 Chrome profile 同时最多一个 session。
- 无法记录 `chrome://`、Chrome UI、扩展页、系统/原生对话框、`file://`、内置 PDF、incognito、closed shadow root 或 canvas/WebGL 内部语义。
- 不是视频录屏；rrweb 是历史 DOM 证据，不保证可以对真实后端自动重放。
- 跨源 iframe 分别采集，未获权限、断联、消息溢出或 stop flush 超时会成为显式 gap。
- Manifest V3 Service Worker 被回收后会从持久状态恢复并声明网络关联 gap；整个浏览器重启后不会静默续录，会话进入 `interrupted`。用户选择 Resume 时，必须从当前受支持的 HTTP(S) 页面显式重绑定为新 root，并记录不可恢复的 lineage gap；也可以直接 Stop 导出已有的部分证据。
- 网络层不保存 body、敏感 header、WebSocket 内容；console 与截图也不是完整 DevTools 保真。
- 截图遮罩依赖顶层页面可报告的敏感 DOM rect；跨源 iframe 会整块遮罩。Chrome 只允许对获得临时 `activeTab` 授权的当前页面截图，后代或跨源页面无授权时会记录 screenshot gap；导出前仍应人工复查。

## 自动验证覆盖

CI 执行 lint、TypeScript、unit/contract tests、WXT production build，以及 Playwright Chromium 扩展测试。当前独立验收为 9 个测试文件 / 95 个 unit-contract tests 与 5 个 Chromium E2E 全部通过。浏览器 E2E 实际覆盖：生产 manifest 权限/CSP 白名单、popup idle、真实 HTTP fixture 的 record/pause/resume/stop、立即 stop flush、同页第二会话、受限页启动失败的状态原子性、输入/query/console/network/CSS/ARIA/Unicode PAN/暂停期哨兵不进入 IndexedDB 或最终 ZIP、lifecycle 附件，以及浏览器重启后显式进入 `interrupted`。Service Worker 单独强杀/BFCache、跨源 iframe、容量退化及截图像素级遮罩仍是人工或后续自动化项目，未宣称已覆盖。

完整范围与安全决策见 [批准的实现计划](docs/plans/2026-08-17-chrome.md)。
