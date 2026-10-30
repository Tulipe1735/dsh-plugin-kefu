import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/** Minimal request/response doubles for the host bridge. */
function makeReq({ method = 'GET', url = '/', headers = {}, body }) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  }
}

function makeRes() {
  const state = { status: 200, body: '' }
  return {
    writeHead(status) {
      state.status = status
    },
    end(chunk) {
      state.body = chunk ?? ''
    },
    get status() {
      return state.status
    },
    get json() {
      try {
        return JSON.parse(state.body)
      } catch {
        return state.body
      }
    },
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-kefu-test-'))
process.env.DSH_HOME = temp

const { apply } = await import('../index.js')
const { resetStateForTests } = await import('../lib/store.js')

function makeContext() {
  const tools = new Map()
  const routes = new Map()
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effect(fn) {
      const disposer = fn()
      return () => disposer?.()
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:54205',
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, tools, routes }
}

const { ctx, tools, routes } = makeContext()
apply(ctx)
const route = [...routes.values()][0]

async function call({ method = 'GET', path: urlPath, body, headers = {} }) {
  const res = makeRes()
  await route.handler(makeReq({ method, url: urlPath, body, headers }), res)
  return res
}

const API = '/plugins/dsh-plugin-kefu/api/'
const CH = '/plugins/dsh-plugin-kefu/channels/'

test('registers the expected tools and the HTTP prefix', () => {
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['kefu_draft_reply', 'kefu_import_products', 'kefu_queue', 'kefu_search_products', 'kefu_send_reply'],
  )
  assert.equal(routes.has('/plugins/dsh-plugin-kefu'), true)
})

test('status starts empty and does not leak secrets', async () => {
  const res = await call({ path: `${API}status` })
  assert.equal(res.status, 200)
  assert.equal(res.json.products, 0)
  assert.equal(res.json.config.channels.qianniu.appSecret, undefined)
})

test('import builds the catalog and search returns evidence', async () => {
  const csv = [
    '标题,价格,规格,参数,发货,售后,关键词',
    '重磅纯棉短袖 T 恤,¥129,S/129/12；M/129/8,材质:100% 纯棉;克重:230g,48 小时内发出,7 天无理由退换,夏季',
    '陶瓷马克杯,¥39,350ml,材质:陶瓷,72 小时内发出,不支持退换,杯子',
  ].join('\n')

  const imported = await call({ method: 'POST', path: `${API}products/import`, body: { text: csv } })
  assert.equal(imported.status, 200)
  assert.equal(imported.json.added.length, 2)
  assert.equal(imported.json.total, 2)

  const searched = await call({ method: 'POST', path: `${API}search`, body: { q: '纯棉短袖多少钱' } })
  assert.equal(searched.json.products[0].title, '重磅纯棉短袖 T 恤')
  assert.ok(searched.json.products[0].evidence.some((item) => item.field === 'price'))

  const tool = tools.get('kefu_search_products')
  const output = await tool.execute({ query: '纯棉短袖多少钱' }, {})
  assert.equal(output.hits[0].title, '重磅纯棉短袖 T 恤')
  assert.equal(output.intent, 'price')
})

test('re-import updates instead of duplicating', async () => {
  const again = await call({
    method: 'POST',
    path: `${API}products/import`,
    body: { text: '标题,价格\n重磅纯棉短袖 T 恤,¥119' },
  })
  assert.equal(again.json.added.length, 0)
  assert.equal(again.json.updated.length, 1)
  assert.equal(again.json.total, 2)
})

test('cross-site state changes are rejected', async () => {
  const res = await call({
    method: 'POST',
    path: `${API}config`,
    body: { mode: 'auto' },
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(res.status, 403)

  const same = await call({
    method: 'POST',
    path: `${API}config`,
    body: { mode: 'auto' },
    headers: { origin: 'http://127.0.0.1:54205', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(same.status, 200)
  assert.equal(same.json.config.mode, 'auto')
})

test('bridge push, auto-reply and outbox pull work end to end', async () => {
  await call({ method: 'POST', path: `${API}config`, body: { channels: { bridge: { enabled: true, token: 'tok' } } } })

  const pushed = await call({
    method: 'POST',
    path: `${CH}bridge/push`,
    headers: { 'x-kefu-token': 'tok' },
    body: { buyerId: 'buyer-1', buyerName: '小王', text: '纯棉短袖多少钱' },
  })
  assert.equal(pushed.status, 200)
  assert.equal(pushed.json.action, 'auto_reply')
  assert.equal(pushed.json.sent?.ok, true)

  const pulled = await call({
    method: 'GET',
    path: `${CH}bridge/pull?after=0&token=tok`,
    headers: { 'x-kefu-token': 'tok' },
  })
  assert.equal(pulled.status, 200)
  assert.equal(pulled.json.items.length, 1)
  assert.match(pulled.json.items[0].text, /1\d\d/)

  const acked = await call({ method: 'POST', path: `${CH}bridge/ack`, headers: { 'x-kefu-token': 'tok' }, body: { ids: [pulled.json.items[0].id] } })
  assert.equal(acked.json.removed, 1)

  const empty = await call({ method: 'GET', path: `${CH}bridge/pull?after=0`, headers: { 'x-kefu-token': 'tok' } })
  assert.equal(empty.json.items.length, 0)
})

test('a duplicate delivery is not answered twice', async () => {
  const body = { messageId: 'm-1', buyerId: 'buyer-2', text: '陶瓷马克杯多少钱' }
  const first = await call({ method: 'POST', path: `${CH}bridge/push`, headers: { 'x-kefu-token': 'tok' }, body })
  assert.equal(first.status, 200)
  const second = await call({ method: 'POST', path: `${CH}bridge/push`, headers: { 'x-kefu-token': 'tok' }, body })
  assert.equal(second.json.status, 'duplicate')
})

test('a wrong bridge token is a 403, not a guess', async () => {
  const res = await call({
    method: 'POST',
    path: `${CH}bridge/push`,
    headers: { 'x-kefu-token': 'nope' },
    body: { buyerId: 'x', text: 'hello' },
  })
  assert.equal(res.status, 403)
})

test('千牛 without a send method hands the draft to a human instead of sending', async () => {
  await call({ method: 'POST', path: `${API}config`, body: { channels: { qianniu: { enabled: true, appKey: 'k', appSecret: 's', token: 'qtok' } } } })

  const pushed = await call({
    method: 'POST',
    path: `${CH}qianniu/push`,
    headers: { 'x-kefu-token': 'qtok' },
    body: { buyerId: 'tb-buyer', buyer_nick: 'tb买家', content: '这个纯棉短袖多少钱' },
  })
  assert.equal(pushed.status, 200)

  const sent = await call({
    method: 'POST',
    path: `${API}queue/${encodeURIComponent('qianniu:tb-buyer')}/send`,
    body: { text: '亲，这款 129 元。' },
  })
  assert.equal(sent.status, 409)
  assert.equal(sent.json.delivery.mode, 'adopt')

  const queue = await call({ method: 'GET', path: `${API}queue?status=all` })
  const conversation = queue.json.conversations.find((item) => item.id === 'qianniu:tb-buyer')
  assert.ok(conversation)
  assert.ok(conversation.messages.some((message) => message.mode === 'adopt'))
})

test('the dry-run tester explains the decision without sending', async () => {
  const res = await call({ method: 'POST', path: `${API}test`, body: { text: '陶瓷马克杯还有货吗' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.action, 'escalate')
  assert.ok(res.json.reasons.some((reason) => reason.code === 'no_evidence'))
})

test('the draft tool mirrors the engine', async () => {
  const tool = tools.get('kefu_draft_reply')
  const output = await tool.execute({ message: '纯棉短袖多少钱' }, {})
  assert.ok(['copilot', 'auto_reply'].includes(output.action))
  assert.match(output.draft, /1\d\d/)
  assert.equal(output.citations[0].field, 'price')
})

test('reset clears the queue, and only clears the catalog when asked', async () => {
  const before = await call({ method: 'GET', path: `${API}status` })
  assert.ok(before.json.stats.total > 0)
  assert.ok(before.json.products > 0)

  const queueOnly = await call({ method: 'POST', path: `${API}reset`, body: { catalog: false } })
  assert.equal(queueOnly.json.conversations > 0, true)
  const afterQueue = await call({ method: 'GET', path: `${API}status` })
  assert.equal(afterQueue.json.stats.total, 0)
  assert.equal(afterQueue.json.products, before.json.products, 'catalog survives a queue reset')

  const everything = await call({ method: 'POST', path: `${API}reset`, body: { catalog: true } })
  assert.equal(everything.json.catalogCleared, true)
  const afterAll = await call({ method: 'GET', path: `${API}status` })
  assert.equal(afterAll.json.products, 0)
})

test('an absent pagination parameter falls back instead of clamping to 1', async () => {
  const { clampInt, clampNumber } = await import('../lib/http.js')
  assert.equal(clampInt(null, 20, 1, 50), 20, 'Number(null) is 0, not NaN')
  assert.equal(clampInt(undefined, 100, 1, 500), 100)
  assert.equal(clampInt('', 50, 1, 200), 50)
  assert.equal(clampInt('5', 20, 1, 50), 5)
  assert.equal(clampInt('999', 20, 1, 50), 50)
  assert.equal(clampNumber(null, 0.55, 0.1, 0.95), 0.55)
})

test('secrets are stored with restrictive permissions on POSIX', async () => {
  const file = path.join(temp, 'kefu', 'config.json')
  const stats = await fs.stat(file)
  if (process.platform !== 'win32') assert.equal(stats.mode & 0o777, 0o600)
  else assert.ok(stats.isFile())
  await resetStateForTests()
})
