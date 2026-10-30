/**
 * 千牛 / 淘宝天猫 adapter.
 *
 * Route: the official 淘宝开放平台 (TOP) gateway. Inbound buyer messages arrive
 * as a signed push to `/channels/qianniu/push`; outbound replies go back through
 * whichever message API the merchant has been granted, configured as
 * `sendMethod` (method names are per-app and per-category, so the plugin never
 * hard-codes one and pretends it is universal).
 *
 * This adapter does **not** touch the Qianniu desktop client. Hooking that
 * client means reverse-engineering a closed-source protocol, which breaks on
 * every release and is not something a public plugin can ship.
 */
import { callGateway, formatTimestamp, hmacSign, sortSign, verifySign } from './gateway.js'

const ID = 'qianniu'
const LABEL = '千牛 / 淘宝天猫'

/** Buyer identifiers appear under different names per push format. */
function pick(message, keys) {
  for (const key of keys) {
    const value = message?.[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value)
  }
  return ''
}

export function normalizeInbound(payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const buyerId = pick(body, ['buyerId', 'buyer_id', 'buyerNick', 'buyer_nick', 'nick', 'pin', 'user_id'])
  const text = pick(body, ['text', 'content', 'msg', 'message', 'recv_content'])
  const messageId = pick(body, ['messageId', 'message_id', 'msg_id', 'msgId', 'id'])
  const images = Array.isArray(body.images) ? body.images.filter((item) => typeof item === 'string') : []
  if (buyerId === '') throw new Error('推送里没有买家标识（buyerId / buyer_nick / nick 任一）')
  if (text === '' && images.length === 0) throw new Error('推送里没有消息内容')
  return {
    messageId: messageId || `qianniu-${buyerId}-${Date.now()}`,
    buyerId,
    buyerName: pick(body, ['buyerName', 'buyer_nick', 'buyerNick', 'nick']) || buyerId,
    shop: pick(body, ['shop', 'shopName', 'seller_nick', 'sellerNick']),
    text,
    images,
    raw: body,
  }
}

/**
 * Verify an inbound push. When the merchant configured a token we require it
 * (header or body); when they also enabled signing, the signature must match
 * the sort-signature of the body.
 */
export function verifyInbound({ headers = {}, payload = {}, config }) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const providedToken =
    headers['x-kefu-token'] ?? headers['x-kefu-token'.toLowerCase()] ?? body.token ?? body.kefu_token ?? ''
  if (config.token !== '' && String(providedToken) !== config.token) {
    return { ok: false, reason: '推送 token 不匹配' }
  }
  const providedSign = body.sign ?? headers['x-keep-sign'] ?? ''
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
            ? '还差 sendMethod：填你开通的客服消息发送接口名，才能把回复发回买家。'
            : config.appKey === ''
              ? '还差 App Key / App Secret（淘宝开放平台 → 应用管理）。'
              : '',
        inboundUrl: '/plugins/dsh-plugin-kefu/channels/qianniu/push',
        notes: '官方通道：需要在淘宝开放平台为应用申请客服消息类目权限。',
      }
    },
    verifyInbound,
    normalizeInbound,
    /**
     * Send one reply through the configured TOP method.
     *
     * @returns {Promise<{ok: boolean, queued?: boolean, detail?: string, response?: unknown}>}
     */
    async send({ buyerId, text, raw = {} }) {
      const config = getConfig()
      if (!config.enabled) return { ok: false, detail: '千牛通道未启用' }
      if (config.appKey === '' || config.appSecret === '') return { ok: false, detail: '缺少 App Key / App Secret' }
      if (config.sendMethod === '') return { ok: false, detail: '缺少 sendMethod（消息发送接口名）' }

      const params = {
        method: config.sendMethod,
        app_key: config.appKey,
        session: config.sessionKey,
        timestamp: formatTimestamp(),
        format: 'json',
        v: '2.0',
        sign_method: 'md5',
        ...(config.sendParams ?? {}),
        [config.buyerField || 'buyer_nick']: buyerId,
        [config.replyField || 'content']: text,
      }
      if (raw?.chatId) params.chat_id = raw.chatId
      params.sign = sortSign(params, config.appSecret)
      const response = await callGateway(config.gateway, params)
      logger?.debug?.('kefu: 千牛回复已提交')
      return { ok: true, response }
    },
    /** Sign a request by hand — used by the panel's "测试签名" button. */
    sign(params) {
      const config = getConfig()
      return config.appSecret === '' ? null : sortSign(params, config.appSecret)
    },
    hmac(params) {
      const config = getConfig()
      return config.appSecret === '' ? null : hmacSign(params, config.appSecret)
    },
  }
}
