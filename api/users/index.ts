import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { requireAuth, hashPassword } from '../_auth'
import type { User } from '../_types'
import { v4 as uuidv4 } from 'uuid'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })
  if (user.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' })

  if (req.method === 'GET') {
    try {
      const usernames = await redis.smembers('users')
      const users = []
      for (const username of usernames) {
        const u = await redis.hgetall<User>(`user:${username}`)
        if (u) {
          const { passwordHash, ...safe } = u
          users.push(safe)
        }
      }
      users.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      return res.status(200).json(users)
    } catch (e) {
      return res.status(500).json({ error: 'サーバーエラーが発生しました' })
    }
  }

  if (req.method === 'POST') {
    const { username, password, displayName, role } = req.body
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'ユーザー名・パスワード・役職は必須です' })
    }
    try {
      const exists = await redis.exists(`user:${username}`)
      if (exists) return res.status(400).json({ error: 'このユーザー名は既に使われています' })

      const passwordHash = await hashPassword(password)
      const now = new Date().toISOString()
      const newUser = { id: uuidv4(), username, displayName: displayName || username, passwordHash, role, createdAt: now }
      await redis.hset(`user:${username}`, newUser)
      await redis.sadd('users', username)

      const { passwordHash: _, ...safe } = newUser
      return res.status(201).json(safe)
    } catch (e) {
      return res.status(500).json({ error: 'サーバーエラーが発生しました' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
