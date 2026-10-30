/**
 * Persistence for the catalog, the conversation queue and the delivery outbox.
 *
 * Everything is a single JSON file rewritten atomically through a serialised
 * queue: two panel tabs and the bridge must not interleave writes. Volumes are
 * shop-sized (tens of thousands of messages at most), so plain files keep the
 * plugin dependency-free and the data trivially backupable.
 */
import { readJson, writeJson, dataPath, ensureDir } from './paths.js'
import { mergeProducts } from './ingest.js'

const MAX_MESSAGES = 200
const MAX_CONVERSATIONS = 800
const MAX_OUTBOX = 500

let queue = Promise.resolve()

/** Serialise mutations so concurrent HTTP calls cannot lose updates. */
function serialize(task) {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function productsFile() {
  return dataPath('kb', 'products.json')
}

export function conversationsFile() {
  return dataPath('conversations.json')
}

export function outboxFile() {
  return dataPath('outbox.json')
}

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

let catalogCache = null

export async function loadProducts() {
  if (catalogCache) return catalogCache
  const raw = await readJson(productsFile(), { products: [] })
  const products = Array.isArray(raw?.products) ? raw.products : Array.isArray(raw) ? raw : []
  catalogCache = products
  return products
}

export async function importProducts(rows, source = 'import') {
  return serialize(async () => {
    const current = await loadProducts()
    const merged = mergeProducts(current, rows, source)
    catalogCache = merged.products
    await ensureDir(dataPath('kb'))
    await writeJson(productsFile(), {
      version: 1,
      updatedAt: Date.now(),
      count: merged.products.length,
      products: merged.products,
    })
    return { added: merged.added, updated: merged.updated, total: merged.products.length }
  })
}

export async function replaceProducts(products) {
  return serialize(async () => {
    catalogCache = products
    await ensureDir(dataPath('kb'))
    await writeJson(productsFile(), {
      version: 1,
      updatedAt: Date.now(),
      count: products.length,
      products,
    })
    return products.length
  })
}

export async function deleteProduct(id) {
  return serialize(async () => {
    const current = await loadProducts()
    const next = current.filter((card) => card.id !== id)
    catalogCache = next
    await writeJson(productsFile(), { version: 1, updatedAt: Date.now(), count: next.length, products: next })
    return current.length - next.length
  })
}

export function invalidateCatalog() {
  catalogCache = null
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

function emptyState() {
  return { version: 1, conversations: [], outbox: { cursor: 0, items: [] }, seen: [] }
}

let stateCache = null

async function loadState() {
  if (stateCache) return stateCache
  const raw = await readJson(conversationsFile(), null)
  const outbox = await readJson(outboxFile(), null)
  stateCache = {
    version: 1,
    conversations: Array.isArray(raw?.conversations) ? raw.conversations : [],
    outbox: {
      cursor: Number(outbox?.cursor ?? 0),
      items: Array.isArray(outbox?.items) ? outbox.items : [],
    },
    seen: Array.isArray(raw?.seen) ? raw.seen : [],
  }
  return stateCache
}

async function persist() {
  const state = await loadState()
  if (state.conversations.length > MAX_CONVERSATIONS) {
    const sorted = [...state.conversations].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
    state.conversations = sorted.slice(0, MAX_CONVERSATIONS)
  }
  await writeJson(conversationsFile(), { version: 1, seen: state.seen, conversations: state.conversations })
  await writeJson(outboxFile(), state.outbox)
  return state
}

export function conversationId(channel, buyerId) {
  return `${channel}:${buyerId}`
}

export async function listConversations({ status, limit = 50 } = {}) {
  const state = await loadState()
  const filtered = status
    ? state.conversations.filter((item) => item.status === status)
    : state.conversations
  return [...filtered]
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
    .slice(0, Math.min(200, Math.max(1, limit)))
}

export async function getConversation(id) {
  const state = await loadState()
  return state.conversations.find((item) => item.id === id) ?? null
}

/**
 * Record an inbound or outbound message.
 *
 * `id` is required for inbound messages: channels retry webhooks, and a buyer
 * must never be answered twice for the same delivery.
 */
export async function appendMessage({ conversation, message, rememberId }) {
  return serialize(async () => {
    const state = await loadState()
    if (rememberId) {
      if (state.seen.includes(rememberId)) return { duplicate: true, conversation: null }
      state.seen.push(rememberId)
      if (state.seen.length > 5000) state.seen = state.seen.slice(-5000)
    }
    const now = Date.now()
    let record = state.conversations.find((item) => item.id === conversation.id)
    if (!record) {
      record = {
        id: conversation.id,
        channel: conversation.channel,
        shop: conversation.shop ?? '',
        buyerId: conversation.buyerId,
        buyerName: conversation.buyerName ?? conversation.buyerId,
        status: 'bot',
        createdAt: now,
        lastAt: now,
        reasons: [],
        messages: [],
      }
      state.conversations.push(record)
    }
    record.messages.push({ ...message, at: message.at ?? now })
    if (record.messages.length > MAX_MESSAGES) record.messages = record.messages.slice(-MAX_MESSAGES)
    record.lastAt = now
    if (conversation.buyerName) record.buyerName = conversation.buyerName
    if (conversation.shop) record.shop = conversation.shop
    if (message.role === 'buyer') {
      record.status = record.status === 'closed' ? 'bot' : record.status
      record.reasons = []
      record.unread = (record.unread ?? 0) + 1
    }
    await persist()
    return { duplicate: false, conversation: record }
  })
}

export async function setConversationStatus(id, status, reasons = []) {
  return serialize(async () => {
    const state = await loadState()
    const record = state.conversations.find((item) => item.id === id)
    if (!record) return null
    record.status = status
    record.reasons = reasons
    if (status === 'pending') record.escalatedAt = Date.now()
    if (status === 'human' || status === 'closed') record.unread = 0
    await persist()
    return record
  })
}

export async function markRead(id) {
  return serialize(async () => {
    const state = await loadState()
    const record = state.conversations.find((item) => item.id === id)
    if (!record) return null
    record.unread = 0
    await persist()
    return record
  })
}

export async function queueStats() {
  const state = await loadState()
  const counts = { bot: 0, pending: 0, human: 0, closed: 0 }
  for (const record of state.conversations) {
    if (counts[record.status] !== undefined) counts[record.status] += 1
  }
  const outbox = state.outbox.items.length
  return {
    ...counts,
    total: state.conversations.length,
    conversations: counts.pending + counts.human,
    outbox,
  }
}

/* ------------------------------------------------------------------ */
/* Outbox (Local Bridge / webhook delivery)                            */
/* ------------------------------------------------------------------ */

/**
 * Queue an outbound reply for a channel that pulls it (Local Bridge) or that
 * the plugin pushes itself (webhook, official gateways).
 */
export async function pushOutbound(item) {
  return serialize(async () => {
    const state = await loadState()
    state.outbox.cursor += 1
    const entry = { id: state.outbox.cursor, at: Date.now(), ...item }
    state.outbox.items.push(entry)
    if (state.outbox.items.length > MAX_OUTBOX) state.outbox.items = state.outbox.items.slice(-MAX_OUTBOX)
    await persist()
    return entry
  })
}

export async function takeOutbound(channel, after = 0, limit = 20) {
  const state = await loadState()
  return state.outbox.items
    .filter((item) => item.channel === channel && item.id > after)
    .slice(0, Math.min(50, Math.max(1, limit)))
}

export async function ackOutbound(ids) {
  return serialize(async () => {
    const state = await loadState()
    const drop = new Set((Array.isArray(ids) ? ids : []).map(Number))
    const before = state.outbox.items.length
    state.outbox.items = state.outbox.items.filter((item) => !drop.has(item.id))
    await persist()
    return before - state.outbox.items.length
  })
}

export async function resetStateForTests() {
  catalogCache = null
  stateCache = null
}

export { emptyState }
