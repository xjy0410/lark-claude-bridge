# lark-claude-bridge

飞书/Lark <-> Claude Code Agent 协作桥接器。通过飞书群聊与 Claude Code Agent 交互，支持多 Agent、Session 管理、流式卡片输出、工具调用折叠等功能。

## 功能

- **多 Agent 隔离** — 每个飞书群绑定一个独立 Agent，互不干扰
- **Session 管理** — 查看/接管/新建 CLI session，支持 fork 和 resume
- **流式卡片输出** — 实时流式更新飞书卡片，按步骤分段显示
- **工具调用折叠** — Bash、Read、Edit 等工具调用默认折叠为 collapsible panel
- **Status 置顶** — 工作时自动置顶状态消息（thinking / running...）
- **CLI 共存** — 检测 CLI 占用，提供 watch/fork/kill 选项
- **定时巡检** — 支持 cron 定时任务（日报、监控等）
- **访问控制** — 支持 open/allowlist 模式
- **多终端支持** — 多台机器共用 Manager 群，心跳上报在线状态
- **macOS/Linux 自启动** — launchd / systemd 配置

## 架构

```
飞书 WebSocket (lark-cli event subscribe)
  → Bridge (NDJSON parser)
  → Router (chat_id → group config)
  → Queue (per-group serial, cross-group parallel)
  → Agent (Python SDK subprocess, session resume)
  → Reply Engine (step-based streaming cards)
  → lark-cli (send/reply/patch)
  → 飞书群聊
```

## 快速开始

### 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| [Bun](https://bun.sh) | >= 1.0 | 运行时 |
| Python | >= 3.10 | Agent worker |
| Node.js | >= 18 | 安装 lark-cli |
| Claude Code | latest | `claude` 命令可用 |
| 飞书自建应用 | — | 需配置权限和事件 |

### 安装

```sh
git clone https://github.com/xjy0410/lark-claude-bridge.git
cd lark-claude-bridge
bun install
pip3 install claude-agent-sdk
npm install -g @anthropic-ai/lark-cli
```

### 配置飞书应用

1. 在 [飞书开放平台](https://open.feishu.cn) 创建自建应用
2. 添加**机器人**能力
3. 配置权限（应用身份）：
   - `im:message` — 获取与发送消息
   - `im:message:send_as_bot` — 机器人发消息
   - `im:message:patch` — 更新消息（流式必需）
   - `im:reaction` — 表情回复
   - `im:chat` — 群组管理
4. 事件订阅 → **WebSocket 长连接模式**：
   - `im.message.receive_v1`
5. 将机器人加入目标群聊

### 配置 lark-cli

```sh
echo "YOUR_APP_SECRET" | lark-cli config init \
  --app-id cli_xxxxxxxxxx \
  --app-secret-stdin \
  --brand feishu
```

### 创建配置

```sh
mkdir -p ~/.lark-channel/agents
cp config.example.yaml config.yaml
```

编辑 `config.yaml`：

```yaml
settings:
  session_ttl: 7d
  max_concurrent: 10
  default_model: claude-opus-4-6
  python: python3
  terminal_name: MacBook
  # heartbeat_doc: https://xxx.feishu.cn/docx/xxx

access:
  policy: open
  allowed_senders: []
```

### 创建 Agent

每个 Agent 是 `~/.lark-channel/agents/` 下的一个 `.md` 文件：

```markdown
---
chat_id: oc_你的群聊ID
name: assistant
cwd: ~/workspace
permission_mode: bypassPermissions
---

你是一个全能助手 Agent。用用户的语言回复，回复简洁。
```

### 启动

```sh
bun start
```

## Agent 配置字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `chat_id` | 是 | 飞书群聊 ID（oc_xxx） |
| `name` | 否 | Agent 名称（默认取文件名） |
| `cwd` | 否 | 工作目录（支持 `~/`） |
| `permission_mode` | 否 | `default` / `acceptEdits` / `bypassPermissions` |
| `session_id` | 否 | 绑定已有 CLI session（用于接管） |
| `is_manager` | 否 | 是否为 manager 群（启用管理命令） |
| `schedule` | 否 | 定时任务列表 |

### 定时任务

```yaml
schedule:
  - cron: "0 9 * * 1-5"
    prompt: "检查所有服务状态，汇总报告"
```

### 共享能力块

以 `_` 开头的文件不会被当作 Agent，而是作为共享上下文注入所有 Agent 的 persona：

```sh
# ~/.lark-channel/agents/_feishu_workspace.md
# 内容会追加到每个 Agent 的系统提示词中
```

## 群聊命令

### Manager 群

| 命令 | 说明 |
|------|------|
| `sessions` | 列出所有活跃 CLI session（含上下文摘要） |
| `use <N>` | 查看 session N 详情 |
| `takeover <N> <name>` | 接管 session，创建新群 `<name> [MacBook]` |
| `new <name>` | 创建新工作空间 |
| `help` | 显示命令列表 |

### 工作群

| 命令 | 说明 |
|------|------|
| `update` | 显示 CLI 端新活动 |
| `watch` | 查看当前 session 状态 |
| `fork` | Fork session，独立继续 |
| `kill-cli` | 终止 CLI 进程，切换到飞书 |
| `end` | 结束工作空间（需确认，解散群，保留上下文） |
| `help` | 显示命令列表 |

## 卡片输出逻辑

每个回复按步骤分段，每步一张卡片：

```
┌─────────────────────────────────┐
│ 我来看一下这个文件。             │  ← 步骤文字（流式更新）
│─────────────────────────────────│
│ ▶ Read server.ts         [折叠] │  ← collapsible_panel
│ ▶ Bash `npm test`        [折叠] │  ← collapsible_panel
└─────────────────────────────────┘
┌─────────────────────────────────┐
│ 测试通过了，已修复。             │  ← 最终步骤
│─────────────────────────────────│
│ ▶ Edit utils.ts          [折叠] │
│                                 │
│ 3 tools · 12s                   │  ← footer
└─────────────────────────────────┘
```

工作时自动置顶状态消息：`[MacBook] thinking...` → `[MacBook] running: Bash npm test...` → 完成后取消。

## 多终端支持

多台机器（MacBook、Linux 服务器等）可以共用一个 Manager 群，每台部署独立的飞书应用 + lark-channel 实例。

### 工作原理

- 每台机器配置不同的 `terminal_name`
- 飞书群聊中 bot 默认只收到 @自己的消息 → 天然隔离
- 每台机器独立的 `~/.lark-channel/` → session 存储天然隔离
- 通过共享飞书文档实现心跳上报

### 配置

```yaml
settings:
  terminal_name: MacBook                              # 终端标识
  heartbeat_doc: https://xxx.feishu.cn/docx/xxx       # 心跳文档 URL
```

### 心跳机制

1. 每个终端每 5 分钟读取心跳文档 → 更新自己的状态 → 写回
2. 同时更新 Manager 群的置顶消息，显示所有终端状态：
   ```
   🟢 MacBook (3 sessions, 2m ago)
   🟢 Linux-Server (1 session, 4m ago)
   🔴 Office-PC (offline, 6h ago)
   ```
3. 超过 10 分钟未更新的终端自动标记为 offline

### 部署第二台机器

1. 在飞书开放平台创建新的自建应用（每台机器一个 bot）
2. 将新 bot 加入同一个 Manager 群
3. 配置不同的 `terminal_name`，相同的 `heartbeat_doc`
4. 在 Manager 群中 @对应 bot 即可操作对应终端

## 系统自启动

### macOS (launchd)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.lark-channel</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.bun/bin/bun</string>
    <string>run</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$HOME/lark-claude-bridge</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.lark-channel/lark-channel.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.lark-channel/lark-channel.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
```

保存到 `~/Library/LaunchAgents/com.lark-channel.plist`（替换 `$HOME` 为实际路径），然后：

```sh
launchctl load ~/Library/LaunchAgents/com.lark-channel.plist
```

### Linux (systemd)

```ini
[Unit]
Description=Lark Claude Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/lark-claude-bridge
ExecStart=%h/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=5
Environment=PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

保存到 `~/.config/systemd/user/lark-channel.service`，然后：

```sh
systemctl --user daemon-reload
systemctl --user enable --now lark-channel
```

## 一键配置提示词

在新机器上用 Claude Code 一键配置，复制以下提示词：

```
帮我在这台机器上安装和配置 lark-claude-bridge：

1. 安装 Bun: curl -fsSL https://bun.sh/install | bash
2. 克隆项目: git clone https://github.com/xjy0410/lark-claude-bridge.git && cd lark-claude-bridge && bun install
3. 安装 Python SDK: pip3 install claude-agent-sdk
4. 安装 lark-cli: npm install -g @anthropic-ai/lark-cli
5. 配置 lark-cli（我会提供 App ID 和 Secret）
6. 给这台终端起一个名字（如 MacBook、Linux-Server），写入 config.yaml 的 terminal_name 字段，新建工作群时会加上该后缀
7. 创建 ~/.lark-channel/agents/ 目录和配置文件
8. 创建 config.yaml（包含 terminal_name 和 heartbeat_doc）
9. 配置系统自启动（macOS 用 launchd，Linux 用 systemd）
10. 启动服务并验证

每步完成后确认再继续。
```

## 项目结构

```
├── src/
│   ├── index.ts        # 主入口 + 管理命令
│   ├── agent.ts        # Agent SDK 子进程管理
│   ├── reply.ts        # 步骤分段流式卡片引擎
│   ├── router.ts       # 配置加载 + chat_id 路由
│   ├── sessions.ts     # Session 持久化 + CLI 发现
│   ├── bridge.ts       # 飞书 WebSocket 事件桥接
│   ├── queue.ts        # 并发队列
│   ├── access.ts       # 访问控制
│   ├── patrol.ts       # 定时巡检
│   ├── heartbeat.ts    # 多终端心跳上报
│   └── lark.ts         # lark-cli 命令封装
├── agent_worker.py     # Python Agent SDK worker
├── config.example.yaml # 配置模板
├── package.json
└── tsconfig.json
```

## 开发

```sh
bun dev          # watch 模式
bun run check    # 类型检查
```

## License

MIT
