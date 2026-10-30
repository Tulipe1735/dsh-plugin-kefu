import assert from 'node:assert/strict'
import test from 'node:test'

import {
  detectIntent,
  detectIntents,
  factsForIntent,
  factsForIntents,
  normalizeProduct,
  searchProducts,
  tokenize,
} from '../lib/kb.js'

const products = [
  normalizeProduct(
    {
      id: 'tee',
      title: '重磅纯棉短袖 T 恤',
      aliases: ['纯棉T恤', '打底衫'],
      price: '¥129',
      skus: [
        { name: 'S', price: '¥129', stock: '12 件' },
        { name: 'M', price: '¥129', stock: '8 件' },
      ],
      attrs: { 材质: '100% 纯棉', 克重: '230g', 版型: '宽松' },
      shipping: '48 小时内发出，满 99 包邮',
      afterSales: '7 天无理由退换，质量问题包邮退',
      keywords: ['夏季', '基础款'],
    },
    0,
  ),
  normalizeProduct(
    {
      id: 'pants',
      title: '高腰直筒牛仔裤',
      price: '¥219',
      skus: [{ name: '28', price: '¥219', stock: '5 件' }],
      attrs: { 材质: '98% 棉 + 2% 氨纶', 版型: '直筒' },
      shipping: '72 小时内发出，偏远地区补运费',
      afterSales: '支持 7 天无理由，不支持改地址',
    },
    1,
  ),
  normalizeProduct(
    {
      id: 'cup',
      title: '陶瓷马克杯',
      price: '¥39',
      attrs: { 容量: '350ml', 材质: '陶瓷' },
    },
    2,
  ),
]

test('tokenize keeps Chinese bigrams and latin words', () => {
  const tokens = tokenize('纯棉T恤 129元')
  assert.ok(tokens.includes('纯棉'))
  assert.ok(tokens.includes('棉t') || tokens.includes('t恤') || tokens.includes('恤'))
  assert.ok(tokens.every((token) => token === token.toLowerCase()))
  assert.equal(new Set(tokens).size, tokens.length, 'no duplicate tokens')
})

test('search ranks a title match above a body-only match', () => {
  const result = searchProducts(products, '纯棉短袖多少钱')
  assert.equal(result.best.card.id, 'tee')
  assert.ok(result.confidence > 0.5)
  assert.ok(result.hits[0].matchedFields.includes('title'))
})

test('search finds the right product for an attribute query', () => {
  const cup = searchProducts(products, '杯子容量多大')
  assert.equal(cup.best?.card.id, 'cup')
  assert.equal(cup.hits.length >= 1, true)
})

test('empty query or empty catalog is handled', () => {
  assert.equal(searchProducts(products, '').best, null)
  assert.equal(searchProducts([], '纯棉').best, null)
})

test('intent detection picks the dominant intent', () => {
  assert.equal(detectIntent('多少钱一件').intent.id, 'price')
  assert.equal(detectIntent('什么时候发货').intent.id, 'shipping')
  assert.equal(detectIntent('能退货吗').intent.id, 'afterSales')
  assert.equal(detectIntent('有什么颜色尺码').intent.id, 'spec')
  assert.equal(detectIntent('你好').intent.id, 'general')
})

test('one message with two questions yields both intents', () => {
  const intents = detectIntents('这个多少钱，什么时候发货').map((item) => item.intent.id)
  assert.deepEqual(intents.sort(), ['price', 'shipping'])
})

test('a size question is a spec question, not a greeting', () => {
  assert.equal(detectIntent('纯棉短袖有 M 码吗').intent.id, 'spec')
  assert.equal(detectIntent('40码的有吗').intent.id, 'spec')
  assert.equal(detectIntent('XL码还有吗').intent.id, 'spec')
})

test('facts are gathered for every intent and a gap is still a gap', () => {
  const tee = products[0]
  const both = factsForIntents(tee, [{ id: 'price' }, { id: 'shipping' }])
  assert.deepEqual(both.missing, [])
  assert.ok(both.facts.some((fact) => fact.field === 'price'))
  assert.ok(both.facts.some((fact) => fact.field === 'shipping'))

  const cup = products.find((card) => card.id === 'cup')
  const partial = factsForIntents(cup, [{ id: 'price' }, { id: 'shipping' }])
  assert.deepEqual(partial.missing, ['shipping'])
})

test('factsForIntent reports missing fields instead of inventing them', () => {
  const tee = products[0]
  const price = factsForIntent(tee, { id: 'price' })
  assert.deepEqual(price.missing, [])
  assert.equal(price.facts[0].field, 'price')

  const cup = products.find((card) => card.id === 'cup')
  const shipping = factsForIntent(cup, { id: 'shipping' })
  assert.deepEqual(shipping.missing, ['shipping'])
  assert.equal(shipping.facts.length, 0)
})

test('normalizeProduct parses spreadsheet-style strings', () => {
  const card = normalizeProduct(
    {
      title: '测试商品',
      skus: 'S / 99 / 10\nM / 99 / 5',
      attrs: '材质:棉; 产地:杭州',
    },
    0,
  )
  assert.equal(card.skus.length, 2)
  assert.equal(card.skus[0].price, '99')
  assert.equal(card.attrs['材质'], '棉')
  assert.equal(card.attrs['产地'], '杭州')
})
