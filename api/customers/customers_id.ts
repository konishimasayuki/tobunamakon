import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { requireAuth } from '../_auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })

  const { id } = req.query as { id: string }

  if (req.method === 'PUT') {
    const { customerCode, companyName, companyNameKana, phone, address, contactPerson, memo } = req.body
    if (!companyName) return res.status(400).json({ error: '会社名は必須です' })
    try {
      const existing = await redis.hgetall(`customer:${id}`)
      if (!existing || Object.keys(existing).length === 0) return res.status(404).json({ error: '顧客が見つかりません' })
      const updated = {
        ...existing,
        customerCode:    customerCode    || '',
        companyName,
        companyNameKana: companyNameKana || '',
        phone:           phone           || '',
        address:         address         || '',
        contactPerson:   contactPerson   || '',
        memo:            memo            || '',
        updatedAt: new Date().toISOString(),
      }
      await redis.hset(`customer:${id}`, updated)
      return res.status(200).json(updated)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  if (req.method === 'DELETE') {
    try {
      await redis.del(`customer:${id}`)
      await redis.srem('customers', id)
      return res.status(200).json({ message: '削除しました' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
