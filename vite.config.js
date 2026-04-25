import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import path from 'path'

// ── 飞书 Token 缓存（共享） ──────────────────────────────────

function createFeishuTokenManager(env) {
  const appId = env.FEISHU_APP_ID
  const appSecret = env.FEISHU_APP_SECRET
  let tokenCache = { token: '', expireAt: 0 }

  async function getAccessToken() {
    const now = Math.floor(Date.now() / 1000)
    if (tokenCache.token && now < tokenCache.expireAt) return tokenCache.token

    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const data = await res.json()
    if (data.code !== 0) throw new Error(`获取 app_access_token 失败: ${data.msg}`)
    tokenCache = { token: data.app_access_token, expireAt: now + 7200 - 300 }
    return tokenCache.token
  }

  return { getAccessToken, appId, appSecret }
}

// ── 飞书 h5sdk.config 签名中间件 ──────────────────────────────
// GET /api/h5sdk-config?url=xxx → { appId, timestamp, nonceStr, signature }

function createH5SDKConfigMiddleware(tokenManager) {
  let ticketCache = { ticket: '', expireAt: 0 }

  async function getJsapiTicket(accessToken) {
    const res = await fetch('https://open.feishu.cn/open-apis/jssdk/ticket/get', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    if (data.code !== 0) throw new Error(`获取 jsapi_ticket 失败: ${data.msg}`)
    return data.data.ticket
  }

  function generateSignature(ticket, nonceStr, timestamp, url) {
    const str = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`
    return crypto.createHash('sha1').update(str).digest('hex')
  }

  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/h5sdk-config')) return next()

    const url = new URL(req.url, 'http://localhost')
    const pageUrl = url.searchParams.get('url')
    if (!pageUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '缺少 url 参数' }))
      return
    }

    try {
      const accessToken = await tokenManager.getAccessToken()

      const now = Math.floor(Date.now() / 1000)
      if (!ticketCache.ticket || now >= ticketCache.expireAt) {
        const ticket = await getJsapiTicket(accessToken)
        ticketCache = { ticket, expireAt: now + 7200 - 300 }
      }

      const timestamp = Date.now()
      const nonceStr = Math.random().toString(36).substring(2, 15)
      const signature = generateSignature(ticketCache.ticket, nonceStr, String(timestamp), pageUrl)

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        appId: tokenManager.appId,
        timestamp,
        nonceStr,
        signature,
      }))
    } catch (err) {
      console.error('[h5sdk-config] 签名失败:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// ── 飞书消息详情接口 ──────────────────────────────────────────
// GET /api/message-detail?message_id=xxx&chat_id=xxx

function createMessageDetailMiddleware(tokenManager) {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/message-detail')) return next()

    const url = new URL(req.url, 'http://localhost')
    const messageId = url.searchParams.get('message_id')
    const chatId = url.searchParams.get('chat_id')

    if (!messageId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '缺少 message_id 参数' }))
      return
    }

    try {
      const accessToken = await tokenManager.getAccessToken()
      const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      }
      if (chatId) headers['lark_chat_id'] = chatId

      const apiRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, { headers })
      const apiData = await apiRes.json()

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(apiData))
    } catch (err) {
      console.error('[message-detail] 获取消息失败:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// ── 执行日志查询中间件（从 SQLite 读取真实数据） ──────────────
// GET /v1/execution-log?message_id=xxx
//
// 查询流程:
//   1. 用飞书 API 通过 message_id 获取 chat_id + sender.open_id
//   2. 在 SQLite sessions 表中找 source='feishu' + user_id 匹配的会话
//   3. 从 messages 表提取工具调用链，格式化为执行日志

function createExecutionLogMiddleware(tokenManager, hermesHome) {
  const dbPath = path.join(hermesHome, 'state.db')

  function getDb() {
    try {
      return new Database(dbPath, { readonly: true })
    } catch (err) {
      console.error('[execution-log] SQLite 打开失败:', err.message)
      return null
    }
  }

  // 从飞书 API 获取消息的 chat_id 和 sender open_id
  async function getFeishuMessageInfo(messageId, accessToken) {
    const apiRes = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    )
    const data = await apiRes.json()
    if (data.code !== 0) throw new Error(`飞书 API 错误: ${data.msg} (code: ${data.code})`)

    const msg = data.data?.items?.[0] || data.data
    const sender = msg?.sender || {}
    // 飞书 API 返回格式: { id: "ou_xxx", id_type: "open_id", sender_type: "user" }
    const senderId = sender.id_type === 'open_id' ? sender.id : sender.sender_id?.open_id
    return {
      chatId: msg?.chat_id,
      senderId,
      content: msg?.body?.content,
      createTime: msg?.create_time,
    }
  }

  // 在所有飞书会话中，通过消息时间匹配对应的 user 消息行
  // 返回 { sessionId, rowId, timestamp, content } 或 null
  function findMatchingUserMessage(db, userId, feishuCreateTime) {
    if (!feishuCreateTime) return null
    let createTimeSec = Number(feishuCreateTime)
    if (createTimeSec > 1e12) createTimeSec = createTimeSec / 1000

    // 在该用户的所有飞书 session 中搜索匹配的 user 消息
    // 窗口 ±300 秒（5分钟，覆盖 Hermes 处理延迟）
    const row = db.prepare(`
      SELECT m.id as row_id, m.session_id, m.timestamp, m.content
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE s.source = 'feishu' AND s.user_id = ?
        AND m.role = 'user'
        AND m.timestamp > ? AND m.timestamp < ?
      ORDER BY ABS(m.timestamp - ?)
      LIMIT 1
    `).get(userId, createTimeSec - 300, createTimeSec + 300, createTimeSec)
    return row || null
  }

  // 从 messages 表提取指定轮次的执行日志
  // turnStartId: 该轮 user 消息的行 ID
  // 只提取从该 user 消息到下一个 user 消息之间的所有消息
  function extractExecutionLog(db, sessionId, turnStartId) {
    // 先找到下一轮 user 消息的行 ID（作为结束边界）
    let turnEndId = null
    if (turnStartId) {
      const nextUser = db.prepare(`
        SELECT id FROM messages
        WHERE session_id = ? AND role = 'user' AND id > ?
        ORDER BY id LIMIT 1
      `).get(sessionId, turnStartId)
      turnEndId = nextUser ? nextUser.id : null
    }

    const messages = db.prepare(`
      SELECT id, role, content, tool_name, tool_call_id, tool_calls,
             timestamp, finish_reason, reasoning
      FROM messages
      WHERE session_id = ?
        ${turnStartId ? 'AND id >= ?' : ''}
        ${turnEndId ? 'AND id < ?' : ''}
      ORDER BY id
    `).all(sessionId, ...(turnStartId ? [turnStartId] : []), ...(turnEndId ? [turnEndId] : []))

    if (!messages || messages.length === 0) return []

    const log = []
    let logId = 1

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]

      // 跳过 session_meta
      if (msg.role === 'session_meta') continue

      // assistant 消息中的 reasoning（思考过程）
      if (msg.role === 'assistant' && msg.reasoning) {
        try {
          const reasoningText = typeof msg.reasoning === 'string'
            ? msg.reasoning
            : JSON.stringify(msg.reasoning)
          if (reasoningText.trim()) {
            log.push({
              id: logId++,
              type: 'thought',
              content: reasoningText.trim().substring(0, 2000),
              timestamp: msg.timestamp,
            })
          }
        } catch {}
      }

      // assistant 消息中的 tool_calls（发起工具调用）
      if (msg.role === 'assistant' && msg.tool_calls) {
        try {
          const calls = typeof msg.tool_calls === 'string'
            ? JSON.parse(msg.tool_calls)
            : msg.tool_calls
          for (const call of calls) {
            const fn = call.function || {}
            let args = {}
            try { args = JSON.parse(fn.arguments || '{}') } catch {}

            log.push({
              id: logId++,
              type: 'tool',
              content: `调用工具 ${fn.name}`,
              toolName: fn.name,
              params: args,
              timestamp: msg.timestamp,
            })
          }
        } catch {}
      }

      // tool 消息（工具返回结果）
      if (msg.role === 'tool' && msg.tool_call_id) {
        // 找到对应的 tool 调用信息
        let toolName = msg.tool_name || ''
        if (!toolName) {
          for (const m of messages) {
            if (m.tool_calls) {
              try {
                const calls = typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls
                const match = calls.find(c => c.id === msg.tool_call_id || c.call_id === msg.tool_call_id)
                if (match) { toolName = match.function?.name || ''; break }
              } catch {}
            }
          }
        }

        // 解析工具返回内容
        let resultPreview = ''
        try {
          const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content
          if (typeof parsed === 'object') {
            // 提取 output 或 error
            if (parsed.output) resultPreview = String(parsed.output).substring(0, 500)
            else if (parsed.error) resultPreview = `❌ ${String(parsed.error).substring(0, 500)}`
            else resultPreview = JSON.stringify(parsed).substring(0, 500)
          } else {
            resultPreview = String(msg.content).substring(0, 500)
          }
        } catch {
          resultPreview = String(msg.content).substring(0, 500)
        }

        // 更新上一个 tool 调用条目的 result
        for (let j = log.length - 1; j >= 0; j--) {
          if (log[j].type === 'tool' && !log[j].result) {
            log[j].result = resultPreview
            log[j].toolName = log[j].toolName || toolName
            break
          }
        }
      }

      // assistant 的最终文本回复
      if (msg.role === 'assistant' && msg.content && msg.finish_reason === 'stop') {
        log.push({
          id: logId++,
          type: 'response',
          content: String(msg.content).substring(0, 2000),
          timestamp: msg.timestamp,
        })
      }
    }

    return log
  }

  return async (req, res, next) => {
    if (!req.url?.startsWith('/v1/execution-log')) return next()

    const url = new URL(req.url, 'http://localhost')
    const messageId = url.searchParams.get('message_id')

    if (!messageId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '缺少 message_id 参数' }))
      return
    }

    let db = null
    try {
      const accessToken = await tokenManager.getAccessToken()

      // 1. 通过飞书 API 获取消息的 chat_id 和 sender
      const msgInfo = await getFeishuMessageInfo(messageId, accessToken)
      console.log(`[execution-log] 消息信息: chatId=${msgInfo.chatId}, senderId=${msgInfo.senderId}`)

      if (!msgInfo.senderId) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message_id: messageId, execution_log: [] }))
        return
      }

      // 2. 查找对应的 Hermes 会话
      db = getDb()
      if (!db) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '无法打开 Hermes 数据库' }))
        return
      }

      // 2. 在所有飞书 session 中按时间匹配 user 消息
      const match = findMatchingUserMessage(db, msgInfo.senderId, msgInfo.createTime)
      if (!match) {
        console.log(`[execution-log] 未找到匹配消息: userId=${msgInfo.senderId}, createTime=${msgInfo.createTime}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message_id: messageId, execution_log: [] }))
        return
      }

      const sessionId = match.session_id
      const turnStartId = match.row_id
      console.log(`[execution-log] 匹配成功: session=${sessionId}, userRow=${turnStartId}, 时间差=${Math.abs(match.timestamp - Number(msgInfo.createTime)).toFixed(1)}s`)

      // 3. 提取该轮次的执行日志
      const executionLog = extractExecutionLog(db, sessionId, turnStartId)

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        message_id: messageId,
        session_id: sessionId,
        execution_log: executionLog,
      }))
    } catch (err) {
      console.error('[execution-log] 查询失败:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    } finally {
      if (db) db.close()
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const env = loadEnv(command, process.cwd(), '')

  const config = {
    plugins: [
      react(),
      {
        name: 'feishu-api-middleware',
        configureServer(server) {
          const tokenManager = createFeishuTokenManager(env)
          const hermesHome = env.HERMES_HOME || path.join(process.env.HOME || '/root', '.hermes')

          // 执行日志中间件必须在 proxy 之前注册，拦截 /v1/execution-log
          server.middlewares.use(createExecutionLogMiddleware(tokenManager, hermesHome))
          server.middlewares.use(createH5SDKConfigMiddleware(tokenManager))
          server.middlewares.use(createMessageDetailMiddleware(tokenManager))
        },
      },
    ],
    server: {
      port: 8080,
      host: '0.0.0.0',
      cors: true,
      proxy: {
        // 保留 Hermes API 代理（用于其他 /v1/* 端点）
        '/v1': {
          target: 'http://localhost:8642',
          changeOrigin: true,
          headers: {
            'Authorization': 'Bearer hermes-sidebar-key',
          },
        },
      },
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
    },
  }

  return config
})
