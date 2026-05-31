import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { redis } from './_redis'
import { requireAuth } from './_auth'

const SETTINGS_KEY = 'line:settings'
const USERS_KEY = 'line:users'
const GROUPS_KEY = 'line:groups'   // groupId(または roomId) → グループレコードJSON

// JWT_SECRET から導出した鍵で AES-256-GCM 暗号化（保存時に難読化）
const ENC_KEY = crypto.createHash('sha256').update(process.env.JWT_SECRET || 'change-this-secret').digest()
function enc(text: string): string {
  if (!text) return ''
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv)
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()])
  return `v1:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${data.toString('hex')}`
}
function dec(stored: string): string {
  if (!stored) return ''
  const s = String(stored)
  if (!s.startsWith('v1:')) return s // 旧・平文は後方互換でそのまま返す
  try {
    const [, ivh, tagh, datah] = s.split(':')
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivh, 'hex'))
    d.setAuthTag(Buffer.from(tagh, 'hex'))
    return Buffer.concat([d.update(Buffer.from(datah, 'hex')), d.final()]).toString('utf8')
  } catch { return '' }
}

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

// ===== グループID 取得・保存（line_groups 相当）=====
interface LineGroup {
  groupId: string
  sourceType: 'group' | 'room'
  status: 'active' | 'left'
  firstSeenAt: string
  lastSeenAt: string
  acquiredVia: 'join' | 'message'
}

async function getGroup(id: string): Promise<LineGroup | null> {
  try {
    const v = await redis.hget<LineGroup | string>(GROUPS_KEY, id)
    if (!v) return null
    return typeof v === 'string' ? (JSON.parse(v) as LineGroup) : (v as LineGroup)
  } catch {
    return null
  }
}

// upsert：未登録なら新規作成、登録済みなら last_seen_at 等を更新（冪等）
async function upsertGroup(
  id: string,
  sourceType: 'group' | 'room',
  via: 'join' | 'message',
): Promise<void> {
  const now = new Date().toISOString()
  const existing = await getGroup(id)
  const rec: LineGroup = existing
    ? {
        ...existing,
        sourceType,
        status: 'active',          // 再受信＝参加中に復帰
        lastSeenAt: now,
        // first_seen_at / acquired_via は初回値を維持（join を優先したいので message では上書きしない）
        acquiredVia: existing.acquiredVia || via,
      }
    : {
        groupId: id,
        sourceType,
        status: 'active',
        firstSeenAt: now,
        lastSeenAt: now,
        acquiredVia: via,
      }
  await redis.hset(GROUPS_KEY, { [id]: JSON.stringify(rec) })
}

// leave：該当グループを退出済みに
async function markGroupLeft(id: string): Promise<void> {
  const existing = await getGroup(id)
  const now = new Date().toISOString()
  const rec: LineGroup = existing
    ? { ...existing, status: 'left', lastSeenAt: now }
    : { groupId: id, sourceType: 'group', status: 'left', firstSeenAt: now, lastSeenAt: now, acquiredVia: 'join' }
  await redis.hset(GROUPS_KEY, { [id]: JSON.stringify(rec) })
}

// 返信（reply）：replyToken は1回限り・短時間で失効するため受信後すぐ使う
async function replyMessage(replyToken: string, text: string, token: string): Promise<void> {
  if (!replyToken || !token) return
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    })
  } catch (e) {
    console.error('reply failed', e)
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ===== アプリからのプッシュ送信（認証必須）。Webhookと区別するため action=push で判定 =====
  if (req.method === 'POST' && (req.body as any)?.action === 'push') {
    const user = requireAuth(req)
    if (!user) return res.status(401).json({ error: '認証が必要です' })
    const { lineUserIds, text } = (req.body || {}) as any
    const ids: string[] = Array.isArray(lineUserIds) ? lineUserIds.filter(Boolean) : []
    if (ids.length === 0) return res.status(400).json({ error: '送信先のLINEユーザーIDがありません' })
    const settings = (await redis.hgetall<Record<string, string>>(SETTINGS_KEY)) || {}
    const token = dec(settings.channelAccessToken || '')
    if (!token) return res.status(400).json({ error: 'LINEチャネルアクセストークンが未設定です（設定画面で登録してください）' })
    const message = String(text || '').trim() || 'テスト'
    const results: Array<{ to: string; ok: boolean; error?: string }> = []
    for (const to of ids) {
      try {
        const r = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ to, messages: [{ type: 'text', text: message }] }),
        })
        if (r.ok) results.push({ to, ok: true })
        else { const e = await r.text(); results.push({ to, ok: false, error: e.slice(0, 200) }) }
      } catch (e) {
        results.push({ to, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    const sent = results.filter(r => r.ok).length
    return res.status(200).json({ sent, total: ids.length, results })
  }

  // ===== LINE Webhook（LINEプラットフォームからのPOST・認証不要・常に200）=====
  if (req.method === 'POST') {
    try {
      const settings = (await redis.hgetall<Record<string, string>>(SETTINGS_KEY)) || {}
      const token = dec(settings.channelAccessToken || '')
      const events = (req.body && (req.body as any).events) || []
      for (const ev of events) {
        const srcType = ev?.source?.type   // 'user' | 'group' | 'room'

        // ===== グループ／複数人トーク：groupId / roomId を取得・記録 =====
        if (srcType === 'group' || srcType === 'room') {
          const gid: string | undefined = srcType === 'group' ? ev?.source?.groupId : ev?.source?.roomId
          if (!gid) continue
          const stype: 'group' | 'room' = srcType === 'group' ? 'group' : 'room'

          if (ev.type === 'join') {
            // F-1: 招待された瞬間に自動記録
            await upsertGroup(gid, stype, 'join')
            await replyMessage(ev.replyToken, `グループIDを登録しました。\n${gid}`, token)
          } else if (ev.type === 'leave') {
            // F-3: 退出・削除されたら status を left に
            await markGroupLeft(gid)
          } else if (ev.type === 'message') {
            // F-2: 未登録なら補完記録、登録済みなら last_seen_at 更新
            await upsertGroup(gid, stype, 'message')
            // F-4: 「ID」と送信されたら groupId を返信（確認用）
            const text = ev?.message?.type === 'text' ? String(ev.message.text || '').trim() : ''
            if (text === 'ID' || text === 'id' || text === 'ＩＤ') {
              await replyMessage(ev.replyToken, gid, token)
            }
          }
          continue   // グループ系イベントはここで完了（既存のユーザー処理に流さない）
        }

        // ===== 個人（user）：既存のフォロワー取得処理（変更しない）=====
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

    // グループ一覧（F-5）
    const groupsMap = (await redis.hgetall<Record<string, LineGroup | string>>(GROUPS_KEY)) || {}
    const groups = Object.values(groupsMap).map((v) => (typeof v === 'string' ? (JSON.parse(v) as LineGroup) : (v as LineGroup)))
    // active を上に、次に最終確認の新しい順
    groups.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1
      return String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))
    })

    return res.status(200).json({
      users,
      groups,
      activeGroupCount: groups.filter((g) => g.status === 'active').length,
      hasToken: !!settings.channelAccessToken,
      hasSecret: !!settings.channelSecret,
    })
  }

  if (req.method === 'PUT') {
    if (user.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' })
    const { channelAccessToken, channelSecret } = (req.body || {}) as any
    const cur = (await redis.hgetall<Record<string, string>>(SETTINGS_KEY)) || {}
    await redis.hset(SETTINGS_KEY, {
      channelAccessToken: channelAccessToken != null ? enc(channelAccessToken) : (cur.channelAccessToken || ''),
      channelSecret: channelSecret != null ? enc(channelSecret) : (cur.channelSecret || ''),
    })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const idParam = req.query.userId
    const userId = Array.isArray(idParam) ? idParam[0] : idParam
    if (userId) await redis.hdel(USERS_KEY, userId)
    const gidParam = req.query.groupId
    const groupId = Array.isArray(gidParam) ? gidParam[0] : gidParam
    if (groupId) await redis.hdel(GROUPS_KEY, groupId)
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
