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

// 返信（reply）に複数メッセージ（テキスト＋画像など）を送る
async function replyMessages(replyToken: string, messages: any[], token: string): Promise<void> {
  if (!replyToken || !token || !messages.length) return
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
    })
  } catch (e) {
    console.error('reply(multi) failed', e)
  }
}

// 端末（日本時間）基準の本日 YYYY-MM-DD
function todayJST(): string {
  const now = new Date(Date.now() + 9 * 3600 * 1000) // UTC+9
  return now.toISOString().slice(0, 10)
}

// 住所文字列から「緯度,経度」を取り出す（例: "... （緯度経度:33.1,130.2）" や "33.1, 130.2"）
function extractLatLng(s: string): { lat: number; lng: number } | null {
  const m = String(s || '').match(/(-?\d{1,3}\.\d{3,})\s*[,，]\s*(-?\d{1,3}\.\d{3,})/)
  if (!m) return null
  return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) }
}

// 出荷データから Google Static Maps の画像URLを作る（ピン＋矢印を線で描画）
function staticMapUrl(ship: any): string | null {
  const key = process.env.VITE_GMAPS_API_KEY || process.env.GMAPS_API_KEY || ''
  if (!key) return null
  const view = ship.mapView && typeof ship.mapView.lat === 'number' ? ship.mapView : null
  const coords = extractLatLng(ship.siteAddress || '')
  const center = view ? { lat: view.lat, lng: view.lng } : coords
  if (!center) return null
  const zoom = view ? Math.round(view.zoom || 18) : 17
  const params: string[] = [
    `size=640x400`, `scale=2`, `zoom=${zoom}`,
    `center=${center.lat},${center.lng}`,
    `markers=color:red%7C${center.lat},${center.lng}`,
    `language=ja`, `region=JP`, `key=${key}`,
  ]
  // 矢印（緯度経度2点）を赤い太線で描画
  const arrows = Array.isArray(ship.mapArrows) ? ship.mapArrows : []
  for (const a of arrows.slice(0, 10)) {
    if (typeof a.lat1 === 'number' && typeof a.lat2 === 'number') {
      params.push(`path=color:0xe8211cff%7Cweight:5%7C${a.lat1},${a.lng1}%7C${a.lat2},${a.lng2}`)
    }
  }
  return `https://maps.googleapis.com/maps/api/staticmap?${params.join('&')}`
}

// 出荷情報を読みやすいテキストに整形
function formatShipment(s: any): string {
  const times = Array.isArray(s.times) ? s.times.map((t: any) => (t && t.text != null ? t.text : t)).filter(Boolean) : []
  const drivers = Array.isArray(s.drivers) ? s.drivers.map((d: any) => d.name).filter(Boolean) : []
  const lines: string[] = []
  lines.push(`■ ${s.companyName || ''}${s.tradingCompany ? `（${s.tradingCompany}）` : ''}`)
  if (s.siteName) lines.push(`現場: ${s.siteName}`)
  if (times.length) lines.push(`時間: ${times.join(' / ')}`)
  if (s.vehicleType) lines.push(`車種: ${s.vehicleType}${s.truckCount ? ` ${s.truckCount}台` : ''}`)
  if (s.mixCode) lines.push(`配合: ${s.mixCode}`)
  if (s.volume) lines.push(`量: ${s.volume}m³${s.volumeUncertain ? '?' : ''}`)
  if (drivers.length) lines.push(`担当: ${drivers.join('、')}`)
  if (s.siteContact) lines.push(`現場連絡先: ${s.siteContact}`)
  return lines.join('\n')
}

// LINEユーザーIDから、本日の出荷情報の返信メッセージ配列を作る
async function buildGenbaReply(lineUserId: string): Promise<any[]> {
  // 顧客を全件読み、lineUserId が一致する顧客を特定
  const custIds = (await redis.smembers('customers')) || []
  let customer: any = null
  const want = String(lineUserId || '').trim()
  let withIdCount = 0
  let sampleKeys = ''
  let i = 0
  for (const cid of custIds) {
    const c = await redis.hgetall<Record<string, any>>(`customer:${cid}`)
    if (i === 0 && c) sampleKeys = Object.keys(c).join(',')
    i++
    const have = String((c && c.lineUserId) || '').trim()
    if (have) withIdCount++
    if (c && have && have === want) { customer = c; break }
  }
  if (!customer) {
    return [{ type: 'text', text: `お客様情報が見つかりませんでした。\n\n受信ID:\n${want}\n\n(顧客総数:${custIds.length} / LINE ID登録済:${withIdCount})\n先頭顧客の項目:\n${sampleKeys}` }]
  }
  // 本日 かつ この顧客の出荷を抽出
  const today = todayJST()
  const shipIds = (await redis.smembers('shipments')) || []
  const ships: any[] = []
  for (const sid of shipIds) {
    const s = await redis.hgetall<Record<string, any>>(`shipment:${sid}`)
    if (!s) continue
    if (String(s.date) !== today) continue
    if (s.companyId && customer.id && s.companyId === customer.id) ships.push(s)
    else if (String(s.companyName || '') === String(customer.companyName || '')) ships.push(s)
  }
  if (ships.length === 0) {
    return [{ type: 'text', text: `本日（${today}）の出荷予定はありません。` }]
  }
  // 時間順に
  const ft = (s: any) => Array.isArray(s.times) && s.times.length ? String(s.times[0]?.text ?? s.times[0] ?? '') : ''
  ships.sort((a, b) => ft(a).localeCompare(ft(b)))

  const messages: any[] = []
  messages.push({ type: 'text', text: `📋 本日（${today}）の出荷予定 ${ships.length}件` })
  for (const s of ships.slice(0, 2)) {   // reply上限5メッセージ。各現場=テキスト+地図で2枠使うので最大2件
    messages.push({ type: 'text', text: formatShipment(s) })
    const addr = String(s.siteAddress || '').replace(/（緯度経度:[^）]*）/g, '').trim()
    const mapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr || s.siteName || '')}`
    const img = staticMapUrl(s)
    if (img) {
      messages.push({ type: 'image', originalContentUrl: img, previewImageUrl: img })
    }
    // 住所＋地図リンクは直前のテキストに含めず別テキストにすると枠を食うため、最後にまとめない
  }
  return messages.slice(0, 5)
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

          // キーフレーズ「現場」→ そのユーザーに紐づく本日の出荷情報を返信
          if (ev.type === 'message' && ev?.message?.type === 'text') {
            const text = String(ev.message.text || '').trim()
            if (text === '現場' || text === 'げんば' || text === 'ゲンバ') {
              const messages = await buildGenbaReply(userId)
              await replyMessages(ev.replyToken, messages, token)
            }
          }
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
