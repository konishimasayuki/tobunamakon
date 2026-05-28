import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { hashPassword } from '../_auth'
import { v4 as uuidv4 } from 'uuid'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { setupKey, username, password, displayName } = req.body
  if (setupKey !== (process.env.SETUP_KEY || 'tobu-setup-2024')) {
    return res.status(403).json({ error: 'セットアップキーが違います' })
  }

  try {
    const existing = await redis.exists(`user:${username}`)
    if (existing) return res.status(400).json({ error: 'このユーザー名は既に使われています' })

    const passwordHash = await hashPassword(password)
    const now = new Date().toISOString()
    await redis.hset(`user:${username}`, {
      id: uuidv4(), username,
      displayName: displayName || username,
      passwordHash, role: 'admin', createdAt: now,
    })
    await redis.sadd('users', username)

    return res.status(201).json({ message: '管理者ユーザーを作成しました', username })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: 'サーバーエラーが発生しました' })
  }
}
