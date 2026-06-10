import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from './_redis'
import { requireAuth } from './_auth'

// 全データのバックアップ（エクスポート＝GET）／復元（インポート＝POST）。
// 復元は「追加・上書き（id単位のupsert）」で、今あるデータは消さない（誤って消える事故を防ぐ）。
// ※PDF本体（shipmentpdf:*）は容量が大きいためバックアップ対象外。

const INDEX_KEY = 'shipments:bydate'
function dateScore(d: any): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''))
  return m ? parseInt(m[1] + m[2] + m[3], 10) : 0
}

async function readAll(setKey: string, prefix: string): Promise<Record<string, any>[]> {
  const ids = (await redis.smembers(setKey)) || []
  if (!ids.length) return []
  const p = redis.pipeline()
  ids.forEach((id: string) => p.hgetall(`${prefix}:${id}`))
  const rows = (await p.exec<Record<string, any>[]>()) || []
  return rows.filter(r => r && Object.keys(r).length > 0)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })

  // エクスポート（全データ取得）
  if (req.method === 'GET') {
    try {
      const [shipments, customers, employees] = await Promise.all([
        readAll('shipments', 'shipment'),
        readAll('customers', 'customer'),
        readAll('employees', 'employee'),
      ])
      return res.status(200).json({
        app: 'tobunamakon',
        type: 'backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        counts: { shipments: shipments.length, customers: customers.length, employees: employees.length },
        shipments, customers, employees,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 復元（追加・上書き＝id単位のupsert。今あるデータは削除しない）
  if (req.method === 'POST') {
    try {
      const body: any = req.body || {}
      if (body.type && body.type !== 'backup') return res.status(400).json({ error: 'バックアップファイルではありません' })
      const result = { shipments: 0, customers: 0, employees: 0 }

      if (Array.isArray(body.customers)) {
        for (const c of body.customers) {
          if (!c || !c.id) continue
          await redis.hset(`customer:${c.id}`, c)
          await redis.sadd('customers', c.id)
          result.customers++
        }
      }
      if (Array.isArray(body.employees)) {
        for (const e of body.employees) {
          if (!e || !e.id) continue
          await redis.hset(`employee:${e.id}`, e)
          await redis.sadd('employees', e.id)
          result.employees++
        }
      }
      if (Array.isArray(body.shipments)) {
        for (const s of body.shipments) {
          if (!s || !s.id) continue
          await redis.hset(`shipment:${s.id}`, s)
          await redis.sadd('shipments', s.id)
          const sc = dateScore(s.date)
          if (sc) { try { await redis.zadd(INDEX_KEY, { score: sc, member: s.id }) } catch { /* 索引失敗は無視 */ } }
          result.shipments++
        }
      }
      return res.status(200).json({ restored: result })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
