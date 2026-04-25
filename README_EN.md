# Feishu Sidebar — Hermes Agent Execution Log Viewer

A Feishu (Lark) sidebar app for viewing the execution trace of Hermes Agent. Right-click a bot message in Feishu chat, open the sidebar via "Message Quick Action", and see the full execution trace — including thought process, tool calls, sub-agents, and final response.

[中文文档](./README.md)

## Features

- **Message Quick Action entry**: Right-click message → select quick action → sidebar shows execution trace
- **Feishu h5sdk.config signature**: Auto-completes JS-SDK signing via Vite middleware
- **Multi-message switching**: Quick action returns up to 20 messages; click any to switch
- **Multi-message type parsing**: Supports text / post / interactive / image / media / file
- **Real execution logs**: Reads directly from Hermes SQLite database (`~/.hermes/state.db`), matches by message content
- **Timeline UI**: Displays thought, tool, sub-agent, response steps in a timeline with collapse/expand
- **Recursive JSON folding**: Tool call parameters and results shown as collapsible JSON trees
- **Markdown rendering**: Final responses support Markdown (tables, code blocks, lists, etc.)
- **Debug panel**: Built-in debug panel for environment info, raw logs, and API response data
- **Dev mode**: Auto-enters dev mode outside Feishu environment with mock data

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Feishu Client   │     │  Sidebar (React) │     │  Vite Dev Server │
│                 │     │                  │     │  (Middleware)     │
│ Right-click msg  │────▶│ h5sdk.config sig │     │                  │
│ → Quick Action   │     │       ↓          │     │  /api/h5sdk-config│
│                 │     │ getBlockAction    │     │  (Signing MW)    │
│  tt JS-SDK      │     │ SourceDetail     │────▶│                  │
│  (window.h5sdk) │     │       ↓          │     │  /v1/execution-log│
│                 │     │ fetch exec log   │────▶│  (SQLite query)   │
└─────────────────┘     └──────────────────┘     └──────────────────┘
                                                         │
                                                         ▼
                                               ┌──────────────────┐
                                               │  Feishu Open API  │
                                               │  (Get msg detail) │
                                               └──────────────────┘
                                                         │
                                                         ▼
                                               ┌──────────────────┐
                                               │  Hermes SQLite    │
                                               │  ~/.hermes/state.db│
                                               └──────────────────┘
```

### Frontend

- **React 18** + **Vite 5**
- Feishu client JS-SDK (`tt` / `lark` / `h5sdk` global objects)
- **react-markdown** — Markdown rendering for final responses

### Backend (Vite Middleware)

- **h5sdk.config signing**: `app_access_token → jsapi_ticket → SHA1 signature`
- **Execution log query**: Feishu API get message detail → SQLite content match → extract round log
- **Message detail proxy**: Get full message content via Feishu API

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/h5sdk-config?url=xxx` | Feishu h5sdk.config signing (app_access_token → jsapi_ticket → SHA1) |
| `GET /api/message-detail?message_id=xxx&chat_id=xxx` | Proxy Feishu message detail API |
| `GET /v1/execution-log?message_id=xxx` | Query execution log from Hermes SQLite (core endpoint) |
| `proxy: /v1/*` | Proxy other `/v1/*` requests to Hermes Gateway (`http://localhost:8642`) |

## Project Structure

```
feishu-sidebar/
├── app/
│   └── src/
│       ├── App.jsx          # Main app component (Feishu SDK calls + UI rendering)
│       ├── main.jsx         # React entry point
│       └── index.css        # Styles (light theme, timeline, JSON folding)
├── app.json                 # Feishu app config (message quick action + sidebar)
├── index.html               # HTML entry (includes Feishu H5 JS SDK 1.5.16)
├── package.json             # Dependencies
├── vite.config.js           # Vite config + API middleware (signing, exec log, msg detail)
├── .env.example             # Environment variable template
└── .gitignore
```

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **Hermes Agent** deployed and running (needs access to its SQLite database)
- **Feishu app** created (needs App ID and App Secret)

### 1. Clone and Install

```bash
git clone https://github.com/nujgnoix/feishu-sidebar.git
cd feishu-sidebar
npm install
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Feishu app credentials (get from Feishu Developer Console)
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Hermes database path (default ~/.hermes)
HERMES_HOME=/root/.hermes

# Hermes Gateway API address (for other /v1/* endpoint proxy)
VITE_HERMES_API_BASE=http://localhost:8642
```

### 3. Start Dev Server

```bash
npm run dev
# Visit http://localhost:8080
```

Outside Feishu environment, it auto-enters dev mode with mock data for debugging.

### 4. Build for Production

```bash
npm run build
# Output in dist/ directory
```

## Feishu Developer Console Setup

1. Log in to [Feishu Developer Console](https://open.feishu.cn/app)
2. Create or select an app
3. **Configure Message Quick Action**:
   - Go to "App Features" → "Message Quick Action"
   - Add a quick action, e.g. "View Execution Logic"
   - Set callback URL to the deployed sidebar URL
4. **Configure Sidebar**:
   - Go to "App Features" → "Mini Program / Web App"
   - Set desktop/mobile homepage to the sidebar URL
5. **Configure Permissions**: `im:message`, `im:message:readonly`, JSSDK permissions
6. **Deploy**: Deploy the `dist/` directory to an accessible static server

## Hermes Agent Adaptation Guide

This section explains how other Hermes Agent instances can install and adapt the Feishu sidebar.

### Overview

The sidebar reads Hermes's SQLite database to fetch execution logs. Adaptation is mainly **configuring environment variables** — no frontend code changes needed. If your Hermes database schema differs, you may need to adjust SQL queries in `vite.config.js`.

### Step 1: Confirm Hermes Database Location

Hermes stores its state database at `~/.hermes/state.db` by default. Verify your instance path:

```bash
# Default location
ls ~/.hermes/state.db

# If using a custom path, check Hermes config
hermes config show | grep -i home
```

### Step 2: Verify Database Schema

The sidebar depends on the following table structure. Older Hermes versions may be missing some fields:

**sessions table**:

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT | Session ID |
| `source` | TEXT | Source (must be `'feishu'`) |
| `user_id` | TEXT | Feishu user open_id |

**messages table**:

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER | Message ID |
| `session_id` | TEXT | Session ID |
| `role` | TEXT | Role (`user` / `assistant` / `tool`) |
| `content` | TEXT | Message content |
| `tool_name` | TEXT | Tool name |
| `tool_calls` | TEXT | Tool calls JSON |
| `tool_call_id` | TEXT | Tool call ID |
| `timestamp` | REAL | Timestamp (Unix seconds, float) |
| `finish_reason` | TEXT | Finish reason |
| `reasoning` | TEXT | Reasoning content |

Verify your database:

```bash
sqlite3 ~/.hermes/state.db "PRAGMA table_info(sessions);"
sqlite3 ~/.hermes/state.db "PRAGMA table_info(messages);"
```

### Step 3: Configure Environment Variables

```env
# Point to your Hermes database directory
HERMES_HOME=/path/to/your/.hermes

# If Hermes Gateway is not on the default port
VITE_HERMES_API_BASE=http://your-hermes-host:8642
```

### Step 4: Update API Key (if needed)

If your Hermes Gateway uses API Key authentication, update the proxy config in `vite.config.js`:

```js
// vite.config.js proxy config
proxy: {
  '/v1': {
    target: 'http://your-hermes-host:8642',
    changeOrigin: true,
    headers: {
      'Authorization': 'Bearer your-actual-api-key',  // Change this
    },
  },
},
```

### Step 5: Hermes Source Code Changes (Recommended: Message Timestamp Fix)

If your Hermes version uses batch writes (all messages written at the same time), execution log timestamps will be inaccurate. We recommend modifying Hermes source code to record real timestamps at message creation time.

#### Change 1: `hermes_state.py` — `append_message` accept timestamp parameter

Find the `append_message` method and add a `timestamp` parameter:

```python
# hermes_state.py — append_message method signature
def append_message(
    self,
    session_id: str,
    role: str,
    content: str = None,
    # ... other params ...
    timestamp: float = None,   # New
) -> int:
```

In the INSERT statement, change `time.time()` to `timestamp or time.time()`:

```python
# hermes_state.py — INSERT statement
timestamp or time.time(),  # Prefer message's own timestamp
```

#### Change 2: `run_agent.py` — Record `_created_at` at message creation

Add this before `return msg` in `_build_assistant_message`:

```python
msg["_created_at"] = time.time()
return msg
```

In `_flush_messages_to_session_db`, pass `_created_at` to `append_message`:

```python
self._session_db.append_message(
    # ... other params ...
    timestamp=msg.get("_created_at"),  # New
)
```

In all direct `messages.append()` calls, add `"_created_at": time.time()`:

```python
# user message
user_msg = {"role": "user", "content": user_message, "_created_at": time.time()}

# tool message
tool_msg = {"role": "tool", "content": result, "tool_call_id": tc.id, "_created_at": time.time()}
```

#### Change 3: `agent_loop.py` — Same `_created_at` addition

Add `"_created_at": time.time()` to all 3 `messages.append()` calls in `agent_loop.py` (requires `import time`).

### Step 6: Start and Verify

```bash
# Start the sidebar
npm run dev

# Send a message to Hermes in Feishu
# Then right-click the message → Quick Action → View Execution Logic
# You should see the complete execution log
```

### Execution Log Query Flow

```
User clicks message quick action
        ↓
Frontend calls tt.getBlockActionSourceDetail() to get message list (with openMessageId + createTime)
        ↓
Takes openMessageId, calls GET /v1/execution-log?message_id=xxx
        ↓
Vite middleware processes:
  1. Uses Feishu API to get sender.open_id + content + create_time via message_id
  2. Finds matching session in SQLite sessions table (source='feishu' + user_id)
  3. Locates the user message in messages table by content match (no upper time limit, lower limit -60s)
  4. Extracts all messages between this user message and the next user message
  5. Formats as execution log (thought / tool / sub_agent / response)
```

### Message Matching Strategy

The sidebar uses a **content-first matching** strategy, independent of time windows:

1. **Content match** (primary): Searches all Feishu sessions for user messages whose content matches the Feishu message text, sorted by time proximity, no upper time limit
2. **No match**: Returns empty result (shows "No execution log"), does not fall back to time matching

This means:
- If Hermes is still processing a message (not yet in the database), the sidebar correctly shows "No execution log"
- No incorrect matches due to time differences

## Environment Variables

| Variable | Purpose | Default | Used In |
|----------|---------|---------|---------|
| `FEISHU_APP_ID` | Feishu App ID | (required) | vite.config.js |
| `FEISHU_APP_SECRET` | Feishu App Secret | (required) | vite.config.js |
| `HERMES_HOME` | Hermes database directory | `~/.hermes` | vite.config.js |
| `VITE_HERMES_API_BASE` | Hermes Gateway API address | `http://localhost:8642` | App.jsx (frontend) |

Variables with `VITE_` prefix are injected into frontend code by Vite (via `import.meta.env`); others are only used in Vite config (Node.js side).

## Notes

- Execution logs depend on Hermes Agent's SQLite database (`~/.hermes/state.db`), which must be on the same machine as the Vite dev server
- Feishu message `create_time` (send time) and Hermes `timestamp` (processing time) may differ by seconds to minutes, but the matching logic uses content matching and is unaffected
- `h5sdk.config` signing requires the Feishu app to have JSSDK permissions
- Outside Feishu environment (no `window.h5sdk`), auto-enters dev mode
- For production deployment, Vite middleware won't run — you'll need a standalone backend or alternative approach
