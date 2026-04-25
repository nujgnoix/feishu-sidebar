import React, { useState, useEffect, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'

// API 基础地址，可通过 Vite 环境变量配置
const API_BASE = import.meta.env.VITE_HERMES_API_BASE || ''

// ── 复制到剪贴板工具 ──────────────────────────────────────────

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
  } else {
    fallbackCopy(text)
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch {}
  document.body.removeChild(ta)
}

// ── 从 URL 参数解析飞书启动信息 ────────────────────────────────

function parseUrlParams() {
  const params = new URLSearchParams(window.location.search)
  const result = {}

  // bdp_launch_query: {"__trigger_id__": "xxx"}
  const launchQuery = params.get('bdp_launch_query')
  if (launchQuery) {
    try {
      const parsed = JSON.parse(launchQuery)
      result.triggerCode = parsed.__trigger_id__
      result.launchQuery = parsed
    } catch {}
  }

  // trigger_context: {"chatId":"xx","appId":"xx","messageIds":["xx"],...}
  const triggerContext = params.get('trigger_context')
  if (triggerContext) {
    try {
      const parsed = JSON.parse(triggerContext)
      result.chatId = parsed.chatId
      result.appId = parsed.appId
      result.chatName = parsed.chatName
      result.chatType = parsed.chatType
      result.messageIds = parsed.messageIds || []
      result.actionTime = parsed.actionTime
      result.from = parsed.from
      result.triggerContext = parsed
    } catch {}
  }

  result.from = params.get('from') || result.from
  return result
}

// ── 在飞书客户端中查找 JS-SDK ────────────────────────────────
// H5 Web 应用需要先调 h5sdk.config() 认证，之后 window.tt 才会出现
// PC 客户端还可能有 ttJSCore、__LarkPCSDK__ 等内部对象

function findPCSDK() {
  const candidates = [
    { name: 'window.tt', obj: window.tt },
    { name: 'window.lark', obj: window.lark },
    { name: 'window.h5sdk', obj: window.h5sdk },
    { name: 'window.ttJSCore', obj: window.ttJSCore },
    { name: 'window.__LarkPCSDK__', obj: window.__LarkPCSDK__ },
    { name: 'window.__Lark_Bridge__', obj: window.__Lark_Bridge__ },
  ]

  const debugInfo = []

  for (const c of candidates) {
    if (!c.obj) {
      debugInfo.push(`${c.name}: 不存在`)
      continue
    }

    const type = typeof c.obj
    const keys = type === 'object' ? Object.keys(c.obj).slice(0, 30).join(', ') : String(c.obj)
    debugInfo.push(`${c.name}: type=${type}, keys=[${keys}]`)

    if (type !== 'object') continue

    // 直接有 getBlockActionSourceDetail（我们最终需要的）
    if (typeof c.obj.getBlockActionSourceDetail === 'function') {
      return { source: c.name, sdk: c.obj, debugInfo }
    }
    // 直接有 getHostLaunchQuery
    if (typeof c.obj.getHostLaunchQuery === 'function') {
      return { source: c.name, sdk: c.obj, debugInfo }
    }
    // 搜索子对象
    for (const subKey of ['tt', 'lark', 'jsapi', 'api']) {
      if (c.obj[subKey] && typeof c.obj[subKey] === 'object') {
        if (typeof c.obj[subKey].getBlockActionSourceDetail === 'function' ||
            typeof c.obj[subKey].getHostLaunchQuery === 'function') {
          return { source: `${c.name}.${subKey}`, sdk: c.obj[subKey], debugInfo }
        }
      }
    }
  }

  return { source: null, sdk: null, debugInfo }
}

// ── 消息内容解析工具 ──────────────────────────────────────────

function parseMessageContent(message) {
  if (!message) return { text: '（无内容）', raw: '' }

  const { messageType, content } = message

  try {
    switch (messageType) {
      case 'text': {
        const parsed = JSON.parse(content || '{}')
        return { text: parsed.text || content || '（空文本）', raw: content }
      }
      case 'post': {
        const parsed = JSON.parse(content || '{}')
        const title = parsed.title || ''
        const bodyText = (parsed.content || [])
          .map(line => (line.attrs || [])
            .map(attr => attr.text || '')
            .join(''))
          .join('\n')
        return { text: [title, bodyText].filter(Boolean).join('\n'), raw: content }
      }
      case 'interactive': {
        const parsed = JSON.parse(content || '{}')
        return { text: parsed.title || '（消息卡片）', raw: content }
      }
      case 'image':
        return { text: '（图片消息）', raw: content }
      case 'media':
        return { text: '（视频消息）', raw: content }
      case 'file':
        return { text: '（文件消息）', raw: content }
      default:
        return { text: `（不支持的消息类型: ${messageType}）`, raw: content }
    }
  } catch {
    return { text: content || '（无法解析）', raw: content }
  }
}

// ── 时间戳格式化（精确到毫秒） ────────────────────────────────

function formatTimestamp(ts) {
  let ms = ts
  if (typeof ms === 'number' && ms < 1e12) {
    // SQLite 秒级浮点时间戳，转为毫秒
    ms = ms * 1000
  }
  const d = new Date(ms)
  if (isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const sss = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${sss}`
}

// ── 模拟执行日志（开发调试用） ────────────────────────────────

function generateMockExecutionLog() {
  const now = Date.now()
  return [
    {
      id: 1,
      type: 'thought',
      content: '用户询问如何使用 Hermes Agent，我需要提供详细的使用指南。',
      timestamp: new Date(now - 12000).toISOString(),
    },
    {
      id: 2,
      type: 'tool',
      content: '调用工具获取 Hermes Agent 文档',
      toolName: 'get_hermes_docs',
      params: { topic: 'getting_started' },
      result: '获取到 Hermes Agent 快速开始文档',
      timestamp: new Date(now - 8000).toISOString(),
    },
    {
      id: 3,
      type: 'sub_agent',
      content: '调用子代理生成详细的使用指南',
      subAgentName: 'document_writer',
      params: { topic: 'hermes_agent_usage', format: 'markdown' },
      result: '生成了详细的 Hermes Agent 使用指南',
      timestamp: new Date(now - 4000).toISOString(),
    },
    {
      id: 4,
      type: 'thought',
      content: '整合获取的信息，为用户提供完整的使用指南。',
      timestamp: new Date(now - 1000).toISOString(),
    },
  ]
}

// ── 日志类型配置 ──────────────────────────────────────────────

const LOG_TYPE_CONFIG = {
  thought:   { label: '思考过程', icon: '💭', className: 'thought' },
  tool:      { label: '工具调用', icon: '🔧', className: 'tool' },
  sub_agent: { label: '子代理',   icon: '🤖', className: 'sub-agent' },
  response:  { label: '最终回复', icon: '💬', className: 'response' },
  error:     { label: '错误',     icon: '❌', className: 'error-item' },
}

// ── 递归可折叠 JSON 查看器 ────────────────────────────────────

function JsonNode({ keyName, value, isLast, depth = 0 }) {
  const [expanded, setExpanded] = useState(depth < 2)

  if (value === null) {
    return (
      <span>
        {keyName !== undefined && <span className="json-key">"{keyName}"</span>}
        {keyName !== undefined && <span className="json-colon">: </span>}
        <span className="json-value-null">null</span>
        {!isLast && <span className="json-comma">,</span>}
      </span>
    )
  }

  if (typeof value === 'boolean') {
    return (
      <span>
        {keyName !== undefined && <span className="json-key">"{keyName}"</span>}
        {keyName !== undefined && <span className="json-colon">: </span>}
        <span className="json-value-boolean">{String(value)}</span>
        {!isLast && <span className="json-comma">,</span>}
      </span>
    )
  }

  if (typeof value === 'number') {
    return (
      <span>
        {keyName !== undefined && <span className="json-key">"{keyName}"</span>}
        {keyName !== undefined && <span className="json-colon">: </span>}
        <span className="json-value-number">{value}</span>
        {!isLast && <span className="json-comma">,</span>}
      </span>
    )
  }

  if (typeof value === 'string') {
    return (
      <span>
        {keyName !== undefined && <span className="json-key">"{keyName}"</span>}
        {keyName !== undefined && <span className="json-colon">: </span>}
        <span className="json-value-string">"{value}"</span>
        {!isLast && <span className="json-comma">,</span>}
      </span>
    )
  }

  // Array
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <span>
          {keyName !== undefined && <span className="json-key">"{keyName}"</span>}
          {keyName !== undefined && <span className="json-colon">: </span>}
          <span className="json-bracket">[]</span>
          {!isLast && <span className="json-comma">,</span>}
        </span>
      )
    }

    return (
      <div className="json-node">
        <div className="json-node-header" onClick={() => setExpanded(!expanded)}>
          <span className="json-toggle">{expanded ? '▼' : '▶'}</span>
          <span>
            {keyName !== undefined && <span className="json-key">"{keyName}"</span>}
            {keyName !== undefined && <span className="json-colon">: </span>}
            <span className="json-bracket">[</span>
            {!expanded && (
              <span className="json-preview">
                {' '}{value.length} items{!isLast ? ',' : ''}
              </span>
            )}
            {expanded && <span className="json-bracket">]</span>}
            {!isLast && expanded && <span className="json-comma">,</span>}
          </span>
        </div>
        {expanded && (
          <div className="json-children expanded">
            {value.map((item, idx) => (
              <JsonNode
                key={idx}
                value={item}
                isLast={idx === value.length - 1}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // Object
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      return (
        <span>
          {keyName !== undefined && <span className="json-key">"{keyName}"</span>}
          {keyName !== undefined && <span className="json-colon">: </span>}
          <span className="json-bracket">{'{}'}</span>
          {!isLast && <span className="json-comma">,</span>}
        </span>
      )
    }

    return (
      <div className="json-node">
        <div className="json-node-header" onClick={() => setExpanded(!expanded)}>
          <span className="json-toggle">{expanded ? '▼' : '▶'}</span>
          <span>
            {keyName !== undefined && <span className="json-key">"{keyName}"</span>}
            {keyName !== undefined && <span className="json-colon">: </span>}
            <span className="json-bracket">{'{'}</span>
            {!expanded && (
              <span className="json-preview">
                {' '}{entries.length} keys{!isLast ? ',' : ''}
              </span>
            )}
            {expanded && <span className="json-bracket">{'}'}</span>}
            {!isLast && expanded && <span className="json-comma">,</span>}
          </span>
        </div>
        {expanded && (
          <div className="json-children expanded">
            {entries.map(([k, v], idx) => (
              <JsonNode
                key={k}
                keyName={k}
                value={v}
                isLast={idx === entries.length - 1}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return null
}

function JsonViewer({ data, label }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="json-viewer">
      <div className="json-node">
        <div className="json-node-header" onClick={() => setExpanded(!expanded)}>
          <span className="json-toggle">{expanded ? '▼' : '▶'}</span>
          <span>
            <span className="json-key">{label}</span>
            <span className="json-colon">: </span>
            {!expanded && <span className="json-preview">...</span>}
          </span>
        </div>
        {expanded && (
          <div className="json-children expanded">
            <JsonNode value={data} isLast={true} depth={0} />
          </div>
        )}
      </div>
    </div>
  )
}

// ── 调试面板组件（FAB 模式） ──────────────────────────────────

function DebugPanel({ visible, onClose, logs, envInfo, messages, executionLog }) {
  const [copied, setCopied] = useState(false)

  if (!visible) return null

  const handleCopyAll = () => {
    const output = {
      envInfo,
      messages,
      executionLog,
      debugLogs: logs.map(l => ({
        time: l.time,
        level: l.level,
        msg: l.msg,
        ...(l.data !== undefined ? { data: l.data } : {}),
      })),
    }
    copyToClipboard(JSON.stringify(output, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (!visible) {
    return null
  }

  return (
    <div className="debug-overlay" onClick={onClose}>
      <div className="debug-slide-panel" onClick={e => e.stopPropagation()}>
        <div className="debug-panel-header">
          <span className="debug-panel-title">🐞 调试面板</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              className={`btn-copy-all ${copied ? 'copied' : ''}`}
              onClick={handleCopyAll}
            >
              {copied ? '✓ 已复制' : '📋 复制全部'}
            </button>
            <button className="debug-panel-close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="debug-panel-body">
          {/* 环境信息 */}
          <div className="debug-section">
            <div className="debug-section-title">环境信息</div>
            <table className="debug-table">
              <tbody>
                {Object.entries(envInfo).map(([key, val]) => (
                  <tr key={key}>
                    <td className="debug-key">{key}</td>
                    <td className="debug-val"><code>{String(val)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 调试日志 */}
          <div className="debug-section">
            <div className="debug-section-title">调试日志 ({logs.length})</div>
            <div className="debug-logs">
              {logs.map((log, idx) => (
                <div key={idx} className={`debug-log-entry level-${log.level}`}>
                  <span className="debug-log-time">{log.time}</span>
                  <span className={`debug-log-level ${log.level}`}>{log.level.toUpperCase()}</span>
                  <span className="debug-log-msg">{log.msg}</span>
                  {log.data !== undefined && (
                    <details className="debug-log-data">
                      <summary>查看数据</summary>
                      <pre>{typeof log.data === 'string' ? log.data : JSON.stringify(log.data, null, 2)}</pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 主应用组件 ────────────────────────────────────────────────

function App() {
  const [messageContext, setMessageContext] = useState(null)
  const [messages, setMessages] = useState([])
  const [executionLog, setExecutionLog] = useState([])
  const [loading, setLoading] = useState(true)
  const [logLoading, setLogLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sdkReady, setSdkReady] = useState(false)
  const [debugLogs, setDebugLogs] = useState([])
  const [envInfo, setEnvInfo] = useState({})
  const [expandedItems, setExpandedItems] = useState({})
  const [debugVisible, setDebugVisible] = useState(false)

  const addLog = useCallback((level, msg, data) => {
    const time = new Date().toLocaleTimeString()
    setDebugLogs(prev => [...prev, { time, level, msg, data }])
    if (level === 'error') console.error(`[Debug] ${msg}`, data || '')
    else if (level === 'warn') console.warn(`[Debug] ${msg}`, data || '')
    else console.log(`[Debug] ${msg}`, data || '')
  }, [])

  const toggleItem = useCallback((idx) => {
    setExpandedItems(prev => ({ ...prev, [idx]: !prev[idx] }))
  }, [])

  // ── 步骤1: h5sdk.config 认证 → 调用 getBlockActionSourceDetail ──
  useEffect(() => {
    const urlParams = parseUrlParams()

    const env = {
      'window.tt': !!window.tt,
      'window.lark': !!window.lark,
      'window.h5sdk': !!window.h5sdk,
      '__LarkPCSDK__': !!window.__LarkPCSDK__,
      'from (URL)': urlParams.from || '(无)',
      'triggerCode (URL)': urlParams.triggerCode ? `${urlParams.triggerCode.substring(0, 12)}...` : '(无)',
      'chatId (URL)': urlParams.chatId || '(无)',
      'UserAgent': navigator.userAgent.substring(0, 80),
      'URL': window.location.href,
      'API_BASE': API_BASE,
    }
    setEnvInfo(env)
    addLog('info', '环境检测完成', env)
    addLog('info', `URL 参数: triggerCode=${urlParams.triggerCode || '无'}, chatId=${urlParams.chatId || '无'}, from=${urlParams.from || '无'}`)

    // 非飞书环境（浏览器直接打开）
    if (!urlParams.from) {
      addLog('info', '非飞书环境（无 from 参数），进入开发模式')
      setSdkReady(false)
      setLoading(false)
      return
    }

    // 飞书环境：需要先 h5sdk.config 认证
    if (!window.h5sdk) {
      addLog('error', '飞书环境中 window.h5sdk 不存在，请检查 index.html 是否引入了 lark-js-sdk.min.js')
      setSdkReady(false)
      setLoading(false)
      return
    }

    addLog('info', '✅ window.h5sdk 存在，开始 h5sdk.config 认证...')
    doH5SDKConfig(urlParams)
  }, [])

  // ── h5sdk.config 认证 ──
  const doH5SDKConfig = async (urlParams) => {
    try {
      // 向 Vite 中间件请求签名参数
      const pageUrl = window.location.href.split('?')[0] + window.location.search
      addLog('info', `请求签名: ${pageUrl.substring(0, 80)}...`)

      const configRes = await fetch(`/api/h5sdk-config?url=${encodeURIComponent(pageUrl)}`)
      const configData = await configRes.json()

      if (!configRes.ok || configData.error) {
        throw new Error(configData.error || `签名接口返回 ${configRes.status}`)
      }

      addLog('info', '签名获取成功', { appId: configData.appId, timestamp: configData.timestamp, nonceStr: configData.nonceStr })

      // 调用 h5sdk.config 进行 JSAPI 认证
      window.h5sdk.config({
        appId: configData.appId,
        timestamp: configData.timestamp,
        nonceStr: configData.nonceStr,
        signature: configData.signature,
        jsApiList: ['getBlockActionSourceDetail', 'getHostLaunchQuery'],
        onSuccess(res) {
          addLog('info', '✅ h5sdk.config 认证成功', res)
          addLog('info', `认证后 window.tt: ${!!window.tt}, window.lark: ${!!window.lark}`)

          // 官方示例：在 h5sdk.ready 回调里调用 JSAPI
          window.h5sdk.ready(() => {
            addLog('info', '✅ h5sdk.ready 触发')
            addLog('info', `ready 后 window.tt: ${!!window.tt}, window.lark: ${!!window.lark}`)

            const sdk = window.tt || window.lark
            if (!sdk) {
              addLog('error', 'h5sdk.ready 后 window.tt / window.lark 仍不存在')
              setError('JSAPI ready 但 SDK 未加载')
              setLoading(false)
              return
            }

            setSdkReady(true)

            // 优先用 URL 中的 triggerCode
            if (urlParams.triggerCode && typeof sdk.getBlockActionSourceDetail === 'function') {
              addLog('info', `调用 getBlockActionSourceDetail(triggerCode="${urlParams.triggerCode}")...`)
              sdk.getBlockActionSourceDetail({
                triggerCode: urlParams.triggerCode,
                success(detailRes) {
                  addLog('info', 'getBlockActionSourceDetail 返回成功', detailRes)
                  processDetailResponse(detailRes)
                },
                fail(err) {
                  addLog('error', `getBlockActionSourceDetail 失败: errCode=${err.errCode}, errMsg=${err.errMsg || ''}`, err)
                  setError(`获取消息详情失败 (错误码: ${err.errCode}): ${err.errMsg || ''}`)
                  setLoading(false)
                },
              })
              return
            }

            // 否则走 getHostLaunchQuery
            if (typeof sdk.getHostLaunchQuery === 'function') {
            addLog('info', '调用 getHostLaunchQuery...')
            callGetHostLaunchQuery(sdk)
            return
          }

          addLog('error', 'SDK 上没有 getBlockActionSourceDetail 或 getHostLaunchQuery')
          setError('SDK 方法不可用')
          setLoading(false)
          }) // end h5sdk.ready
        },
        onFail(err) {
          addLog('error', `h5sdk.config 认证失败: ${JSON.stringify(err)}`, err)
          setError(`JSAPI 认证失败: ${err.errMsg || err.errCode || JSON.stringify(err)}`)
          setLoading(false)
        },
      })
    } catch (err) {
      addLog('error', `获取签名失败: ${err.message}`)
      setError(`获取签名失败: ${err.message}`)
      setLoading(false)
    }
  }

  // ── 调用 getHostLaunchQuery ──
  const callGetHostLaunchQuery = (sdk) => {
    sdk.getHostLaunchQuery({
      success(res) {
        addLog('info', 'getHostLaunchQuery 返回成功', res)
        addLog('info', `launchQuery 类型: ${typeof res.launchQuery}, 值: ${res.launchQuery}`)

        if (!res.launchQuery) {
          addLog('warn', 'launchQuery 为空')
          setError('未获取到启动参数 (launchQuery 为空)')
          setLoading(false)
          return
        }

        let triggerCode = null
        try {
          const parsed = JSON.parse(res.launchQuery)
          addLog('info', 'launchQuery JSON 解析成功', parsed)
          triggerCode = parsed.__trigger_id__
          addLog('info', `triggerCode (__trigger_id__): ${triggerCode || '未找到'}`)
          addLog('info', `launchQuery 所有字段: ${Object.keys(parsed).join(', ')}`)
        } catch (e) {
          addLog('error', `launchQuery JSON 解析失败: ${e.message}`, res.launchQuery)
        }

        if (!triggerCode) {
          addLog('error', '未找到 triggerCode (__trigger_id__)')
          setError('未找到 triggerCode')
          setLoading(false)
          return
        }

        if (typeof sdk.getBlockActionSourceDetail !== 'function') {
          addLog('error', 'SDK 缺少 getBlockActionSourceDetail 方法')
          setError('飞书 SDK 缺少 getBlockActionSourceDetail 方法')
          setLoading(false)
          return
        }

        addLog('info', `正在调用 getBlockActionSourceDetail(triggerCode="${triggerCode}")...`)
        sdk.getBlockActionSourceDetail({
          triggerCode,
          success(detailRes) {
            addLog('info', 'getBlockActionSourceDetail 返回成功', detailRes)
            processDetailResponse(detailRes)
          },
          fail(err) {
            addLog('error', `getBlockActionSourceDetail 失败: errCode=${err.errCode}, errMsg=${err.errMsg || err.message || ''}`, err)
            setError(`获取消息详情失败 (错误码: ${err.errCode || '未知'}): ${err.errMsg || err.message || ''}`)
            setLoading(false)
          },
        })
      },
      fail(err) {
        addLog('error', `getHostLaunchQuery 失败: ${JSON.stringify(err)}`, err)
        setError('获取启动参数失败')
        setLoading(false)
      },
    })
  }

  // ── 处理 getBlockActionSourceDetail 返回 ──
  const processDetailResponse = (detailRes) => {
    const content = detailRes.content || {}
    const bizType = detailRes.bizType
    addLog('info', `bizType: ${bizType}, 消息数量: ${(content.messages || []).length}`)

    if (bizType !== 'message') {
      setError(`不支持的业务类型: ${bizType}`)
      setLoading(false)
      return
    }

    const msgList = content.messages || []
    if (msgList.length === 0) {
      setError('未获取到消息数据')
      setLoading(false)
      return
    }

    msgList.forEach((msg, i) => {
      addLog('info', `消息[${i}]: type=${msg.messageType}, sender=${msg.sender?.name}, openMessageId=${msg.openMessageId}`)
    })

    setMessageContext({
      bizType,
      actionTime: content.actionTime,
      openChatId: msgList[0].openChatId,
      openMessageId: msgList[0].openMessageId,
      source: 'sdk',
    })
    setMessages(msgList)
    setLoading(false)

    const messageId = msgList[0].openMessageId
    if (messageId) {
      fetchExecutionLog(messageId)
    }
  }

  // ── 步骤2: 调用 Hermes Agent API 获取执行日志 ──
  const fetchExecutionLog = useCallback(async (messageId) => {
    if (!messageId) return

    setLogLoading(true)
    const url = `${API_BASE}/v1/execution-log?message_id=${encodeURIComponent(messageId)}`
    addLog('info', `正在请求执行日志: ${url}`)

    try {
      const response = await fetch(url)
      addLog('info', `API 响应状态: ${response.status} ${response.statusText}`)

      if (!response.ok) {
        throw new Error(`API 返回 ${response.status}`)
      }

      const data = await response.json()
      addLog('info', `API 返回数据 keys: ${Object.keys(data).join(', ')}`)
      addLog('info', `execution_log 条数: ${(data.execution_log || data.data || []).length}`)

      const log = data.execution_log || data.data || []
      setExecutionLog(Array.isArray(log) ? log : [])
    } catch (err) {
      addLog('warn', `获取执行日志失败: ${err.message}，回退到模拟数据`)
      setExecutionLog(generateMockExecutionLog())
    } finally {
      setLogLoading(false)
    }
  }, [addLog])

  const handleMessageClick = (msg) => {
    const messageId = msg.openMessageId
    addLog('info', `点击消息: openMessageId=${messageId}`)
    if (messageId) {
      setMessageContext(prev => ({
        ...prev,
        openMessageId: messageId,
      }))
      fetchExecutionLog(messageId)
    }
  }

  // ── 渲染: 加载中 ──
  if (loading) {
    return (
      <div className="app">
        <div className="content">
          <div className="loading">
            <div className="spinner" />
            <p>正在获取消息上下文...</p>
          </div>
        </div>
        <DebugPanel visible={debugVisible} onClose={() => setDebugVisible(false)} logs={debugLogs} envInfo={envInfo} messages={messages} executionLog={executionLog} />
      </div>
    )
  }

  // ── 渲染: 错误 ──
  if (error) {
    return (
      <div className="app">
        <div className="content">
          <div className="error-banner"><p>{error}</p></div>
          {!sdkReady && (
            <div className="dev-notice">
              <p>当前为开发模式（未检测到飞书 SDK）</p>
              <p>在飞书客户端中通过消息快捷操作打开本应用即可正常使用。</p>
              <p>请检查调试面板中的环境信息确认 SDK 加载状态。</p>
            </div>
          )}
        </div>
        <DebugPanel visible={debugVisible} onClose={() => setDebugVisible(false)} logs={debugLogs} envInfo={envInfo} messages={messages} executionLog={executionLog} />
      </div>
    )
  }

  // ── 渲染: 无消息（开发模式） ──
  if (!messageContext && messages.length === 0) {
    return (
      <div className="app">
        <div className="content">
          <div className="empty-state">
            <div className="empty-icon">📭</div>
            <p>请在聊天中选择一条消息</p>
            <p className="empty-hint">右键点击消息 → 选择「查看执行逻辑」</p>
          </div>
          {!sdkReady && (
            <div className="dev-notice">
              <p>开发模式：可点击下方按钮加载模拟数据</p>
              <button
                className="btn-primary"
                onClick={() => {
                  addLog('info', '手动加载模拟数据')
                  setMessages([
                    {
                      messageType: 'text',
                      sender: { name: '测试用户', open_id: 'ou_test' },
                      createTime: Math.floor(Date.now() / 1000),
                      support: true,
                      openChatId: 'oc_test',
                      openMessageId: 'om_test_mock',
                      content: '{"text":"帮我写一个 Python 脚本"}',
                      status: true,
                    },
                  ])
                  setMessageContext({
                    bizType: 'message',
                    actionTime: Math.floor(Date.now() / 1000),
                    openChatId: 'oc_test',
                    openMessageId: 'om_test_mock',
                  })
                  setExecutionLog(generateMockExecutionLog())
                }}
              >
                加载模拟数据
              </button>
            </div>
          )}
        </div>
        <DebugPanel visible={debugVisible} onClose={() => setDebugVisible(false)} logs={debugLogs} envInfo={envInfo} messages={messages} executionLog={executionLog} />
      </div>
    )
  }

  // ── 渲染: 主界面 ──
  return (
    <div className="app">
      <div className="content">

        {/* 消息上下文区 */}
        <section className="section message-context">
          <h3 className="section-title">
            <span>消息上下文</span>
            <span className="debug-trigger" onClick={() => setDebugVisible(true)} title="调试面板">🕷️</span>
          </h3>
          <div className="message-list">
            {messages.map((msg, idx) => {
              const { text } = parseMessageContent(msg)
              const isActive = msg.openMessageId === messageContext?.openMessageId
              return (
                <div
                  key={msg.openMessageId || idx}
                  className={`message-item ${isActive ? 'active' : ''} ${!msg.support ? 'unsupported' : ''}`}
                  onClick={() => handleMessageClick(msg)}
                >
                  <div className="message-sender">
                    <span className="sender-avatar">
                      {msg.sender?.name?.charAt(0) || '?'}
                    </span>
                    <span className="sender-name">{msg.sender?.name || '未知'}</span>
                    <span className="message-type-badge">{msg.messageType}</span>
                  </div>
                  <div className="message-text">{text}</div>
                  <div className="message-meta">
                    {msg.createTime && (
                      <span>{new Date(msg.createTime * 1000).toLocaleString()}</span>
                    )}
                    {msg.openMessageId && (
                      <span className="msg-id" title={msg.openMessageId}>
                        ID: {msg.openMessageId.substring(0, 12)}...
                      </span>
                    )}
                    {!msg.support && <span className="unsupported-tag">不支持</span>}
                  </div>
                  <JsonViewer data={msg} label="原始数据" />
                </div>
              )
            })}
          </div>
        </section>

        {/* 执行日志区 */}
        <section className="section execution-section">
          <h3 className="section-title">
            <span>执行逻辑{!logLoading && executionLog.length > 0 && <span className="log-count">{executionLog.length}</span>}</span>
            {messageContext?.openMessageId && (
              <span
                className="refresh-btn"
                onClick={() => fetchExecutionLog(messageContext.openMessageId)}
                title="刷新执行日志"
              >
                ↻
              </span>
            )}
          </h3>

          {logLoading && (
            <div className="log-loading">
              <div className="spinner small" />
              <span>获取执行日志中...</span>
            </div>
          )}

          {!logLoading && executionLog.length === 0 && (
            <div className="log-empty">
              <p>执行日志尚未生成，请稍后</p>
            </div>
          )}

          {!logLoading && executionLog.length > 0 && (
            <div className="execution-timeline">
              {executionLog.map((item, idx) => {
                const config = LOG_TYPE_CONFIG[item.type] || LOG_TYPE_CONFIG.thought
                const isExpanded = expandedItems[idx] !== undefined ? expandedItems[idx] : idx < 3
                return (
                  <div key={item.id || idx} className={`log-item ${config.className}`}>
                    <div className="timeline-dot" />

                    <div className="log-card">
                      <div className="log-card-header" onClick={() => toggleItem(idx)}>
                        <div className="log-header-left">
                          <span className="log-type-badge">
                            <span className="log-icon">{config.icon}</span>
                            {config.label}
                          </span>
                          <span className="log-time">
                            {item.timestamp
                              ? formatTimestamp(item.timestamp)
                              : ''}
                          </span>
                        </div>
                        <div className="log-header-right">
                          <span className={`chevron ${isExpanded ? 'expanded' : ''}`}>▶</span>
                        </div>
                      </div>

                      <div className={`log-card-body ${isExpanded ? 'expanded' : ''}`}>
                        <div className="log-card-body-inner">
                          {/* thought: 只显示 thought-bubble，不显示 log-content */}
                          {item.type === 'thought' && (
                            <div className="thought-bubble">{item.content}</div>
                          )}

                          {/* response: 只显示 response-bubble，不显示 log-content */}
                          {item.type === 'response' && (
                            <div className="response-bubble md-content">
                              <ReactMarkdown>{item.content || ''}</ReactMarkdown>
                            </div>
                          )}

                          {/* tool: 显示 log-content + 可展开的 tool-detail */}
                          {item.type === 'tool' && (
                            <>
                              <div className="log-content">{item.content}</div>
                              {item.toolName && (
                                <ToolDetailCard
                                  title={item.toolName}
                                  params={item.params}
                                  result={item.result}
                                />
                              )}
                            </>
                          )}

                          {/* sub_agent: 显示 log-content + 可展开的 sub-agent-detail */}
                          {item.type === 'sub_agent' && (
                            <>
                              <div className="log-content">{item.content}</div>
                              {item.subAgentName && (
                                <ToolDetailCard
                                  title={item.subAgentName}
                                  params={item.params}
                                  result={item.result}
                                  isSubAgent
                                />
                              )}
                            </>
                          )}

                          {/* error: 显示 log-content */}
                          {item.type === 'error' && (
                            <div className="log-content">{item.content}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {/* 调试面板 FAB */}
      <DebugPanel visible={debugVisible} onClose={() => setDebugVisible(false)} logs={debugLogs} envInfo={envInfo} messages={messages} executionLog={executionLog} />
    </div>
  )
}

// ── Tool / Sub-Agent 详情卡片（参数和结果各自可折叠） ──────────

function ToolDetailCard({ title, params, result, isSubAgent }) {
  const [paramsExpanded, setParamsExpanded] = useState(false)
  const [resultExpanded, setResultExpanded] = useState(false)

  return (
    <div className={`detail-card ${isSubAgent ? 'sub-agent-detail' : 'tool-detail'}`}>
      <div className="detail-title">
        <span>{isSubAgent ? '🤖' : '🔧'}</span>
        <span className="tool-name">{title}</span>
      </div>

      {params && (
        <>
          <div className="detail-block-header" onClick={() => setParamsExpanded(!paramsExpanded)}>
            <span className="detail-label">参数</span>
            <span className={`chevron ${paramsExpanded ? 'expanded' : ''}`}>▶</span>
          </div>
          <div className={`detail-block-body ${paramsExpanded ? 'expanded' : ''}`}>
            <div className="detail-block-content">
              <pre className="detail-pre">{JSON.stringify(params, null, 2)}</pre>
            </div>
          </div>
        </>
      )}

      {result && (
        <>
          <div className="detail-block-header" onClick={() => setResultExpanded(!resultExpanded)}>
            <span className="detail-label">结果</span>
            <span className={`chevron ${resultExpanded ? 'expanded' : ''}`}>▶</span>
          </div>
          <div className={`detail-block-body ${resultExpanded ? 'expanded' : ''}`}>
            <div className="detail-block-content">
              <div className="detail-result">{result}</div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default App
