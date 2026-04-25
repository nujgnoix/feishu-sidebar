# 飞书侧边栏 — Hermes Agent 执行逻辑查看器

飞书侧边栏应用，用于展示 Hermes Agent 机器人的执行逻辑。用户在飞书聊天中右键点击机器人消息，通过「消息快捷操作」打开侧边栏，即可查看该消息对应的完整执行轨迹——包括思考过程、工具调用、子代理和最终回复。

## 功能特性

- **消息快捷操作入口**：右键消息 → 选择快捷操作 → 侧边栏自动展示执行轨迹
- **飞书 h5sdk.config 签名认证**：通过 Vite 中间件自动完成 JS-SDK 签名
- **多消息切换**：快捷操作最多返回 20 条消息，点击任意消息可切换查看其执行日志
- **多消息类型解析**：支持 text / post / interactive / image / media / file 等
- **真实执行日志**：直接从 Hermes SQLite 数据库（`~/.hermes/state.db`）读取，按消息内容精确匹配到对应轮次
- **时间线 UI**：以时间线形式展示思考、工具调用、子代理、回复等步骤，支持收起/展开
- **JSON 递归折叠**：工具调用的参数和结果以可折叠 JSON 树展示
- **Markdown 渲染**：最终回复支持 Markdown 语法（表格、代码块、列表等）
- **调试面板**：内嵌调试面板，可查看环境信息、原始日志和 API 返回数据
- **开发模式**：非飞书环境下自动进入开发模式，可加载模拟数据调试

## 技术架构

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  飞书客户端      │     │  侧边栏 (React)   │     │  Vite Dev Server │
│                 │     │                  │     │  (中间件层)       │
│ 右键消息         │────▶│ h5sdk.config 签名 │     │                  │
│ → 快捷操作       │     │       ↓          │     │  /api/h5sdk-config│
│                 │     │ getBlockAction    │     │  (签名中间件)     │
│  tt JS-SDK      │     │ SourceDetail     │────▶│                  │
│  (window.h5sdk) │     │       ↓          │     │  /v1/execution-log│
│                 │     │ fetch 执行日志     │────▶│  (SQLite 查询)    │
└─────────────────┘     └──────────────────┘     └──────────────────┘
                                                         │
                                                         ▼
                                               ┌──────────────────┐
                                               │  飞书 Open API    │
                                               │  (获取消息详情)    │
                                               └──────────────────┘
                                                         │
                                                         ▼
                                               ┌──────────────────┐
                                               │  Hermes SQLite    │
                                               │  ~/.hermes/state.db│
                                               └──────────────────┘
```

### 前端

- **React 18** + **Vite 5**
- 飞书客户端 JS-SDK（`tt` / `lark` / `h5sdk` 全局对象）
- **react-markdown** — 最终回复 Markdown 渲染

### 后端（Vite 中间件）

- **h5sdk.config 签名**：`app_access_token → jsapi_ticket → SHA1 签名`
- **执行日志查询**：飞书 API 获取消息详情 → SQLite 按内容匹配 → 提取轮次日志
- **消息详情代理**：通过飞书 API 获取消息完整内容

### API 端点

| 端点 | 功能 |
|------|------|
| `GET /api/h5sdk-config?url=xxx` | 飞书 h5sdk.config 签名（app_access_token → jsapi_ticket → SHA1） |
| `GET /api/message-detail?message_id=xxx&chat_id=xxx` | 代理飞书消息详情 API |
| `GET /v1/execution-log?message_id=xxx` | 从 Hermes SQLite 查询执行日志（核心端点） |
| `proxy: /v1/*` | 其他 `/v1/*` 请求代理到 Hermes Gateway（`http://localhost:8642`） |

## 目录结构

```
feishu-sidebar/
├── app/
│   └── src/
│       ├── App.jsx          # 主应用组件（飞书 SDK 调用 + UI 渲染）
│       ├── main.jsx         # React 入口
│       └── index.css        # 样式（明亮主题、时间线、JSON 折叠）
├── app.json                 # 飞书应用配置（消息快捷操作 + 侧边栏）
├── index.html               # HTML 入口（引入飞书 H5 JS SDK 1.5.16）
├── package.json             # 依赖
├── vite.config.js           # Vite 配置 + API 中间件（签名、执行日志、消息详情）
├── .env.example             # 环境变量模板
└── .gitignore
```

## 快速开始

### 前置条件

- **Node.js** >= 18
- **Hermes Agent** 已部署并运行（需要访问其 SQLite 数据库）
- **飞书应用**已创建（需要 App ID 和 App Secret）

### 1. 克隆并安装

```bash
git clone https://github.com/your-org/feishu-sidebar.git
cd feishu-sidebar
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# 飞书应用凭证（在飞书开发者后台获取）
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Hermes 数据库路径（默认 ~/.hermes）
HERMES_HOME=/root/.hermes

# Hermes Gateway API 地址（用于其他 /v1/* 端点代理）
VITE_HERMES_API_BASE=http://localhost:8642
```

### 3. 启动开发服务器

```bash
npm run dev
# 访问 http://localhost:8080
```

非飞书环境下会自动进入开发模式，可加载模拟数据进行调试。

### 4. 构建生产版本

```bash
npm run build
# 产物在 dist/ 目录
```

## 飞书开发者后台配置

1. 登录 [飞书开发者后台](https://open.feishu.cn/app)
2. 创建或选择一个应用
3. **配置消息快捷操作**：
   - 进入「应用功能」→「消息快捷操作」
   - 添加快捷操作，名称如「查看执行逻辑」
   - 回调地址填写部署后的侧边栏 URL
4. **配置侧边栏**：
   - 进入「应用功能」→「小程序/网页应用」
   - 设置桌面端/移动端首页为侧边栏 URL
5. **配置权限**：`im:message`、`im:message:readonly`、JSSDK 权限
6. **部署**：将 `dist/` 目录部署到可访问的静态服务器

## Hermes Agent 适配指南

本节说明其他 Hermes Agent 实例如何安装和适配飞书侧边栏。

### 适配概览

侧边栏需要读取 Hermes 的 SQLite 数据库来获取执行日志。适配工作主要是**配置环境变量**，不需要修改前端代码。如果 Hermes 数据库 schema 有差异，可能需要调整 `vite.config.js` 中的 SQL 查询。

### 步骤 1：确认 Hermes 数据库位置

Hermes 默认将状态数据库存储在 `~/.hermes/state.db`。确认你的实例路径：

```bash
# 默认位置
ls ~/.hermes/state.db

# 如果使用了自定义路径，检查 Hermes 配置
hermes config show | grep -i home
```

### 步骤 2：确认数据库 Schema

侧边栏依赖以下表结构。如果你的 Hermes 版本较旧，可能缺少部分字段：

**sessions 表**：

| 字段 | 类型 | 用途 |
|------|------|------|
| `id` | TEXT | 会话 ID |
| `source` | TEXT | 来源（需为 `'feishu'`） |
| `user_id` | TEXT | 飞书用户 open_id |

**messages 表**：

| 字段 | 类型 | 用途 |
|------|------|------|
| `id` | INTEGER | 消息 ID |
| `session_id` | TEXT | 所属会话 ID |
| `role` | TEXT | 角色（`user` / `assistant` / `tool`） |
| `content` | TEXT | 消息内容 |
| `tool_name` | TEXT | 工具名称 |
| `tool_calls` | TEXT | 工具调用 JSON |
| `tool_call_id` | TEXT | 工具调用 ID |
| `timestamp` | REAL | 时间戳（Unix 秒级浮点数） |
| `finish_reason` | TEXT | 完成原因 |
| `reasoning` | TEXT | 推理内容 |

验证你的数据库：

```bash
sqlite3 ~/.hermes/state.db "PRAGMA table_info(sessions);"
sqlite3 ~/.hermes/state.db "PRAGMA table_info(messages);"
```

### 步骤 3：配置环境变量

```env
# 指向你的 Hermes 数据库目录
HERMES_HOME=/path/to/your/.hermes

# 如果 Hermes Gateway 不在默认端口，修改 API 地址
VITE_HERMES_API_BASE=http://your-hermes-host:8642
```

### 步骤 4：修改 API Key（如需要）

如果你的 Hermes Gateway 配置了 API Key 认证，需要修改 `vite.config.js` 中的 proxy 配置：

```js
// vite.config.js 中的 proxy 配置
proxy: {
  '/v1': {
    target: 'http://your-hermes-host:8642',
    changeOrigin: true,
    headers: {
      'Authorization': 'Bearer your-actual-api-key',  // 修改这里
    },
  },
},
```

### 步骤 5：Hermes 源码修改（推荐：消息时间戳修复）

如果你的 Hermes 版本在消息写入数据库时使用批量写入（所有消息在同一时刻写入），执行日志中的时间间隔会不准确。建议修改 Hermes 源码，在消息创建时就记录真实时间戳。

#### 修改 1：`hermes_state.py` — `append_message` 支持 timestamp 参数

找到 `append_message` 方法，新增 `timestamp` 参数：

```python
# hermes_state.py — append_message 方法签名
def append_message(
    self,
    session_id: str,
    role: str,
    content: str = None,
    # ... 其他参数 ...
    timestamp: float = None,   # 新增
) -> int:
```

在 INSERT 语句中，将 `time.time()` 改为 `timestamp or time.time()`：

```python
# hermes_state.py — INSERT 语句中
timestamp or time.time(),  # 优先使用消息自带的时间戳
```

#### 修改 2：`run_agent.py` — 消息创建时记录 `_created_at`

在 `_build_assistant_message` 方法的 `return msg` 之前添加：

```python
msg["_created_at"] = time.time()
return msg
```

在 `_flush_messages_to_session_db` 方法中，将 `_created_at` 传递给 `append_message`：

```python
self._session_db.append_message(
    # ... 其他参数 ...
    timestamp=msg.get("_created_at"),  # 新增
)
```

在所有直接构造消息的 `messages.append()` 调用中，添加 `"_created_at": time.time()`：

```python
# user 消息
user_msg = {"role": "user", "content": user_message, "_created_at": time.time()}

# tool 消息
tool_msg = {"role": "tool", "content": result, "tool_call_id": tc.id, "_created_at": time.time()}
```

#### 修改 3：`agent_loop.py` — 同样添加 `_created_at`

在 `agent_loop.py` 的 3 个 `messages.append()` 调用点添加 `"_created_at": time.time()`（需要 `import time`）。

### 步骤 6：启动并验证

```bash
# 启动侧边栏
npm run dev

# 在飞书中发送一条消息给 Hermes
# 然后右键该消息 → 快捷操作 → 查看执行逻辑
# 应该能看到完整的执行日志
```

### 执行日志查询原理

```
用户点击消息快捷操作
        ↓
前端通过 tt.getBlockActionSourceDetail() 获取消息列表（含 openMessageId + createTime）
        ↓
取 openMessageId，调用 GET /v1/execution-log?message_id=xxx
        ↓
Vite 中间件处理：
  1. 用飞书 API 通过 message_id 获取 sender.open_id + content + create_time
  2. 在 SQLite sessions 表中找 source='feishu' + user_id 匹配的会话
  3. 通过消息内容在 messages 表中定位到该轮 user 消息（无时间上限，只设下限 -60s）
  4. 提取从该 user 消息到下一个 user 消息之间的所有消息
  5. 格式化为执行日志（thought / tool / sub_agent / response）
```

### 消息匹配策略

侧边栏使用**内容优先匹配**策略，不依赖时间窗口：

1. **内容匹配**（主策略）：在所有飞书 session 中搜索 content 与飞书消息文本匹配的 user 消息，按时间距离排序，无时间上限
2. **无匹配时**：返回空结果（显示"暂无执行日志"），不会回退到时间匹配

这意味着：
- 如果 Hermes 还在处理消息（数据库中还没有对应记录），侧边栏会正确显示"暂无执行日志"
- 不会因为时间差导致匹配到错误的消息

## 环境变量清单

| 变量名 | 用途 | 默认值 | 使用位置 |
|--------|------|--------|----------|
| `FEISHU_APP_ID` | 飞书应用 ID | （必填） | vite.config.js |
| `FEISHU_APP_SECRET` | 飞书应用密钥 | （必填） | vite.config.js |
| `HERMES_HOME` | Hermes 数据库目录 | `~/.hermes` | vite.config.js |
| `VITE_HERMES_API_BASE` | Hermes Gateway API 地址 | `http://localhost:8642` | App.jsx（前端） |

`VITE_` 前缀的变量会被 Vite 注入到前端代码中（通过 `import.meta.env`），其余变量仅在 Vite 配置（Node.js 端）使用。

## 注意事项

- 执行日志依赖 Hermes Agent 的 SQLite 数据库（`~/.hermes/state.db`），需要和 Vite 开发服务器在同一台机器上
- 飞书消息的 `create_time`（消息发送时间）与 Hermes 存储的 `timestamp`（消息处理时间）可能存在数秒到数分钟的差异，但匹配逻辑使用内容匹配，不受时间差影响
- `h5sdk.config` 签名需要飞书应用具备 JSSDK 权限
- 非飞书环境下（无 `window.h5sdk`）自动进入开发模式
- 生产部署时 Vite 中间件不会运行，需要独立后端服务或改用其他方案
