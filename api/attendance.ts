import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from './_redis'

// ===== 出欠登録（日付ごと・全端末で共有）=====
// 休み(rests)＝従業員一覧から選択した人、追加要員(extras)＝自由入力（バイト等）。
// 出社人数の基準(base)はグローバル（既定16）。掲示板からも編集できるよう認証は必須にしない（社内運用データ）。
// 保存時に shipments:rev を +1 して、掲示板のポーリングが変更を検知できるようにする。
const REV_KEY = 'shipments:rev'
const BASE_KEY = 'attendance:base'
function keyFor(date: string) { return `attendance:${date}` }

// 各項目の正規化（部分更新でも同じ規則で揃える）
function normRests(v: any): { id: string; name: string }[] {
  return Array.isArray(v)
    ? v.map((r: any) => ({ id: String(r?.id || ''), name: String(r?.name || '') })).filter((r: any) => r.name)
    : []
}
function normExtras(v: any): string[] {
  return Array.isArray(v) ? v.map((x: any) => String(x || '').trim()).filter(Boolean) : []
}
// 出荷予定表ヘッダの自由記述メモ（1行・日付ごと）。改行は潰し、長さを制限する。
function normNote(v: any): string {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200)
}

function parseRec(raw: unknown): { rests: { id: string; name: string }[]; extras: string[]; note: string } {
  let obj: any = raw
  if (typeof raw === 'string') { try { obj = JSON.parse(raw) } catch { obj = null } }
  return {
    rests: normRests(obj && obj.rests),
    extras: normExtras(obj && obj.extras),
    note: (obj && typeof obj.note === 'string') ? normNote(obj.note) : '',
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const q = req.query
  const dateParam = Array.isArray(q.date) ? q.date[0] : q.date
  const date = String(dateParam || '')

  if (req.method === 'GET') {
    try {
      const rec = date ? parseRec(await redis.get(keyFor(date))) : { rests: [], extras: [], note: '' }
      const base = Number(await redis.get(BASE_KEY))
      return res.status(200).json({ date, rests: rec.rests, extras: rec.extras, note: rec.note, base: (Number.isFinite(base) && base > 0) ? base : 16 })
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    if (!date) return res.status(400).json({ error: '日付が必要です' })
    try {
      const body: any = req.body || {}
      // 部分更新：送られてきた項目だけ差し替え、未指定は既存を保持する。
      // （出欠の保存でメモが消える／メモの保存で休みが消える、といった事故を防ぐ）
      const cur = parseRec(await redis.get(keyFor(date)))
      const rec = {
        rests:  body.rests  !== undefined ? normRests(body.rests)   : cur.rests,
        extras: body.extras !== undefined ? normExtras(body.extras) : cur.extras,
        note:   body.note   !== undefined ? normNote(body.note)     : cur.note,
      }
      const tx = redis.multi()
      tx.set(keyFor(date), JSON.stringify(rec))
      if (body.base !== undefined) { const b = Math.max(0, parseInt(body.base, 10) || 0); tx.set(BASE_KEY, String(b)) }
      tx.incr(REV_KEY)   // 掲示板ポーリングへ変更通知
      await tx.exec()
      const base = Number(await redis.get(BASE_KEY))
      return res.status(200).json({ date, rests: rec.rests, extras: rec.extras, note: rec.note, base: (Number.isFinite(base) && base > 0) ? base : 16 })
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
