/**
 * The reply brain: decide whether the bot may answer, and compose a reply that
 * contains nothing the merchant did not write down.
 *
 * Two layers of content checking, in this order:
 *   1. the merchant's own sensitive-word list  → block the whole reply
 *   2. platform red lines (off-site chat, private transfer, contact leaks)
 *      → block the whole reply; these cannot be configured away
 *
 * A blocked reply is never trimmed and sent: it becomes a handover.
 */
import { PLATFORM_RED_LINES, withinHours } from './config.js'
import { numbersGrounded, replySystemPrompt } from './composer.js'
import { detectIntent, detectIntents, factsForIntents, INTENTS, searchProducts } from './kb.js'

const ADDRESS = /(改|换|修改|变更).{0,4}(地址|收货信息|收货人|电话)|收货地址|地址填错|地址写错/
const ORDER_NOTE = /(订单)?备注|留个?言|备注一下|写在备注/
const IMAGE_INTENT = /(看看|看一下|拍(个|张|一段)|发(个|张|段)?(图|照片|视频)|来张|上图|图片|照片|实拍|视频)/

/**
 * A model that hedges is not answering. Sending 「这个我需要确认一下」 as the
 * final reply is worse than handing over: it looks like a human will follow up
 * when in fact nobody has been told.
 */
const UNCERTAIN = /(需要|要|得)\s*.{0,6}(确认|核实|查一下|问一下)|不太确定|不确定|无法确认|查不到|核实一下|稍等.{0,6}(确认|核实)/

/**
 * Collect the reasons a conversation must go to a human before the knowledge
 * base is even consulted. Order matters: the first reason is the one shown in
 * the queue.
 */
export function preScreen({ text, images = [], config, now = new Date() }) {
  const reasons = []
  const message = String(text ?? '')
  if (config.triggers.image && (images.length > 0 || IMAGE_INTENT.test(message))) {
    reasons.push({ code: 'buyer_image', label: '买家发来图片/要求看图' })
  }
  if (config.triggers.address && ADDRESS.test(message)) {
    reasons.push({ code: 'address', label: '涉及修改收货地址' })
  }
  if (config.triggers.orderNote && ORDER_NOTE.test(message)) {
    reasons.push({ code: 'order_note', label: '涉及订单备注' })
  }
  const word = config.triggerWords.find((item) => item !== '' && message.includes(item))
  if (word) reasons.push({ code: 'trigger_word', label: `命中触发词「${word}」` })
  if (config.triggers.offHours && !withinHours(config.hours, now)) {
    reasons.push({ code: 'off_hours', label: `当前不在接待时段 ${config.hours.start}-${config.hours.end}` })
  }
  const { intent } = detectIntent(message)
  if (config.triggers.afterSales && intent.id === 'afterSales') {
    reasons.push({ code: 'after_sales', label: '售后类问题' })
  }
  return { reasons, intent }
}

/**
 * Check outbound text against the merchant list and the platform red lines.
 *
 * @returns {{blocked: boolean, hits: Array<{source: string, label: string, term: string}>}}
 */
export function screenOutbound(text, config) {
  const body = String(text ?? '')
  const hits = []
  for (const term of config.sensitiveWords) {
    if (term !== '' && body.includes(term)) hits.push({ source: 'merchant', label: '商家敏感词', term })
  }
  for (const line of PLATFORM_RED_LINES) {
    const match = body.match(line.pattern)
    if (match) hits.push({ source: 'platform', label: line.label, term: match[0] })
  }
  return { blocked: hits.length > 0, hits }
}

export function looksUncertain(text) {
  return UNCERTAIN.test(String(text ?? ''))
}

/** A reply identical to the last thing said in this thread is not re-sent. */
export function isDuplicate(text, history, windowSize = 6) {
  const body = String(text ?? '').trim()
  if (body === '') return true
  const recent = (Array.isArray(history) ? history : [])
    .filter((message) => message?.role === 'shop')
    .slice(-windowSize)
  return recent.some((message) => String(message.text ?? '').trim() === body)
}

/**
 * Compose a grounded reply from the facts of one product.
 *
 * No arguments, no persuasion, no invented numbers: the sentence structure is
 * fixed and the slots are filled with the merchant's own strings.
 */
export function composeGroundedReply(product, facts, intent, config) {
  if (!product || facts.length === 0) return null
  const body =
    facts.length === 1
      ? facts[0].value
      : facts
          .map((fact) => (intent.id === 'general' ? fact.value : `${fact.label}：${fact.value}`))
          .join('；')
  const greeting = config.reply.greeting
  const text = `${greeting}${body}${config.reply.signOff}`
  const clipped = text.length > config.reply.maxChars ? `${text.slice(0, config.reply.maxChars - 1)}…` : text
  return {
    text: clipped,
    productId: product.id,
    productTitle: product.title,
    intent: intent.id,
    generatedBy: 'template',
    citations: facts.map((fact) => ({ field: fact.field, label: fact.label, value: fact.value })),
  }
}

/** Trim the scaffolding models like to add around a one-line reply. */
export function normalizeModelText(raw) {
  return String(raw ?? '')
    .replace(/^[\s"'“”「『]+|[\s"'“”」』]+$/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Ask the model to phrase the evidence, then re-check everything that must not
 * depend on the model behaving well: length, invented numbers, sensitive words.
 * Any failure returns null so the caller keeps the deterministic template.
 */
export async function tryCompose({ compose, config, product, draft, message }) {
  if (typeof compose !== 'function') return null
  try {
    const result = await compose({
      system: replySystemPrompt({ product, citations: draft.citations, config }),
      input: `买家消息：${message}`,
      provider: config.llm?.provider ?? '',
      model: config.llm?.model ?? '',
      maxTokens: config.llm?.maxTokens ?? 400,
      timeoutMs: config.llm?.timeoutMs ?? 20_000,
    })
    const text = normalizeModelText(typeof result === 'string' ? result : result?.text)
    if (text === '') return null
    if (text.length > config.reply.maxChars * 1.5) return null
    if (!numbersGrounded(text, draft.citations).ok) return null
    if (screenOutbound(text, config).blocked) return null
    return { text, generatedBy: 'model', model: result?.model, provider: result?.provider }
  } catch {
    return null
  }
}

/** Split one reply into human-paced segments (never mid-number). */
export function segmentReply(text, enabled = true) {
  const body = String(text ?? '').trim()
  if (!enabled || body.length <= 60) return [body]
  const parts = body
    .split(/(?<=[。！？；~\n])/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length <= 1) return [body]
  const merged = []
  for (const part of parts) {
    const last = merged[merged.length - 1]
    if (last && last.length + part.length <= 60) merged[merged.length - 1] = `${last}${part}`
    else merged.push(part)
  }
  return merged.slice(0, 4)
}

/**
 * Full decision for one inbound buyer message.
 *
 * @returns {Promise<{action: 'auto_reply'|'escalate'|'ignore', reasons: Array,
 *   confidence: number, intent: string, hits: Array, product: object|null,
 *   draft: object|null, sensitive: object, segments: string[]}>}
 */
export async function decide({ text, images = [], products, config, history = [], now = new Date(), compose }) {
  const pre = preScreen({ text, images, config, now })
  const result = {
    action: 'escalate',
    reasons: pre.reasons,
    confidence: 0,
    intent: pre.intent.id,
    hits: [],
    product: null,
    draft: null,
    sensitive: { blocked: false, hits: [] },
    segments: [],
  }

  // A pre-screen hit means a human is needed regardless of what the KB knows;
  // the bot still prepares evidence so the handover is not empty-handed.
  const search = searchProducts(products, text, { limit: 3 })
  result.hits = search.hits
  result.confidence = search.confidence
  result.product = search.best?.card ?? null

  if (result.product) {
    const detected = detectIntents(text)
    const intents = detected.length > 0 ? detected.map((item) => item.intent) : [INTENTS.general]
    const { facts, missing } = factsForIntents(result.product, intents)
    if (missing.length > 0) {
      result.reasons.push({ code: 'no_evidence', label: `知识库缺少「${missing.join('、')}」字段` })
    } else {
      result.draft = composeGroundedReply(result.product, facts, intents[0], config)
    }
  }

  if (pre.reasons.length > 0) {
    result.reasons.push({ code: 'handover', label: '已转人工' })
    result.action = 'escalate'
    return result
  }

  if (result.hits.length === 0) {
    result.reasons.push({ code: 'unlisted', label: '知识库里没有匹配的商品' })
    result.action = config.triggers.unlisted ? 'escalate' : 'escalate'
    return result
  }

  if (result.confidence < config.minConfidence) {
    result.reasons.push({
      code: 'low_confidence',
      label: `匹配度 ${result.confidence.toFixed(2)} 低于阈值 ${config.minConfidence}`,
    })
    result.action = 'escalate'
    return result
  }

  if (!result.draft) {
    result.reasons.push({ code: 'no_evidence', label: '知识库缺少能回答这个问题的字段' })
    result.action = 'escalate'
    return result
  }

  // Retrieval has accepted the evidence; the model may only rephrase it.
  if (config.llm?.enabled !== false) {
    const phrased = await tryCompose({ compose, config, product: result.product, draft: result.draft, message: text })
    if (phrased !== null) result.draft = { ...result.draft, ...phrased }
  }

  const sensitive = screenOutbound(result.draft.text, config)
  result.sensitive = sensitive
  if (sensitive.blocked) {
    result.reasons.push({
      code: 'sensitive',
      label: `回复命中${sensitive.hits[0].source === 'platform' ? '平台红线' : '敏感词'}「${sensitive.hits[0].term}」`,
    })
    result.action = 'escalate'
    return result
  }

  // The model hedged: keep its wording as the draft for a human, but do not
  // let a non-answer go out as if the question had been answered.
  if (looksUncertain(result.draft.text)) {
    result.reasons.push({ code: 'model_uncertain', label: '回复本身就是“需要确认”，应转人工' })
    result.action = 'escalate'
    return result
  }

  if (isDuplicate(result.draft.text, history)) {
    result.reasons.push({ code: 'duplicate', label: '这句话刚发过，不再重复发送' })
    result.action = 'escalate'
    return result
  }

  result.action = config.mode === 'auto' ? 'auto_reply' : 'copilot'
  result.segments = segmentReply(result.draft.text, config.reply.segments)
  return result
}

/** The handover line sent to the buyer so they are not left waiting silently. */
export function handoverText(config) {
  return config.reply.unsureText || config.reply.escalateText
}
