/**
 * dsh-plugin-kefu — Client half.
 *
 * A plain-JavaScript client module (no build step) that registers the 客服 panel
 * in the sidebar. Four tabs: the handover queue, the product knowledge base, the
 * channel setup, and the shop policy (triggers / sensitive words / hours).
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-kefu',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const BASE = '/plugins/dsh-plugin-kefu/'
    const API = `${BASE}api/`

    const zh = (typeof navigator !== 'undefined' ? navigator.language : 'zh').toLowerCase().startsWith('zh')
    const COPY = {
      panel: zh ? '客服' : 'Service',
      title: zh ? '电商客服台' : 'Customer service desk',
      subtitle: zh
        ? '有依据才回复，拿不准就转人工'
        : 'Answers from evidence, hands over when unsure',
      tabs: {
        queue: zh ? '待处理' : 'Queue',
        kb: zh ? '知识库' : 'Knowledge',
        channels: zh ? '通道' : 'Channels',
        settings: zh ? '设置' : 'Settings',
      },
      refresh: zh ? '刷新' : 'Refresh',
      loading: zh ? '加载中…' : 'Loading…',
      empty: zh ? '还没有数据' : 'Nothing here yet',
      pending: zh ? '待人工' : 'Waiting',
      human: zh ? '人工中' : 'Human',
      bot: zh ? 'AI 已答' : 'Answered',
      closed: zh ? '已关闭' : 'Closed',
      send: zh ? '发送回复' : 'Send reply',
      sending: zh ? '发送中…' : 'Sending…',
      adopt: zh ? '复制并标记已发' : 'Copy & mark sent',
      markHuman: zh ? '我来接手' : 'Take over',
      close: zh ? '关闭会话' : 'Close',
      reasons: zh ? '转人工原因' : 'Handover reasons',
      noReasons: zh ? '没有记录原因' : 'No reason recorded',
      draftPlaceholder: zh ? '在这个框里改一改再发。没把握就留给人。' : 'Edit before sending. Leave it to a human when unsure.',
      buyer: zh ? '买家' : 'Buyer',
      channel: zh ? '通道' : 'Channel',
      confidence: zh ? '匹配度' : 'Confidence',
      citations: zh ? '回答依据' : 'Cited evidence',
      importTitle: zh ? '导入商品' : 'Import products',
      importHint: zh
        ? '粘贴 CSV / TSV / JSON / Markdown 表格（表头：标题,价格,规格,参数,发货,售后）。重复导入会按商品更新。'
        : 'Paste CSV / TSV / JSON / Markdown (headers: title, price, skus, attrs, shipping, afterSales).',
      import: zh ? '导入' : 'Import',
      importing: zh ? '导入中…' : 'Importing…',
      searchPlaceholder: zh ? '搜索商品 / 关键词' : 'Search products',
      productCount: zh ? '个商品' : 'products',
      testTitle: zh ? '试一句买家提问' : 'Try a buyer question',
      testPlaceholder: zh ? '例如：这个多少钱？什么时候发货？' : 'e.g. How much is this? When will it ship?',
      test: zh ? '试一下' : 'Test',
      actionAuto: zh ? '会直接回复' : 'Would reply',
      actionCopilot: zh ? '会等你确认' : 'Would wait for you',
      actionEscalate: zh ? '会转人工' : 'Would escalate',
      save: zh ? '保存' : 'Save',
      saved: zh ? '已保存' : 'Saved',
      channelReady: zh ? '可用' : 'Ready',
      channelOff: zh ? '未启用' : 'Disabled',
      channelIncomplete: zh ? '待配置' : 'Needs setup',
      inboundUrl: zh ? '推送地址' : 'Inbound URL',
      copy: zh ? '复制' : 'Copy',
      copied: zh ? '已复制' : 'Copied',
      mode: zh ? '接待模式' : 'Mode',
      copilot: zh ? '人机协作' : 'Copilot',
      auto: zh ? 'AI 全托管' : 'Full auto',
      copilotHint: zh ? 'AI 接常规问题，其余进待处理队列' : 'AI answers routine questions, the rest goes to the queue',
      autoHint: zh ? 'AI 直接发，仍守住敏感词与转人工规则' : 'AI sends directly, still blocked by red lines',
      threshold: zh ? '自动回复的匹配度下限' : 'Minimum confidence to auto-reply',
      triggers: zh ? '转人工触发' : 'Handover triggers',
      triggerWords: zh ? '触发词（逗号分隔）' : 'Trigger words (comma separated)',
      sensitiveWords: zh ? '敏感词（命中整条不发）' : 'Sensitive words (block the whole reply)',
      hours: zh ? '接待时段' : 'Business hours',
      modelTitle: zh ? '用 DSH 的模型写回复' : 'Phrase replies with DSH',
      modelHint: zh
        ? '开启后，插件把「证据 + 买家问题」交给 DSH 的模型改写措辞；模型只许复述证据，出现证据里没有的数字或平台红线内容会自动丢弃并回退模板。'
        : 'When on, the plugin hands evidence plus the buyer question to the DSH model. The model may only rephrase evidence; invented numbers or red-line content are discarded and the template is used.',
      modelUse: zh ? '模型改写措辞（Recommend）' : 'Let the model phrase replies',
      modelAuto: zh ? '自动（第一个可用）' : 'Auto (first available)',
      modelReady: zh ? '模型可用' : 'Model available',
      modelUnavailable: zh ? '没有 llm 服务' : 'No llm service',
      modelInUse: zh ? '当前使用' : 'In use',
      redLines: zh ? '平台红线（不可关闭）' : 'Platform red lines (cannot be disabled)',
      triggerLabels: {
        image: zh ? '买家发来图片' : 'Buyer sent an image',
        address: zh ? '修改地址' : 'Address change',
        orderNote: zh ? '订单备注' : 'Order note',
        afterSales: zh ? '售后问题' : 'After-sales',
        lowConfidence: zh ? '匹配度不足' : 'Low confidence',
        offHours: zh ? '非接待时段' : 'Off hours',
        unlisted: zh ? '知识库未命中' : 'Not in knowledge base',
      },
      adoptHint: zh
        ? '千牛/京麦没有配置官方发送接口时，插件不会发送：点这里把草稿复制走，人工在客户端里发。'
        : 'Without an official send method the plugin will not deliver: copy the draft and send it in the client yourself.',
      noConversation: zh ? '左边选一个会话' : 'Pick a conversation on the left',
      stats: {
        pending: zh ? '待人工' : 'waiting',
        human: zh ? '人工' : 'human',
        bot: zh ? 'AI' : 'AI',
        products: zh ? '商品' : 'products',
      },
    }

    const UI_CSS = `
.dsh-kefu-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsh-text-primary,inherit)}
.dsh-kefu-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsh-border, rgba(127,127,127,.18))}
.dsh-kefu-title{font-weight:600;font-size:14px}
.dsh-kefu-sub{opacity:.55;font-size:11px}
.dsh-kefu-stats{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.dsh-kefu-chip{border:1px solid var(--dsh-border, rgba(127,127,127,.2));border-radius:999px;padding:2px 8px;font-size:11px;opacity:.8;white-space:nowrap}
.dsh-kefu-tabs{display:flex;gap:2px;padding:6px 10px;border-bottom:1px solid var(--dsh-border, rgba(127,127,127,.18))}
.dsh-kefu-tab{border:0;background:transparent;color:inherit;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;opacity:.6}
.dsh-kefu-tab[data-active=true]{background:var(--dsh-surface-2, rgba(127,127,127,.14));opacity:1;font-weight:600}
.dsh-kefu-body{flex:1;min-height:0;display:flex}
.dsh-kefu-col{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.dsh-kefu-scroll{overflow:auto;padding:10px 12px;min-height:0}
.dsh-kefu-split{display:flex;flex:1;min-height:0}
.dsh-kefu-list{width:260px;min-width:200px;border-right:1px solid var(--dsh-border, rgba(127,127,127,.18));overflow:auto}
.dsh-kefu-item{padding:8px 10px;border-bottom:1px solid var(--dsh-border, rgba(127,127,127,.1));cursor:pointer;display:flex;flex-direction:column;gap:3px}
.dsh-kefu-item[data-active=true]{background:var(--dsh-surface-2, rgba(127,127,127,.13))}
.dsh-kefu-item-top{display:flex;align-items:center;gap:6px}
.dsh-kefu-item-name{font-weight:600;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-kefu-item-text{font-size:11px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-kefu-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsh-border, rgba(127,127,127,.25));opacity:.85;white-space:nowrap}
.dsh-kefu-badge[data-tone=warn]{border-color:#d08a2c;color:#d08a2c}
.dsh-kefu-badge[data-tone=ok]{border-color:#2f9e6b;color:#2f9e6b}
.dsh-kefu-badge[data-tone=info]{border-color:#3d7fb8;color:#3d7fb8}
.dsh-kefu-detail{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.dsh-kefu-thread{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dsh-kefu-msg{max-width:86%;padding:6px 9px;border-radius:8px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.dsh-kefu-msg[data-role=buyer]{align-self:flex-start;background:var(--dsh-surface-2, rgba(127,127,127,.14))}
.dsh-kefu-msg[data-role=shop]{align-self:flex-end;background:rgba(61,127,184,.16)}
.dsh-kefu-msg[data-role=system]{align-self:center;background:transparent;border:1px dashed var(--dsh-border, rgba(127,127,127,.35));opacity:.85;max-width:96%}
.dsh-kefu-reasons{display:flex;flex-wrap:wrap;gap:5px;padding:8px 12px;border-top:1px dashed var(--dsh-border, rgba(127,127,127,.25))}
.dsh-kefu-compose{border-top:1px solid var(--dsh-border, rgba(127,127,127,.18));padding:8px 12px;display:flex;flex-direction:column;gap:6px}
.dsh-kefu-textarea{width:100%;min-height:64px;resize:vertical;border-radius:6px;border:1px solid var(--dsh-border, rgba(127,127,127,.3));background:var(--dsh-input-bg, transparent);color:inherit;padding:6px 8px;font:inherit;font-size:12px}
.dsh-kefu-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsh-kefu-btn{border:1px solid var(--dsh-border, rgba(127,127,127,.3));background:transparent;color:inherit;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.dsh-kefu-btn[data-primary=true]{background:var(--dsh-accent, #3d7fb8);border-color:transparent;color:#fff}
.dsh-kefu-btn:disabled{opacity:.45;cursor:default}
.dsh-kefu-field{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
.dsh-kefu-field > label{font-size:11px;opacity:.7}
.dsh-kefu-input,.dsh-kefu-select{width:100%;border-radius:6px;border:1px solid var(--dsh-border, rgba(127,127,127,.3));background:var(--dsh-input-bg, transparent);color:inherit;padding:4px 7px;font:inherit;font-size:12px}
.dsh-kefu-card{border:1px solid var(--dsh-border, rgba(127,127,127,.2));border-radius:8px;padding:10px;margin-bottom:10px}
.dsh-kefu-card-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.dsh-kefu-card-title{font-weight:600;font-size:12px}
.dsh-kefu-small{font-size:11px;opacity:.62}
.dsh-kefu-pre{margin:0;padding:8px;border-radius:6px;background:var(--dsh-surface-2, rgba(127,127,127,.1));font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
.dsh-kefu-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.dsh-kefu-toast{position:sticky;bottom:0;padding:6px 12px;font-size:11px;color:var(--dsh-accent, #3d7fb8)}
.dsh-kefu-check{display:flex;align-items:center;gap:6px;font-size:12px;margin:3px 0}
.dsh-kefu-empty{padding:28px 12px;text-align:center;opacity:.5;font-size:12px}
`

    async function api(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        headers: options.body ? { 'content-type': 'application/json' } : undefined,
        method: options.method ?? (options.body ? 'POST' : 'GET'),
        body: options.body ? JSON.stringify(options.body) : undefined,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `HTTP ${response.status}`)
      }
      return payload
    }

    function fmtTime(at) {
      if (!at) return ''
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    const STATUS_TONE = { pending: 'warn', human: 'info', bot: 'ok', closed: '' }

    function createComponents() {
      const t = COPY

      function Chip({ children, tone }) {
        return h('span', { className: 'dsh-kefu-chip' }, children)
      }

      function Badge({ children, tone }) {
        return h('span', { className: 'dsh-kefu-badge', 'data-tone': tone ?? '' }, children)
      }

      function Toast({ text }) {
        if (!text) return null
        return h('div', { className: 'dsh-kefu-toast' }, text)
      }

      function Button({ children, onClick, primary, disabled }) {
        return h(
          'button',
          { type: 'button', className: 'dsh-kefu-btn', 'data-primary': primary === true, onClick, disabled },
          children,
        )
      }

      /* ---------------- Queue ---------------- */

      function QueueTab({ toast, setToast }) {
        const [items, setItems] = useState([])
        const [stats, setStats] = useState({})
        const [activeId, setActiveId] = useState(null)
        const [detail, setDetail] = useState(null)
        const [draft, setDraft] = useState('')
        const [busy, setBusy] = useState(false)
        const [filter, setFilter] = useState('pending')

        const load = useCallback(async () => {
          try {
            const data = await api(`queue?status=${filter}&limit=100`)
            setItems(data.conversations ?? [])
            setStats(data.stats ?? {})
            setActiveId((current) => current ?? data.conversations?.[0]?.id ?? null)
          } catch (error) {
            setToast(error.message)
          }
        }, [filter, setToast])

        useEffect(() => {
          void load()
          const timer = setInterval(() => void load(), 15000)
          return () => clearInterval(timer)
        }, [load])

        useEffect(() => {
          if (activeId === null) {
            setDetail(null)
            return
          }
          let cancelled = false
          api(`queue/${encodeURIComponent(activeId)}`)
            .then((data) => {
              if (cancelled) return
              setDetail(data.conversation)
              const suggestion = [...(data.conversation?.messages ?? [])]
                .reverse()
                .find((message) => message.role === 'system' && String(message.text ?? '').includes('待采纳'))
              setDraft(suggestion ? String(suggestion.text).replace(/^建议回复（待采纳）：/, '') : '')
            })
            .catch((error) => setToast(error.message))
          return () => {
            cancelled = true
          }
        }, [activeId, setToast])

        const send = async () => {
          if (detail === null || draft.trim() === '') return
          setBusy(true)
          try {
            const result = await api(`queue/${encodeURIComponent(detail.id)}/send`, { body: { text: draft } })
            setToast(result.delivery?.detail ?? t.saved)
            await load()
            const refreshed = await api(`queue/${encodeURIComponent(detail.id)}`)
            setDetail(refreshed.conversation)
            setDraft('')
          } catch (error) {
            setToast(error.message)
          } finally {
            setBusy(false)
          }
        }

        const adopt = async () => {
          if (draft.trim() === '') return
          try {
            await navigator.clipboard.writeText(draft)
            setToast(`${t.copied} — ${t.adoptHint}`)
          } catch {
            setToast(draft)
          }
        }

        const setStatus = async (status) => {
          if (detail === null) return
          try {
            await api(`queue/${encodeURIComponent(detail.id)}/status`, { body: { status } })
            setToast(t.saved)
            await load()
          } catch (error) {
            setToast(error.message)
          }
        }

        return h(
          'div',
          { className: 'dsh-kefu-col' },
          h(
            'div',
            { className: 'dsh-kefu-row', style: { padding: '6px 12px', borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,.18))' } },
            h(
              'select',
              { className: 'dsh-kefu-select', style: { width: 120 }, value: filter, onChange: (event) => setFilter(event.target.value) },
              h('option', { value: 'pending' }, t.pending),
              h('option', { value: 'human' }, t.human),
              h('option', { value: 'bot' }, t.bot),
              h('option', { value: 'all' }, '全部'),
            ),
            h('span', { className: 'dsh-kefu-small' }, `${stats.pending ?? 0} ${t.stats.pending} · ${stats.human ?? 0} ${t.stats.human}`),
            h('span', { style: { flex: 1 } }),
            h(Button, { onClick: () => void load() }, t.refresh),
          ),
          h(
            'div',
            { className: 'dsh-kefu-split' },
            h(
              'div',
              { className: 'dsh-kefu-list' },
              items.length === 0
                ? h('div', { className: 'dsh-kefu-empty' }, t.empty)
                : items.map((item) =>
                    h(
                      'div',
                      {
                        key: item.id,
                        className: 'dsh-kefu-item',
                        'data-active': item.id === activeId,
                        onClick: () => setActiveId(item.id),
                      },
                      h(
                        'div',
                        { className: 'dsh-kefu-item-top' },
                        h('span', { className: 'dsh-kefu-item-name' }, item.buyerName || item.buyerId),
                        h(Badge, { tone: STATUS_TONE[item.status] }, item.status === 'pending' ? t.pending : item.status === 'human' ? t.human : item.status === 'bot' ? t.bot : t.closed),
                      ),
                      h('span', { className: 'dsh-kefu-item-text' }, `${item.channel} · ${fmtTime(item.lastAt)}`),
                      item.reasons?.[0]
                        ? h('span', { className: 'dsh-kefu-item-text' }, item.reasons[0].label)
                        : null,
                    ),
                  ),
            ),
            detail === null
              ? h('div', { className: 'dsh-kefu-empty', style: { flex: 1 } }, t.noConversation)
              : h(
                  'div',
                  { className: 'dsh-kefu-detail' },
                  h(
                    'div',
                    { className: 'dsh-kefu-thread' },
                    detail.messages.map((message, index) =>
                      h(
                        'div',
                        {
                          key: `${message.id ?? index}-${message.at}`,
                          className: 'dsh-kefu-msg',
                          'data-role': message.role,
                        },
                        message.text,
                        message.images?.length
                          ? h('div', { className: 'dsh-kefu-small' }, `[${message.images.length} 张图]`)
                          : null,
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dsh-kefu-reasons' },
                    h('span', { className: 'dsh-kefu-small' }, `${t.reasons}：`),
                    detail.reasons?.length
                      ? detail.reasons.map((reason) => h(Badge, { key: reason.code, tone: 'warn' }, reason.label))
                      : h('span', { className: 'dsh-kefu-small' }, t.noReasons),
                  ),
                  h(
                    'div',
                    { className: 'dsh-kefu-compose' },
                    h('textarea', {
                      className: 'dsh-kefu-textarea',
                      value: draft,
                      placeholder: t.draftPlaceholder,
                      onChange: (event) => setDraft(event.target.value),
                    }),
                    h(
                      'div',
                      { className: 'dsh-kefu-row' },
                      h(Button, { primary: true, onClick: () => void send(), disabled: busy || draft.trim() === '' }, busy ? t.sending : t.send),
                      h(Button, { onClick: () => void adopt(), disabled: draft.trim() === '' }, t.adopt),
                      h(Button, { onClick: () => void setStatus('human') }, t.markHuman),
                      h(Button, { onClick: () => void setStatus('closed') }, t.close),
                      h('span', { style: { flex: 1 } }),
                      h(Button, { onClick: () => void load() }, t.refresh),
                    ),
                    h('div', { className: 'dsh-kefu-small' }, t.adoptHint),
                  ),
                ),
          ),
        )
      }

      /* ---------------- Knowledge base ---------------- */

      function KnowledgeTab({ toast, setToast }) {
        const [products, setProducts] = useState([])
        const [total, setTotal] = useState(0)
        const [query, setQuery] = useState('')
        const [text, setText] = useState('')
        const [busy, setBusy] = useState(false)
        const [probe, setProbe] = useState('')
        const [probeResult, setProbeResult] = useState(null)

        const load = useCallback(async () => {
          try {
            const data = await api(`products?limit=200&q=${encodeURIComponent(query)}`)
            setProducts(data.products ?? [])
            setTotal(data.total ?? 0)
          } catch (error) {
            setToast(error.message)
          }
        }, [query, setToast])

        useEffect(() => {
          void load()
        }, [load])

        const importText = async () => {
          if (text.trim() === '') return
          setBusy(true)
          try {
            const result = await api('products/import', { body: { text } })
            setToast(`+${result.added?.length ?? 0} / ~${result.updated?.length ?? 0} · ${result.total} ${t.stats.products}`)
            setText('')
            await load()
          } catch (error) {
            setToast(error.message)
          } finally {
            setBusy(false)
          }
        }

        const test = async () => {
          if (probe.trim() === '') return
          try {
            const result = await api('test', { body: { text: probe } })
            setProbeResult(result)
          } catch (error) {
            setToast(error.message)
          }
        }

        const remove = async (id) => {
          try {
            await api('products/delete', { body: { id } })
            await load()
          } catch (error) {
            setToast(error.message)
          }
        }

        const actionLabel = probeResult
          ? probeResult.action === 'auto_reply' || probeResult.action === 'copilot'
            ? probeResult.action === 'auto_reply'
              ? t.actionAuto
              : t.actionCopilot
            : t.actionEscalate
          : ''

        return h(
          'div',
          { className: 'dsh-kefu-col' },
          h(
            'div',
            { className: 'dsh-kefu-body', style: { flex: 1, minHeight: 0 } },
            h(
              'div',
              { className: 'dsh-kefu-col' },
              h(
                'div',
                { className: 'dsh-kefu-scroll' },
                h('div', { className: 'dsh-kefu-card' },
                  h('div', { className: 'dsh-kefu-card-head' },
                    h('span', { className: 'dsh-kefu-card-title' }, t.importTitle),
                    h('span', { className: 'dsh-kefu-small' }, `${total} ${t.stats.products}`),
                  ),
                  h('div', { className: 'dsh-kefu-small', style: { marginBottom: 6 } }, t.importHint),
                  h('textarea', {
                    className: 'dsh-kefu-textarea',
                    style: { minHeight: 90 },
                    value: text,
                    placeholder: '标题,价格,规格,参数,发货,售后\n纯棉短袖,￥129,S/129/12；M/129/8,材质:纯棉;版型:宽松,48 小时发货,7 天无理由',
                    onChange: (event) => setText(event.target.value),
                  }),
                  h('div', { className: 'dsh-kefu-row', style: { marginTop: 6 } },
                    h(Button, { primary: true, onClick: () => void importText(), disabled: busy || text.trim() === '' }, busy ? t.importing : t.import),
                  ),
                ),
                h('div', { className: 'dsh-kefu-card' },
                  h('div', { className: 'dsh-kefu-card-head' }, h('span', { className: 'dsh-kefu-card-title' }, t.testTitle)),
                  h('textarea', {
                    className: 'dsh-kefu-textarea',
                    value: probe,
                    placeholder: t.testPlaceholder,
                    onChange: (event) => setProbe(event.target.value),
                  }),
                  h('div', { className: 'dsh-kefu-row', style: { marginTop: 6 } },
                    h(Button, { onClick: () => void test(), disabled: probe.trim() === '' }, t.test),
                    probeResult ? h(Badge, { tone: probeResult.action === 'escalate' ? 'warn' : 'ok' }, actionLabel) : null,
                    probeResult ? h('span', { className: 'dsh-kefu-small' }, `${t.confidence} ${Number(probeResult.confidence ?? 0).toFixed(2)}`) : null,
                  ),
                  probeResult
                    ? h('div', { style: { marginTop: 8 } },
                        probeResult.reasons?.length
                          ? h('div', { className: 'dsh-kefu-reasons', style: { padding: '4px 0', borderTop: 0 } },
                              probeResult.reasons.map((reason) => h(Badge, { key: reason.code, tone: 'warn' }, reason.label)))
                          : null,
                        probeResult.draft
                          ? h('pre', { className: 'dsh-kefu-pre', style: { marginTop: 6 } }, probeResult.draft)
                          : null,
                        probeResult.citations?.length
                          ? h('div', { style: { marginTop: 6 } },
                              h('div', { className: 'dsh-kefu-small' }, t.citations),
                              h('pre', { className: 'dsh-kefu-pre' }, probeResult.citations.map((item) => `${item.label}：${item.value}`).join('\n')))
                          : null,
                      )
                    : null,
                ),
              ),
            ),
            h(
              'div',
              { className: 'dsh-kefu-col' },
              h('div', { className: 'dsh-kefu-row', style: { padding: '8px 12px' } },
                h('input', {
                  className: 'dsh-kefu-input',
                  value: query,
                  placeholder: t.searchPlaceholder,
                  onChange: (event) => setQuery(event.target.value),
                }),
                h(Button, { onClick: () => void load() }, t.refresh),
              ),
              h('div', { className: 'dsh-kefu-scroll' },
                products.length === 0
                  ? h('div', { className: 'dsh-kefu-empty' }, t.empty)
                  : products.map((product) =>
                      h(
                        'div',
                        { key: product.id, className: 'dsh-kefu-card' },
                        h('div', { className: 'dsh-kefu-card-head' },
                          h('span', { className: 'dsh-kefu-card-title' }, product.title),
                          h('span', { className: 'dsh-kefu-small' }, product.price ?? ''),
                          h('span', { style: { flex: 1 } }),
                          h(Button, { onClick: () => void remove(product.id) }, '删除'),
                        ),
                        h('pre', { className: 'dsh-kefu-pre' }, JSON.stringify({
                          skus: product.skus,
                          attrs: product.attrs,
                          shipping: product.shipping,
                          afterSales: product.afterSales,
                        }, null, 1)),
                      ),
                    ),
              ),
            ),
          ),
        )
      }

      /* ---------------- Channels ---------------- */

      function ChannelsTab({ toast, setToast }) {
        const [channels, setChannels] = useState([])
        const [config, setConfig] = useState(null)
        const [dirty, setDirty] = useState({})

        const load = useCallback(async () => {
          try {
            const data = await api('config')
            setConfig(data.config)
            const status = await api('channels')
            setChannels(status.channels ?? [])
          } catch (error) {
            setToast(error.message)
          }
        }, [setToast])

        useEffect(() => {
          void load()
          const timer = setInterval(() => void load(), 20000)
          return () => clearInterval(timer)
        }, [load])

        const field = (channelId, key, value) => {
          setDirty((current) => ({
            ...current,
            [channelId]: { ...(current[channelId] ?? {}), [key]: value },
          }))
        }

        const save = async (channelId) => {
          try {
            const patch = dirty[channelId] ?? {}
            const body = { channels: { [channelId]: patch } }
            await api('config', { body })
            setToast(t.saved)
            setDirty((current) => ({ ...current, [channelId]: {} }))
            await load()
          } catch (error) {
            setToast(error.message)
          }
        }

        const valueOf = (channelId, key) => {
          const local = dirty[channelId]?.[key]
          if (local !== undefined) return local
          const remote = config?.channels?.[channelId]?.[key]
          return remote ?? ''
        }

        const renderChannel = (status) => {
          const id = status.id
          const tone = status.ready ? 'ok' : status.enabled ? 'warn' : ''
          const label = status.ready ? t.channelReady : status.enabled ? t.channelIncomplete : t.channelOff
          return h(
            'div',
            { key: id, className: 'dsh-kefu-card' },
            h('div', { className: 'dsh-kefu-card-head' },
              h('span', { className: 'dsh-kefu-card-title' }, status.label),
              h(Badge, { tone }, label),
              h('span', { style: { flex: 1 } }),
              h(
                'label',
                { className: 'dsh-kefu-check' },
                h('input', {
                  type: 'checkbox',
                  checked: valueOf(id, 'enabled') === true || valueOf(id, 'enabled') === 'true',
                  onChange: (event) => field(id, 'enabled', event.target.checked),
                }),
                '启用',
              ),
            ),
            status.detail ? h('div', { className: 'dsh-kefu-small', style: { marginBottom: 6 } }, status.detail) : null,
            h('div', { className: 'dsh-kefu-small', style: { marginBottom: 6 } }, status.notes ?? ''),

            id === 'qianniu'
              ? h('div', null,
                  rowInput('App Key', 'appKey', id),
                  rowInput('App Secret', 'appSecret', id, 'password'),
                  rowInput('Session Key', 'sessionKey', id, 'password'),
                  rowInput('网关', 'gateway', id),
                  rowInput('发送接口名 sendMethod', 'sendMethod', id),
                  rowInput('买家字段名', 'buyerField', id),
                  rowInput('内容字段名', 'replyField', id),
                  rowInput('推送 token', 'token', id, 'password'),
                )
              : null,
            id === 'jingmai'
              ? h('div', null,
                  rowInput('App Key', 'appKey', id),
                  rowInput('App Secret', 'appSecret', id, 'password'),
                  rowInput('Access Token', 'accessToken', id, 'password'),
                  rowInput('网关', 'gateway', id),
                  rowInput('发送接口名 sendMethod', 'sendMethod', id),
                  rowInput('买家字段名', 'buyerField', id),
                  rowInput('推送 token', 'token', id, 'password'),
                )
              : null,
            id === 'bridge'
              ? h('div', null, rowInput('访问 token', 'token', id, 'password'))
              : null,
            id === 'webhook'
              ? h('div', null,
                  rowInput('inboundToken（外部工具带 x-kefu-token）', 'inboundToken', id, 'password'),
                  rowInput('outboundUrl（回复推回这里）', 'outboundUrl', id),
                  rowInput('outboundSecret（HMAC-SHA256 签名）', 'outboundSecret', id, 'password'),
                )
              : null,

            h('div', { className: 'dsh-kefu-row', style: { marginTop: 6 } },
              h(Button, { primary: true, onClick: () => void save(id) }, t.save),
              h('span', { className: 'dsh-kefu-small dsh-kefu-mono' }, status.inboundUrl ?? ''),
              h(Button, { onClick: () => { void navigator.clipboard?.writeText(`${window.location.origin}${status.inboundUrl}`); setToast(t.copied) } }, t.copy),
            ),
          )

          function rowInput(label, key, channelId, type) {
            return h(
              'div',
              { className: 'dsh-kefu-field' },
              h('label', null, label),
              h('input', {
                className: 'dsh-kefu-input',
                type: type ?? 'text',
                value: String(valueOf(channelId, key) ?? ''),
                placeholder: key === 'sendMethod' ? '例如平台文档里的接口名' : '',
                onChange: (event) => field(channelId, key, event.target.value),
              }),
            )
          }
        }

        return h(
          'div',
          { className: 'dsh-kefu-scroll' },
          h('div', { className: 'dsh-kefu-card' },
            h('div', { className: 'dsh-kefu-card-title', style: { marginBottom: 6 } }, '接入方式'),
            h('div', { className: 'dsh-kefu-small' },
              '本插件只走官方开放平台通道与本地桥接。桌面客户端抓取/注入不在插件范围内：那类工具违反千牛与京麦的开放平台审核规范，版本一升级就失效，也无法作为公开插件分发。桥接通道留给自建采集端。'),
          ),
          channels.length === 0 ? h('div', { className: 'dsh-kefu-empty' }, t.loading) : channels.map(renderChannel),
        )
      }

      /* ---------------- Settings ---------------- */

      function SettingsTab({ toast, setToast }) {
        const [config, setConfig] = useState(null)
        const [llm, setLlm] = useState(null)
        const [busy, setBusy] = useState(false)

        const load = useCallback(async () => {
          try {
            const data = await api('config')
            setConfig(data.config)
            const models = await api('llm').catch(() => null)
            if (models) setLlm(models)
          } catch (error) {
            setToast(error.message)
          }
        }, [setToast])

        useEffect(() => {
          void load()
        }, [load])

        if (config === null) return h('div', { className: 'dsh-kefu-empty' }, t.loading)

        const patch = (next) => setConfig((current) => ({ ...current, ...next }))
        const toggleTrigger = (key) => {
          const triggers = { ...config.triggers, [key]: !config.triggers[key] }
          patch({ triggers })
        }
        const patchLlm = (next) => patch({ llm: { ...config.llm, ...next } })
        const providerOptions = llm?.providers ?? []
        const activeProvider = providerOptions.find((item) => item.provider === (config.llm?.provider || llm?.route?.provider))
        const modelOptions = activeProvider?.models ?? []

        const save = async () => {
          setBusy(true)
          try {
            await api('config', {
              body: {
                mode: config.mode,
                minConfidence: config.minConfidence,
                triggers: config.triggers,
                triggerWords: config.triggerWords,
                sensitiveWords: config.sensitiveWords,
                hours: config.hours,
                reply: config.reply,
                llm: config.llm,
              },
            })
            setToast(t.saved)
            await load()
          } catch (error) {
            setToast(error.message)
          } finally {
            setBusy(false)
          }
        }

        return h(
          'div',
          { className: 'dsh-kefu-scroll' },
          h('div', { className: 'dsh-kefu-card' },
            h('div', { className: 'dsh-kefu-card-head' },
              h('span', { className: 'dsh-kefu-card-title' }, t.modelTitle),
              h(Badge, { tone: llm?.available ? 'ok' : 'warn' }, llm?.available ? t.modelReady : t.modelUnavailable),
            ),
            h('div', { className: 'dsh-kefu-small', style: { marginBottom: 6 } }, t.modelHint),
            h('label', { className: 'dsh-kefu-check' },
              h('input', {
                type: 'checkbox',
                checked: config.llm?.enabled !== false,
                onChange: (event) => patchLlm({ enabled: event.target.checked }),
              }),
              t.modelUse,
            ),
            h('div', { className: 'dsh-kefu-row', style: { marginTop: 6 } },
              h('select', {
                className: 'dsh-kefu-select',
                style: { width: 190 },
                value: config.llm?.provider || llm?.route?.provider || '',
                onChange: (event) => patchLlm({ provider: event.target.value, model: '' }),
              },
                h('option', { value: '' }, t.modelAuto),
                providerOptions.map((item) => h('option', { key: item.provider, value: item.provider }, item.label)),
              ),
              h('select', {
                className: 'dsh-kefu-select',
                style: { width: 190 },
                value: config.llm?.model || llm?.route?.model || '',
                onChange: (event) => patchLlm({ model: event.target.value }),
              },
                h('option', { value: '' }, t.modelAuto),
                modelOptions.map((item) => h('option', { key: item.model, value: item.model }, item.label)),
              ),
            ),
            llm?.route ? h('div', { className: 'dsh-kefu-small', style: { marginTop: 6 } }, `${t.modelInUse} ${llm.route.provider} / ${llm.route.model}`) : null,
          ),
          h('div', { className: 'dsh-kefu-card' },
            h('div', { className: 'dsh-kefu-card-title', style: { marginBottom: 6 } }, t.mode),
            h('div', { className: 'dsh-kefu-row' },
              h('select', {
                className: 'dsh-kefu-select',
                style: { width: 160 },
                value: config.mode,
                onChange: (event) => patch({ mode: event.target.value }),
              },
                h('option', { value: 'copilot' }, t.copilot),
                h('option', { value: 'auto' }, t.auto),
              ),
              h('span', { className: 'dsh-kefu-small' }, config.mode === 'auto' ? t.autoHint : t.copilotHint),
            ),
            h('div', { className: 'dsh-kefu-field', style: { marginTop: 8 } },
              h('label', null, `${t.threshold}: ${Number(config.minConfidence).toFixed(2)}`),
              h('input', {
                type: 'range',
                min: 0.2,
                max: 0.9,
                step: 0.05,
                value: config.minConfidence,
                onChange: (event) => patch({ minConfidence: Number(event.target.value) }),
              }),
            ),
          ),
          h('div', { className: 'dsh-kefu-card' },
            h('div', { className: 'dsh-kefu-card-title', style: { marginBottom: 6 } }, t.triggers),
            Object.keys(config.triggers).map((key) =>
              h('label', { key, className: 'dsh-kefu-check' },
                h('input', { type: 'checkbox', checked: config.triggers[key], onChange: () => toggleTrigger(key) }),
                t.triggerLabels[key] ?? key,
              ),
            ),
            h('div', { className: 'dsh-kefu-field', style: { marginTop: 8 } },
              h('label', null, t.triggerWords),
              h('input', {
                className: 'dsh-kefu-input',
                value: config.triggerWords.join(','),
                onChange: (event) => patch({ triggerWords: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) }),
              }),
            ),
            h('div', { className: 'dsh-kefu-field' },
              h('label', null, t.sensitiveWords),
              h('input', {
                className: 'dsh-kefu-input',
                value: config.sensitiveWords.join(','),
                onChange: (event) => patch({ sensitiveWords: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) }),
              }),
            ),
            h('div', { className: 'dsh-kefu-small' }, `${t.redLines}: `, config.redLines.map((line) => line.label).join(' / ')),
          ),
          h('div', { className: 'dsh-kefu-card' },
            h('div', { className: 'dsh-kefu-card-title', style: { marginBottom: 6 } }, t.hours),
            h('div', { className: 'dsh-kefu-row' },
              h('input', { className: 'dsh-kefu-input', style: { width: 90 }, value: config.hours.start, onChange: (event) => patch({ hours: { ...config.hours, start: event.target.value } }) }),
              '—',
              h('input', { className: 'dsh-kefu-input', style: { width: 90 }, value: config.hours.end, onChange: (event) => patch({ hours: { ...config.hours, end: event.target.value } }) }),
            ),
          ),
          h('div', { className: 'dsh-kefu-card' },
            h('div', { className: 'dsh-kefu-card-title', style: { marginBottom: 6 } }, '话术'),
            ['greeting', 'signOff', 'unsureText', 'escalateText'].map((key) =>
              h('div', { key, className: 'dsh-kefu-field' },
                h('label', null, key),
                h('input', {
                  className: 'dsh-kefu-input',
                  value: config.reply[key],
                  onChange: (event) => patch({ reply: { ...config.reply, [key]: event.target.value } }),
                }),
              ),
            ),
          ),
          h('div', { className: 'dsh-kefu-row', style: { paddingBottom: 16 } }, h(Button, { primary: true, onClick: () => void save(), disabled: busy }, t.save)),
        )
      }

      /* ---------------- Shell ---------------- */

      function KefuPanel() {
        const [tab, setTab] = useState('queue')
        const [toast, setToast] = useState('')
        const [stats, setStats] = useState({})
        const timerRef = useRef(null)

        useEffect(() => {
          let cancelled = false
          const tick = async () => {
            try {
              const data = await api('status')
              if (!cancelled) setStats(data.stats ?? {})
            } catch {
              /* the panel stays usable offline; tabs surface their own errors */
            }
          }
          void tick()
          timerRef.current = setInterval(() => void tick(), 15000)
          return () => {
            cancelled = true
            if (timerRef.current) clearInterval(timerRef.current)
          }
        }, [])

        useEffect(() => {
          if (toast === '') return undefined
          const timer = setTimeout(() => setToast(''), 4000)
          return () => clearTimeout(timer)
        }, [toast])

        return h(
          'div',
          { className: 'dsh-kefu-root' },
          h('div', { className: 'dsh-kefu-head' },
            h('div', null,
              h('div', { className: 'dsh-kefu-title' }, t.title),
              h('div', { className: 'dsh-kefu-sub' }, t.subtitle),
            ),
            h('div', { className: 'dsh-kefu-stats' },
              h(Chip, null, `${stats.pending ?? 0} ${t.stats.pending}`),
              h(Chip, null, `${stats.human ?? 0} ${t.stats.human}`),
              h(Chip, null, `${stats.bot ?? 0} ${t.stats.bot}`),
            ),
          ),
          h('div', { className: 'dsh-kefu-tabs' },
            ['queue', 'kb', 'channels', 'settings'].map((key) =>
              h('button', {
                key,
                type: 'button',
                className: 'dsh-kefu-tab',
                'data-active': tab === key,
                onClick: () => setTab(key),
              }, t.tabs[key]),
            ),
          ),
          h('div', { className: 'dsh-kefu-body' },
            tab === 'queue' ? h(QueueTab, { toast, setToast }) : null,
            tab === 'kb' ? h(KnowledgeTab, { toast, setToast }) : null,
            tab === 'channels' ? h(ChannelsTab, { toast, setToast }) : null,
            tab === 'settings' ? h(SettingsTab, { toast, setToast }) : null,
          ),
          h(Toast, { text: toast }),
        )
      }

      function KefuIcon({ size = 20 }) {
        return h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: size,
            height: size,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { display: 'block' },
          },
          h('path', { d: 'M4 5.5h16v10H9l-5 4v-14z' }),
          h('path', { d: 'M8 9.5h8M8 12.5h5' }),
        )
      }

      return { KefuPanel, KefuIcon }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-plugin-kefu'
        style.textContent = UI_CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'kefu: styles')

        const { KefuPanel, KefuIcon } = createComponents()

        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'kefu' }, KefuPanel)),
          'kefu: main panel',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register({ name: 'sidebar.panellist', id: 'kefu', order: 34, label: () => COPY.panel }, KefuIcon),
            ),
          'kefu: sidebar entry',
        )
      },
    }
  },
})
