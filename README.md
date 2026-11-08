<p align="center">
  <img src="./docs/hero.png" alt="omp-web — omp 的浏览器工作台" width="100%">
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-58A6FF?style=flat&colorA=222222" alt="License"></a>
  <img src="https://img.shields.io/badge/omp%20SDK-18.18.1-CB3837?style=flat&colorA=222222" alt="omp SDK 18.18.1">
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4.4-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
</p>

# omp-web

[oh-my-pi（omp）](https://github.com/can1357/oh-my-pi) 编程智能体的 Web 界面。

omp-web 不是另一个 agent。它在服务端进程内直接运行 omp 自己的 SDK，读写的就是 `omp` 命令行使用的 `~/.omp/agent` 目录：终端里开始的会话可以在浏览器里接着聊，反过来也一样；模型、凭据、技能、插件配置两边共用。

## 与上游的关系

本仓库基于以下项目，按 MIT 许可证保留原作者版权：

```
agegr/pi-web  →  ddallabenetta/omp-web  →  n0rthwood/omp-web  →  本仓库
```

相对 `n0rthwood/omp-web` 0.5.17 的改动：

- omp SDK（`@oh-my-pi/*`）从 18.10.4 升级到 **18.18.1**，与当前 `omp` 命令行版本一致；移除了只适用于 18.10.4 的 prelude 补丁。
- 修复新会话不会自动生成标题：omp 18.x 已删除 `providers.tinyModel` 设置（改为 `modelRoles.tiny`），旧代码读取它时会报错。

> npm 上的 `omp-web` 包是上游版本（SDK 18.10.4），不包含以上改动。使用本仓库请按下面的方式从源码运行。

## 功能

- **会话浏览**：按项目分组列出所有 omp 会话，支持搜索、重命名、删除、导出 HTML。
- **实时对话**：流式输出、工具调用卡片、思考过程、上下文用量与费用；刷新页面后自动重连正在运行的会话。
- **旁路提问**：`/btw <问题>` 流式回答，不写入主对话上下文；支持取消和按话题追问，输入 `/btw` 查看与终端共用的本会话历史。打开会话直接读取旁路历史，不启动空闲 agent；仅正在回答的旁路回合订阅 SSE。
- **SDK 会话事件**：SSE 连接期间同步模型、思考等级与手动压缩状态；工具卡片实时显示运行中的输出和编辑预览；通知显示回退模型、TTSR 规则、Advisor 费用与审阅完成、Agent 间消息和配置警告，待办提醒复用任务清单。空闲订阅沿用原有 30 秒宽限期。
  累计工具输出按调用合并，每 250ms 最多推送一帧；结束时取消待发预览，SDK 的工具流投影保持即时推送。
- **分支与派生**：从任意一条消息继续（会话内分支），或派生出独立的新会话。
- **模型角色**：按工作类型（`default`、`smol`、`slow`、`plan`、`commit`、`task` 等）分配模型，与 TUI 的 `/model` 写入同一份配置。
- **计划模式**：先让 agent 起草计划，确认后再执行。
- **排队与循环**：`/queue <message>` 空闲时立即发送，运行中等待 agent 让出；`/loop [次数|时长] [--while|--until '<命令>'] [提示]` 重复下一条或内联提示，次数包含首次运行，条件从第二次起按退出码判断。再次 `/loop` 关闭，中止会暂停并在下一条提示时恢复；输入框附近可查看状态并关闭。
- **后台旁支**：`/tan <work>` 复用 SDK 的后台会话克隆与作业管理，在子 agent 面板查看，完成结果显示在当前对话。
- **项目文件**：侧边栏文件树，预览源码、Markdown、图片、音频、PDF、DOCX，查看 Git diff，切换 Git worktree。
- **内部资源链接**：聊天中的 `agent://`、`artifact://`、`local://`、`memory://`、`issue://`、`pr://`、`skill://`、`rule://`、`omp://` 链接与独立行内代码可在右侧标签页只读打开；读取绑定原会话，历史会话无需启动 agent。
- **网页配置**：管理模型提供方、OAuth 登录与 API Key、`models.yml`、插件和技能。
- **目标模式**：`/goal` 打开目标编辑或管理弹窗，可设置 token 预算、暂停、恢复和放弃目标；目标完成后显示通知。`/login`、`/logout` 打开提供方认证，`/skills` 打开技能设置。
- **终端标签页**（可选）：在工作区里开一个真实的 shell。
- **多语言界面**：简体中文、English。
- **主题**：直接使用 omp 的明暗主题配色。

## 截图

| 会话与文件浏览 | 实时对话 |
| --- | --- |
| ![会话列表与文件树](./docs/screenshots/01-sidebar-and-explorer.png) | ![对话界面](./docs/screenshots/02-chat-session.png) |
| **文件预览** | **模型角色配置** |
| ![文件预览](./docs/screenshots/03-file-preview.png) | ![模型角色](./docs/screenshots/04-settings.png) |

## 快速开始

### 环境要求

- [Bun](https://bun.sh) **1.4.4 或更高**（omp SDK 18.18.1 的要求）。omp SDK 以 TypeScript 源码发布并依赖 `bun:` 内置模块，服务端只能在 Bun 上运行。
- 已安装并配置过 [omp](https://github.com/can1357/oh-my-pi)（至少有一个可用的模型提供方）。没配置也能启动，可以在网页的「模型」面板里登录或填写 API Key。

### 安装与启动

```bash
git clone https://github.com/MoYiC6/omp-web.git
cd omp-web
bun install
bun run build
bun bin/omp-web.js
```

服务就绪后会自动打开浏览器，地址是 <http://127.0.0.1:30141>，默认只监听本机。

### 启动参数

```bash
bun bin/omp-web.js --port 8080         # 指定端口（也可用环境变量 PORT）
bun bin/omp-web.js --hostname 0.0.0.0  # 指定监听地址（也可用 OMP_WEB_HOSTNAME）
bun bin/omp-web.js --no-open           # 不自动打开浏览器（也可用 OMP_WEB_NO_OPEN=1）
```

常用环境变量：

| 变量 | 作用 |
| --- | --- |
| `OMP_WEB_PASSWORD` | 开启 HTTP Basic 认证，用户名 `omp`；未设置时不认证 |
| `OMP_WEB_ALLOWED_HOSTS` | 反向代理使用的外部域名，逗号分隔，需精确匹配 |
| `OMP_WEB_TERMINALS=1` | 启用终端标签页（默认关闭） |
| `OMP_WEB_BUN` | 指定使用的 Bun 可执行文件路径 |
| `PI_CODING_AGENT_DIR` | 使用其他 omp 数据目录（默认 `~/.omp/agent`） |
| `HTTP_PROXY` / `HTTPS_PROXY` | 服务端请求模型 API 时使用的代理 |

## 安全说明

omp-web 能驱动一个可以读写文件、执行命令的 agent，**能访问这个页面的人就能操作你的电脑**。

- 默认只监听 `127.0.0.1`，本机使用无需额外配置。
- 需要在局域网或远程访问时，务必开启认证：设置 `OMP_WEB_PASSWORD`，或配置网页用户（登录页、角色、每个用户可见的项目、CLI Token），详见 [docs/web-users.md](./docs/web-users.md)。开启认证后，包括本机 `curl` 在内的所有请求都需要凭据。
- 不要把纯 HTTP 端口暴露到公网，请通过 HTTPS 反向代理或 VPN 访问。
- 终端标签页等同于一个完整 shell。在非本机地址上，未开启认证时它会拒绝启用。
- 打开一个项目不会执行它的代码：项目内的 `.omp/extensions`、`.omp/hooks`、`.omp/tools` 和 `.mcp.json` 需要你明确信任后才会加载，详见 [docs/project-trust.md](./docs/project-trust.md)。

## 使用说明

- **数据位置**：会话文件在 `~/.omp/agent/sessions/<编码后的 cwd>/<时间戳>_<uuid>.jsonl`；凭据存在 omp 的 `agent.db`，与命令行共用。
- **不要同时打开同一个会话**：同一个会话不要在 omp-web 和终端里同时运行，两边会同时追加写入同一个文件。
- **重启会中断对话**：浏览器里的会话运行在服务进程内，重启服务会中止所有正在进行的回合。
- **会话标题**：按 omp 的 `tiny → commit → smol` 角色链选择模型生成，不占用会话主模型。配置了本地 tiny 模型（`modelRoles.tiny: local/<id>`）时只用本地模型。
- **HTML 导出**：omp 18.18.1 导出的 HTML 从 stencil.so 加载查看器脚本，打开时需要联网。
- **代理**：Bun 只在启动时读取一次 `HTTP_PROXY` / `HTTPS_PROXY`，且不支持 `NO_PROXY`；如果使用 Ollama、LM Studio 等本地模型服务，注意代理可能也作用于本地地址。
- **Git worktree**：见 [docs/worktrees.zh-CN.md](./docs/worktrees.zh-CN.md)。
- **界面翻译**：见 [docs/i18n.md](./docs/i18n.md)。

## 开发

```bash
bun install
bun run dev        # 开发服务器，http://127.0.0.1:30141
bun run typecheck
bun run lint
bun test           # 需要用 bun test，Node 无法加载 omp SDK
```

- 开发期间不要运行 `bun run build`：它会覆盖 `.next/`，干扰正在运行的开发服务器。
- 不要用 `next dev` 测性能：开发模式每个 API 请求慢约 800ms，生产构建只有几毫秒。
- 升级到 SDK 18.18.1 后，测试套件有 22 个失败，与升级前（18.10.4）完全相同，属于上游已有问题。

### 目录结构

```text
app/api/        Next.js API 路由：agent（会话与 SSE）、sessions、files、models、auth、skills、plugins …
components/     React 界面：AppShell、SessionSidebar、ChatWindow、ChatInput、MessageView、FileViewer …
hooks/          useAgentSession（会话加载、命令发送、SSE 状态机）等
lib/            服务端逻辑：rpc-manager（AgentSession 生命周期）、omp-runtime、session-reader、session-title …
bin/            omp-web.js 启动入口：查找 Bun 并以生产模式启动服务
docs/           认证、项目信任、worktree、多语言等文档
```

更详细的架构说明和已知陷阱见 [AGENTS.md](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)。原始代码版权归 [pi-web](https://github.com/agegr/pi-web) 及各上游 fork 作者所有。
