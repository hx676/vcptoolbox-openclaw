# OpenClaw + VCP 集成工作逻辑

## 文档定位

本文档专门说明 `OpenClaw -> VCPToolBox -> VCPChat` 的真实工作链路，重点回答以下问题：

- OpenClaw 到底如何调用 VCP
- 记忆搜索、知识检索、长期记忆写入分别走哪条链
- 渠道消息、工具结果、知识问答结果如何落盘归档
- VCPChat 为什么能在主列表里看到飞书 / 微信镜像会话

本文档只描述当前仓库里已经实现的逻辑，不写未来规划版流程。

## 一句话架构

在当前这套部署中，职责划分固定为：

- `OpenClaw`：负责渠道接入、会话调度、短期 session、定时任务、skills
- `VCPToolBox`：负责工具执行、知识库 / 记忆搜索、长期记忆写入、镜像落盘
- `VCPChat`：负责镜像会话可视化查看，不直接承担 OpenClaw 主回复链

## 关键入口

### OpenClaw 插件入口

OpenClaw 侧实际安装的是这个本地插件包：

- `VCPChat/OpenClawmodules/vcp-openclaw-bridge`

关键文件：

- `VCPChat/OpenClawmodules/vcp-openclaw-bridge/index.js`
- `VCPChat/OpenClawmodules/vcp-openclaw-bridge/src/client.js`
- `VCPChat/OpenClawmodules/vcp-openclaw-bridge/README.md`

### VCPToolBox 集成接口入口

VCP 后端集成入口固定挂在：

- `/v1/integrations/openclaw/*`

关键文件：

- `VCPToolBox/server.js`
- `VCPToolBox/routes/openclawIntegrationRoutes.js`
- `VCPToolBox/modules/openclaw/channelMirrorStore.js`

## 安全边界

OpenClaw 集成接口不是公网开放接口，当前实现有两层硬限制：

1. 必须是 loopback 请求
   - 只允许 `127.0.0.1` / `::1` 一类本机来源
2. 必须携带共享令牌
   - 令牌来自 `OPENCLAW_VCP_SHARED_TOKEN`

如果未满足这两个条件，请求会直接被拒绝。

## OpenClaw 到 VCP 的 4 条主链

### 1. 工具执行链

OpenClaw 插件把部分 VCP 能力注册成 OpenClaw 工具，当前包括：

- `vcp_url_fetch`
- `vcp_vsearch`
- `vcp_bilibili_fetch`

调用路径是：

1. OpenClaw 调用插件工具
2. 插件向 `POST /v1/integrations/openclaw/tools/execute` 发请求
3. `VCPToolBox` 在 allowlist 内校验工具名
4. `pluginManager.processToolCall()` 执行真实 VCP 工具
5. 结果归一化后回给 OpenClaw
6. 如果当前渠道启用了镜像，则额外写一条 `system` 镜像事件到 `ChannelMirrorData`

工具 allowlist 来自：

- `OPENCLAW_VCP_TOOL_ALLOWLIST`

默认 allowlist 是：

- `UrlFetch`
- `VSearch`
- `BilibiliFetch`

### 2. 记忆搜索链

OpenClaw 侧暴露给模型的记忆搜索工具名是：

- `vcp_memory_search`

实际走的是：

1. OpenClaw 插件调用 `POST /v1/integrations/openclaw/memory/search`
2. `VCPToolBox` 使用 embedding 接口先把查询词向量化
3. 调用 `knowledgeBaseManager.search(...)`
4. 返回结构化结果：
   - `items`
   - `summary`
   - `debug`

这条链的定位是：

- 面向 OpenClaw 的“直接知识 / 记忆检索”
- 返回的是检索命中，不是最终自然语言代答

换句话说，`vcp_memory_search` 是“查资料”，不是“替你回答”。

### 3. 知识库智能体问答链

如果 OpenClaw 想直接调用 VCP 的知识库智能体，而不是自己拼检索结果，就走：

- `vcp_kb_agent_ask`

实际链路是：

1. OpenClaw 插件调用 `POST /v1/integrations/openclaw/kb/ask`
2. `VCPToolBox` 先检查 `agentAlias` 是否存在于 `agent_map.json`
3. 然后构造一组本地 VCP chat 请求：
   - 默认走 `/v1/chat/completions`
   - `showVcp = true` 时走 `/v1/chatvcp/completions`
4. system prompt 中会注入 `{{agentAlias}}`
5. 再补一段固定提示，要求这个智能体优先使用自己的知识库、记忆和 VCP 工具回答
6. 从返回结果里抽取 assistant 最终文本，回给 OpenClaw

默认 agent 和模型来自：

- `OPENCLAW_VCP_DEFAULT_KB_AGENT`
- `OPENCLAW_VCP_KB_MODEL`

这条链的定位是：

- 不是普通检索
- 而是“把问题转交给 VCP 内部某个知识库智能体来答”

所以当前推荐理解为：

- `vcp_memory_search` = 原始检索
- `vcp_kb_agent_ask` = 智能体代答

### 4. 长期记忆写入链

OpenClaw 侧暴露给模型的长期记忆写入工具名是：

- `vcp_memory_write`

实际链路是：

1. OpenClaw 插件调用 `POST /v1/integrations/openclaw/memory/write`
2. `VCPToolBox` 将请求体整理成 `DailyNoteWrite` 所需结构
3. 最终通过 `pluginManager.executePlugin('DailyNoteWrite', ...)` 执行真实写盘
4. 返回 `savedPath`
5. 如果当前渠道启用了镜像，还会再写一条 `system` 镜像事件，记录这次写入成功或失败

### 记忆写入会写到哪里

长期记忆的根目录来自：

- `KNOWLEDGEBASE_ROOT_PATH`
- 如果未配置，则回退到 `VCPToolBox/dailynote`

`memory/write` 请求体里的 `notebook` 会变成日记本目录名。最终典型落盘路径形态是：

```text
VCPToolBox/dailynote/<notebook>/<date>_<agent>_<title>.md
```

或者时间戳文件名模式：

```text
VCPToolBox/dailynote/<notebook>/<date>-<HH_mm_ss>.md
```

写入内容里会保留：

- 标题
- 正文
- Tag 行
- notebook / agent / date 元信息

默认 notebook、默认写入 agent、默认时区分别来自：

- `OPENCLAW_VCP_DEFAULT_NOTEBOOK`
- `OPENCLAW_VCP_DEFAULT_MEMORY_AGENT`
- `DEFAULT_TIMEZONE`

## 渠道消息如何镜像落盘

### 镜像入口

所有渠道镜像统一写入：

- `POST /v1/integrations/openclaw/mirror/session-event`

这个接口最终调用：

- `ChannelMirrorStore.appendSessionEvent(payload)`

### 落盘根目录

镜像根目录来自：

- `CHANNEL_MIRROR_ROOT_PATH`
- 如果未配置，则回退到 `VCPToolBox/ChannelMirrorData`

### 目录结构

单个会话的落盘结构固定为：

```text
ChannelMirrorData/
└─ <channel>/
   └─ <base64url(conversationId)>/
      ├─ session.json
      └─ topics/
         └─ main/
            ├─ topic.json
            └─ history.json
```

其中：

- `session.json`：会话元信息
- `topic.json`：当前主题元信息，默认只有 `main`
- `history.json`：时间线事件列表

### history.json 里会写什么

每条镜像事件都会标准化为：

- `id`
- `mirrorMessageId`
- `direction`
- `source`
- `role`
- `name`
- `content`
- `attachments`
- `toolCalls`
- `memoryHits`
- `metadata`
- `timestamp`

这里的 `direction` 典型包括：

- `inbound`
- `outbound`
- `system`

### 什么情况下会写镜像

当前 OpenClaw 插件会在这些节点写镜像：

1. 收到渠道入站消息
   - 记为 `inbound`
2. OpenClaw 成功发出回复
   - 记为 `outbound`
3. 渠道发送失败
   - 记为 `system`
4. 通过 VCP 调用了工具
   - 记为 `system`
5. 通过 VCP 做了 `memory_write`
   - 记为 `system`
6. 通过 VCP 做了 `kb_agent_ask`
   - 记为 `system`

也就是说，镜像里不仅有聊天消息，也有“知识问答结果”“工具调用结果”“长期记忆写入结果”。

## VCPChat 为什么能看到这些镜像

VCPChat 不直接读 OpenClaw 自己的内部存储格式，它读的是 `VCPToolBox` 写出来的镜像目录。

前端读取链路是：

1. Electron IPC 读取 `CHANNEL_MIRROR_ROOT_PATH` 或默认 `VCPToolBox/ChannelMirrorData`
2. 扫描每个 `session.json`
3. 把它们包装成 `channel_mirror` 类型的会话项
4. 在主列表中显示成只读会话

对应代码入口在：

- `VCPChat/modules/ipc/channelMirrorHandlers.js`

## 为什么有时 VCPChat 能看到比 history.json 更多的回复

因为 `VCPChat` 额外做了一层“补全回填”。

它会去读取 OpenClaw 本地 session JSONL：

```text
%USERPROFILE%\\.openclaw\\agents\\<agentId>\\sessions\\*.jsonl
```

然后按 `message_id` 关联，补出：

- assistant 真正发出的文本回复
- 通过 OpenClaw `message.send` 发出的文件附件

当前内置的渠道到 agentId 映射是：

- `feishu -> feishu`
- `openclaw-weixin -> weixin`
- `qqbot -> qq`

所以你在 VCPChat 里看到的完整时间线，通常来自两层数据合并：

1. `ChannelMirrorData/.../history.json`
2. `~/.openclaw/agents/.../sessions/*.jsonl` 的补全结果

## 当前推荐工作方式

如果你希望职责清晰、后续可维护，当前建议固定采用下面的分工：

- 短期上下文、渠道接入、skills、定时任务：交给 OpenClaw
- 原始知识检索：交给 `vcp_memory_search`
- 知识库智能体代答：交给 `vcp_kb_agent_ask`
- 长期记忆写入：交给 `vcp_memory_write`
- 工具执行：交给 VCP allowlist 工具接口
- 可视化回看：交给 VCPChat 的 `channel_mirror`

## 关键配置项速查

| 配置项 | 作用 |
| --- | --- |
| `OPENCLAW_VCP_SHARED_TOKEN` | OpenClaw 与 VCP 之间的共享 Bearer Token |
| `OPENCLAW_VCP_TOOL_ALLOWLIST` | OpenClaw 允许调用的 VCP 工具白名单 |
| `OPENCLAW_VCP_DEFAULT_NOTEBOOK` | `memory/write` 默认写入的 notebook |
| `OPENCLAW_VCP_DEFAULT_MEMORY_AGENT` | `memory/write` 默认写入时使用的 agent 名 |
| `OPENCLAW_VCP_DEFAULT_KB_AGENT` | `kb/ask` 默认知识库智能体 |
| `OPENCLAW_VCP_KB_MODEL` | `kb/ask` 默认模型 |
| `CHANNEL_MIRROR_ROOT_PATH` | 会话镜像根目录 |
| `KNOWLEDGEBASE_ROOT_PATH` | 长期知识库 / 记忆的根目录 |
| `DEFAULT_TIMEZONE` | 记忆写入默认时区 |

## 最后结论

如果只记一句话，当前实现的真实逻辑是：

> OpenClaw 负责“聊”和“调度”，VCP 负责“查、写、归档和可视化”，VCPChat 负责“把归档后的会话和补全后的时间线展示出来”。
