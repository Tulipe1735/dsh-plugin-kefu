/**
 * dsh-plugin-kefu — Host half.
 *
 * The customer-service desk lives in three pieces:
 *   1. a product knowledge base (what the shop already wrote down),
 *   2. a decision engine that answers only from that evidence and hands the
 *      rest to a human,
 *   3. channel adapters that move messages in and out.
 *
 * The model-facing tools let the conversation in DSH search the catalog, draft
 * a reply with citations and push it out; the panel does the same by hand.
 */
import { createChannelRegistry } from './lib/channels/index.js'
import { createComposer, hasLlm } from './lib/composer.js'
import { loadConfig, patchConfig, publicConfig, saveConfig } from './lib/config.js'
import { IngestError, parseProducts, parseProductsFile, parseProducts as parseInline } from './lib/ingest.js'
import { actionOf, clampInt, clampNumber, errorPayload, HttpError, isTrustedRequest, readFormBody, readJsonBody, safeEqual, sendJson } from './lib/http.js'
import { detectIntent, searchProducts } from './lib/kb.js'
import { decide, segmentReply } from './lib/reply.js'
import {
  ackOutbound,
  appendMessage,
  clearConversations,
  conversationId,
  deleteProduct,
  getConversation,
  importProducts,
  listConversations,
  loadProducts,
  markRead,
  pushOutbound,
  queueStats,
  replaceProducts,
  setConversationStatus,
  takeOutbound,
} from './lib/store.js'
import { DEFAULT_CONFIG } from './lib/config.js'

const PLUGIN_ID = 'dsh-plugin-kefu'
const ROUTE_PREFIX = `/plugins/${PLUGIN_ID}/`
const API_PREFIX = `${ROUTE_PREFIX}api/`
const CHANNEL_PREFIX = `${ROUTE_PREFIX}channels/`
const ROOT_ROUTE = ROUTE_PREFIX.replace(/\/$/, '')

export const name = PLUGIN_ID
export const inject = ['tools', 'webServer']

/** Re-exported so tests can drive the engine without booting DSH. */
export { decide, searchProducts, detectIntent, parseProducts, parseInline }

export function apply(ctx) {
  let config = DEFAULT_CONFIG
  const ready = refresh()
  const registry = createChannelRegistry({ getConfig: () => config, logger: ctx.logger })
  // `llm` is optional: a headless profile has no model service, and the desk
  // must still work there with its deterministic template replies. `ctx.get`
  // reads a service without declaring a hard dependency on it.
  const composer = createComposer({
    getLlm: () => {
      try {
        return typeof ctx.get === 'function' ? ctx.get('llm') : (ctx.llm ?? null)
      } catch {
        return null
      }
    },
    logger: ctx.logger,
  })
  const compose = (args) => composer.compose(args)

  async function refresh() {
    config = await loadConfig()
    return config
  }

  async function setConfig(next) {
    config = await saveConfig(next)
    return config
  }

  const origin = () => {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return undefined
    }
  }

  /* ---------------------------------------------------------------- */
  /* HTTP bridge for the panel and for channel pushes                  */
  /* ---------------------------------------------------------------- */

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROOT_ROUTE,
        handler: (req, res) =>
          handleRequest(
            { ctx, registry, origin, ready, refresh, setConfig, getConfig: () => config, compose, composer },
            req,
            res,
          ),
      }),
    'kefu: HTTP bridge',
  )

  /* ---------------------------------------------------------------- */
  /* Model-facing tools                                                */
  /* ---------------------------------------------------------------- */

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kefu_import_products',
        description:
          'Import products into the customer-service knowledge base from a file (CSV / TSV / JSON / Markdown table) or inline rows. ' +
          'Recognised Chinese or English headers: 标题/商品名称, 价格, 规格, 参数, 发货, 售后, 关键词, 别名, 详情, 图片, 库存. ' +
          'Re-importing the same product id/title updates it instead of duplicating. ' +
          'Use this before answering any product question: the bot only answers from what is imported.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Absolute path to a .csv/.tsv/.json/.md file to import.' },
            text: { type: 'string', description: 'Inline product rows instead of a file (same formats as the file).' },
            format: { type: 'string', enum: ['csv', 'tsv', 'json', 'markdown'], description: 'Force the parser when the extension is missing.' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          exec.signal?.throwIfAborted?.()
          await ready
          try {
            const rows =
              typeof args.file === 'string' && args.file.trim() !== ''
                ? await parseProductsFile(args.file.trim())
                : parseInline(String(args.text ?? ''), { format: args.format })
            if (rows.length === 0) return { status: 'empty', imported: 0, note: '没有解析到任何商品行' }
            const result = await importProducts(rows, typeof args.file === 'string' ? `file:${args.file}` : 'inline')
            return {
              status: 'imported',
              imported: rows.length,
              added: result.added.length,
              updated: result.updated.length,
              total: result.total,
              sampleIds: [...result.added, ...result.updated].slice(0, 5),
            }
          } catch (error) {
            if (error instanceof IngestError) return { status: 'error', error: error.message }
            throw error
          }
        },
      }),
    'kefu: import tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kefu_search_products',
        description:
          'Search the shop product knowledge base. Returns ranked products with the exact fields (价格 / 规格 / 参数 / 发货 / 售后) that matched, plus a 0-1 confidence. ' +
          'Use it to ground an answer before writing one; if confidence is low or no field answers the question, tell the buyer a human will confirm instead of guessing.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "The buyer's question or product keywords." },
            limit: { type: 'integer', description: 'How many products to return (default 5, max 20).' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          exec.signal?.throwIfAborted?.()
          await ready
          const products = await loadProducts()
          if (products.length === 0) {
            return { query: args.query, hits: [], confidence: 0, note: '知识库为空：先用 kefu_import_products 导入商品' }
          }
          const result = searchProducts(products, args.query, { limit: clampInt(args.limit, 5, 1, 20) })
          const { intent } = detectIntent(args.query)
          return {
            query: result.query,
            intent: intent.id,
            intentLabel: intent.label,
            confidence: result.confidence,
            hits: result.hits.map((hit) => ({
              id: hit.card.id,
              title: hit.card.title,
              confidence: hit.confidence,
              matchedFields: hit.matchedFields,
              evidence: hit.evidence,
              price: hit.card.price,
              skus: hit.card.skus,
              attrs: hit.card.attrs,
              shipping: hit.card.shipping,
              afterSales: hit.card.afterSales,
            })),
          }
        },
      }),
    'kefu: search tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kefu_draft_reply',
        description:
          'Run one buyer message through the customer-service engine WITHOUT sending anything. ' +
          'Returns the decision (auto_reply / copilot / escalate), the reasons for a handover, the matched product with citations, and a grounded draft reply. ' +
          'Use this when the user pastes a buyer question and wants to know what the desk would answer, or before kefu_send_reply.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: "The buyer's message." },
            images: { type: 'array', items: { type: 'string' }, description: 'Image URLs the buyer sent, if any.' },
            channel: { type: 'string', enum: ['qianniu', 'jingmai', 'bridge', 'webhook'], description: 'Which channel this message arrived on (default bridge).' },
          },
          required: ['message'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          exec.signal?.throwIfAborted?.()
          await ready
          const products = await loadProducts()
          const result = await decide({
            text: String(args.message ?? ''),
            images: Array.isArray(args.images) ? args.images : [],
            products,
            config,
            history: [],
            compose,
          })
          return {
            action: result.action,
            reasons: result.reasons,
            intent: result.intent,
            confidence: result.confidence,
            product: result.product ? { id: result.product.id, title: result.product.title } : null,
            citations: result.draft?.citations ?? [],
            draft: result.draft?.text ?? null,
            generatedBy: result.draft?.generatedBy ?? null,
            segments: result.segments,
            sensitive: result.sensitive,
            note:
              result.action === 'escalate'
                ? '不建议自动回复：把这些 reasons 告诉用户，或交给人工。'
                : '有依据，可以直接发送（kefu_send_reply）。',
          }
        },
      }),
    'kefu: draft tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kefu_send_reply',
        description:
          'Send a reply to a buyer through a channel. The text is screened against the merchant sensitive list and the platform red lines first; a blocked reply is never sent. ' +
          'For 千牛/京麦 without a configured sendMethod the reply is NOT sent: it is queued for one-click adoption by a human. Requires a conversationId that exists in the queue.',
        parameters: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: 'Conversation id from kefu_queue, e.g. "bridge:buyer-1".' },
            text: { type: 'string', description: 'Reply text to send.' },
          },
          required: ['conversationId', 'text'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          exec.signal?.throwIfAborted?.()
          await ready
          const conversation = await getConversation(String(args.conversationId ?? ''))
          if (!conversation) return { status: 'error', error: '找不到这个会话，先用 kefu_queue 查 id' }
          const delivery = await deliver({ registry, conversation, text: String(args.text ?? ''), config })
          return { status: delivery.ok ? 'sent' : 'not_sent', ...delivery }
        },
      }),
    'kefu: send tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kefu_queue',
        description:
          'List the customer-service queue: conversations waiting for a human, recent bot conversations, or all. ' +
          'Use it to report "which buyers are waiting", then kefu_draft_reply / kefu_send_reply to handle them.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'human', 'bot', 'closed', 'all'], description: 'Filter (default pending).' },
            limit: { type: 'integer', description: 'Max conversations (default 10, max 50).' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          exec.signal?.throwIfAborted?.()
          await ready
          const status = args.status === 'all' ? undefined : args.status ?? 'pending'
          const list = await listConversations({ status, limit: clampInt(args.limit, 10, 1, 50) })
          return {
            status: status ?? 'all',
            stats: await queueStats(),
            conversations: list.map((item) => ({
              id: item.id,
              channel: item.channel,
              buyer: item.buyerName,
              status: item.status,
              lastAt: item.lastAt,
              reasons: item.reasons,
              lastBuyerMessage: [...item.messages].reverse().find((m) => m.role === 'buyer')?.text ?? '',
            })),
          }
        },
      }),
    'kefu: queue tool',
  )
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

/**
 * Send one reply through a channel.
 *
 * Three outcomes, and none of them lies to the caller:
 *   - `sent`     : the platform accepted it (official gateway) or the receiver
 *                  answered 2xx (webhook).
 *   - `queued`   : the Local Bridge outbox holds it until the helper pulls.
 *   - `adopt`    : nothing was sent; a human copies the text into 千牛/京麦.
 */
async function deliver({ registry, conversation, text, config }) {
  const body = String(text ?? '').trim()
  if (body === '') return { ok: false, detail: '回复是空的' }
  const adapter = registry.get(conversation.channel)
  const status = adapter.status()
  if (!status.enabled) {
    return { ok: false, detail: `通道「${status.label}」未启用`, mode: 'config' }
  }

  if (conversation.channel === 'bridge') {
    await pushOutbound({
      channel: 'bridge',
      conversationId: conversation.id,
      buyerId: conversation.buyerId,
      text: body,
    })
    await appendMessage({
      conversation,
      message: { role: 'shop', text: body, mode: 'bridge' },
    })
    await setConversationStatus(conversation.id, 'bot')
    return { ok: true, mode: 'bridge', detail: '已进入桥接发件箱，等桥接端拉取' }
  }

  if (conversation.channel === 'qianniu' || conversation.channel === 'jingmai') {
    if (status.ready) {
      try {
        const result = await adapter.send({ buyerId: conversation.buyerId, text: body, raw: conversation.raw ?? {} })
        if (!result.ok) {
          await setConversationStatus(conversation.id, 'pending', [{ code: 'send_failed', label: result.detail ?? '发送失败' }])
          return { ok: false, mode: 'official', detail: result.detail ?? '平台拒绝了这条回复' }
        }
        await appendMessage({ conversation, message: { role: 'shop', text: body, mode: 'official' } })
        await setConversationStatus(conversation.id, 'bot')
        return { ok: true, mode: 'official', detail: '已通过开放平台发送' }
      } catch (error) {
        await setConversationStatus(conversation.id, 'pending', [{ code: 'send_failed', label: errorPayload(error).error }])
        return { ok: false, mode: 'official', detail: errorPayload(error).error }
      }
    }
    // No sendMethod: this plugin cannot deliver on this channel by design, so
    // the human adopts the text in the client instead of it being silently lost.
    await appendMessage({ conversation, message: { role: 'system', text: `建议回复（待采纳）：${body}`, mode: 'adopt' } })
    await setConversationStatus(conversation.id, 'pending', [
      { code: 'needs_adoption', label: '官方通道未配置发送接口，需人工复制发送' },
    ])
    return { ok: false, mode: 'adopt', detail: '未发送：请人工在客户端里采纳这条回复', text: body }
  }

  try {
    const result = await adapter.send({ buyerId: conversation.buyerId, text: body, conversationId: conversation.id })
    if (!result.ok) {
      await setConversationStatus(conversation.id, 'pending', [{ code: 'send_failed', label: result.detail }])
      return { ok: false, mode: 'webhook', detail: result.detail }
    }
    await appendMessage({ conversation, message: { role: 'shop', text: body, mode: 'webhook' } })
    await setConversationStatus(conversation.id, 'bot')
    return { ok: true, mode: 'webhook', detail: '已推送到 outboundUrl' }
  } catch (error) {
    await setConversationStatus(conversation.id, 'pending', [{ code: 'send_failed', label: errorPayload(error).error }])
    return { ok: false, mode: 'webhook', detail: errorPayload(error).error }
  }
}

/* ------------------------------------------------------------------ */
/* Inbound pipeline                                                    */
/* ------------------------------------------------------------------ */

/**
 * One inbound message: verify → de-duplicate → record → decide → answer or
 * escalate. Shared by every channel push route so the behaviour cannot drift.
 */
async function ingestInbound({ registry, config, channel, payload, headers, query, compose }) {
  const adapter = registry.get(channel)
  const status = adapter.status()
  if (!status.enabled) throw new HttpError(409, `通道「${status.label}」未启用`)

  const verification = adapter.verifyInbound({ headers, query, payload, config: config.channels[channel] })
  if (!verification.ok) throw new HttpError(403, verification.reason)

  let inbound
  try {
    inbound = adapter.normalizeInbound(payload)
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error))
  }

  const id = conversationId(channel, inbound.buyerId)
  const conversation = {
    id,
    channel,
    shop: inbound.shop,
    buyerId: inbound.buyerId,
    buyerName: inbound.buyerName,
  }

  const recorded = await appendMessage({
    conversation,
    rememberId: `${channel}:${inbound.messageId}`,
    message: { id: inbound.messageId, role: 'buyer', text: inbound.text, images: inbound.images },
  })
  if (recorded.duplicate) {
    return { status: 'duplicate', conversationId: id, note: '这条消息已经处理过，不重复回复' }
  }

  const products = await loadProducts()
  const history = recorded.conversation?.messages ?? []
  const decision = await decide({
    text: inbound.text,
    images: inbound.images,
    products,
    config,
    history,
    compose,
  })

  const result = {
    status: 'received',
    conversationId: id,
    action: decision.action,
    reasons: decision.reasons,
    confidence: decision.confidence,
    product: decision.product ? { id: decision.product.id, title: decision.product.title } : null,
    citations: decision.draft?.citations ?? [],
    draft: decision.draft?.text ?? null,
    sent: null,
  }

  if (decision.action === 'auto_reply' && decision.draft) {
    const delivery = await deliver({
      registry,
      conversation: await getConversation(id),
      text: decision.draft.text,
      config,
    })
    result.sent = delivery
    if (!delivery.ok) {
      await setConversationStatus(id, 'pending', [
        ...decision.reasons,
        { code: 'send_failed', label: delivery.detail ?? '发送失败' },
      ])
    }
    return result
  }

  // Everything else waits for a human, with the bot's evidence attached.
  const reasons = decision.reasons.length > 0 ? decision.reasons : [{ code: 'manual', label: '人机协作模式：等待人工确认' }]
  await setConversationStatus(id, 'pending', reasons)
  return result
}

/* ------------------------------------------------------------------ */
/* HTTP surface                                                        */
/* ------------------------------------------------------------------ */

async function handleRequest(env, req, res) {
  const url = new URL(req.url ?? '/', 'http://kefu.local')
  const method = req.method ?? 'GET'

  try {
    // Channel pushes are server-to-server: they authenticate with their own
    // token, not with the browser origin, so they are handled before the
    // same-origin check.
    if (url.pathname.startsWith(CHANNEL_PREFIX)) {
      await handleChannelRoute(env, req, res, url, method)
      return
    }

    if (!url.pathname.startsWith(API_PREFIX)) {
      sendJson(res, 404, { error: 'not found' })
      return
    }

    const action = actionOf(url.pathname, API_PREFIX) ?? ''
    const trusted = isTrustedRequest(req, env.origin())
    if (!trusted && method !== 'GET') {
      sendJson(res, 403, { error: 'forbidden origin' })
      return
    }
    await env.ready

    if (method === 'GET' && action === 'status') {
      const products = await loadProducts()
      sendJson(res, 200, {
        ok: true,
        products: products.length,
        stats: await queueStats(),
        config: publicConfig(env.getConfig()),
        channels: env.registry.statuses(),
      })
      return
    }

    if (method === 'GET' && action === 'config') {
      sendJson(res, 200, { ok: true, config: publicConfig(env.getConfig()) })
      return
    }

    if (method === 'POST' && action === 'config') {
      const body = await readJsonBody(req)
      const next = await env.setConfig({
        ...env.getConfig(),
        ...body,
        triggers: { ...env.getConfig().triggers, ...(body.triggers ?? {}) },
        hours: { ...env.getConfig().hours, ...(body.hours ?? {}) },
        reply: { ...env.getConfig().reply, ...(body.reply ?? {}) },
        channels: mergeChannels(env.getConfig().channels, body.channels ?? {}),
      })
      sendJson(res, 200, { ok: true, config: publicConfig(next), channels: env.registry.statuses() })
      return
    }

    if (method === 'GET' && action === 'products') {
      const products = await loadProducts()
      const query = url.searchParams.get('q') ?? ''
      const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500)
      const matched = query === '' ? products : searchProducts(products, query, { limit: 500 }).hits.map((hit) => hit.card)
      sendJson(res, 200, { ok: true, total: products.length, products: matched.slice(0, limit) })
      return
    }

    if (method === 'POST' && action === 'products/import') {
      const body = await readJsonBody(req)
      let rows
      if (typeof body.file === 'string' && body.file.trim() !== '') rows = await parseProductsFile(body.file.trim())
      else rows = parseInline(String(body.text ?? ''), { format: body.format })
      const result = await importProducts(rows, body.source ?? 'panel')
      sendJson(res, 200, { ok: true, ...result, total: result.total })
      return
    }

    if (method === 'POST' && action === 'products') {
      const body = await readJsonBody(req)
      const result = await importProducts([body], 'manual')
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (method === 'POST' && action === 'products/replace') {
      const body = await readJsonBody(req)
      const rows = Array.isArray(body.products) ? body.products : []
      const total = await replaceProducts(rows)
      sendJson(res, 200, { ok: true, total })
      return
    }

    if (method === 'POST' && action === 'products/delete') {
      const body = await readJsonBody(req)
      const removed = await deleteProduct(String(body.id ?? ''))
      sendJson(res, 200, { ok: true, removed, total: (await loadProducts()).length })
      return
    }

    if (method === 'POST' && action === 'search') {
      const body = await readJsonBody(req)
      const products = await loadProducts()
      const result = searchProducts(products, body.q ?? '', { limit: clampInt(body.limit, 5, 1, 20) })
      sendJson(res, 200, {
        ok: true,
        query: result.query,
        confidence: result.confidence,
        products: result.hits.map((hit) => ({
          id: hit.card.id,
          title: hit.card.title,
          confidence: hit.confidence,
          matchedFields: hit.matchedFields,
          evidence: hit.evidence,
        })),
      })
      return
    }

    if (method === 'POST' && action === 'test') {
      const body = await readJsonBody(req)
      const products = await loadProducts()
      const result = await decide({
        text: String(body.text ?? ''),
        images: Array.isArray(body.images) ? body.images : [],
        products,
        config: env.getConfig(),
        history: [],
        compose: body.useModel === false ? undefined : env.compose,
      })
      sendJson(res, 200, {
        ok: true,
        action: result.action,
        reasons: result.reasons,
        intent: result.intent,
        confidence: result.confidence,
        product: result.product ? { id: result.product.id, title: result.product.title } : null,
        citations: result.draft?.citations ?? [],
        draft: result.draft?.text ?? null,
        generatedBy: result.draft?.generatedBy ?? null,
        segments: result.segments,
        sensitive: result.sensitive,
      })
      return
    }

    if (method === 'GET' && action === 'llm') {
      const status = await env.composer.status()
      const config = env.getConfig()
      const route = await env.composer.route(config.llm)
      sendJson(res, 200, {
        ok: true,
        available: status.available,
        providers: status.providers,
        route,
        lastError: status.lastError ?? null,
        settings: config.llm,
      })
      return
    }

    if (method === 'POST' && action === 'reset') {
      const body = await readJsonBody(req)
      const catalog = body.catalog === true
      if (catalog) await replaceProducts([])
      const removed = await clearConversations()
      sendJson(res, 200, { ok: true, conversations: removed, catalogCleared: catalog })
      return
    }

    if (method === 'GET' && action === 'queue') {
      const status = url.searchParams.get('status') || 'pending'
      const list = await listConversations({
        status: status === 'all' ? undefined : status,
        limit: clampInt(url.searchParams.get('limit'), 50, 1, 200),
      })
      sendJson(res, 200, {
        ok: true,
        stats: await queueStats(),
        conversations: list.map(publicConversation),
      })
      return
    }

    if (method === 'GET' && action.startsWith('queue/')) {
      const id = decodeURIComponent(action.slice('queue/'.length))
      const conversation = await getConversation(id)
      if (!conversation) {
        sendJson(res, 404, { ok: false, error: '会话不存在' })
        return
      }
      await markRead(id)
      sendJson(res, 200, { ok: true, conversation: publicConversation(conversation) })
      return
    }

    if (method === 'POST' && action.endsWith('/send')) {
      const id = decodeURIComponent(action.slice(0, -'/send'.length).replace(/^queue\//, ''))
      const body = await readJsonBody(req)
      const conversation = await getConversation(id)
      if (!conversation) {
        sendJson(res, 404, { ok: false, error: '会话不存在' })
        return
      }
      const delivery = await deliver({
        registry: env.registry,
        conversation,
        text: String(body.text ?? ''),
        config: env.getConfig(),
      })
      sendJson(res, delivery.ok ? 200 : 409, { ok: delivery.ok, delivery, conversation: publicConversation(await getConversation(id)) })
      return
    }

    if (method === 'POST' && action.endsWith('/status')) {
      const id = decodeURIComponent(action.slice(0, -'/status'.length).replace(/^queue\//, ''))
      const body = await readJsonBody(req)
      const allowed = new Set(['bot', 'pending', 'human', 'closed'])
      const status = String(body.status ?? '')
      if (!allowed.has(status)) {
        sendJson(res, 400, { ok: false, error: 'status 只能是 bot / pending / human / closed' })
        return
      }
      const updated = await setConversationStatus(id, status, Array.isArray(body.reasons) ? body.reasons : [])
      sendJson(res, 200, { ok: updated !== null, conversation: updated ? publicConversation(updated) : null })
      return
    }

    if (method === 'GET' && action === 'channels') {
      sendJson(res, 200, { ok: true, channels: env.registry.statuses() })
      return
    }

    sendJson(res, 404, { error: `未知接口：${method} ${action}` })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof IngestError ? 400 : 500
    sendJson(res, status, errorPayload(error))
  }
}

async function handleChannelRoute(env, req, res, url, method) {
  const rest = actionOf(url.pathname, CHANNEL_PREFIX) ?? ''
  const [channelId, verb] = rest.split('/')
  if (!env.registry.has(channelId)) {
    sendJson(res, 404, { error: `未知通道：${channelId}` })
    return
  }
  await env.ready
  const query = Object.fromEntries(url.searchParams)

  if (channelId === 'bridge' && method === 'GET' && verb === 'pull') {
    const status = env.registry.get('bridge').status()
    const verification = env.registry
      .get('bridge')
      .verifyInbound({ headers: req.headers, query, config: env.getConfig().channels.bridge })
    if (!verification.ok) {
      sendJson(res, 403, { ok: false, error: verification.reason })
      return
    }
    if (!status.enabled) {
      sendJson(res, 409, { ok: false, error: 'bridge 通道未启用' })
      return
    }
    const after = clampInt(query.after, 0, 0, Number.MAX_SAFE_INTEGER)
    const items = await takeOutbound('bridge', after, clampInt(query.limit, 20, 1, 50))
    sendJson(res, 200, {
      ok: true,
      cursor: items.length > 0 ? items[items.length - 1].id : after,
      items: items.map((item) => ({
        id: item.id,
        conversationId: item.conversationId,
        buyerId: item.buyerId,
        text: item.text,
        at: item.at,
      })),
    })
    return
  }

  if (channelId === 'bridge' && method === 'POST' && verb === 'ack') {
    const verification = env.registry
      .get('bridge')
      .verifyInbound({ headers: req.headers, query, config: env.getConfig().channels.bridge })
    if (!verification.ok) {
      sendJson(res, 403, { ok: false, error: verification.reason })
      return
    }
    const body = await readJsonBody(req)
    const removed = await ackOutbound(body.ids)
    sendJson(res, 200, { ok: true, removed })
    return
  }

  if (method === 'POST' && (verb === 'push' || verb === undefined)) {
    const contentType = String(req.headers['content-type'] ?? '')
    const payload = contentType.includes('application/x-www-form-urlencoded')
      ? await readFormBody(req)
      : await readJsonBody(req)
    const result = await ingestInbound({
      registry: env.registry,
      config: env.getConfig(),
      channel: channelId,
      payload,
      headers: req.headers,
      query,
      compose: env.compose,
    })
    sendJson(res, 200, result)
    return
  }

  sendJson(res, 404, { error: `未知通道接口：${method} ${rest}` })
}

function mergeChannels(current, patch) {
  const next = { ...current }
  for (const [id, value] of Object.entries(patch ?? {})) {
    if (!value || typeof value !== 'object') continue
    next[id] = { ...(current[id] ?? {}), ...value }
  }
  return next
}

/** Drop message-internal fields the browser never needs. */
function publicConversation(conversation) {
  return {
    id: conversation.id,
    channel: conversation.channel,
    shop: conversation.shop,
    buyerId: conversation.buyerId,
    buyerName: conversation.buyerName,
    status: conversation.status,
    reasons: conversation.reasons ?? [],
    unread: conversation.unread ?? 0,
    lastAt: conversation.lastAt,
    escalatedAt: conversation.escalatedAt,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      images: message.images ?? [],
      at: message.at,
      mode: message.mode,
    })),
  }
}

export { segmentReply, clampNumber, safeEqual, parseProducts as parseImport }
