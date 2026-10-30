/**
 * 京麦 / 京东咚咚 adapter.
 *
 * Route: the official 京东开放平台 (JOS / 宙斯) `routerjson` gateway. Inbound
 * buyer messages arrive as a signed push to `/channels/jingmai/push`; replies
 * leave through the message API the merchant was granted (`sendMethod`).
 *
 * As with Qianniu: nothing here hooks the Jingmai desktop client.
 */
import { callGateway, sortSign, verifySign } from './gateway.js'

const ID = 'jingmai'
const LABEL = '京麦 / 京东咚咚'

function pick(message, keys) {
  for (const key of keys) {
    const value = message?.[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value)
  }
  return ''
}

export function normalizeInbound(payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const buyerId = pick(body, ['buyerId', 'buyer_id', 'pin', 'buyerPin', 'customerPin', 'userPin'])
  const text = pick(body, ['text', 'content', 'msg', 'message', 'contentMsg'])
  const messageId = pick(body, ['messageId', 'message_id', 'msgId', 'msg_id', 'id'])
  const images = Array.isArray(body.images) ? body.images.filter((item) => typeof item === 'string') : []
  if (buyerId === '') throw new Error('推送里没有买家标识（buyerId / pin / customerPin 任一）')
  if (text === '' && images.length === 0) throw new Error('推送里没有消息内容')
  return {
    messageId: messageId || `jingmai-${buyerId}-${Date.now()}`,
    buyerId,
    buyerName: pick(body, ['buyerName', 'buyerNick', 'nickName', 'pin']) || buyerId,
    shop: pick(body, ['shop', 'shopName', 'venderName', 'vender']),
    text,
    images,
    raw: body,
  }
}

export function verifyInbound({ headers = {}, payload = {}, config }) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const providedToken = headers['x-kefu-token'] ?? body.token ?? body.kefu_token ?? ''
  if (config.token !== '' && String(providedToken) !== config.token) {
    return { ok: false, reason: '推送 token 不匹配' }
  }
  const providedSign = body.sign ?? headers['x-jd-sign'] ?? ''
  if (providedSign !== '' && config.appSecret !== '') {
    const expected = sortSign(body, config.appSecret)
    if (!verifySign(expected, providedSign)) return { ok: false, reason: '推送签名校验失败' }
  }
  return { ok: true }
}

export function createAdapter({ getConfig, logger }) {
  return {
    id: ID,
    label: LABEL,
    kind: 'official',
    status() {
      const config = getConfig()
      return {
        id: ID,
        label: LABEL,
        enabled: config.enabled,
        configured: config.appKey !== '' && config.appSecret !== '',
        ready: config.enabled && config.appKey !== '' && config.appSecret !== '' && config.sendMethod !== '',
        detail:
          config.sendMethod === ''
            ? '还差 sendMethod：填你开通的咚咚消息发送接口名。'
            : config.appKey === ''
              ? '还差 App Key / App Secret（京东开放平台 → 我的应用）。'
              : '',
        inboundUrl: '/plugins/dsh-plugin-kefu/channels/jingmai/push',
        notes: '官方通道：咚咚客服接口需要 ISV 签约或商家自用授权。',
      }
    },
    verifyInbound,
    normalizeInbound,
    async send({ buyerId, text, raw = {} }) {
      const config = getConfig()
      if (!config.enabled) return { ok: false, detail: '京麦通道未启用' }
      if (config.appKey === '' || config.appSecret === '') return { ok: false, detail: '缺少 App Key / App Secret' }
      if (config.sendMethod === '') return { ok: false, detail: '缺少 sendMethod（消息发送接口名）' }

      const params = {
        method: config.sendMethod,
        app_key: config.appKey,
        access_token: config.accessToken,
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
        format: 'json',
        v: '2.0',
        sign_method: 'md5',
        ...(config.sendParams ?? {}),
        [config.buyerField || 'customerPin']: buyerId,
        [config.replyField || 'content']: text,
      }
      if (raw?.sessionId) params.session_id = raw.sessionId
      params.sign = sortSign(params, config.appSecret)
      const response = await callGateway(config.gateway, params)
      logger?.debug?.('kefu: 京东回复已提交')
      return { ok: true, response }
    },
    sign(params) {
      const config = getConfig()
      return config.appSecret === '' ? null : sortSign(params, config.appSecret)
    },
  }
}
