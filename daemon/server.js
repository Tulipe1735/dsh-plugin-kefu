/**
 * kefu-daemon — the customer-service brain as a standalone 24/7 service.
 *
 * The DSH plugin is a desk an operator sits at; this is the bot behind it. It
 * reuses `lib/` wholesale (retrieval, decision, grounding checks, storage), so
 * both entry points answer with the same rules, and exposes a small HTTP
 * contract that any message source can speak:
 *
 *   POST /push   { buyerId, buyerName?, text, images?, messageId? }  → auto-answer
 *   GET  /pull?after=<cursor>                                       → replies to deliver
 *   POST /ack    { ids: [...] }                                     → confirm delivered
 *
 * No desktop-client code lives here. The collector that reads 千牛/京麦 is the
 * operator's own process and speaks this contract.
 */
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import { loadConfig, publicConfig, saveConfig } from '../lib/config.js'
import { parseProducts, parseProductsFile } from '../lib/ingest.js'
import { clampInt, errorPayload, HttpError, readJsonBody, safeEqual, sendJson } from '../lib/http.js'
import { decide } from '../lib/reply.js'
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
  pushOutbound,
  queueStats,
  replaceProducts,
  resetStateForTests,
  setConversationStatus,
  takeOutbound,
} from '../lib/store.js'

export const VERSION = '0.1.0'

/**
 * Build (but do not start) the daemon.
 *
 * @param {object} options
 * @param {(args: object) => Promise<{text: string}>} options.compose model composer; omit to run template-only
 * @param {string} options.token shared secret every non-health route requires
 * @param {string} [options.dataHome] directory under which `kefu/` holds state
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.host] defaults to 127.0.0.1
 */
export async function createDeskServer({ compose, token, dataHome, mode, port = 0, host = '127.0.0.1', logger = console } = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('缺少访问 token：设置 KEFU_TOKEN 后再启动（守护进程不接受无鉴权的请求）')
  }
  if (dataHome !== undefined) {
    process.env.DSH_HOME = dataHome
    resetStateForTests()
  }

  let config = await loadConfig()
  // A bot that silently starts in copilot mode would look broken to its owner,
  // so the mode can be pinned at boot.
  if (mode === 'auto' || mode === 'copilot') {
    if (config.mode !== mode) config = await saveConfig({ ...config, mode })
  }
  const startedAt = Date.now()

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500
      sendJson(res, status, errorPayload(error))
    })
  })

  async function authorized(req, url) {
    const provided = req.headers['x-kefu-token'] ?? url.searchParams.get('token') ?? ''
    return safeEqual(String(provided), token)
  }

  async function ingest({ buyerId, buyerName, shop, text, images, messageId }) {
    const id = conversationId('bridge', buyerId)
    const conversation = { id, channel: 'bridge', shop, buyerId, buyerName }
    const recorded = await appendMessage({
      conversation,
      rememberId: `bridge:${messageId}`,
      message: { id: messageId, role: 'buyer', text, images },
    })
    if (recorded.duplicate) return { status: 'duplicate', conversationId: id }

    const products = await loadProducts()
    const decision = await decide({
      text,
      images,
      products,
      config,
      history: recorded.conversation?.messages ?? [],
      compose,
    })
    const result = {
      status: 'received',
      conversationId: id,
      action: decision.action,
      reasons: decision.reasons,
      confidence: decision.confidence,
      product: decision.product ? { id: decision.product.id, title: decision.product.title } : null,
      draft: decision.draft?.text ?? null,
      generatedBy: decision.draft?.generatedBy ?? null,
      queued: false,
    }

    if (decision.action === 'auto_reply' && decision.draft) {
      await pushOutbound({ channel: 'bridge', conversationId: id, buyerId, text: decision.draft.text })
      await appendMessage({ conversation, message: { role: 'shop', text: decision.draft.text, mode: 'daemon' } })
      await setConversationStatus(id, 'bot')
      result.queued = true
      return result
    }

    const reasons = decision.reasons.length > 0 ? decision.reasons : [{ code: 'manual', label: '等待人工确认' }]
    await setConversationStatus(id, 'pending', reasons)
    return result
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${host}`)
    const method = req.method ?? 'GET'
    const route = url.pathname.replace(/\/+$/, '') || '/'

    if (route === '/health') {
      sendJson(res, 200, { ok: true, version: VERSION, uptimeMs: Date.now() - startedAt })
      return
    }

    if (!(await authorized(req, url))) {
      sendJson(res, 401, { ok: false, error: 'token 不匹配' })
      return
    }

    if (method === 'GET' && route === '/status') {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        uptimeMs: Date.now() - startedAt,
        products: (await loadProducts()).length,
        stats: await queueStats(),
        config: publicConfig(config),
      })
      return
    }

    if (method === 'GET' && route === '/config') {
      sendJson(res, 200, { ok: true, config: publicConfig(config) })
      return
    }

    if (method === 'POST' && route === '/config') {
      const patch = await readJsonBody(req)
      config = await saveConfig({
        ...config,
        ...patch,
        triggers: { ...config.triggers, ...(patch.triggers ?? {}) },
        reply: { ...config.reply, ...(patch.reply ?? {}) },
        channels: { ...config.channels },
      })
      sendJson(res, 200, { ok: true, config: publicConfig(config) })
      return
    }

    if (method === 'POST' && route === '/push') {
      const body = await readJsonBody(req)
      const buyerId = String(body.buyerId ?? body.buyer_id ?? '').trim()
      const text = String(body.text ?? body.content ?? '').trim()
      const images = Array.isArray(body.images) ? body.images.filter((item) => typeof item === 'string') : []
      if (buyerId === '') throw new HttpError(400, 'push 缺少 buyerId')
      if (text === '' && images.length === 0) throw new HttpError(400, 'push 缺少 text/images')
      const result = await ingest({
        buyerId,
        buyerName: String(body.buyerName ?? buyerId),
        shop: String(body.shop ?? ''),
        text,
        images,
        messageId: String(body.messageId ?? `daemon-${buyerId}-${Date.now()}`),
      })
      sendJson(res, 200, result)
      return
    }

    if (method === 'GET' && route === '/pull') {
      const after = clampInt(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER)
      const items = await takeOutbound('bridge', after, clampInt(url.searchParams.get('limit'), 20, 1, 50))
      sendJson(res, 200, {
        ok: true,
        cursor: items.length > 0 ? items[items.length - 1].id : after,
        items: items.map((item) => ({ id: item.id, conversationId: item.conversationId, buyerId: item.buyerId, text: item.text, at: item.at })),
      })
      return
    }

    if (method === 'POST' && route === '/ack') {
      const body = await readJsonBody(req)
      sendJson(res, 200, { ok: true, removed: await ackOutbound(body.ids) })
      return
    }

    if (method === 'GET' && route === '/queue') {
      const status = url.searchParams.get('status') || 'pending'
      const list = await listConversations({
        status: status === 'all' ? undefined : status,
        limit: clampInt(url.searchParams.get('limit'), 50, 1, 200),
      })
      sendJson(res, 200, { ok: true, stats: await queueStats(), conversations: list.map(publicConversation) })
      return
    }

    if (method === 'GET' && route.startsWith('/queue/')) {
      const conversation = await getConversation(decodeURIComponent(route.slice('/queue/'.length)))
      if (!conversation) throw new HttpError(404, '会话不存在')
      sendJson(res, 200, { ok: true, conversation: publicConversation(conversation) })
      return
    }

    if (method === 'POST' && route.endsWith('/reply')) {
      const id = decodeURIComponent(route.slice('/queue/'.length, -'/reply'.length))
      const body = await readJsonBody(req)
      const conversation = await getConversation(id)
      if (!conversation) throw new HttpError(404, '会话不存在')
      const text = String(body.text ?? '').trim()
      if (text === '') throw new HttpError(400, '回复是空的')
      // Operator-approved replies take the same path as bot ones: outbox first,
      // so a collector can never lose an answer it has not acknowledged.
      await pushOutbound({ channel: 'bridge', conversationId: id, buyerId: conversation.buyerId, text })
      await appendMessage({ conversation, message: { role: 'shop', text, mode: 'operator' } })
      await setConversationStatus(id, 'bot')
      sendJson(res, 200, { ok: true, queued: true })
      return
    }

    if (method === 'POST' && route.endsWith('/status')) {
      const id = decodeURIComponent(route.slice('/queue/'.length, -'/status'.length))
      const body = await readJsonBody(req)
      const allowed = new Set(['bot', 'pending', 'human', 'closed'])
      const status = String(body.status ?? '')
      if (!allowed.has(status)) throw new HttpError(400, 'status 只能是 bot / pending / human / closed')
      const updated = await setConversationStatus(id, status, Array.isArray(body.reasons) ? body.reasons : [])
      sendJson(res, 200, { ok: updated !== null, conversation: updated ? publicConversation(updated) : null })
      return
    }

    if (method === 'GET' && route === '/products') {
      const products = await loadProducts()
      sendJson(res, 200, { ok: true, total: products.length, products })
      return
    }

    if (method === 'POST' && route === '/products/import') {
      const body = await readJsonBody(req)
      const rows =
        typeof body.file === 'string' && body.file.trim() !== ''
          ? await parseProductsFile(body.file.trim())
          : parseProducts(String(body.text ?? ''), { format: body.format })
      const result = await importProducts(rows, body.source ?? 'daemon')
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (method === 'POST' && route === '/products/delete') {
      const body = await readJsonBody(req)
      sendJson(res, 200, { ok: true, removed: await deleteProduct(String(body.id ?? '')) })
      return
    }

    if (method === 'POST' && route === '/reset') {
      const body = await readJsonBody(req)
      const catalog = body.catalog === true
      if (catalog) await replaceProducts([])
      const removed = await clearConversations()
      sendJson(res, 200, { ok: true, conversations: removed, catalogCleared: catalog })
      return
    }

    sendJson(res, 404, { ok: false, error: `未知接口：${method} ${route}` })
  }

  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      const address = server.address()
      return { port: typeof address === 'object' && address !== null ? address.port : port, host }
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
    get config() {
      return config
    },
  }
}

function publicConversation(conversation) {
  return {
    id: conversation.id,
    channel: conversation.channel,
    buyerId: conversation.buyerId,
    buyerName: conversation.buyerName,
    status: conversation.status,
    reasons: conversation.reasons ?? [],
    lastAt: conversation.lastAt,
    messages: conversation.messages.map((message) => ({
      role: message.role,
      text: message.text,
      images: message.images ?? [],
      at: message.at,
      mode: message.mode,
    })),
  }
}

/* ------------------------------------------------------------------ */
/* CLI entry                                                           */
/* ------------------------------------------------------------------ */

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const { createDeepSeekComposer } = await import('./deepseek.js')
  const port = Number(process.env.KEFU_PORT ?? 17802)
  const host = process.env.KEFU_HOST ?? '127.0.0.1'
  const token = process.env.KEFU_TOKEN ?? ''
  const dataHome = process.env.KEFU_HOME
  const apiKey = process.env.DEEPSEEK_API_KEY ?? ''

  try {
    const compose = apiKey === '' ? undefined : createDeepSeekComposer({ apiKey, logger: console })
    if (compose === undefined) console.warn('[kefu-daemon] 未设置 DEEPSEEK_API_KEY：只走确定性模板，不调用模型')
    const desk = await createDeskServer({ compose, token, dataHome, mode: process.env.KEFU_MODE, port, host })
    const bound = await desk.start()
    console.log(`[kefu-daemon] 已启动 http://${bound.host}:${bound.port} (v${VERSION})`)
    if (desk.config.mode !== 'auto') {
      console.warn(`[kefu-daemon] 当前是「${desk.config.mode}」模式：消息会进入待处理队列而不会自动回复；设 mode=auto 才是 7×24 自动客服`)
    }
    const shutdown = async (signal) => {
      console.log(`[kefu-daemon] 收到 ${signal}，正在停止…`)
      await desk.close()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
  } catch (error) {
    console.error(`[kefu-daemon] 启动失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

export { normalizeConfig } from '../lib/config.js'
