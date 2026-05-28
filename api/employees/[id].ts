import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { requireAuth } from '../_auth'
import type { Employee } from './index'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })

  const { id } = req.query as { id: string }

  if (req.method === 'PUT') {
    const { employeeId, name, lineId, type } = req.body
    if (!name) return res.status(400).json({ error: '氏名は必須です' })
    try {
      const existing = await redis.hgetall<Employee>(`employee:${id}`)
      if (!existing) return res.status(404).json({ error: '従業員が見つかりません' })
      const updated: Employee = {
        ...existing,
        employeeId: employeeId || '',
        name, lineId: lineId || '', type: type || 'office',
        updatedAt: new Date().toISOString(),
      }
      await redis.hset(`employee:${id}`, updated as unknown as Record<string, unknown>)
      return res.status(200).json(updated)
    } catch (e) {
      return res.status(500).json({ error: 'サーバーエラーが発生しました' })
    }
  }

  if (req.method === 'DELETE') {
    if (!['admin', 'manager'].includes(user.role)) {
      return res.status(403).json({ error: '削除権限がありません' })
    }
    try {
      await redis.del(`employee:${id}`)
      await redis.srem('employees', id)
      return res.status(200).json({ message: '削除しました' })
    } catch (e) {
      return res.status(500).json({ error: 'サーバーエラーが発生しました' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
