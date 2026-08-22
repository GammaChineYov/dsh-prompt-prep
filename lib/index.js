/**
 * dsh-prompt-prep: 提示词转译插件（独立包版，2026-08-21）
 *
 * 把模糊用户输入（"还是不行啊""多1G嘛"）结合会话轨迹与历史消息，经本地 llama（8083）
 * 转成明确候选指令，供用户选择覆盖输入框。输入框上方 dock「⚡ 转译」按钮 + assistant
 * 消息「💡 建议」按钮。
 *
 * 架构（v5 语义，2026-08-21 永久化；v2 修正：独立包无 harness，Client RPC 改 webServer 路由）：
 * - Host：webServer.register 暴露 POST /prompt-prep/translate、/prompt-prep/suggest（JSON），
 *   Client 用 fetch 调用（不再依赖 harness.handle——那只对动态插件 sandbox 可用）；
 * - 本地 llama 调用：subprocess spawn python，stdin 传 payload 防 ENAMETOOLONG，
 *   sys.stdin.buffer.read().decode('utf-8') 防 Windows cp936 误读；
 * - 上下文：会话事件索引（listEvents 轻量 seq→类型）+ 最近用户消息快照（readEvent 按需读）
 *   + 模型可调 read_events(fromSeq,toSeq) 定向翻轨迹（tool-call 循环）；
 * - 指代规则：用户完整原话优先（反复抱怨的问题），轨迹只作佐证；数值维度判定防混淆；
 * - modelTrace 返回给 Client 显示"模型翻阅了哪些 seq 区间"。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'prompt-prep'

export const inject = ['tools', 'subprocess', 'sessionQuery', 'webServer']

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(new Error('invalid JSON body: ' + e.message)) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

export function apply(ctx) {
  const PY = 'C:\\Users\\Landrom\\.global-python\\Scripts\\python.exe'
  const BASE = 'http://127.0.0.1:8083/v1/chat/completions'

  function blocksText(blocks) {
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }

  function eventText(ev, maxLen) {
    const d = ev && ev.data
    if (!d) return ''
    const cap = maxLen || 300
    if (ev.type === 'user/message') return blocksText(d.content).slice(0, 500)
    if (ev.type === 'assistant/message') return '[助手] ' + blocksText(d.message && d.message.content).slice(0, cap)
    if (ev.type === 'tool/call') {
      let args = ''
      try { args = JSON.stringify(JSON.parse(d.arguments)).slice(0, 200) } catch { args = String(d.arguments).slice(0, 200) }
      return '[工具调用] ' + d.name + (args ? ' ' + args : '')
    }
    if (ev.type === 'tool/result') return '[工具结果] ' + blocksText(d.message && d.message.content).slice(0, cap)
    return ''
  }

  function isMissingSession(e) {
    return !!(e && e.code === 'SESSION_QUERY_SESSION_NOT_FOUND')
  }

  // 缺失会话去重告警：同一 sessionId 只提示一次，不刷屏但保留可排查痕迹
  const missingSessionWarned = new Set()
  function warnMissingSession(sessionId) {
    if (!sessionId || missingSessionWarned.has(sessionId)) return
    missingSessionWarned.add(sessionId)
    console.warn('[prompt-prep] 会话不存在，按空会话处理: ' + sessionId + '（仅提示一次，若频繁出现请排查 sessionId 来源）')
  }

  async function readLog(sessionId) {
    const sq = ctx.get('sessionQuery')
    if (!sessionId || !sq) return { records: [] }
    try {
      const records = await sq.listEvents(sessionId)
      return { records: records || [] }
    } catch (e) {
      if (isMissingSession(e)) warnMissingSession(sessionId)
      else console.error('listEvents failed', e)
      return { records: [] }
    }
  }

  async function readWindow(sessionId, fromSeq, toSeq) {
    const sq = ctx.get('sessionQuery')
    if (!sq) return []
    try {
      const win = await sq.readEvent({ sessionId, seq: fromSeq, after: Math.min(toSeq - fromSeq, 120) })
      return (win && win.events) || []
    } catch (e) {
      if (isMissingSession(e)) warnMissingSession(sessionId)
      else console.error('readEvent failed', e)
      return []
    }
  }

  function buildIndex(records, maxRows) {
    const rows = []
    for (const rec of records) {
      let tag = ''
      if (rec.type === 'user/message') tag = '用户消息'
      else if (rec.type === 'assistant/message') tag = '助手'
      else if (rec.type === 'tool/call') tag = '工具调用'
      else if (rec.type === 'tool/result') tag = '工具结果'
      else continue
      rows.push('seq ' + rec.seq + ' [' + tag + ']')
    }
    return rows.slice(-(maxRows || 300)).join('\n')
  }

  async function buildSnapshot(sessionId, records, count) {
    const userSeqs = records.filter((r) => r.type === 'user/message').map((r) => r.seq)
    const recent = userSeqs.slice(-(count || 15))
    const lines = []
    for (const seq of recent) {
      const evs = await readWindow(sessionId, seq, seq)
      const ev = evs.find((e) => e.seq === seq)
      const t = eventText(ev, 400)
      if (t) lines.push('seq ' + seq + ' ' + t)
    }
    return lines.join('\n')
  }

  const SCRIPT = [
    'import sys, json, urllib.request',
    'body = sys.stdin.buffer.read().decode("utf-8")',
    'req = urllib.request.Request(' + JSON.stringify(BASE) + ', data=body.encode("utf-8"), headers={"Content-Type": "application/json; charset=utf-8"})',
    'r = json.loads(urllib.request.urlopen(req, timeout=240).read())',
    'sys.stdout.buffer.write(json.dumps(r, ensure_ascii=False).encode("utf-8"))',
  ].join('; ')

  async function callLocal(messages, tools, maxTokens, signal) {
    const sp = ctx.get('subprocess')
    if (!sp) throw new Error('subprocess unavailable')
    const payload = JSON.stringify({
      model: 'Qwen3.5-9B-Q4_K_M.gguf',
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: maxTokens || 1600,
      temperature: 0.3,
    })
    const handle = sp.spawn({
      argv: [PY, '-c', SCRIPT],
      cwd: 'C:\\',
      stdio: {
        stdin: { data: payload },
        stdout: { maxBytes: 2 * 1024 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 30000,
      signal,
    })
    const outcome = await handle.done
    const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    if (outcome.exitCode !== 0) {
      throw new Error('本地模型调用失败: ' + (err || ('exit ' + outcome.exitCode)))
    }
    return JSON.parse(out)
  }

  const READ_RANGE_TOOL = {
    type: 'function',
    function: {
      name: 'read_events',
      description: '按 seq 范围读取会话事件正文（用户消息/助手/工具调用/工具结果），用于确认指代。最多一次 120 条。',
      parameters: {
        type: 'object',
        properties: {
          fromSeq: { type: 'integer', description: '起始 seq（含）' },
          toSeq: { type: 'integer', description: '结束 seq（含）' },
        },
        required: ['fromSeq', 'toSeq'],
      },
    },
  }
  const EMIT_TOOL = {
    type: 'function',
    function: {
      name: 'emit_suggestions',
      description: '输出 1-4 条明确的候选指令（中文，可直接作为用户下一条消息发送给 agent），并标注每条意图。',
      parameters: {
        type: 'object',
        properties: {
          suggestions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '候选指令全文，明确指代对象/工具/期望结果' },
                note: { type: 'string', description: '一句话说明这条指令针对什么' },
              },
              required: ['text', 'note'],
            },
          },
        },
        required: ['suggestions'],
      },
    },
  }

  const SYSTEM = [
    '你是「提示词转译器」。用户在与一个自动化 agent 对话，他的消息经常缺乏指代（如“还是不行啊”“多1G嘛”“触发一下”）。',
    '你的任务：结合【会话事件索引】与【最近消息快照】，判断模糊输入的真实指代，改写为 1-4 条明确、可执行、无歧义的候选指令。',
    '【可用信息】',
    '1. 事件索引：每行 “seq N [类型]”，N 是事件序号，类型是用户消息/助手/工具调用/工具结果。索引不含正文。',
    '2. 最近快照：最后若干条用户消息的完整正文（带 seq 标注）。',
    '3. 需要看更早或更详细的正文时，调用 read_events(fromSeq, toSeq) 按序号区间读取。',
    '【指代解析规则（按优先级）】',
    '4. 第一优先：用户自己之前发过的消息里的明确诉求/问题。最新模糊消息（“还是不行啊”“还是没解决”）默认指代【用户反复抱怨或最近明确提出的那个问题】，候选指令必须围绕它。',
    '5. 第二优先：会话轨迹（工具结果、报错）只作佐证，不能替代用户原话成为指代对象。',
    '6. 若最近快照里找不到用户之前的明确诉求，用 read_events 往更早的“用户消息”序号查。',
    '【数值/属性维度判定】',
    '7. 用户提到数值对比（多1G、大1G、快2倍）时，先确认维度（可用内存/显存/模型体积/速度/精度/参数量），从上下文实际讨论对象判定，禁止偷换维度。',
    '【话题聚焦】',
    '8. 建议必须围绕【会话最新主题】：以最近几条用户消息和助手回复的焦点为准。历史里的旧问题（如几轮前的报错/抱怨）如果已被后续讨论转向或处理，不要重复建议；除非用户在最近消息里仍在追问它。',
    '【输出规则】',
    '9. 候选指令像用户直接对 agent 说话，明确动作对象与期望结果。',
    '最后调用 emit_suggestions 输出候选。不要在其他文本里输出 JSON。',
  ].join('\n')

  async function runLoop(messages, tools, sessionId, maxRounds, signal) {
    const modelTrace = []
    let suggestions = []
    for (let i = 0; i < maxRounds; i++) {
      if (signal && signal.aborted) break
      const resp = await callLocal(messages, tools, undefined, signal)
      const m = resp.choices && resp.choices[0] && resp.choices[0].message
      const tcs = (m && m.tool_calls) || []
      if (!tcs.length) break
      messages.push({ role: 'assistant', content: m.content || null, tool_calls: tcs })
      let done = false
      for (const tc of tcs) {
        let args = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
        if (tc.function.name === 'read_events') {
          const from = Number(args.fromSeq)
          const to = Number(args.toSeq)
          if (Number.isFinite(from) && Number.isFinite(to)) {
            const evs = await readWindow(sessionId, from, to)
            const text = evs
              .map((ev) => { const t = eventText(ev, 300); return t ? 'seq ' + ev.seq + ' ' + t : '' })
              .filter(Boolean)
              .join('\n')
            messages.push({ role: 'tool', tool_call_id: tc.id, content: text || '（该区间无事件）' })
            modelTrace.push({ tool: 'read_events', from, to, hits: evs.length })
          } else {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: '（fromSeq/toSeq 无效）' })
          }
        } else if (tc.function.name === 'emit_suggestions') {
          const list = Array.isArray(args.suggestions) ? args.suggestions : []
          suggestions = list
            .filter((s) => s && typeof s.text === 'string' && s.text.trim())
            .map((s) => ({ text: s.text.trim(), note: typeof s.note === 'string' ? s.note : '' }))
          modelTrace.push({ tool: 'emit_suggestions', count: suggestions.length })
          done = true
        } else {
          modelTrace.push({ tool: tc.function.name })
          messages.push({ role: 'tool', tool_call_id: tc.id, content: '（未知工具）' })
        }
      }
      if (done) break
    }
    return { suggestions, modelTrace }
  }

  async function translate(sessionId, draft, signal) {
    const { records } = await readLog(sessionId)
    const index = buildIndex(records, 300)
    const snapshot = await buildSnapshot(sessionId, records, 15)
    const context = (
      '[会话事件索引（seq → 类型，正文用 read_events 按需读取）]\n' + (index || '（空）') +
      '\n\n[最近用户消息快照（带 seq，主依据）]\n' + (snapshot || '（无）')
    )
    const userMsg = '[用户最新消息]\n' + (draft || '（空）')
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: context + '\n\n' + userMsg },
    ]
    return runLoop(messages, [READ_RANGE_TOOL, EMIT_TOOL], sessionId, 5, signal)
  }

  async function suggest(sessionId, signal) {
    const { records } = await readLog(sessionId)
    const index = buildIndex(records, 300)
    const snapshot = await buildSnapshot(sessionId, records, 15)
    const context = (
      '[会话事件索引]\n' + (index || '（空）') +
      '\n\n[最近用户消息快照]\n' + (snapshot || '（无）')
    )
    const prompt = context + '\n\n[任务] 会话刚结束一轮。先确定【当前最新主题】（看最近几条用户消息与助手回复的焦点），建议必须围绕当前主题；历史旧问题已被转向则不要重复。给出 1-4 条建议指令（中文），明确指代对象与期望结果。'
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }]
    return runLoop(messages, [READ_RANGE_TOOL, EMIT_TOOL], sessionId, 4, signal)
  }

  // ============ webServer 路由（Client RPC 替代 harness.handle——独立包无 harness） ============
  const ws = ctx.get('webServer')
  if (ws) {
    ctx.effect(() => {
      const d1 = ws.register({
        kind: 'exact',
        path: '/prompt-prep/translate',
        handler: async (req, res) => {
          const ac = new AbortController()
          req.on('close', () => ac.abort())
          try {
            const body = await readBody(req)
            const r = await translate(body.sessionId, typeof body.draft === 'string' ? body.draft : '', ac.signal)
            sendJson(res, 200, { ok: true, suggestions: r.suggestions, modelTrace: r.modelTrace })
          } catch (e) {
            if (ac.signal.aborted) return
            sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
        },
      })
      const d2 = ws.register({
        kind: 'exact',
        path: '/prompt-prep/suggest',
        handler: async (req, res) => {
          const ac = new AbortController()
          req.on('close', () => ac.abort())
          try {
            const body = await readBody(req)
            const r = await suggest(body.sessionId, ac.signal)
            sendJson(res, 200, { ok: true, suggestions: r.suggestions, modelTrace: r.modelTrace })
          } catch (e) {
            if (ac.signal.aborted) return
            sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
        },
      })
      return () => { d1(); d2() }
    }, 'prompt-prep: routes')
  }

  // 注册工具（agent 排查/状态可见）
  const renderJson = (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]
  ctx.tools.register(defineTool({
    name: 'prompt_prep_status',
    description: '查看 prompt-prep 提示词转译插件状态：本地 llama 端点、模型、依赖服务、HTTP 路由是否可用。',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute() {
      return {
        base: BASE,
        model: 'Qwen3.5-9B-Q4_K_M.gguf',
        python: PY,
        subprocess: !!ctx.get('subprocess'),
        sessionQuery: !!ctx.get('sessionQuery'),
        webServer: !!ctx.get('webServer'),
        routes: ['/prompt-prep/translate', '/prompt-prep/suggest'],
      }
    },
  }))
}
