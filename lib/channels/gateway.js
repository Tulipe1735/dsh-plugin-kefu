/**
 * Helpers for the two official open-platform gateways (淘宝 TOP, 京东宙斯).
 *
 * Both platforms sign server-to-server calls the same way: sort the business
 * parameters by name, concatenate `key + value` with no separators, wrap the
 * secret around the result, MD5 it and upper-case it. Inbound push signatures
 * are verified with the same helper so a forged webhook cannot inject messages
 * into the queue.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const REQUEST_TIMEOUT_MS = 12_000

function md5(text) {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

/** Sort-signature shared by TOP and JOS: md5(secret + k1v1k2v2… + secret). */
export function sortSign(params, secret, { upper = true } = {}) {
  const body = Object.keys(params)
    .filter((key) => key !== 'sign' && params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('')
  const digest = md5(`${secret}${body}${secret}`)
  return upper ? digest.toUpperCase() : digest
}

/** TOP also accepts the HMAC-MD5 variant (`sign_method=hmac`). */
export function hmacSign(params, secret) {
  const body = Object.keys(params)
    .filter((key) => key !== 'sign' && params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('')
  return createHmac('md5', secret).update(body, 'utf8').digest('hex').toUpperCase()
}

/** Constant-time signature comparison; length mismatch is simply "no". */
export function verifySign(expected, provided) {
  const left = Buffer.from(String(expected ?? '').toUpperCase(), 'utf8')
  const right = Buffer.from(String(provided ?? '').toUpperCase(), 'utf8')
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function withTimeout(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

/**
 * Call a gateway with form-encoded parameters.
 *
 * Returns the parsed JSON body, or throws with the platform's own error text so
 * the panel can show "isv.permission-denied" instead of a generic failure.
 */
export async function callGateway(gateway, params) {
  const body = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
  ).toString()
  const timeout = withTimeout(REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(gateway, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
      signal: timeout.signal,
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`${gateway} 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
    }
    const error = findGatewayError(parsed)
    if (error) throw new Error(error)
    return parsed
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`调用 ${gateway} 超时（${REQUEST_TIMEOUT_MS}ms）`)
    throw error
  } finally {
    timeout.done()
  }
}

/** Both gateways bury errors under a differently named `<service>_response`. */
function findGatewayError(parsed) {
  if (parsed === null || typeof parsed !== 'object') return null
  if (parsed.error_response) {
    const error = parsed.error_response
    return `平台返回错误：${error.zh_desc ?? error.msg ?? error.sub_msg ?? JSON.stringify(error)}`
  }
  if (parsed.error) {
    return `平台返回错误：${parsed.error.zh_desc ?? parsed.error.msg ?? JSON.stringify(parsed.error)}`
  }
  for (const value of Object.values(parsed)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = findGatewayError(value)
      if (nested) return nested
    }
  }
  return null
}

export function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`
}
