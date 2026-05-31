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

// hgetall で文字列化されている場合があるオブジェクト/配列を安全にパース
function asObj(v: any): any {
  if (v == null) return null
  if (typeof v === 'string') { try { return JSON.parse(v) } catch { return null } }
  return v
}
function asArr(v: any): any[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] } }
  return []
}

// 出荷データから Google Static Maps の画像URLを作る（ピン＋矢印を線で描画）
function staticMapUrl(ship: any): string | null {
  const key = process.env.GMAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GMAPS_API_KEY || ''
  if (!key) return null
  const view = asObj(ship.mapView)
  const hasView = view && typeof view.lat === 'number'
  const coords = extractLatLng(ship.siteAddress || '')
  // 中心: 固定ビュー > 住所内座標 > 住所文字列（Static Mapsは住所も中心に使える）
  const addrText = String(ship.siteAddress || '').replace(/（緯度経度:[^）]*）/g, '').trim()
  let center: string | null = null
  if (hasView) center = `${view.lat},${view.lng}`
  else if (coords) center = `${coords.lat},${coords.lng}`
  else if (addrText) center = encodeURIComponent(addrText)
  if (!center) return null
  const zoom = hasView ? Math.round(view.zoom || 18) : 17
  const params: string[] = [
    `size=600x400`, `scale=2`, `zoom=${zoom}`,
    `center=${center}`,
    `markers=color:red%7C${center}`,
    `language=ja`, `region=JP`, `maptype=roadmap`, `key=${key}`,
  ]
  // 矢印（緯度経度2点）を赤い太線＋終点に矢じり(V字)で描画
  const arrows = asArr(ship.mapArrows)
  for (const a of arrows.slice(0, 8)) {
    if (a && typeof a.lat1 === 'number' && typeof a.lat2 === 'number') {
      const { lat1, lng1, lat2, lng2 } = a
      // 本体の線
      params.push(`path=color:0xe8211cff%7Cweight:5%7C${lat1},${lng1}%7C${lat2},${lng2}`)
      // 矢じり：終点(lat2,lng2)で、線の向きから左右に短い線を2本引く
      const latRad = (lat2 * Math.PI) / 180
      // 経度差は緯度で縮むので cos 補正して角度を計算
      const dx = (lng2 - lng1) * Math.cos(latRad)
      const dy = lat2 - lat1
      const ang = Math.atan2(dy, dx)
      // 線の全長の15%（最小・最大でクランプ）を矢じりの長さに
      const len = Math.hypot(dx, dy)
      const head = Math.min(Math.max(len * 0.18, 0.00015), 0.0015)
      const spread = Math.PI / 7   // 矢じりの開き角
      for (const s of [ang + Math.PI - spread, ang + Math.PI + spread]) {
        const hLat = lat2 + head * Math.sin(s)
        const hLng = lng2 + (head * Math.cos(s)) / Math.cos(latRad)
        params.push(`path=color:0xe8211cff%7Cweight:5%7C${lat2},${lng2}%7C${hLat},${hLng}`)
      }
    }
  }
  return `https://maps.googleapis.com/maps/api/staticmap?${params.join('&')}`
}

// 出荷情報を読みやすいテキストに整形（フォールバック用）
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

// 現場住所のGoogleマップURL（住所がURLならそのまま、テキストなら検索URL）
function mapsUrlOf(s: any): string {
  const addr = String(s.siteAddress || '').replace(/（緯度経度:[^）]*）/g, '').trim()
  if (!addr) return ''
  return /^https?:\/\//.test(addr) ? addr : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`
}

// 出荷1件を「伝票風」の Flex バブルにする（出荷登録フォームの全項目を反映）
function shipmentBubble(s: any): any {
  const times = Array.isArray(s.times) ? s.times.map((t: any) => (t && t.text != null ? t.text : t)).filter(Boolean) : []
  const drivers = Array.isArray(s.drivers) ? s.drivers.map((d: any) => d.name).filter(Boolean) : []
  const placements = asArr(s.placements).filter(Boolean)
  const mixNotes = asArr(s.mixNotes).map((x: any) => String(x || '').trim())
  const notesArr = asArr(s.notes).map((n: any) => String((n && n.text != null) ? n.text : n)).filter(Boolean)
  const driverMsgArr = asArr(s.driverMessages).map((n: any) => String((n && n.text != null) ? n.text : n)).filter(Boolean)
  const addr = String(s.siteAddress || '').replace(/（緯度経度:[^）]*）/g, '').trim()
  const mapUrl = mapsUrlOf(s)

  // 配合表示：20-50-20 ＋ 特記（中央のみ等は元の配列をそのまま / で）
  const mixLine = String(s.mixCode || '').trim()
  const mixNoteLine = mixNotes.some(Boolean) ? mixNotes.filter(Boolean).join(' / ') : ''

  // ラベル＋値の行
  const row = (label: string, value: string, opts: any = {}) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#8a97a6', flex: 4 },
      { type: 'text', text: value || '—', size: opts.big ? 'lg' : 'sm', weight: opts.big ? 'bold' : 'regular', color: opts.color || '#111111', flex: 8, wrap: true },
    ],
  })
  const sep = () => ({ type: 'separator', margin: 'md', color: '#eef0f4' })

  const contents: any[] = [
    // ヘッダー：日付・時間 ｜ 業者名/商社名
    {
      type: 'box', layout: 'horizontal', spacing: 'md', alignItems: 'center',
      contents: [
        {
          type: 'box', layout: 'vertical', flex: 5,
          contents: [
            { type: 'text', text: s.date || '', size: 'xs', color: '#8a97a6' },
            { type: 'text', text: times.length ? times.join('　') : '時間未定', weight: 'bold', size: 'lg', color: '#c0392b', wrap: true },
          ],
        },
        {
          type: 'box', layout: 'vertical', flex: 6,
          contents: [
            { type: 'text', text: s.companyName || '', weight: 'bold', size: 'md', color: '#111111', wrap: true, align: 'end' },
            { type: 'text', text: s.tradingCompany || '商社名なし', size: 'sm', color: s.tradingCompany ? '#3a4a5c' : '#cccccc', wrap: true, align: 'end' },
          ],
        },
      ],
    },
    sep(),
    // 現場名（大きく中央）
    { type: 'text', text: s.siteName || '（現場名なし）', weight: 'bold', size: 'xl', color: '#111111', align: 'center', wrap: true },
    sep(),
    // 主要項目
    row('担当', drivers.join('、'), { big: true }),
    row('車種', `${s.vehicleType || '—'}${s.truckCount ? `  ${s.truckCount}台` : ''}`),
    row('配合', mixLine, { big: true, color: '#c0392b' }),
  ]
  if (mixNoteLine) contents.push(row('（特記）', mixNoteLine, { color: '#c0392b' }))
  contents.push(row('セメント種', String(s.cementType || '')))
  contents.push(row('量', s.volume ? `${s.volume}m³${s.volumeUncertain ? ' ?' : ''}` : '—'))
  contents.push(row('配置', placements.join('・')))
  contents.push(sep())
  contents.push(row('連絡先', String(s.orderContact || '')))
  contents.push(row('現場連絡先', String(s.siteContact || '')))
  if (notesArr.length) contents.push(row('備考', notesArr.join(' / ')))
  if (driverMsgArr.length) contents.push(row('ドライバーへの連絡', driverMsgArr.join(' / ')))
  contents.push(sep())
  contents.push(row('住所', addr || ''))

  const bubble: any = {
    type: 'bubble', size: 'mega',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: [
        mapUrl
          ? { type: 'button', style: 'primary', color: '#1a4d8f', height: 'sm', action: { type: 'uri', label: '📍 Googleマップで開く', uri: mapUrl } }
          : { type: 'text', text: '住所未登録', size: 'sm', color: '#9aa7b5', align: 'center' },
      ],
    },
  }
  return bubble
}

// LINEユーザーIDから、本日の出荷情報の返信メッセージ配列を作る。
// 送信者を「従業員(ドライバー)のlineId」「顧客のlineUserId」の両方で照合する。
async function buildGenbaReply(lineUserId: string): Promise<any[]> {
  const want = String(lineUserId || '').trim()
  const today = todayJST()

  // 1) 従業員（ドライバー）として照合
  const empIds = (await redis.smembers('employees')) || []
  let employee: any = null
  for (const eid of empIds) {
    const e = await redis.hgetall<Record<string, any>>(`employee:${eid}`)
    const have = String((e && e.lineId) || '').trim()
    if (e && have && have === want) { employee = e; break }
  }

  // 2) 顧客（業者）として照合
  const custIds = (await redis.smembers('customers')) || []
  let customer: any = null
  for (const cid of custIds) {
    const c = await redis.hgetall<Record<string, any>>(`customer:${cid}`)
    const have = String((c && c.lineUserId) || '').trim()
    if (c && have && have === want) { customer = c; break }
  }

  if (!employee && !customer) {
    return [{ type: 'text', text: `登録情報が見つかりませんでした。\n\n受信ID:\n${want}\n\n従業員管理の「LINE ID」または顧客管理の「LINEユーザーID」に、このIDを登録してください。` }]
  }

  // 本日の出荷を抽出（従業員＝担当に含まれる出荷／顧客＝その業者の出荷）
  const shipIds = (await redis.smembers('shipments')) || []
  const ships: any[] = []
  for (const sid of shipIds) {
    const s = await redis.hgetall<Record<string, any>>(`shipment:${sid}`)
    if (!s) continue
    if (String(s.date) !== today) continue
    let hit = false
    if (employee) {
      const drivers = Array.isArray(s.drivers) ? s.drivers : []
      if (drivers.some((d: any) => (d.id && employee.id && d.id === employee.id) || String(d.name || '') === String(employee.name || ''))) hit = true
    }
    if (!hit && customer) {
      if (s.companyId && customer.id && s.companyId === customer.id) hit = true
      else if (String(s.companyName || '') === String(customer.companyName || '')) hit = true
    }
    if (hit) ships.push(s)
  }

  const who = employee ? `${employee.name} さん` : `${customer.companyName} 様`
  if (ships.length === 0) {
    return [{ type: 'text', text: `${who}\n本日（${today}）の出荷予定はありません。` }]
  }
  const ft = (s: any) => Array.isArray(s.times) && s.times.length ? String(s.times[0]?.text ?? s.times[0] ?? '') : ''
  ships.sort((a, b) => ft(a).localeCompare(ft(b)))

  // reply上限は5メッセージ。伝票カード(carousel)で1枠、残りで地図画像を別メッセージに。
  const target = ships.slice(0, 12)
  const bubbles = target.map(shipmentBubble)
  const messages: any[] = [
    { type: 'text', text: `📋 ${who}\n本日（${today}）の出荷予定 ${ships.length}件` },
    {
      type: 'flex',
      altText: `本日の出荷予定 ${ships.length}件`,
      contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles },
    },
  ]
  // 地図画像を別リプライで（残り枠ぶん。reply合計5まで）
  let imgCount = 0
  for (const s of target) {
    if (messages.length >= 5) break
    const img = staticMapUrl(s)
    if (img) { messages.push({ type: 'image', originalContentUrl: img, previewImageUrl: img }); imgCount++ }
  }
  // 地図画像が1枚も付けられなかった場合のみ、原因＋URLをテキストで返す（成功時は静か）
  if (imgCount === 0 && messages.length < 5) {
    const s0 = target[0]
    const key = process.env.GMAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GMAPS_API_KEY || ''
    const view = asObj(s0.mapView)
    const coords = extractLatLng(s0.siteAddress || '')
    const url = staticMapUrl(s0) || ''
    const dbg = [
      `key:${key ? 'あり(' + key.length + ')' : 'なし'}`,
      `view:${view && typeof view.lat === 'number' ? 'あり' : 'なし'}`,
      `coords:${coords ? 'あり' : 'なし'}`,
      `url:${url ? 'OK' : 'NG'}`,
    ].join(' / ')
    messages.push({ type: 'text', text: `地図画像を出せませんでした。\n[${dbg}]` })
    if (url) messages.push({ type: 'text', text: `↓このURLをブラウザで開くとGoogleのエラーが見えます\n${url}` })
  }
  return messages
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ===== アプリからの出荷カード送信（認証必須）。指定出荷の伝票カード＋地図画像を担当へ =====
  if (req.method === 'POST' && (req.body as any)?.action === 'pushShipment') {
    const user = requireAuth(req)
    if (!user) return res.status(401).json({ error: '認証が必要です' })
    const { shipmentId, lineUserIds } = (req.body || {}) as any
    const cln = (v: any) => String(v || '').replace(/[\s　​-‍﻿]/g, '').trim()
    const ids: string[] = Array.isArray(lineUserIds) ? Array.from(new Set(lineUserIds.map(cln).filter(Boolean))) : []
    if (!shipmentId) return res.status(400).json({ error: '出荷IDがありません' })
    if (ids.length === 0) return res.status(400).json({ error: '送信先のLINEユーザーIDがありません' })
    const settings = (await redis.hgetall<Record<string, string>>(SETTINGS_KEY)) || {}
    const token = dec(settings.channelAccessToken || '')
    if (!token) return res.status(400).json({ error: 'LINEチャネルアクセストークンが未設定です（設定画面で登録してください）' })
    const s = await redis.hgetall<Record<string, any>>(`shipment:${shipmentId}`)
    if (!s || Object.keys(s).length === 0) return res.status(404).json({ error: '出荷登録が見つかりません' })
    // 「現場」返信と同じ：伝票カード＋矢印付き地図画像
    const pushMsgs: any[] = [
      { type: 'flex', altText: `出荷予定 ${s.siteName || s.companyName || ''}`, contents: shipmentBubble(s) },
    ]
    const mapImg = staticMapUrl(s)
    if (mapImg) pushMsgs.push({ type: 'image', originalContentUrl: mapImg, previewImageUrl: mapImg })

    const known = (await redis.hgetall<Record<string, string>>(USERS_KEY)) || {}
    const rs: Array<{ to: string; ok: boolean; error?: string }> = []
    for (const to of ids) {
      try {
        const prof = await fetch(`https://api.line.me/v2/bot/profile/${to}`, { headers: { Authorization: `Bearer ${token}` } })
        if (!prof.ok) {
          const inList = Object.prototype.hasOwnProperty.call(known, to)
          const hint = inList ? 'このIDは登録済みですが現在送信できません（ブロック/退会の可能性）。' : 'このIDはこの公式アカウントの友だちとして取得されていません。'
          rs.push({ to, ok: false, error: `友だち未確認(HTTP${prof.status}) ${hint}` })
          continue
        }
        const r = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ to, messages: pushMsgs }),
        })
        if (r.ok) rs.push({ to, ok: true })
        else {
          const body = await r.text()
          const reqId = r.headers.get('x-line-request-id') || ''
          rs.push({ to, ok: false, error: `HTTP${r.status} ${body.slice(0, 300)}${reqId ? ` [req:${reqId}]` : ''}` })
        }
      } catch (e) {
        rs.push({ to, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return res.status(200).json({ sent: rs.filter(r => r.ok).length, total: ids.length, results: rs })
  }

  // ===== アプリからのプッシュ送信（認証必須）。Webhookと区別するため action=push で判定 =====
  if (req.method === 'POST' && (req.body as any)?.action === 'push') {
    const user = requireAuth(req)
    if (!user) return res.status(401).json({ error: '認証が必要です' })
    const { lineUserIds, text } = (req.body || {}) as any
    // 送信先IDをサニタイズ（前後空白・改行・制御文字・全角空白を除去）。コピペ混入対策
    const clean = (v: any) => String(v || '').replace(/[\s　​-‍﻿]/g, '').trim()
    const ids: string[] = Array.isArray(lineUserIds) ? Array.from(new Set(lineUserIds.map(clean).filter(Boolean))) : []
    if (ids.length === 0) return res.status(400).json({ error: '送信先のLINEユーザーIDがありません' })
    const settings = (await redis.hgetall<Record<string, string>>(SETTINGS_KEY)) || {}
    const token = dec(settings.channelAccessToken || '')
    if (!token) return res.status(400).json({ error: 'LINEチャネルアクセストークンが未設定です（設定画面で登録してください）' })
    const message = String(text || '').trim() || 'テスト'
    // この公式アカウントが取得済みの友だち一覧（webhookで自動登録）
    const knownUsers = (await redis.hgetall<Record<string, string>>(USERS_KEY)) || {}
    const results: Array<{ to: string; ok: boolean; error?: string }> = []
    for (const to of ids) {
      try {
        // 送信前にプロフィール取得で友だち＝送信可能か確認（取れない＝友だちでない/別チャネルのID）
        const prof = await fetch(`https://api.line.me/v2/bot/profile/${to}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!prof.ok) {
          const inList = Object.prototype.hasOwnProperty.call(knownUsers, to)
          const hint = inList
            ? 'このIDは登録済み一覧にありますが、現在この公式アカウントから送信できません（ブロック/退会の可能性）。'
            : 'このIDはこの公式アカウントの友だちとして取得されていません。設定画面のLINEユーザー一覧に表示されているIDか確認してください（別の公式アカウントのID/手入力ミスの可能性）。'
          results.push({ to, ok: false, error: `友だち未確認(HTTP${prof.status}) ${hint}` })
          continue
        }
        const r = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ to, messages: [{ type: 'text', text: message }] }),
        })
        if (r.ok) results.push({ to, ok: true })
        else {
          const body = await r.text()
          const reqId = r.headers.get('x-line-request-id') || ''
          results.push({ to, ok: false, error: `HTTP${r.status} ${body.slice(0, 300)}${reqId ? ` [req:${reqId}]` : ''}` })
        }
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
