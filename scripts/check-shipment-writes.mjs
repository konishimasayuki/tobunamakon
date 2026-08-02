#!/usr/bin/env node
// 伝票（shipment）の書き込みは必ず saveShipmentHash / removeShipment を通す規約を機械的に守らせるチェック。
// これらのヘルパーは hset＋索引更新＋版番号INCR(shipments:rev) を MULTI で原子的に行う。
// 直接 redis.hset(`shipment:...`) 等を書く「ヘルパーを通さない新規経路」は版番号更新が漏れ、
// 掲示板（別ウィンドウ）のポーリングが変更を取りこぼす原因になるため、CIで検出して不合格にする。
//
// 使い方: node scripts/check-shipment-writes.mjs
import { readFileSync } from 'node:fs'

const FILE = 'api/shipments.ts'

// 禁止パターン（コード行のみ対象。コメント行は除外）。
// いずれも「ヘルパー内はパイプライン変数(tx./p./zp.)経由」なので redis. 直呼びのみが引っかかる。
const RULES = [
  { re: /redis\.hset\(\s*[`'"]shipment:/, msg: '伝票ハッシュへの直接 hset は禁止。saveShipmentHash() を使ってください。' },
  { re: /redis\.del\(\s*[`'"]shipment:/, msg: '伝票ハッシュの直接 del は禁止。removeShipment() を使ってください。' },
  { re: /redis\.sadd\(\s*[`'"]shipments[`'"]/, msg: "'shipments' 集合への直接 sadd は禁止。saveShipmentHash() を使ってください。" },
  { re: /redis\.(srem|zrem)\(\s*[`'"A-Za-z_]/, msg: '伝票集合/索引の直接 srem/zrem は禁止。removeShipment() を使ってください。' },
  { re: /redis\.zadd\(\s*INDEX_KEY/, msg: '索引への直接 zadd は禁止。saveShipmentHash() を使ってください。' },
]

let src
try { src = readFileSync(FILE, 'utf8') } catch (e) { console.error(`読み込めません: ${FILE}: ${e.message}`); process.exit(2) }

const lines = src.split('\n')
const violations = []
lines.forEach((line, i) => {
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return   // コメント行は対象外
  for (const rule of RULES) {
    if (rule.re.test(line)) violations.push({ line: i + 1, text: t, msg: rule.msg })
  }
})

if (violations.length) {
  console.error('✗ 伝票書き込み規約 違反が見つかりました（saveShipmentHash / removeShipment を通してください）:\n')
  for (const v of violations) {
    console.error(`  ${FILE}:${v.line}`)
    console.error(`    ${v.text}`)
    console.error(`    → ${v.msg}\n`)
  }
  process.exit(1)
}

console.log('✓ 伝票書き込み規約チェック OK（すべて saveShipmentHash / removeShipment 経由）')
