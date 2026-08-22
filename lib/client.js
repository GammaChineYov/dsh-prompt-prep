// dsh-prompt-prep — browser half（ModuleLoader bundle 格式，v6：跨会话隔离 + 取消按钮）
//
// 输入框上方 dock「⚡ 转译」+ assistant 消息「💡 建议」。
// 读写走 fetch → Host webServer 路由（/prompt-prep/translate、/prompt-prep/suggest）。
// 失败时在 dock 显示气泡式错误条（红色，带关闭按钮）。
// 样式用 <style> 注入（类名 prep- 前缀隔离）。

window.__ModuleLoader__.load({
  id: 'dsh-prompt-prep',
  factory: function (require) {
    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    var CSS = `
.prep-dock { display:flex; flex-direction:column; gap:6px; padding:6px 2px; }
.prep-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.prep-btn {
  display:inline-flex; align-items:center; gap:4px; padding:4px 12px;
  border-radius:999px; font-size:12px; font-weight:600; cursor:pointer;
  border:1px solid var(--dsw-alias-brand-primary,#5b9cf5);
  background:var(--dsw-alias-brand-primary,#5b9cf5);
  color:#fff;
}
.prep-btn:hover { filter:brightness(1.12); }
.prep-btn:disabled { opacity:.5; cursor:default; filter:none; }
.prep-btn-ghost {
  display:inline-flex; align-items:center; gap:3px; padding:2px 8px;
  border-radius:999px; font-size:11px; cursor:pointer;
  border:1px solid var(--dsw-alias-brand-primary,#5b9cf5);
  background:transparent; color:var(--dsw-alias-brand-primary,#5b9cf5);
}
.prep-btn-ghost:hover { background:var(--dsw-alias-brand-primary,#5b9cf5); color:#fff; }
.prep-btn-cancel {
  display:inline-flex; align-items:center; gap:3px; padding:2px 10px;
  border-radius:999px; font-size:11px; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.5));
  background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.25));
  color:var(--dsw-alias-label-secondary,rgba(255,255,255,.7));
}
.prep-btn-cancel:hover { border-color:var(--dsw-alias-state-error-primary,#e5534b); color:var(--dsw-alias-state-error-primary,#e5534b); }
.prep-list { display:flex; flex-direction:column; gap:6px; }
.prep-item {
  display:flex; align-items:flex-start; gap:8px; padding:8px 10px;
  border-radius:8px; border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.5));
  background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.35));
  cursor:pointer; text-align:left; color:var(--dsw-alias-label-primary,#fff);
  box-shadow:0 1px 3px rgba(0,0,0,.3);
}
.prep-item:hover { border-color:var(--dsw-alias-brand-primary,#5b9cf5); }
.prep-item-note { font-size:11px; color:var(--dsw-alias-label-secondary,rgba(255,255,255,.65)); margin-top:3px; }
.prep-trace { font-size:10px; color:var(--dsw-alias-label-secondary,rgba(255,255,255,.55)); font-family:monospace; }
.prep-spin { display:inline-block; width:12px; height:12px; border:2px solid rgba(128,128,128,.3); border-top-color:var(--dsw-alias-brand-primary,#5b9cf5); border-radius:50%; animation:prep-spin .8s linear infinite; }
@keyframes prep-spin { to { transform: rotate(360deg); } }
.prep-error {
  display:flex; align-items:flex-start; gap:6px; padding:6px 10px;
  border-radius:6px; border:1px solid var(--dsw-alias-state-error-primary,#e5534b);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 12%, transparent);
  color:var(--dsw-alias-state-error-primary,#e5534b); font-size:12px; line-height:1.5;
}
.prep-error-close { cursor:pointer; font-size:12px; flex:0 0 auto; border:none; background:transparent; color:inherit; padding:0 2px; }
`

    function callApi(path, body, signal) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: signal,
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || !data || !data.ok) {
            throw new Error((data && data.error) || ('HTTP ' + res.status))
          }
          return data
        })
      })
    }

    function errText(e) {
      if (e && e.name === 'AbortError') return '已取消'
      return String(e && e.message ? e.message : e)
    }

    // ---- 按会话隔离的共享状态（跨会话边界要求） ----
    var sharedBySession = {}
    var listeners = {}

    function slotOf(sessionId) {
      var key = sessionId || 'default'
      if (!sharedBySession[key]) {
        sharedBySession[key] = { suggestions: [], trace: null, busy: false }
      }
      return sharedBySession[key]
    }

    function setShared(sessionId, next, trace, busy) {
      var slot = slotOf(sessionId)
      slot.suggestions = next
      slot.trace = trace || null
      slot.busy = !!busy
      Object.keys(listeners).forEach(function (k) { listeners[k]() })
    }

    function readShared(sessionId) {
      var slot = slotOf(sessionId)
      return { suggestions: slot.suggestions, trace: slot.trace, busy: slot.busy }
    }

    function applyDraft(inputActions, text) {
      if (inputActions && typeof inputActions.setDraft === 'function') inputActions.setDraft(text)
    }

    function traceText(trace) {
      if (!trace || !trace.length) return ''
      return trace.map(function (t) {
        if (t.tool === 'read_events') return 'read_events(seq ' + t.from + '-' + t.to + ')'
        if (t.tool === 'emit_suggestions') return 'emit_suggestions'
        return t.tool
      }).join(' → ')
    }

    function ErrorBubble(props) {
      return h('div', { className: 'prep-error' },
        h('span', { style: { flex: '1 1 auto' } }, '⚠ ' + props.message),
        h('button', { className: 'prep-error-close', onClick: props.onClose, title: '关闭' }, '✕'),
      )
    }

    function DockView(props) {
      var sessionId = props.sessionId
      var inputActions = props.inputActions
      var input = props.input
      var draft = input && input.draft ? input.draft : ''
      var state = useState({ suggestions: [], trace: null, busy: false, err: null })
      var local = state[0]
      var setLocal = state[1]
      var abortRef = React.useRef(null)

      // 外部 setShared（assistant 建议按钮写入本会话槽）→ 同步到本地渲染
      var shared = readShared(sessionId)
      useEffect(function () {
        var fn = function () {
          var s = readShared(sessionId)
          setLocal(function (prev) {
            if (prev.busy) return prev // 本地进行中不覆盖
            return Object.assign({}, prev, { suggestions: s.suggestions, trace: s.trace })
          })
        }
        var key = 'dock-' + (sessionId || 'default') + '-' + Math.random().toString(36).slice(2)
        listeners[key] = fn
        return function () { delete listeners[key] }
      }, [sessionId])

      var translate = function () {
        if (abortRef.current) abortRef.current.abort()
        var ac = new AbortController()
        abortRef.current = ac
        setLocal(function (s) { return Object.assign({}, s, { suggestions: [], trace: null, busy: true, err: null }) })
        setShared(sessionId, [], null, true)
        callApi('/prompt-prep/translate', { sessionId: sessionId, draft: draft }, ac.signal).then(function (res) {
          var list = res && res.suggestions ? res.suggestions : []
          var trace = res && res.modelTrace ? res.modelTrace : null
          setLocal(function (s) { return Object.assign({}, s, { suggestions: list, trace: trace, busy: false }) })
          setShared(sessionId, list, trace, false)
        }).catch(function (e) {
          setLocal(function (s) { return Object.assign({}, s, { err: errText(e), busy: false }) })
          setShared(sessionId, [], null, false)
        })
      }

      var cancel = function () {
        if (abortRef.current) {
          abortRef.current.abort()
          abortRef.current = null
        }
        setLocal(function (s) { return Object.assign({}, s, { busy: false, err: null }) })
        setShared(sessionId, local.suggestions, local.trace, false)
      }

      var dismissError = function () {
        setLocal(function (s) { return Object.assign({}, s, { err: null }) })
      }

      var list = local.suggestions.length > 0 ? local.suggestions : shared.suggestions
      var trace = local.trace || shared.trace
      var busy = local.busy || shared.busy
      var visible = list.length > 0 || busy || local.err
      if (!visible) {
        return h('div', { className: 'prep-dock' },
          h('div', { className: 'prep-row' },
            h('button', { className: 'prep-btn', onClick: translate, disabled: busy, title: '把模糊输入结合会话轨迹转成候选指令，点击覆盖输入框' }, '⚡ 转译'),
          ),
        )
      }

      var traceStr = traceText(trace)
      return h('div', { className: 'prep-dock' },
        h('div', { className: 'prep-row' },
          h('button', { className: 'prep-btn', onClick: translate, disabled: busy }, '⚡ 转译'),
          busy ? h('span', { className: 'prep-spin' }) : null,
          busy ? h('button', { className: 'prep-btn-cancel', onClick: cancel }, '✕ 取消') : null,
        ),
        local.err ? h(ErrorBubble, { message: local.err, onClose: dismissError }) : null,
        list.length > 0 ? h('div', { className: 'prep-list' },
          list.map(function (s, i) {
            return h('button', {
              key: i,
              className: 'prep-item',
              onClick: function () { applyDraft(inputActions, s.text) },
            },
              h('div', null,
                h('div', null, s.text),
                s.note ? h('div', { className: 'prep-item-note' }, s.note) : null,
              ),
            )
          }),
        ) : null,
        traceStr ? h('div', { className: 'prep-trace' }, '模型翻阅：' + traceStr + (trace && trace.length >= 2 ? '（' + trace.length + ' 步）' : '')) : null,
      )
    }

    function SuggestAction(props) {
      var sessionId = props.sessionId
      var state = useState({ busy: false, err: null })
      var busy = state[0].busy
      var err = state[0].err
      var setState = state[1]
      var abortRef = React.useRef(null)

      var suggest = function () {
        if (abortRef.current) abortRef.current.abort()
        var ac = new AbortController()
        abortRef.current = ac
        setState(function (s) { return Object.assign({}, s, { busy: true, err: null }) })
        callApi('/prompt-prep/suggest', { sessionId: sessionId, messageId: props.messageId }, ac.signal).then(function (res) {
          var list = res && res.suggestions ? res.suggestions : []
          var trace = res && res.modelTrace ? res.modelTrace : null
          setShared(sessionId, list, trace, false)
          setState(function (s) { return Object.assign({}, s, { busy: false }) })
        }).catch(function (e) {
          var msg = errText(e)
          setState(function (s) { return Object.assign({}, s, { busy: false, err: msg }) })
          setShared(sessionId, [], null, false)
        })
      }

      var cancel = function () {
        if (abortRef.current) {
          abortRef.current.abort()
          abortRef.current = null
        }
        setState(function (s) { return Object.assign({}, s, { busy: false }) })
      }

      var dismiss = function () { setState(function (s) { return Object.assign({}, s, { err: null }) }) }
      return h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, position: 'relative' } },
        h('button', {
          className: 'prep-btn-ghost',
          onClick: suggest,
          disabled: busy,
          title: '根据会话轨迹生成建议指令，选择后覆盖输入框',
        }, busy ? '…' : '💡 建议'),
        busy ? h('button', { className: 'prep-btn-cancel', onClick: cancel, style: { padding: '1px 6px', fontSize: 10 } }, '取消') : null,
        err ? h(ErrorBubble, { message: err, onClose: dismiss }) : null,
      )
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.effect(function () {
          var style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return function () {
            if (style.parentNode) style.parentNode.removeChild(style)
          }
        }, 'prompt-prep: styles')

        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register({ name: 'conversation.input.dock', id: 'prompt-prep', order: 25 },
            function (props) { return React.createElement(DockView, props) }
          )
        })

        ctx.slots.inject('conversation.chat.assistant-actions', function () {
          return ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'prompt-prep-suggest', order: 30 },
            function (props) { return React.createElement(SuggestAction, props) }
          )
        })
      },
    }
  },
})
