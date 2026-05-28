import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { requireAuth } from '../_auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })

  const { id } = req.query as { id: string }

  if (req.method === 'DELETE') {
    try {
      await redis.del(`shipment:${id}`)
      await redis.srem('shipments', id)
      return res.status(200).json({ message: '削除しました' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
