import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDeskServer } from '../daemon/server.js'

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kefu-daemon-test-'))
const TOKEN = 'daemon-test-token'

let composed = 0
const compose = async () => {
  composed += 1
  // Only facts the catalog actually holds: an invented number would be
  // rejected by the grounding check and the template would win instead.
  return { text: '亲，这款售价 ¥129。', provider: 'stub', model: 'stub' }
}

const desk = await createDeskServer({ compose, token: TOKEN, dataHome: temp, mode: 'auto' })
const { port } = await desk.start()
const base = `http://127.0.0.1:${port}`

async function call(route, { method = 'GET', body, token = TOKEN } = {}) {
  const headers = {}
  if (token !== null) headers['x-kefu-token'] = token
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

test.after(async () => {
  await desk.close()
})

test('health needs no token, every other route does', async () => {
  const health = await call('/health', { token: null })
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)

  const denied = await call('/status', { token: null })
  assert.equal(denied.status, 401)

  const wrong = await call('/status', { token: 'nope' })
  assert.equal(wrong.status, 401)
})

test('refuses to boot without a token', async () => {
  await assert.rejects(() => createDeskServer({ compose, token: '', dataHome: temp }), /token/)
})

test('imports a catalog and auto-answers through the outbox', async () => {
  const imported = await call('/products/import', {
    method: 'POST',
    body: { text: '标题,价格,参数,发货\n纯棉短袖T恤,¥129,材质:纯棉,48小时内发出' },
  })
  assert.equal(imported.json.added.length, 1)

  const pushed = await call('/push', {
    method: 'POST',
    body: { buyerId: 'u1', buyerName: '小王', text: '纯棉短袖多少钱' },
  })
  assert.equal(pushed.json.action, 'auto_reply')
  assert.equal(pushed.json.queued, true)
  assert.equal(pushed.json.generatedBy, 'model', 'the daemon uses its model composer')
  assert.ok(composed >= 1)

  const pulled = await call('/pull?after=0')
  assert.equal(pulled.json.items.length, 1)
  assert.match(pulled.json.items[0].text, /129/)

  const acked = await call('/ack', { method: 'POST', body: { ids: [pulled.json.items[0].id] } })
  assert.equal(acked.json.removed, 1)

  const empty = await call('/pull?after=0')
  assert.equal(empty.json.items.length, 0)
})

test('a duplicate delivery is answered once', async () => {
  const body = { messageId: 'm-dup', buyerId: 'u2', text: '纯棉短袖多少钱' }
  const first = await call('/push', { method: 'POST', body })
  assert.equal(first.json.status, 'received')
  const second = await call('/push', { method: 'POST', body })
  assert.equal(second.json.status, 'duplicate')
})

test('a question the catalog cannot answer waits for a human', async () => {
  const pushed = await call('/push', {
    method: 'POST',
    body: { buyerId: 'u3', text: '纯棉短袖还有货吗' },
  })
  assert.equal(pushed.json.action, 'escalate')
  assert.equal(pushed.json.queued, false)
  assert.ok(pushed.json.reasons.some((reason) => reason.code === 'no_evidence' || reason.code === 'low_confidence'))

  const queue = await call('/queue?status=pending')
  assert.ok(queue.json.conversations.some((item) => item.id === 'bridge:u3'))
  assert.equal(queue.json.stats.pending >= 1, true)
})

test('an operator reply joins the same outbox, not a second one', async () => {
  const reply = await call('/queue/bridge%3Au3/reply', { method: 'POST', body: { text: '亲，M 码有货的。' } })
  assert.equal(reply.json.queued, true)
  const pulled = await call('/pull?after=0')
  assert.ok(pulled.json.items.some((item) => /M 码有货/.test(item.text)))
})

test('reset keeps the catalog unless asked', async () => {
  const queueOnly = await call('/reset', { method: 'POST', body: { catalog: false } })
  assert.equal(queueOnly.json.catalogCleared, false)
  const status = await call('/status')
  assert.equal(status.json.stats.total, 0)
  assert.equal(status.json.products, 1)
})

test('mode can be pinned at boot so the bot never silently sits in copilot', async () => {
  const other = await createDeskServer({ compose, token: 'other', dataHome: temp, mode: 'copilot' })
  assert.equal(other.config.mode, 'copilot')
  await other.close()
})
