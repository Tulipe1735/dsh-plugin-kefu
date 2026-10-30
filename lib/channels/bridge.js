/**
 * Local Bridge channel.
 *
 * For shops that already capture messages some other way (their own helper, an
 * open-source UI-automation project, a scraper they maintain) the plugin
 * exposes a deliberately tiny HTTP contract instead of shipping capture code
 * itself:
 *
 *   POST /channels/bridge/push   { buyerId, buyerName?, shop?, text, images? }
 *   GET  /channels/bridge/pull?after=<cursor>   → { cursor, items: [...] }
 *   POST /channels/bridge/ack    { ids: [...] }
 *
 * The caller authenticates with `x-kefu-token` (or `?token=`). Replies produced
 * by the plugin wait in the outbox until the helper pulls them, so a helper
 * that dies cannot silently drop a customer's answer — the queue is on disk.
 */
const ID = 'bridge'
const LABEL = '本地桥接'

export function normalizeInbound(payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const buyerId = String(body.buyerId ?? body.buyer_id ?? body.nick ?? '').trim()
  const text = String(body.text ?? body.content ?? body.msg ?? '').trim()
  const images = Array.isArray(body.images) ? body.images.filter((item) => typeof item === 'string') : []
  if (buyerId === '') throw new Error('bridge 推送缺少 buyerId')
  if (text === '' && images.length === 0) throw new Error('bridge 推送缺少 text/images')
  return {
    messageId: String(body.messageId ?? body.message_id ?? `bridge-${buyerId}-${Date.now()}`),
    buyerId,
    buyerName: String(body.buyerName ?? body.nick ?? buyerId),
    shop: String(body.shop ?? body.shopName ?? ''),
    text,
    images,
    raw: body,
  }
}

export function verifyInbound({ headers = {}, query = {}, config }) {
  if (config.token === '') return { ok: true }
  const provided = headers['x-kefu-token'] ?? query.token ?? ''
  if (String(provided) !== config.token) return { ok: false, reason: 'bridge token 不匹配' }
  return { ok: true }
}

export function createAdapter({ getConfig }) {
  return {
    id: ID,
    label: LABEL,
    kind: 'bridge',
    status() {
      const config = getConfig()
      return {
        id: ID,
        label: LABEL,
        enabled: config.enabled,
        configured: config.token !== '',
        ready: config.enabled && config.token !== '',
        detail: config.token === '' ? '还差访问 token（随便生成一串，桥接端也填同一个）。' : '',
        inboundUrl: '/plugins/dsh-plugin-kefu/channels/bridge/push',
        notes: '你自己的采集程序把消息 POST 进来，回复由它 GET 拉走。插件不包含任何客户端采集代码。',
      }
    },
    verifyInbound,
    normalizeInbound,
    /**
     * Bridge replies are queued, not sent: the helper owns delivery.
     * `pushOutbound` happens in the host layer where the outbox lives.
     */
    async send({ text }) {
      return { ok: true, queued: true, detail: `已进入桥接发件箱（${text.length} 字），等桥接端拉取` }
    },
  }
}
