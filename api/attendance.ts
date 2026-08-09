import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from './_redis'

// ===== 出欠登録（日付ごと・全端末で共有）=====
// 休み(rests)＝従業員一覧から選択した人、追加要員(extras)＝自由入力（バイト等）。
// 出社人数の基準(base)はグローバル（既定16）。掲示板からも編集できるよう認証は必須にしない（社内運用データ）。
// 保存時に shipments:rev を +1 して、掲示板のポーリングが変更を検知できるようにする。
const REV_KEY = 'shipments:rev'
const BASE_KEY = 'attendance:base'
function keyFor(date: string) { return `attendance:${date}` }

function parseRec(raw: unknown): { rests: { id: string; name: string }[]; extras: string[] } {
  let obj: any = raw
  if (typeof raw === 'string') { try { obj = JSON.parse(raw) } catch { obj = null } }
  const rests = obj && Array.isArray(obj.rests)
    ? obj.rests.map((r: any) => ({ id: String(r?.id || ''), name: String(r?.name || '') })).filter((r: any) => r.name)
    : []
  const extras = obj && Array.isArray(obj.extras)
    ? obj.extras.map((x: any) => String(x || '').trim()).filter(Boolean)
    : []
  return { rests, extras }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const q = req.query
  const dateParam = Array.isArray(q.date) ? q.date[0] : q.date
  const date = String(dateParam || '')

  if (req.method === 'GET') {
    try {
      const rec = date ? parseRec(await redis.get(keyFor(date))) : { rests: [], extras: [] }
      const base = Number(await redis.get(BASE_KEY))
      return res.status(200).json({ date, rests: rec.rests, extras: rec.extras, base: (Number.isFinite(base) && base > 0) ? base : 16 })
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    if (!date) return res.status(400).json({ error: '日付が必要です' })
    try {
      const body: any = req.body || {}
      const rec = parseRec({ rests: body.rests, extras: body.extras })
      const tx = redis.multi()
      tx.set(keyFor(date), JSON.stringify(rec))
      if (body.base !== undefined) { const b = Math.max(0, parseInt(body.base, 10) || 0); tx.set(BASE_KEY, String(b)) }
      tx.incr(REV_KEY)   // 掲示板ポーリングへ変更通知
      await tx.exec()
      const base = Number(await redis.get(BASE_KEY))
      return res.status(200).json({ date, rests: rec.rests, extras: rec.extras, base: (Number.isFinite(base) && base > 0) ? base : 16 })
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
