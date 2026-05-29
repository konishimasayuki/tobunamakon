import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from './_redis'
import { requireAuth, hashPassword } from './_auth'
import type { User } from './_auth'
import { v4 as uuidv4 } from 'uuid'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })
  if (user.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' })

  const unameParam = req.query.username
  const username = Array.isArray(unameParam) ? unameParam[0] : unameParam
  const hasUsername = !!username

  // 一覧取得
  if (req.method === 'GET' && !hasUsername) {
    try {
      const usernames = await redis.smembers('users')
      const users = []
      for (const uname of usernames) {
        const u = await redis.hgetall<User>(`user:${uname}`)
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

  // 新規作成
  if (req.method === 'POST' && !hasUsername) {
    const { username: newUsername, password, displayName, role } = req.body
    if (!newUsername || !password || !role) {
      return res.status(400).json({ error: 'ユーザー名・パスワード・役職は必須です' })
    }
    try {
      const exists = await redis.exists(`user:${newUsername}`)
      if (exists) return res.status(400).json({ error: 'このユーザー名は既に使われています' })

      const passwordHash = await hashPassword(password)
      const now = new Date().toISOString()
      const newUser = { id: uuidv4(), username: newUsername, displayName: displayName || newUsername, passwordHash, role, createdAt: now }
      await redis.hset(`user:${newUsername}`, newUser)
      await redis.sadd('users', newUsername)

      const { passwordHash: _, ...safe } = newUser
      return res.status(201).json(safe)
    } catch (e) {
      return res.status(500).json({ error: 'サーバーエラーが発生しました' })
    }
  }

  // 削除
  if (req.method === 'DELETE' && hasUsername) {
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
