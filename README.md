# CC Sessions Hub

Claude Code 会话工作台，跑在 **DeepSeek Harness（DSH）桌面端**里：在同一个界面中浏览本机 CC 会话、继续对话、审批工具调用、调用 skills、预览文件、查看子代理过程。

> 非官方社区插件，与 DeepSeek、Anthropic 均无隶属关系。

## 功能

- **会话列表**：在线/历史、搜索、归档、摘要、fork、后台任务、终端接管。
- **面板内对话**：打开历史会话直接续聊；发送/停止；SSE 增量（长回答逐字）；加载更早。
- **审批**：允许 / 始终允许（显示写入目标）/ 拒绝；并发审批分卡处理；AskUserQuestion 选择卡（选项、多选、自由输入）。
- **会话设置**：权限模式（默认/计划/自动/接受编辑/不询问）、effort（跟随设置 → max）、思考显示开关；默认 **auto + xhigh + 思考显示关**。
- **命令与 skills**：输入 `/` 或点「命令」出列表，skills 可直接调用；终端专属命令自动过滤。
- **文件预览**：Markdown（含表格）、HTML（sandbox 禁脚本）、PDF、Word/ODT（本机 LibreOffice 转 PDF）、图片、文本。
- **子代理过程**：会话行、对话标题栏都有「子代理（N）」入口，点开直接看，不必先进对话；Task/Agent 卡上也可展开单条。运行中每 1.2s 刷新。
- **完整工具输出**：截断的结果可一键读取转录里的完整内容。

## 环境要求

| 依赖 | 说明 |
|---|---|
| **DSH 桌面端** | 在 `0.2.2-rc.2` 上测试（开发期亦覆盖 rc.1）；插件使用其客户端私有服务（layout / sidebar / slots 等），**DSH 升级可能失效** |
| **Claude Code CLI** | 已在本机 `2.1.323` 上测试；需要已登录，`claude` 在 PATH 或 `CLAUDE_CODE_BIN` |
| **Node.js** | ≥ 22（插件与 SDK 运行在 DSH 主进程） |
| **macOS** | 文件「打开 / Finder」与 LibreOffice 路径按 macOS 实现；Windows/Linux 需自行适配 |
| **LibreOffice**（可选） | Word/ODT 预览需要；未装时提示"用系统应用打开" |

## 安装

```bash
git clone https://github.com/Covertaker/dsh-cc-sessions-hub.git
cd dsh-cc-sessions-hub
npm install

# 装进 desktop profile（会创建 link 依赖；多数版本同时把包加入 bundle 列表）
dsh plugin --profile desktop add link:$PWD
```

确认 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有 `dsh-cc-sessions-hub`；没有则手动加入。**完全退出并重启 DSH**。

安装后，DSH 侧栏出现「CC Sessions Hub」入口。

## 使用

1. 打开侧栏「CC Sessions Hub」。
2. 点会话标题或「对话」进入对话；历史会话直接输入即 resume。
3. 右上「设置」改权限模式 / effort / 思考显示；默认 auto + xhigh + 思考关。
4. 终端里正在跑的会话显示**只读**，点「fork 到面板」才能继续（cc 无文件锁，避免双写分叉）。
5. 「预览文件」可输入绝对路径直接打开；工具卡里的路径也可点「预览」。
6. 会话行或对话标题栏点「子代理（N）」看整个会话的子代理；Task/Agent 卡上可直接展开单条。

## 配置

| 变量 | 作用 |
|---|---|
| `CC_HUB_CHAT=0` | 关闭对话功能，只保留列表/摘要/终端接管（回滚开关） |
| `CC_HUB_WINDOW=60` | 调小单次渲染窗口（默认 250），用于测试分页 |
| `CLAUDE_CODE_BIN` | 指定 `claude` 可执行文件路径 |

## 安全模型

- 插件在**本机 loopback** 上注册 HTTP 路由；每次启动生成随机 token，`/chat/token` 只对同源可读，除 token 与图片原始流外所有请求校验 `x-cc-hub-token`。
- **文件预览可读任意绝对路径**；「打开」会调用系统默认应用（`open`），「Finder」会 `open -R`。仅在本机可信环境使用。
- 插件**不含遥测**，不会把会话内容发往任何地方（除了 Claude Code 自身的模型/API 请求）。
- 面板会话与终端会话使用同一份 `~/.claude` 配置、hooks 与转录；权限行为与终端一致。

## 已知限制

- DSH 私有客户端服务可能随版本升级变化；升级后请先打开面板验证。
- 仅 macOS 验证；文件打开/Word 预览路径为 macOS。
- 历史默认渲染最近 250 条，更多用「加载更早」。
- 工具输出在传输中截断（结果 2500 字、输入 1200 字）；完整内容按需读取。
- **短回答可能直接出结果**：单分片回答的 partial 窗口只有几毫秒，SSE 也可能看不到逐字；长回答可见。
- 终端专属命令（`/status`、`/context`、`/cost` 等）不可用；skills 可用。
- 无模型选择器（模型跟随 CC settings）；无终端快捷键（Esc/Ctrl+C 等），只有「停止」按钮。
- 子代理过程只展开一层；运行中轮询 1.2s。
- 面板会话空闲 30 分钟后回收；下次发送会 resume。

## 开发与测试

```bash
node scripts/smoke-chat.mjs          # 离线：解析/路由/token/审批/预览/SSE/问题卡
node scripts/smoke-chat.mjs --live   # 联网：再加一轮真实模型调用
```

结构：

```
index.js            列表/摘要/fork 路由与 cc_* 工具
host/engine.js      Agent SDK 运行时：常驻进程、流式、审批、中断、回收
host/history.js     JSONL 转录 → 渲染项（含子代理）
host/files.js       文件预览与系统打开
host/routes.js      /_ccpanel/* 路由（Node handler，支持 POST/SSE）
client.js           DSH 主面板 UI（列表 + 对话 + 预览 + 子代理抽屉）
```

运行时用 `@anthropic-ai/claude-agent-sdk` 驱动**本机已装的 `claude`**（`pathToClaudeCodeExecutable`），因此 `~/.claude/settings.json` 的模型、hooks、权限规则全部照常生效；SDK 只负责协议。

## License

MIT. See [LICENSE](LICENSE).
