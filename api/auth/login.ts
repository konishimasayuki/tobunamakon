import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { comparePassword, signToken } from '../_auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' })
  }

  try {
    const user = await redis.hgetall(`user:${username}`) as any
    if (!user || !user.id) return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' })

    const valid = await comparePassword(password, user.passwordHash)
    if (!valid) return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' })

    const token = signToken({ id: user.id, username: user.username, role: user.role })

    return res.status(200).json({
      token,
      user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
    })
  } catch (e) {
    return res.status(500).json({ error: 'サーバーエラーが発生しました' })
  }
}
