# 飞书侧边栏 — 会话分析

飞书侧边栏应用，用于展示 Hermes Agent 机器人的执行逻辑。用户在飞书聊天中右键点击机器人消息，通过「消息快捷操作」打开侧边栏，即可查看该消息对应的完整执行轨迹——包括思考过程、工具调用和最终回复。

## 功能特性

- **消息快捷操作入口**：右键消息 → 选择快捷操作 → 侧边栏自动展示执行轨迹
- **飞书 h5sdk.config 签名认证**：通过 Vite 中间件自动完成 JS-SDK 签名
- **多消息切换**：快捷操作最多返回 20 条消息，点击任意消息可切换查看其执行日志
- **多消息类型解析**：支持 text / post / interactive / image / media / file 等
- **真实执行日志**：直接从 Hermes SQLite 数据库（`~/.hermes/state.db`）读取，按消息时间精确匹配到对应轮次
- **时间线 UI**：以时间线形式展示思考、工具调用、子代理、回复等步骤，支持收起/展开
- **JSON 递归折叠**：工具调用的参数和结果以可折叠 JSON 树展示
- **Markdown 渲染**：最终回复支持 Markdown 语法（表格、代码块、列表等）
- **调试面板**：内嵌调试面板，可查看环境信息、原始日志和 API 返回数据

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
- **执行日志查询**：飞书 API 获取消息详情 → SQLite 按时间匹配 → 提取轮次日志
- **消息详情代理**：通过飞书 API 获取消息完整内容

## 目录结构

```
feishu-sidebar/
├── app/
│   └── src/
│       ├── App.jsx          # 主应用组件（飞书 SDK 调用 + UI 渲染）
│       ├── main.jsx         # React 入口
│       └── index.css        # 样式（明亮主题、时间线、JSON 折叠）
├── app.json                 # 飞书应用配置（消息快捷操作 + 侧边栏）
├── index.html               # HTML 入口
├── package.json             # 依赖
├── vite.config.js           # Vite 配置 + API 中间件（签名、执行日志、消息详情）
├── .env.example             # 环境变量模板
└── .gitignore
```

## 安装与运行

### 1. 安装依赖

```bash
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
   - 添加快捷操作，名称如「会话分析」
   - 回调地址填写部署后的侧边栏 URL
4. **配置侧边栏**：
   - 进入「应用功能」→「小程序/网页应用」
   - 设置桌面端/移动端首页为侧边栏 URL
5. **配置权限**：`im:message`、`im:message:readonly`
6. **部署**：将 `dist/` 目录部署到可访问的静态服务器

## 执行日志查询原理

```
用户点击消息快捷操作
        ↓
前端通过 tt.getBlockActionSourceDetail() 获取消息列表
        ↓
取 openMessageId，调用 GET /v1/execution-log?message_id=xxx
        ↓
Vite 中间件处理：
  1. 用飞书 API 通过 message_id 获取 sender.open_id + create_time
  2. 在 SQLite sessions 表中找 source='feishu' + user_id 匹配的会话
  3. 通过 create_time 在 messages 表中定位到该轮 user 消息（±300 秒窗口）
  4. 提取从该 user 消息到下一个 user 消息之间的所有消息
  5. 格式化为执行日志（thought / tool / sub_agent / response）
```

## 注意事项

- 执行日志依赖 Hermes Agent 的 SQLite 数据库（`~/.hermes/state.db`），需要和 Vite 开发服务器在同一台机器上
- 飞书消息的 `create_time` 与 Hermes 存储的 `timestamp` 可能存在数秒到数分钟的差异（Hermes 处理延迟）
- `h5sdk.config` 签名需要飞书应用具备 JSSDK 权限
- 非飞书环境下（无 `window.h5sdk`）自动进入开发模式
