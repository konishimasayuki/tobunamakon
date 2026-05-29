import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from './_redis'
import { requireAuth } from './_auth'

const SETTINGS_KEY = 'line:settings'
const USERS_KEY = 'line:users'

async function fetchProfile(userId: string, token: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return null
    const j: any = await r.json()
    return j.displayName || null
  } catch {
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ===== LINE Webhook（LINEプラットフォームからのPOST・認証不要・常に200）=====
  if (req.method === 'POST') {
    try {
      const settings = (await redis.hgetall<Record<string, string>>(SETTINGS_KEY)) || {}
      const token = settings.channelAccessToken || ''
      const events = (req.body && (req.body as any).events) || []
      for (const ev of events) {
        const userId = ev?.source?.userId
        if (!userId) continue
        if (ev.type === 'unfollow') {
          await redis.hdel(USERS_KEY, userId)
        } else if (ev.type === 'follow' || ev.type === 'message') {
          let name = String(userId)
          if (token) { const p = await fetchProfile(userId, token); if (p) name = p }
          await redis.hset(USERS_KEY, { [userId]: name })
        }
      }
    } catch (e) {
      console.error(e)
    }
    return res.status(200).json({ ok: true })
  }

  // ===== 管理画面用（認証必須）=====
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })

  if (req.method === 'GET') {
    const settings = (await redis.hgetall<Record<string, string>>(SETTINGS_KEY)) || {}
    const usersMap = (await redis.hgetall<Record<string, string>>(USERS_KEY)) || {}
    const users = Object.entries(usersMap).map(([userId, name]) => ({ userId, name: String(name) }))
    users.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    return res.status(200).json({ users, hasToken: !!settings.channelAccessToken, hasSecret: !!settings.channelSecret })
  }

  if (req.method === 'PUT') {
    if (user.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' })
    const { channelAccessToken, channelSecret } = (req.body || {}) as any
    const cur = (await redis.hgetall<Record<string, string>>(SETTINGS_KEY)) || {}
    await redis.hset(SETTINGS_KEY, {
      channelAccessToken: channelAccessToken != null ? channelAccessToken : (cur.channelAccessToken || ''),
      channelSecret: channelSecret != null ? channelSecret : (cur.channelSecret || ''),
    })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const idParam = req.query.userId
    const userId = Array.isArray(idParam) ? idParam[0] : idParam
    if (userId) await redis.hdel(USERS_KEY, userId)
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
