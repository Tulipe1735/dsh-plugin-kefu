import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { normalizeProduct } from '../lib/kb.js'
import { composeGroundedReply, decide, isDuplicate, looksUncertain, preScreen, screenOutbound, segmentReply } from '../lib/reply.js'

const config = normalizeConfig({})

const products = [
  normalizeProduct(
    {
      id: 'tee',
      title: '重磅纯棉短袖 T 恤',
      price: '¥129',
      skus: [{ name: 'M', price: '¥129', stock: '8 件' }],
      attrs: { 材质: '100% 纯棉' },
      shipping: '48 小时内发出，满 99 包邮',
      afterSales: '7 天无理由退换',
    },
    0,
  ),
  normalizeProduct({ id: 'cup', title: '陶瓷马克杯', price: '¥39', attrs: { 容量: '350ml' } }, 1),
]

test('preScreen catches images, address changes, order notes and trigger words', () => {
  assert.equal(preScreen({ text: '', images: ['a.png'], config }).reasons[0].code, 'buyer_image')
  assert.equal(preScreen({ text: '我要改地址', config }).reasons[0].code, 'address')
  assert.equal(preScreen({ text: '订单备注写一下', config }).reasons[0].code, 'order_note')
  assert.equal(preScreen({ text: '我要投诉你们', config }).reasons[0].code, 'trigger_word')
  assert.equal(preScreen({ text: '你好', config }).reasons.length, 0)
})

test('off-hours is only a trigger when the merchant enables it', () => {
  const now = new Date('2026-10-30T03:00:00+08:00')
  const off = normalizeConfig({ triggers: { offHours: true } })
  assert.ok(preScreen({ text: '在吗', config: off, now }).reasons.some((item) => item.code === 'off_hours'))
  assert.equal(preScreen({ text: '在吗', config, now }).reasons.length, 0)
})

test('sensitive words and platform red lines both block a reply', () => {
  const own = screenOutbound('我们保证正品，绝对最低价', config)
  assert.equal(own.blocked, true)
  assert.equal(own.hits[0].source, 'merchant')

  // Removing every sensitive word must not unlock off-site solicitation.
  const bare = normalizeConfig({ sensitiveWords: [] })
  const platform = screenOutbound('亲，加我微信聊吧', bare)
  assert.equal(platform.blocked, true)
  assert.equal(platform.hits[0].source, 'platform')

  const clean = screenOutbound('亲，48 小时内发出，满 99 包邮', bare)
  assert.equal(clean.blocked, false)
})

test('duplicate guard ignores buyer messages', () => {
  const history = [
    { role: 'buyer', text: '在吗' },
    { role: 'shop', text: '亲，在的' },
  ]
  assert.equal(isDuplicate('亲，在的', history), true)
  assert.equal(isDuplicate('亲，在的 ', history), true)
  assert.equal(isDuplicate('亲，48 小时发货', history), false)
})

test('a confident price question is answerable', async () => {
  const result = await decide({ text: '这个纯棉短袖多少钱', products, config, history: [] })
  assert.equal(result.action, 'copilot', 'copilot mode never auto-sends')
  assert.equal(result.product.id, 'tee')
  assert.equal(result.reasons.length, 0)
  assert.match(result.draft.text, /129/)
  assert.equal(result.draft.citations[0].field, 'price')
  assert.ok(result.segments.length >= 1)
})

test('full-auto mode marks the same message as auto_reply', async () => {
  const auto = normalizeConfig({ mode: 'auto' })
  const result = await decide({ text: '这个纯棉短袖多少钱', products, config: auto, history: [] })
  assert.equal(result.action, 'auto_reply')
})

test('a missing field escalates instead of improvising', async () => {
  const result = await decide({ text: '陶瓷马克杯什么时候发货', products, config, history: [] })
  assert.equal(result.action, 'escalate')
  assert.ok(result.reasons.some((reason) => reason.code === 'no_evidence'))
  assert.equal(result.draft, null)
})

test('an unlisted product escalates', async () => {
  const result = await decide({ text: '你们卖无人机吗', products, config, history: [] })
  assert.equal(result.action, 'escalate')
  assert.ok(result.reasons.some((reason) => reason.code === 'unlisted'))
})

test('a repeated answer is not sent twice', async () => {
  const first = await decide({ text: '纯棉短袖多少钱', products, config, history: [] })
  assert.ok(first.draft)
  const history = [
    { role: 'buyer', text: '纯棉短袖多少钱' },
    { role: 'shop', text: first.draft.text },
  ]
  const second = await decide({ text: '纯棉短袖多少钱', products, config, history })
  assert.equal(second.action, 'escalate')
  assert.ok(second.reasons.some((reason) => reason.code === 'duplicate'))
})

test('composeGroundedReply never exceeds the configured length', () => {
  const long = normalizeConfig({ reply: { maxChars: 40 } })
  const product = normalizeProduct(
    { title: '长文案商品', price: '¥1', description: 'x'.repeat(500), attrs: { 材质: 'y'.repeat(200) } },
    0,
  )
  const reply = composeGroundedReply(product, [{ field: 'attrs', label: '参数', value: 'z'.repeat(300) }], { id: 'spec' }, long)
  assert.ok(reply.text.length <= 40)
})

test('segmentReply splits long replies without exceeding four parts', () => {
  const text = [
    '亲，这款是 100% 纯棉的。',
    '克重 230g，穿着不透。',
    '48 小时内发出，满 99 包邮。',
    '支持 7 天无理由退换，质量问题包邮退。',
    '尺码偏大，建议拍小一码。',
    '有任何问题随时找我。',
  ].join('')
  const parts = segmentReply(text, true)
  assert.ok(text.length > 60)
  assert.ok(parts.length >= 2, `expected a split, got ${parts.length}`)
  assert.ok(parts.length <= 4)
  assert.equal(segmentReply('短回复', true).length, 1)
})

test('the model only rephrases evidence, and a lying model is discarded', async () => {
  const composed = []
  const compose = async (args) => {
    composed.push(args)
    return { text: '亲，这款售价 ¥129，M 码也是 ¥129。', model: 'test-model', provider: 'test' }
  }
  const result = await decide({ text: '这个纯棉短袖多少钱', products, config, history: [], compose })
  assert.equal(result.draft.generatedBy, 'model')
  assert.match(result.draft.text, /129/)
  assert.equal(composed.length, 1)
  assert.match(composed[0].system, /只能使用下面「证据」里出现的事实/)

  // A number that is not in the evidence must be rejected outright.
  const liar = async () => ({ text: '亲，现在活动价 ¥99，还包邮哦。', model: 'liar' })
  const fallback = await decide({ text: '这个纯棉短袖多少钱', products, config, history: [], compose: liar })
  assert.equal(fallback.draft.generatedBy, 'template')
  assert.match(fallback.draft.text, /129/)

  // So must a reply that trips a platform red line.
  const offsite = async () => ({ text: '亲，加我微信详聊，¥129 给你留着。' })
  const blocked = await decide({ text: '这个纯棉短袖多少钱', products, config, history: [], compose: offsite })
  assert.equal(blocked.draft.generatedBy, 'template')
})

test('a failing model never breaks the reply path', async () => {
  const boom = async () => {
    throw new Error('model down')
  }
  const result = await decide({ text: '这个纯棉短袖多少钱', products, config, history: [], compose: boom })
  assert.equal(result.draft.generatedBy, 'template')
  assert.ok(['copilot', 'auto_reply'].includes(result.action))
})

test('a hedging model answer escalates instead of shipping a non-answer', async () => {
  const auto = normalizeConfig({ mode: 'auto' })
  const hedging = async () => ({ text: '这款的尺码情况我需要让客服同事确认一下。' })
  const result = await decide({ text: '这个纯棉短袖多少钱', products, config: auto, history: [], compose: hedging })
  assert.equal(result.action, 'escalate')
  assert.ok(result.reasons.some((reason) => reason.code === 'model_uncertain'))
  assert.match(result.draft.text, /确认/, 'the human still sees what the model wanted to say')
})

test('looksUncertain recognises the phrasings models actually use', () => {
  assert.equal(looksUncertain('这个我需要确认一下'), true)
  assert.equal(looksUncertain('不太确定，帮您问一下'), true)
  assert.equal(looksUncertain('亲，48 小时内发出，满 99 包邮。'), false)
})

test('a size question is answered from the SKU table', async () => {
  const result = await decide({ text: '纯棉短袖有 M 码吗', products, config, history: [] })
  assert.equal(result.intent, 'spec')
  assert.ok(result.draft)
  assert.ok(result.draft.citations.some((item) => item.field === 'skus'))
  assert.match(result.draft.text, /M/)
})
