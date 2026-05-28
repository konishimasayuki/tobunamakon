import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { requireAuth } from '../_auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })
  if (user.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' })

  const { username } = req.query as { username: string }

  if (req.method === 'DELETE') {
    if (username === user.username) return res.status(400).json({ error: '自分自身は削除できません' })
    try {
      await redis.del(`user:${username}`)
      await redis.srem('users', username)
      return res.status(200).json({ message: '削除しました' })
    } catch (e) {
      return res.status(500).json({ error: 'サーバーエラーが発生しました' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
