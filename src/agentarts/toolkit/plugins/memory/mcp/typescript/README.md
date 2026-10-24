# agentarts-memory-mcp

AgentArts Memory（华为云）的 MCP 服务器，TypeScript 实现，**运行时零依赖**。

为什么不用 Python 版：Python 版依赖 `agentarts-sdk`（连带 `mcp`、`requests` 等一串包），
部署负担重；本包构建后产出**单个 `dist/index.mjs`（约 740KB，所有依赖已内联）**，
运行时零依赖——目标机器只需要 Node >= 18，不需要 Python 环境。

## 它提供什么

只读召回（recall）工具 ×3——写入由平台 hooks / 插件负责，MCP 只暴露检索：

| Tool | 参数 | 说明 |
| --- | --- | --- |
| `search_memories` | `query`, `num=5`, `threshold=0.7` | 语义检索云端记忆 |
| `list_memories` | `limit=10`, `offset=0` | 分页列出记忆记录 |
| `search_summary` | `query`, `num=3` | 检索摘要类记忆（summary/episodic/user_preference），无结果时回退到列表 |

## 快速开始

```bash
npm install
npm run build              # typecheck + esbuild bundle -> dist/index.mjs
node dist/index.mjs        # stdio transport，进程由 MCP 宿主拉起
```

`dist/index.mjs` 是构建产物（不进 git），把所有依赖内联成一个文件，
部署时只需要这一个文件 + Node。

## 配置（环境变量）

| 变量 | 必填 | 说明 | 默认 |
| --- | --- | --- | --- |
| `HUAWEICLOUD_SDK_MEMORY_API_KEY` | ✅ | 数据面 API Key（Bearer 认证） | — |
| `AGENTARTS_MEMORY_SPACE_ID` | ✅ | Space ID | — |
| `HUAWEICLOUD_SDK_REGION` | | 区域（也认 `HUAWEICLOUD_REGION` / `OS_REGION_NAME`） | `cn-southwest-2` |
| `AGENTARTS_MEMORY_DATA_ENDPOINT` | | 数据面地址覆盖 | `https://memory.{region}.huaweicloud-agentarts.com` |
| `AGENTARTS_MEMORY_USER_ID` | | 记忆 actor_id | 按平台推断：`cc-user` / `codex-user` / `opencode-user` / `__default__` |
| `AGENTARTS_MEMORY_PLATFORM` | | 平台标识 | 自动探测（`*_PLUGIN_ROOT` 环境变量） |



## 安装方式

- **源码工程**：整个目录拷给对方，`npm install && npm run build` 后即可使用；
- **npm 包**：`npm pack` 生成 tgz（`prepare` 钩子会自动构建），对方
  `npm i -g agentarts-memory-mcp-1.0.0.tgz` 后用 `agentarts-memory-mcp` 命令启动。

## 测试

```bash
npm test
```

端到端验证，不需要网络和真实凭证：在本地起一个 mock 数据面，拉起 `dist/index.mjs`
（MCP 宿主实际运行的同一个产物），逐项断言：

- MCP 协议行为：initialize 握手、tools/list、tools/call、未知工具报错、无凭证降级；
- REST 线格式：请求路径、Bearer 头、请求体默认值（num=5 / threshold=0.7 / actor_id）、
  分页参数、5xx 错误透传——这些"标准答案"逐项对照 Python SDK 的实现
  （`memory_service.py` 数据面分支 + `agentarts_client.py` 归一化逻辑）；
- 只读保证：全程无任何 `/sessions` 写路径端点被调用。

## 数据面接口参考

服务器直接调用以下 REST 接口（Bearer 认证，`Content-Type: application/json`）：

| 操作 | 接口 | 请求体 |
| --- | --- | --- |
| 语义检索 | `POST /v1/core/spaces/{space_id}/memories/search` | `{query, top_k, min_score, actor_id}` → `{records: [{record, score}]}` |
| 列出记忆 | `GET /v1/core/spaces/{space_id}/memories?limit=&offset=` | → `{items: [{id, content, strategy_type, memory_type, created_at}], total}` |

错误处理：接口失败时工具返回 `{"error": "...", "results": [], "total": 0}` 而非抛协议错误，
模型可以看到错误文本。

## 目录结构

```
src/               # TypeScript 源码（4 个模块：协议层/REST/客户端/配置）
test/              # 端到端测试（mock 数据面，node:test，零测试依赖）
dist/index.mjs     # 构建产物（npm run build 生成，gitignore）
```

## Packaging（不随 wheel 分发）

本包位于 `agentarts-sdk` 仓库 `src/agentarts/toolkit/plugins/memory/mcp/typescript/`，
与 Python 版 `mcp/server.py` 并列，**不进入 wheel/sdist**（`pyproject.toml` 的
`[tool.uv.build-backend]` 已通过 `source-exclude` / `wheel-exclude` 排除，
`node_modules` 亦被 uv_build 默认排除）。分发方式：

- 整个目录拷给对方（`npm install && npm run build` 后使用）；
- 或本地构建后只发 `dist/index.mjs`（740KB，对方零构建）。

## License

Apache-2.0
