import assert from 'node:assert/strict'
import test from 'node:test'

import { callGateway, hmacSign, sortSign, verifySign } from '../lib/channels/gateway.js'

test('sortSign is stable, upper-case md5 and order-independent', () => {
  const a = sortSign({ app_key: 'k', method: 'taobao.demo', timestamp: '2026-10-30 10:00:00' }, 'secret')
  const b = sortSign({ timestamp: '2026-10-30 10:00:00', method: 'taobao.demo', app_key: 'k' }, 'secret')
  assert.equal(a, b)
  assert.match(a, /^[0-9A-F]{32}$/)
  assert.notEqual(sortSign({ app_key: 'k' }, 'secret'), sortSign({ app_key: 'k' }, 'other-secret'))
})

test('signature verification rejects tampering and empty input', () => {
  const params = { app_key: 'k', buyer: 'b1' }
  const sign = sortSign(params, 'secret')
  assert.equal(verifySign(sign, sign), true)
  assert.equal(verifySign(sign, `${sign}0`), false)
  assert.equal(verifySign(sign, 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF'), false)
  assert.equal(verifySign(null, null), false)
})

test('hmac variant produces a different but valid signature', () => {
  const params = { app_key: 'k' }
  const hmac = hmacSign(params, 'secret')
  assert.match(hmac, /^[0-9A-F]{32}$/)
  assert.notEqual(hmac, sortSign(params, 'secret'))
})

test('gateway errors are surfaced with the platform message', async (t) => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error_response: { zh_desc: '权限不足' } }), { status: 200 })
  t.after(() => {
    globalThis.fetch = original
  })
  await assert.rejects(() => callGateway('https://example.invalid/router/rest', { method: 'x' }), /权限不足/)
})

test('non-JSON gateway replies are reported, not swallowed', async (t) => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('<html>gateway maintenance</html>', { status: 502 })
  t.after(() => {
    globalThis.fetch = original
  })
  await assert.rejects(() => callGateway('https://example.invalid/router/rest', { method: 'x' }), /不是 JSON/)
})
