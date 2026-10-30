/**
 * Configuration for the customer-service desk: channel credentials, escalation
 * triggers, the merchant's own sensitive-word list and the reply copy.
 *
 * The defaults are deliberately conservative — the product answers only what
 * the catalog proves, and anything emotional or order-related goes to a human.
 */
import { maskSecret, readJson, removeFile, writeJson, dataPath } from './paths.js'

export const CHANNEL_IDS = ['qianniu', 'jingmai', 'bridge', 'webhook']

/** Platform red lines. These can never be switched off by configuration. */
export const PLATFORM_RED_LINES = [
  { id: 'offsite-chat', pattern: /加(我|一下)?\s*(微信|weixin|wechat|VX|vx|qq|QQ|企鹅)|微信(号|同号)|wechat|加v|[vV]信/i, label: '诱导站外私聊' },
  { id: 'private-transfer', pattern: /(私下|直接|单独)\s*(转账|付款|打款|红包)|扫(我|这个)?(码|二维码)\s*(付款|转账)|转到(我的)?(个人)?(支付宝|银行卡|微信)/, label: '私下转账' },
  { id: 'contact-leak', pattern: /(手机|电话|联系方式)\s*[:：]?\s*1[3-9]\d{9}|1[3-9]\d{9}/, label: '泄露联系方式' },
]

export const DEFAULT_CONFIG = {
  version: 1,
  mode: 'copilot',
  minConfidence: 0.55,
  triggers: {
    image: true,
    address: true,
    orderNote: true,
    afterSales: false,
    lowConfidence: true,
    offHours: false,
    unlisted: true,
  },
  triggerWords: ['投诉', '差评', '举报', '人工', '转人工', '找你们老板', '客服经理', '开发票'],
  sensitiveWords: ['最低价', '假一赔十', '百分百', '绝对', '保证正品'],
  hours: { start: '09:00', end: '22:00' },
  llm: {
    enabled: true,
    provider: '',
    model: '',
    maxTokens: 400,
    timeoutMs: 20000,
  },
  reply: {
    greeting: '亲，',
    signOff: '',
    unsureText: '这个我不太确定，已经帮你叫人工客服了，稍等一下～',
    escalateText: '稍等，我帮你转给人工客服确认一下～',
    maxChars: 300,
    segments: true,
  },
  channels: {
    qianniu: {
      enabled: false,
      appKey: '',
      appSecret: '',
      sessionKey: '',
      gateway: 'https://eco.taobao.com/router/rest',
      sendMethod: '',
      replyField: 'content',
      token: '',
    },
    jingmai: {
      enabled: false,
      appKey: '',
      appSecret: '',
      accessToken: '',
      gateway: 'https://api.jd.com/routerjson',
      sendMethod: '',
      token: '',
    },
    bridge: {
      enabled: false,
      token: '',
    },
    webhook: {
      enabled: false,
      inboundToken: '',
      outboundUrl: '',
      outboundSecret: '',
    },
  },
}

export function configFile() {
  return dataPath('config.json')
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback
  return [...new Set(value.map((item) => asString(item)).filter(Boolean))].slice(0, 200)
}

function normalizeHours(value, fallback) {
  const pattern = /^([01]\d|2[0-3]):[0-5]\d$/
  const start = asString(value?.start, fallback.start)
  const end = asString(value?.end, fallback.end)
  return {
    start: pattern.test(start) ? start : fallback.start,
    end: pattern.test(end) ? end : fallback.end,
  }
}

/**
 * Extra gateway parameters ("模板 ID"、"店铺 ID" 之类) come from the platform's
 * own documentation, so they are stored as a free-form JSON object. Invalid
 * JSON degrades to an empty object instead of blocking the whole config.
 */
function normalizeSendParams(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const name = asString(key)
      if (name === '' || item === null || item === undefined) continue
      out[name] = typeof item === 'string' ? item.trim() : item
    }
    return out
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value)
      return normalizeSendParams(parsed)
    } catch {
      return {}
    }
  }
  return {}
}

function normalizeChannel(id, raw, fallback) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  if (id === 'qianniu') {
    return {
      enabled: asBool(input.enabled, fallback.enabled),
      appKey: asString(input.appKey, fallback.appKey),
      appSecret: asString(input.appSecret, fallback.appSecret),
      sessionKey: asString(input.sessionKey, fallback.sessionKey),
      gateway: asString(input.gateway, fallback.gateway),
      sendMethod: asString(input.sendMethod, fallback.sendMethod),
      replyField: asString(input.replyField, fallback.replyField ?? 'content'),
      buyerField: asString(input.buyerField, fallback.buyerField ?? 'buyer_nick'),
      sendParams: normalizeSendParams(input.sendParams),
      token: asString(input.token, fallback.token),
    }
  }
  if (id === 'jingmai') {
    return {
      enabled: asBool(input.enabled, fallback.enabled),
      appKey: asString(input.appKey, fallback.appKey),
      appSecret: asString(input.appSecret, fallback.appSecret),
      accessToken: asString(input.accessToken, fallback.accessToken),
      gateway: asString(input.gateway, fallback.gateway),
      sendMethod: asString(input.sendMethod, fallback.sendMethod),
      replyField: asString(input.replyField, fallback.replyField ?? 'content'),
      buyerField: asString(input.buyerField, fallback.buyerField ?? 'customerPin'),
      sendParams: normalizeSendParams(input.sendParams),
      token: asString(input.token, fallback.token),
    }
  }
  if (id === 'bridge') {
    return { enabled: asBool(input.enabled, fallback.enabled), token: asString(input.token, fallback.token) }
  }
  return {
    enabled: asBool(input.enabled, fallback.enabled),
    inboundToken: asString(input.inboundToken, fallback.inboundToken),
    outboundUrl: asString(input.outboundUrl, fallback.outboundUrl),
    outboundSecret: asString(input.outboundSecret, fallback.outboundSecret),
  }
}

export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const base = DEFAULT_CONFIG
  const channels = {}
  for (const id of CHANNEL_IDS) {
    channels[id] = normalizeChannel(id, input.channels?.[id], base.channels[id])
  }
  return {
    version: 1,
    mode: input.mode === 'auto' ? 'auto' : 'copilot',
    minConfidence: asNumber(input.minConfidence, base.minConfidence, 0.1, 0.95),
    triggers: {
      image: asBool(input.triggers?.image, base.triggers.image),
      address: asBool(input.triggers?.address, base.triggers.address),
      orderNote: asBool(input.triggers?.orderNote, base.triggers.orderNote),
      afterSales: asBool(input.triggers?.afterSales, base.triggers.afterSales),
      lowConfidence: asBool(input.triggers?.lowConfidence, base.triggers.lowConfidence),
      offHours: asBool(input.triggers?.offHours, base.triggers.offHours),
      unlisted: asBool(input.triggers?.unlisted, base.triggers.unlisted),
    },
    triggerWords: stringList(input.triggerWords, base.triggerWords),
    sensitiveWords: stringList(input.sensitiveWords, base.sensitiveWords),
    hours: normalizeHours(input.hours, base.hours),
    llm: {
      enabled: asBool(input.llm?.enabled, base.llm.enabled),
      provider: asString(input.llm?.provider, base.llm.provider),
      model: asString(input.llm?.model, base.llm.model),
      maxTokens: asNumber(input.llm?.maxTokens, base.llm.maxTokens, 64, 4000),
      timeoutMs: asNumber(input.llm?.timeoutMs, base.llm.timeoutMs, 1000, 120_000),
    },
    reply: {
      greeting: asString(input.reply?.greeting, base.reply.greeting),
      signOff: asString(input.reply?.signOff, base.reply.signOff),
      unsureText: asString(input.reply?.unsureText, base.reply.unsureText),
      escalateText: asString(input.reply?.escalateText, base.reply.escalateText),
      maxChars: asNumber(input.reply?.maxChars, base.reply.maxChars, 40, 2000),
      segments: asBool(input.reply?.segments, base.reply.segments),
    },
    channels,
  }
}

export async function loadConfig() {
  const raw = await readJson(configFile(), null)
  return normalizeConfig(raw)
}

export async function saveConfig(raw) {
  const config = normalizeConfig(raw)
  await writeJson(configFile(), config)
  return config
}

export async function patchConfig(patch) {
  const current = await loadConfig()
  const merged = {
    ...current,
    ...patch,
    triggers: { ...current.triggers, ...(patch?.triggers ?? {}) },
    hours: { ...current.hours, ...(patch?.hours ?? {}) },
    reply: { ...current.reply, ...(patch?.reply ?? {}) },
    channels: { ...current.channels, ...(patch?.channels ?? {}) },
  }
  return saveConfig(merged)
}

export async function clearConfig() {
  return removeFile(configFile())
}

/** Shape returned to the browser: credentials are masked, never echoed. */
export function publicConfig(config) {
  const channels = {}
  for (const id of CHANNEL_IDS) {
    const channel = config.channels[id]
    channels[id] =
      id === 'qianniu'
        ? {
            enabled: channel.enabled,
            appKey: channel.appKey,
            appKeyMasked: maskSecret(channel.appKey),
            hasSecret: channel.appSecret !== '',
            hasSession: channel.sessionKey !== '',
            gateway: channel.gateway,
            sendMethod: channel.sendMethod,
            replyField: channel.replyField,
            hasToken: channel.token !== '',
          }
        : id === 'jingmai'
          ? {
              enabled: channel.enabled,
              appKey: channel.appKey,
              appKeyMasked: maskSecret(channel.appKey),
              hasSecret: channel.appSecret !== '',
              hasAccessToken: channel.accessToken !== '',
              gateway: channel.gateway,
              sendMethod: channel.sendMethod,
              hasToken: channel.token !== '',
            }
          : id === 'bridge'
            ? { enabled: channel.enabled, hasToken: channel.token !== '', tokenMasked: maskSecret(channel.token) }
            : {
                enabled: channel.enabled,
                hasInboundToken: channel.inboundToken !== '',
                outboundUrl: channel.outboundUrl,
                hasOutboundSecret: channel.outboundSecret !== '',
              }
  }
  return {
    version: config.version,
    mode: config.mode,
    minConfidence: config.minConfidence,
    triggers: config.triggers,
    triggerWords: config.triggerWords,
    sensitiveWords: config.sensitiveWords,
    hours: config.hours,
    llm: config.llm,
    reply: config.reply,
    channels,
    redLines: PLATFORM_RED_LINES.map((line) => ({ id: line.id, label: line.label })),
  }
}

/** True when `now` falls inside the configured business hours (local time). */
export function withinHours(hours, now = new Date()) {
  const [startHour, startMinute] = hours.start.split(':').map(Number)
  const [endHour, endMinute] = hours.end.split(':').map(Number)
  const minutes = now.getHours() * 60 + now.getMinutes()
  const start = startHour * 60 + startMinute
  const end = endHour * 60 + endMinute
  if (start === end) return true
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}
