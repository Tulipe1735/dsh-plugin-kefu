/**
 * Product import.
 *
 * A shop already has its catalog in some spreadsheet or a JSON export; making
 * the merchant retype 300 products into a form is how these tools die. So we
 * accept the shapes people actually have: CSV/TSV exported from Excel, a JSON
 * array, or a Markdown table copied out of a product doc.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { normalizeProduct } from './kb.js'

export class IngestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'IngestError'
  }
}

/** Header aliases → canonical card keys. First match wins. */
const HEADER_ALIASES = [
  ['title', ['标题', '商品名称', '商品名', '名称', 'title', 'name', 'product', 'productname']],
  ['id', ['id', '商品id', '编号', '货号', '编码', 'sku_id', 'item_id']],
  ['price', ['价格', '售价', '单价', '到手价', 'price', 'sale_price']],
  ['skus', ['规格', 'sku', '规格表', '尺码表', 'skus', 'variants']],
  ['attrs', ['参数', '属性', '规格参数', '参数表', 'attrs', 'params', 'spec', 'specs']],
  ['shipping', ['发货', '物流', '快递', '运费', 'shipping', 'delivery']],
  ['afterSales', ['售后', '退换', '退货', '保修', 'after_sales', 'aftersales', 'warranty']],
  ['keywords', ['关键词', '标签', '关键字', 'keywords', 'tags']],
  ['aliases', ['别名', '同义词', '别称', 'aliases']],
  ['description', ['详情', '描述', '卖点', '简介', 'description', 'desc']],
  ['images', ['图片', '主图', '图', 'images', 'image']],
  ['videos', ['视频', 'videos', 'video']],
  ['stock', ['库存', '数量', 'stock', 'qty']],
]

function canonicalHeader(header) {
  const key = String(header ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/[()（）]/g, '')
  if (key === '') return null
  for (const [canonical, aliases] of HEADER_ALIASES) {
    if (aliases.includes(key)) return canonical
  }
  return null
}

/** RFC4180-ish CSV/TSV parser: quoted fields, escaped quotes, CRLF. */
export function parseDelimited(text, delimiter = ',') {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const source = String(text ?? '').replace(/^\uFEFF/, '')

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    if (char === '\r') continue
    field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''))
}

function rowsToObjects(rows) {
  if (rows.length === 0) return []
  const [headerRow, ...body] = rows
  const headers = headerRow.map(canonicalHeader)
  const objects = []
  for (const cells of body) {
    const object = {}
    headers.forEach((key, index) => {
      if (key === null) return
      const value = cells[index] ?? ''
      if (String(value).trim() === '') return
      object[key] = value
    })
    if (Object.keys(object).length > 0) objects.push(object)
  }
  return objects
}

/** Markdown table: "| a | b |" plus a dash separator row. */
export function parseMarkdownTable(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
  if (lines.length < 2) return []
  const split = (line) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
  const rows = lines.map(split)
  const separator = rows[1]
  if (!separator.every((cell) => /^:?-{2,}:?$/.test(cell))) return []
  return [rows[0], ...rows.slice(2)]
}

export function detectFormat(text, filename = '') {
  const ext = path.extname(String(filename)).toLowerCase()
  if (ext === '.json') return 'json'
  if (ext === '.tsv') return 'tsv'
  if (ext === '.csv') return 'csv'
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  const trimmed = String(text ?? '').trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json'
  if (/^\|.*\|/m.test(trimmed)) return 'markdown'
  if (/\t/.test(trimmed.split('\n')[0] ?? '')) return 'tsv'
  return 'csv'
}

/**
 * Turn arbitrary input text into raw product rows.
 *
 * Accepts a JSON array (or `{products: [...]}`), a delimited table, or a
 * Markdown table. Anything else raises a readable error rather than silently
 * importing zero products.
 */
export function parseProducts(text, { format, filename = '' } = {}) {
  const kind = format ?? detectFormat(text, filename)
  if (kind === 'json') {
    let parsed
    try {
      parsed = JSON.parse(String(text ?? ''))
    } catch (error) {
      throw new IngestError(`JSON 解析失败：${error.message}`)
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.products)
        ? parsed.products
        : Array.isArray(parsed?.items)
          ? parsed.items
          : parsed !== null && typeof parsed === 'object'
            ? [parsed]
            : []
    return rows.filter((row) => row !== null && typeof row === 'object')
  }
  if (kind === 'markdown') {
    const rows = parseMarkdownTable(text)
    if (rows.length === 0) throw new IngestError('没有识别到 Markdown 表格（需要表头 + |---|---| 分隔行）')
    return rowsToObjects(rows)
  }
  const delimiter = kind === 'tsv' ? '\t' : ','
  const rows = parseDelimited(text, delimiter)
  if (rows.length === 0) throw new IngestError('文件是空的')
  const objects = rowsToObjects(rows)
  if (objects.length === 0) {
    throw new IngestError('第一行需要表头（如：标题,价格,规格,参数,发货,售后），没有识别到任何商品行')
  }
  return objects
}

export async function parseProductsFile(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    throw new IngestError(`读取文件失败：${error.message}`)
  }
  return parseProducts(text, { filename: file })
}

/**
 * Merge freshly imported cards into the existing catalog.
 *
 * Re-importing is the normal case (the merchant changed a price), so a card
 * with the same id replaces the old one instead of duplicating it. IDs come
 * from the sheet when present, otherwise from the title.
 */
export function mergeProducts(existing, incoming, source = 'import') {
  const byId = new Map()
  for (const card of Array.isArray(existing) ? existing : []) {
    if (card && typeof card.id === 'string') byId.set(card.id, card)
  }
  const added = []
  const updated = []
  incoming.forEach((raw, index) => {
    const card = normalizeProduct(raw, index, source)
    if (byId.has(card.id)) updated.push(card.id)
    else added.push(card.id)
    const previous = byId.get(card.id)
    byId.set(card.id, previous ? { ...card, createdAt: previous.createdAt ?? Date.now() } : { ...card, createdAt: Date.now() })
  })
  return { products: [...byId.values()], added, updated }
}
