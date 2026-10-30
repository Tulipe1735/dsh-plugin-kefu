/**
 * Generic inbound/outbound webhook channel.
 *
 * This is the seam that lets an external customer-service capture tool (a
 * self-maintained helper, an open-source project, an n8n workflow) hand a buyer
 * message to the plugin and receive the approved reply back over HTTP. Inbound
 * requests carry a token; outbound ones carry an HMAC-SHA256 signature over the
 * raw body so the receiver can prove the request came from this machine.
 */
import { createHmac } from 'node:crypto'

import { callGateway } from './gateway.js'

const ID = 'webhook'
const LABEL = '通用 Webhook'

export function normalizeInbound(payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const buyerId = String(body.buyerId ?? body.buyer_id ?? body.from ?? body.user ?? '').trim()
  const text = String(body.text ?? body.content ?? body.message ?? '').trim()
  const images = Array.isArray(body.images) ? body.images.filter((item) => typeof item === 'string') : []
  if (buyerId === '') throw new Error('webhook 推送缺少 buyerId')
  if (text === '' && images.length === 0) throw new Error('webhook 推送缺少 text/images')
  return {
    messageId: String(body.messageId ?? body.id ?? `webhook-${buyerId}-${Date.now()}`),
    buyerId,
    buyerName: String(body.buyerName ?? body.nick ?? buyerId),
    shop: String(body.shop ?? ''),
    text,
    images,
    raw: body,
  }
}

export function verifyInbound({ headers = {}, query = {}, config }) {
  if (config.inboundToken === '') return { ok: false, reason: 'webhook 未配置 inboundToken，拒绝所有推送' }
  const provided = headers['x-kefu-token'] ?? query.token ?? ''
  if (String(provided) !== config.inboundToken) return { ok: false, reason: 'webhook token 不匹配' }
  return { ok: true }
}

export function signPayload(body, secret) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

export function createAdapter({ getConfig, logger }) {
  return {
    id: ID,
    label: LABEL,
    kind: 'webhook',
    status() {
      const config = getConfig()
      return {
        id: ID,
        label: LABEL,
        enabled: config.enabled,
        configured: config.inboundToken !== '',
        ready: config.enabled && config.inboundToken !== '' && config.outboundUrl !== '',
        detail:
          config.inboundToken === ''
            ? '还差 inboundToken（外部工具推消息时带上）。'
            : config.outboundUrl === ''
              ? '回复会只留在队列里：没配 outboundUrl，插件没法把回复推回外部工具。'
              : '',
        inboundUrl: '/plugins/dsh-plugin-kefu/channels/webhook/push',
        notes: '外部工具推消息进来、插件把回复 POST 回 outboundUrl（带 x-kefu-signature）。',
      }
    },
    verifyInbound,
    normalizeInbound,
    async send({ text, buyerId, conversationId: id }) {
      const config = getConfig()
      if (config.outboundUrl === '') return { ok: false, detail: '未配置 outboundUrl，无法推送回复' }
      const payload = {
        conversationId: id,
        buyerId,
        text,
        at: Date.now(),
      }
      const raw = JSON.stringify(payload)
      // callGateway posts form-encoded; a webhook wants raw JSON, so call fetch
      // directly and keep the gateway helper for the official platforms only.
      const response = await fetch(config.outboundUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-kefu-signature': config.outboundSecret === '' ? '' : signPayload(raw, config.outboundSecret),
        },
        body: raw,
      })
      if (!response.ok) {
        return { ok: false, detail: `outboundUrl 返回 HTTP ${response.status}` }
      }
      logger?.debug?.('kefu: webhook 回复已推送')
      return { ok: true }
    },
  }
}

export { callGateway }
