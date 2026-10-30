/**
 * Small HTTP helpers shared by the host bridge and the channel adapters.
 *
 * The panel talks to the host over the same origin that served the page, so
 * every state-changing route checks the request origin: a random website the
 * user happens to have open must not be able to rewrite the knowledge base or
 * fire a reply to a buyer.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(text)
}

export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体超过 4MB 上限')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

export async function readFormBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体超过 4MB 上限')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return Object.fromEntries(new URLSearchParams(raw))
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Reject cross-site state changes; allow same-origin and non-browser callers. */
export function isTrustedRequest(req, origin) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const header = req.headers.origin
  if (typeof header !== 'string' || header === '') return true
  if (!origin) return true
  try {
    return new URL(header).origin === new URL(origin).origin
  } catch {
    return false
  }
}

/** Strip the route prefix and normalise the remaining action path. */
export function actionOf(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null
  return pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '')
}

export function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

export function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

export function errorPayload(error) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof HttpError ? error.status : undefined,
  }
}

/** Timing-safe string comparison for bridge tokens and signatures. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length) return false
  return timingSafe(left, right)
}

function timingSafe(left, right) {
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i]
  return diff === 0
}
