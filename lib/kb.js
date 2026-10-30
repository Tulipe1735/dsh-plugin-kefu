/**
 * The product knowledge base.
 *
 * A card is one sellable product the shop already described on its own store
 * page: title, price, SKU table, spec table, shipping and after-sales copy.
 * Retrieval is deliberately lexical and explainable — every answer must be
 * traceable to a field the merchant wrote, because the whole point of this
 * plugin is that the bot never invents product facts.
 */

export const INTENTS = {
  price: {
    id: 'price',
    label: '价格',
    fields: ['price', 'skus'],
    patterns: [/多少钱|价格|几块|售价|报个?价|优惠|便宜|打折|折扣|活动价|到手价|包邮吗/],
  },
  spec: {
    id: 'spec',
    label: '规格参数',
    fields: ['attrs', 'skus'],
    patterns: [
      /规格|参数|尺寸|尺码|材质|面料|颜色|型号|多大|多少寸|几寸|容量|重量|克重|厚度|成分|配置|标准|版型|适用/,
      // Size codes are written as "M 码" / "XL码" / "40码"; without this a
      // buyer asking for a size looks like a greeting and gets the wrong facts.
      // `\b` is useless here: CJK characters are not ASCII word characters.
      /(?:xxxs|xxs|xs|xl|xxl|xxxl|s|m|l)\s*码/i,
      /\d{2,3}\s*码/,
      /码数|鞋码|哪个码/,
    ],
  },
  stock: {
    id: 'stock',
    label: '库存',
    fields: ['skus', 'stock'],
    patterns: [/有货|库存|还有吗|有没有货|缺货|现货|补货|卖完|在售|能拍吗/],
  },
  shipping: {
    id: 'shipping',
    label: '发货物流',
    fields: ['shipping'],
    patterns: [/发货|快递|物流|包邮|运费|几天到|多久到|什么时候到|顺丰|中通|圆通|韵达|京东物流|送上门|偏远/],
  },
  afterSales: {
    id: 'afterSales',
    label: '售后',
    fields: ['afterSales'],
    patterns: [/退货|退款|换货|保修|质保|售后|发票|开发票|不开票|七天|无理由|质量问题|维修|保价/],
  },
  general: {
    id: 'general',
    label: '商品咨询',
    fields: ['title', 'attrs', 'skus', 'price', 'shipping'],
    patterns: [],
  },
}

const FIELD_WEIGHT = {
  title: 6,
  aliases: 5,
  keywords: 4,
  attrs: 3,
  skus: 3,
  price: 3,
  shipping: 2,
  afterSales: 2,
  body: 1,
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

/**
 * Interrogatives and filler that carry no product meaning.
 *
 * Without this filter, 「这个纯棉短袖多少钱」 scores its coverage against
 * 「这个」「多少」「少钱」 and lands below the auto-reply threshold even though
 * the shop's title matches perfectly. Stopwords are removed from the *query*
 * only; the index keeps every term.
 */
const STOPWORDS = new Set([
  '这个', '那个', '这款', '那款', '这些', '那些', '你们', '我们', '他们', '它们',
  '多少', '少钱', '多少钱', '什么', '什么时候', '怎么', '怎样', '如何', '哪个', '哪里',
  '可以', '能不能', '能不', '不能', '有没有', '有没', '没有', '是不是', '是不', '不是',
  '一下', '请问', '谢谢', '你好', '您好', '在吗', '在不在', '时候', '想问', '咨询',
  '问题', '帮我', '麻烦', '就是', '还有', '一般', '现在', '知道', '告诉', '需要',
  '想要', '一个', '不要', '能买', '买的', '了吗', '吗', '呢', '啊', '呀', '吧',
  '和', '跟', '的', '了', '是', '有', '我', '你', '他', '她', '就', '也', '还', '都', '请问',
])

export function filterStopwords(tokens) {
  const kept = tokens.filter((token) => !STOPWORDS.has(token))
  // A query made only of filler still has to search for something.
  return kept.length > 0 ? kept : tokens
}

/** Render one SKU row the way a shop assistant would say it. */
export function formatSku(sku) {
  const price = sku.price ? ` ${sku.price}` : ''
  const stock = sku.stock ? `（${sku.stock}）` : ''
  return `${sku.name}${price}${stock}`
}

/**
 * Tokenise mixed Chinese/English text into searchable terms.
 *
 * Chinese has no spaces, so we emit adjacent bigrams (「纯棉」「棉短」) plus the
 * single characters for one-character queries. Latin text becomes lowercase
 * words. Duplicates are dropped: a term that appears twice in a query should
 * not double its weight.
 */
export function tokenize(text) {
  const raw = String(text ?? '').toLowerCase().normalize('NFKC')
  const tokens = new Set()
  const latin = raw.match(/[a-z0-9][a-z0-9._-]*/g) ?? []
  for (const word of latin) {
    if (word.length >= 2) tokens.add(word)
  }
  const cjkRuns = raw.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2))
    // Keep the whole short phrase too: 「最新款」 should outrank a stray 「最新」.
    if (run.length <= 6) tokens.add(run)
  }
  return [...tokens]
}

export function isCjk(text) {
  return CJK.test(String(text ?? ''))
}

function cleanText(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/\r\n?/g, '\n').trim()
}

function cleanList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean)
  if (typeof value !== 'string') return []
  return value
    .split(/[,，;；|\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function cleanSkus(value) {
  const rows = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? value.split(/\n|;|；/).map((line) => line.trim()).filter(Boolean)
      : []
  return rows
    .map((row, index) => {
      if (typeof row === 'string') {
        // "S 码 / 129 / 12 件" style spreadsheet cells.
        const parts = row.split(/\s*[/／|]\s*/).filter(Boolean)
        return {
          name: cleanText(parts[0]) || `规格 ${index + 1}`,
          price: cleanText(parts[1]),
          stock: cleanText(parts[2]),
        }
      }
      return {
        name: cleanText(row?.name ?? row?.spec ?? row?.规格 ?? row?.sku) || `规格 ${index + 1}`,
        price: cleanText(row?.price ?? row?.价格 ?? row?.售价),
        stock: cleanText(row?.stock ?? row?.库存 ?? row?.数量),
      }
    })
    .filter((sku) => sku.name !== '')
}

function cleanAttrs(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const name = cleanText(key)
      const text = cleanText(item)
      if (name && text) out[name] = text
    }
    return out
  }
  if (typeof value === 'string' && value.trim() !== '') {
    // "材质:纯棉; 产地:杭州" or "材质 纯棉 / 产地 杭州"
    const out = {}
    for (const pair of value.split(/[;；\n]/)) {
      const match = pair.match(/^\s*([^:：=/／]+?)\s*[:：=/／]\s*(.+?)\s*$/)
      if (match) out[cleanText(match[1])] = cleanText(match[2])
    }
    return out
  }
  return {}
}

export function slugify(text, fallback = 'item') {
  const base = cleanText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base === '' ? fallback : base
}

/** Normalise one raw row (CSV/JSON/manual) into a stable product card. */
export function normalizeProduct(raw, index = 0, source = 'manual') {
  const card = {
    id: cleanText(raw?.id) || `${slugify(raw?.title ?? raw?.name, `item-${index + 1}`)}-${index + 1}`,
    title: cleanText(raw?.title ?? raw?.name ?? raw?.商品名称 ?? raw?.标题),
    aliases: cleanList(raw?.aliases ?? raw?.别名 ?? raw?.同义词),
    price: cleanText(raw?.price ?? raw?.价格 ?? raw?.售价),
    skus: cleanSkus(raw?.skus ?? raw?.sku ?? raw?.规格),
    attrs: cleanAttrs(raw?.attrs ?? raw?.params ?? raw?.参数 ?? raw?.属性),
    shipping: cleanText(raw?.shipping ?? raw?.发货 ?? raw?.物流 ?? raw?.快递),
    afterSales: cleanText(raw?.afterSales ?? raw?.after_sales ?? raw?.售后 ?? raw?.退换),
    keywords: cleanList(raw?.keywords ?? raw?.关键词 ?? raw?.tags ?? raw?.标签),
    description: cleanText(raw?.description ?? raw?.desc ?? raw?.详情 ?? raw?.卖点),
    images: cleanList(raw?.images ?? raw?.图片 ?? raw?.图),
    videos: cleanList(raw?.videos ?? raw?.视频),
    stock: cleanText(raw?.stock ?? raw?.库存),
    source,
    updatedAt: Date.now(),
  }
  if (card.title === '') card.title = card.aliases[0] ?? `商品 ${index + 1}`
  return card
}

/** All searchable text of a card, bucketed by field for weighted scoring. */
function fieldBuckets(card) {
  const attrs = Object.entries(card.attrs)
    .map(([key, value]) => `${key} ${value}`)
    .join(' ')
  const skus = card.skus.map((sku) => `${sku.name} ${sku.price} ${sku.stock}`).join(' ')
  return {
    title: card.title,
    aliases: card.aliases.join(' '),
    keywords: card.keywords.join(' '),
    attrs,
    skus,
    price: card.price,
    shipping: card.shipping,
    afterSales: card.afterSales,
    body: card.description,
  }
}

export function cardText(card) {
  const buckets = fieldBuckets(card)
  return Object.values(buckets).join(' ')
}

/**
 * Score every card against a query and return the best matches.
 *
 * IDF keeps generic vocabulary (「款」「商品」) from washing out the specific
 * terms; field weights make a title hit beat a description hit.
 */
export function searchProducts(products, query, options = {}) {
  const limit = Math.max(1, Math.min(20, options.limit ?? 5))
  const tokens = filterStopwords(tokenize(query))
  const cards = Array.isArray(products) ? products : []
  if (tokens.length === 0 || cards.length === 0) {
    return { query: String(query ?? ''), tokens, hits: [], confidence: 0, best: null }
  }

  const buckets = cards.map((card) => {
    const fields = fieldBuckets(card)
    const tokenSet = new Set(tokenize(Object.values(fields).join(' ')))
    return { card, fields, tokenSet }
  })

  const docFreq = new Map()
  for (const entry of buckets) {
    for (const token of entry.tokenSet) docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
  }
  const total = buckets.length
  const idfOf = (token) => Math.log(1 + total / (1 + (docFreq.get(token) ?? 0)))

  const scored = []
  for (const entry of buckets) {
    let score = 0
    const matched = []
    const matchedFields = new Set()
    for (const token of tokens) {
      const idf = idfOf(token)
      let hitWeight = 0
      for (const [field, text] of Object.entries(entry.fields)) {
        if (text === '') continue
        if (text.toLowerCase().includes(token)) {
          hitWeight += FIELD_WEIGHT[field] ?? 1
          matchedFields.add(field)
        }
      }
      if (hitWeight > 0) {
        score += idf * hitWeight
        matched.push(token)
      }
    }
    if (score > 0) {
      const coverage = matched.length / tokens.length
      scored.push({
        id: entry.card.id,
        card: entry.card,
        score: Number(score.toFixed(3)),
        coverage: Number(coverage.toFixed(3)),
        matchedTokens: matched,
        matchedFields: [...matchedFields],
        evidence: evidenceFor(entry.card, matchedFields),
      })
    }
  }

  scored.sort((a, b) => b.score - a.score || b.coverage - a.coverage)
  const hits = scored.slice(0, limit).map((hit) => ({ ...hit, confidence: confidenceOf(hit) }))
  const best = hits[0] ?? null
  return {
    query: String(query ?? ''),
    tokens,
    hits,
    best,
    confidence: best?.confidence ?? 0,
  }
}

/**
 * Confidence in [0,1]: how much of the query the card explains, tempered by
 * whether the hit is specific (title/alias/keyword) or incidental (body text).
 */
function confidenceOf(hit) {
  const strong = hit.matchedFields.some((field) => FIELD_WEIGHT[field] >= 4)
  const strength = Math.min(1, hit.score / 10)
  const base = hit.coverage * 0.7 + strength * 0.3
  return Number(Math.min(1, strong ? base + 0.08 : base).toFixed(3))
}

function evidenceFor(card, matchedFields) {
  const evidence = []
  if (matchedFields.has('title')) evidence.push({ field: 'title', label: '商品名', value: card.title })
  // Once the card itself is identified, every field that can answer a question
  // is evidence: the model needs the full card, not only the matched bucket.
  const identified = ['title', 'aliases', 'keywords'].some((field) => matchedFields.has(field))
  if (identified || matchedFields.has('price') || matchedFields.has('skus')) {
    if (card.price) evidence.push({ field: 'price', label: '价格', value: card.price })
    if (card.skus.length > 0) {
      evidence.push({
        field: 'skus',
        label: '规格表',
        value: card.skus.map(formatSku).join('；'),
      })
    }
  }
  if (identified || matchedFields.has('attrs')) {
    const value = Object.entries(card.attrs)
      .map(([key, item]) => `${key}：${item}`)
      .join('；')
    if (value) evidence.push({ field: 'attrs', label: '参数表', value })
  }
  if (identified || matchedFields.has('shipping')) {
    if (card.shipping) evidence.push({ field: 'shipping', label: '发货', value: card.shipping })
  }
  if (identified || matchedFields.has('afterSales')) {
    if (card.afterSales) evidence.push({ field: 'afterSales', label: '售后', value: card.afterSales })
  }
  return evidence
}

/**
 * Classify a buyer message into one of {@link INTENTS}.
 *
 * One message often asks two things (「多少钱，什么时候发货」); the caller uses
 * {@link detectIntents} and answers both instead of silently dropping half.
 */
export function detectIntents(text) {
  const message = String(text ?? '')
  const scored = []
  for (const intent of Object.values(INTENTS)) {
    if (intent.id === 'general') continue
    let score = 0
    for (const pattern of intent.patterns) {
      const match = message.match(pattern)
      if (match) score += match[0].length
    }
    if (score > 0) scored.push({ intent, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}

/** Classify a buyer message into one of {@link INTENTS}. */
export function detectIntent(text) {
  const [first] = detectIntents(text)
  return { intent: first?.intent ?? INTENTS.general, matchedChars: first?.score ?? 0 }
}

/**
 * Pull the fields that answer an intent. Missing fields are reported back so
 * the caller can escalate instead of guessing.
 */
export function factsForIntent(card, intent, detected = {}) {
  const facts = []
  const missing = []
  if (!card) return { facts, missing: ['product'] }

  const wantsSkus = intent.id === 'price' || intent.id === 'spec' || intent.id === 'stock'
  if (intent.id === 'price') {
    if (card.price) facts.push({ field: 'price', label: '价格', value: card.price })
    // Only mention the SKU table when it actually differs from the headline
    // price; otherwise the reply reads like a spreadsheet dump.
    const skuPrices = card.skus.filter((sku) => sku.price)
    const differs = skuPrices.some((sku) => sku.price !== card.price)
    if (skuPrices.length > 0 && (differs || !card.price)) {
      facts.push({
        field: 'skus',
        label: '规格价格',
        value: skuPrices.map((sku) => `${sku.name} ${sku.price}`).join('；'),
      })
    }
    if (!card.price && skuPrices.length === 0) missing.push('price')
  }

  if (intent.id === 'spec') {
    const attrs = Object.entries(card.attrs)
    if (attrs.length > 0) {
      facts.push({
        field: 'attrs',
        label: '参数',
        value: attrs.map(([key, value]) => `${key}：${value}`).join('；'),
      })
    }
    if (card.skus.length > 0) {
      facts.push({
        field: 'skus',
        label: '规格',
        value: card.skus.map((sku) => sku.name).join(' / '),
      })
    }
    if (attrs.length === 0 && card.skus.length === 0) missing.push('attrs')
  }

  if (intent.id === 'stock') {
    if (card.skus.some((sku) => sku.stock)) {
      facts.push({
        field: 'skus',
        label: '库存',
        value: card.skus
          .filter((sku) => sku.stock)
          .map((sku) => `${sku.name} ${sku.stock}`)
          .join('；'),
      })
    } else if (card.stock) {
      facts.push({ field: 'stock', label: '库存', value: card.stock })
    } else {
      missing.push('stock')
    }
  }

  if (intent.id === 'shipping') {
    if (card.shipping) facts.push({ field: 'shipping', label: '发货', value: card.shipping })
    else missing.push('shipping')
  }

  if (intent.id === 'afterSales') {
    if (card.afterSales) facts.push({ field: 'afterSales', label: '售后', value: card.afterSales })
    else missing.push('afterSales')
  }

  if (intent.id === 'general' && facts.length === 0) {
    if (card.title) facts.push({ field: 'title', label: '商品', value: card.title })
    if (card.price || card.skus.length > 0) {
      facts.push({
        field: 'price',
        label: '价格',
        value: card.price || card.skus.map((sku) => `${sku.name} ${sku.price}`).join('；'),
      })
    }
    if (card.skus.length > 0) {
      facts.push({ field: 'skus', label: '规格', value: card.skus.map((sku) => sku.name).join(' / ') })
    }
    if (Object.keys(card.attrs).length > 0) {
      facts.push({
        field: 'attrs',
        label: '参数',
        value: Object.entries(card.attrs)
          .slice(0, 4)
          .map(([key, value]) => `${key}：${value}`)
          .join('；'),
      })
    }
  }

  if (wantsSkus && card.skus.length === 0 && intent.id !== 'price') missing.push('skus')
  return { facts, missing: [...new Set(missing)] }
}

/**
 * Gather facts for every intent in one message, de-duplicated by field+value.
 *
 * A question the catalog cannot answer must not become a half-answer: the
 * caller escalates when `missing` is non-empty, even if the other half was
 * answerable.
 */
export function factsForIntents(card, intents) {
  const list = Array.isArray(intents) && intents.length > 0 ? intents : [INTENTS.general]
  const facts = []
  const missing = []
  const seen = new Set()
  for (const intent of list) {
    const result = factsForIntent(card, intent)
    for (const fact of result.facts) {
      const key = `${fact.field}\u0000${fact.value}`
      if (seen.has(key)) continue
      seen.add(key)
      facts.push({ ...fact, intent: intent.id })
    }
    missing.push(...result.missing)
  }
  return { facts, missing: [...new Set(missing)] }
}
