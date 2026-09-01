import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from './_redis'
import { requireAuth } from './_auth'

// 全データのバックアップ（エクスポート＝GET）／復元（インポート＝POST）。
// 対象：伝票 / 顧客 / 従業員 / ユーザー(認証) / 出欠(attendance) / LINE(設定・ユーザー・グループ)。
// 復元は「追加・上書き（id単位のupsert）」で、今あるデータは消さない（誤って消える事故を防ぐ）。
// ※PDF本体（shipmentpdf:*）は容量が大きく Vercel の1リクエスト上限を超えるため対象外（別ルートで扱う）。
// ※ユーザーのパスワードハッシュや LINE トークンを含むため、実行は管理者のみに制限する。

const INDEX_KEY = 'shipments:bydate'
const REV_KEY = 'shipments:rev'
const BASE_KEY = 'attendance:base'
const LINE_SETTINGS_KEY = 'line:settings'
const LINE_USERS_KEY = 'line:users'
const LINE_GROUPS_KEY = 'line:groups'

function dateScore(d: any): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''))
  return m ? parseInt(m[1] + m[2] + m[3], 10) : 0
}

// セット(setKey)のメンバーidから `${prefix}:${id}` ハッシュを全件読む。
async function readAll(setKey: string, prefix: string): Promise<Record<string, any>[]> {
  const ids = (await redis.smembers(setKey)) || []
  if (!ids.length) return []
  const p = redis.pipeline()
  ids.forEach((id: string) => p.hgetall(`${prefix}:${id}`))
  const rows = (await p.exec<Record<string, any>[]>()) || []
  return rows.filter(r => r && Object.keys(r).length > 0)
}

// 出欠レコードの正規化（保存は JSON 文字列だが、クライアントによりオブジェクトで返ることもあるため両対応）。
function parseAtt(raw: unknown): { rests: { id: string; name: string }[]; extras: string[] } {
  let obj: any = raw
  if (typeof raw === 'string') { try { obj = JSON.parse(raw) } catch { obj = null } }
  const rests = obj && Array.isArray(obj.rests)
    ? obj.rests.map((r: any) => ({ id: String(r?.id || ''), name: String(r?.name || '') })).filter((r: any) => r.name)
    : []
  const extras = obj && Array.isArray(obj.extras)
    ? obj.extras.map((x: any) => String(x || '').trim()).filter(Boolean)
    : []
  return { rests, extras }
}

// attendance:YYYY-MM-DD を SCAN で全件列挙（attendance:base は除外）。日付索引が無いため走査で集める。
async function readAttendance(): Promise<{ base: number | null; records: { date: string; rests: any[]; extras: string[] }[] }> {
  let cursor = '0'
  const dateKeys: string[] = []
  let guard = 0
  do {
    const [next, batch] = await redis.scan(cursor, { match: 'attendance:*', count: 300 })
    cursor = String(next)
    for (const k of batch) { if (k !== BASE_KEY) dateKeys.push(k) }
  } while (cursor !== '0' && ++guard < 10000)

  let records: { date: string; rests: any[]; extras: string[] }[] = []
  if (dateKeys.length) {
    const p = redis.pipeline()
    dateKeys.forEach(k => p.get(k))
    const vals = (await p.exec<any[]>()) || []
    records = dateKeys.map((k, i) => {
      const rec = parseAtt(vals[i])
      return { date: k.slice('attendance:'.length), rests: rec.rests, extras: rec.extras }
    })
  }
  const nBase = Number(await redis.get(BASE_KEY))
  return { base: (Number.isFinite(nBase) && nBase > 0) ? nBase : null, records }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  const authz = req.headers.authorization || ''
  const bearer = authz.startsWith('Bearer ') ? authz.slice(7) : ''
  const admin = !!user && user.role === 'admin'
  // 無人の自動バックアップ用の専用トークン（環境変数 BACKUP_TOKEN）。設定時のみ有効。
  const envTok = process.env.BACKUP_TOKEN || ''
  const tokenOk = envTok.length >= 16 && bearer === envTok
  // 参照(GET=エクスポート/PDF一覧)は「管理者 or バックアップトークン」。
  // 復元(POST=データ/PDF)はパスワードハッシュ等を書き換えるため管理者のみ（トークン不可）。
  if (req.method === 'GET') {
    if (!admin && !tokenOk) return res.status(401).json({ error: '認証が必要です（管理者またはバックアップトークン）' })
  } else {
    if (!admin) return res.status(403).json({ error: '管理者権限が必要です（バックアップは管理者のみ）' })
  }

  // 添付PDFの一覧（id・ファイル名・日付・業者名）。実データは別途 /api/shipments?id=..&pdf=1 で1件ずつ取得する。
  if (req.method === 'GET' && (req.query.pdflist === '1' || req.query.pdflist === 'true')) {
    try {
      const ids = (await redis.smembers('shipments')) || []
      if (!ids.length) return res.status(200).json({ items: [] })
      const pp = redis.pipeline()
      ids.forEach((id: string) => pp.hgetall(`shipment:${id}`))
      const rows = (await pp.exec<Record<string, any>[]>()) || []
      const items = rows
        .map((s, i) => ({ s, id: ids[i] }))
        .filter(({ s }) => s && (s.hasPdf === '1' || s.hasPdf === 1 || s.hasPdf === true))
        .map(({ s, id }) => ({ id, pdfName: String(s.pdfName || ''), date: String(s.date || ''), companyName: String(s.companyName || '') }))
      return res.status(200).json({ items })
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  // エクスポート（全データ取得）
  if (req.method === 'GET') {
    try {
      const [shipments, customers, employees, users, attendance, lineSettings, lineUsers, lineGroups] = await Promise.all([
        readAll('shipments', 'shipment'),
        readAll('customers', 'customer'),
        readAll('employees', 'employee'),
        readAll('users', 'user'),
        readAttendance(),
        redis.hgetall<Record<string, any>>(LINE_SETTINGS_KEY),
        redis.hgetall<Record<string, any>>(LINE_USERS_KEY),
        redis.hgetall<Record<string, any>>(LINE_GROUPS_KEY),
      ])
      return res.status(200).json({
        app: 'tobunamakon',
        type: 'backup',
        version: 2,
        exportedAt: new Date().toISOString(),
        counts: {
          shipments: shipments.length,
          customers: customers.length,
          employees: employees.length,
          users: users.length,
          attendanceDays: attendance.records.length,
          lineUsers: Object.keys(lineUsers || {}).length,
          lineGroups: Object.keys(lineGroups || {}).length,
        },
        shipments, customers, employees, users,
        attendance,
        line: { settings: lineSettings || {}, users: lineUsers || {}, groups: lineGroups || {} },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 添付PDFの復元（1件ずつ）。Vercelの1リクエスト上限のため PDF は分割して送る。
  if (req.method === 'POST' && (req.query.pdf === '1' || req.query.pdf === 'true')) {
    try {
      const body: any = req.body || {}
      const id = String(body.id || '')
      if (!id) return res.status(400).json({ error: 'id が必要です' })
      const raw = typeof body.data === 'string' ? body.data : ''
      const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
      if (!b64) return res.status(400).json({ error: 'data(base64) が必要です' })
      await redis.set(`shipmentpdf:${id}`, b64)
      // 伝票が存在すれば hasPdf/pdfName を補正（他項目は触らない）
      if (await redis.exists(`shipment:${id}`)) {
        await redis.hset(`shipment:${id}`, { hasPdf: '1', pdfName: String(body.pdfName || 'shipment.pdf') })
      }
      return res.status(200).json({ ok: true, id })
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 復元（追加・上書き＝upsert。今あるデータは削除しない）
  if (req.method === 'POST') {
    try {
      const body: any = req.body || {}
      if (body.type && body.type !== 'backup') return res.status(400).json({ error: 'バックアップファイルではありません' })
      const result = { shipments: 0, customers: 0, employees: 0, users: 0, attendanceDays: 0, line: 0 }
      let touched = false

      if (Array.isArray(body.customers)) {
        for (const c of body.customers) {
          if (!c || !c.id) continue
          await redis.hset(`customer:${c.id}`, c)
          await redis.sadd('customers', c.id)
          result.customers++
        }
      }
      if (Array.isArray(body.employees)) {
        for (const e of body.employees) {
          if (!e || !e.id) continue
          await redis.hset(`employee:${e.id}`, e)
          await redis.sadd('employees', e.id)
          result.employees++
        }
      }
      if (Array.isArray(body.users)) {
        for (const u of body.users) {
          if (!u || !u.username) continue
          await redis.hset(`user:${u.username}`, u)
          await redis.sadd('users', u.username)
          result.users++
        }
      }
      if (Array.isArray(body.shipments)) {
        for (const s of body.shipments) {
          if (!s || !s.id) continue
          await redis.hset(`shipment:${s.id}`, s)
          await redis.sadd('shipments', s.id)
          const sc = dateScore(s.date)
          if (sc) { try { await redis.zadd(INDEX_KEY, { score: sc, member: s.id }) } catch { /* 索引失敗は無視 */ } }
          result.shipments++
          touched = true
        }
      }
      // 出欠
      const att = body.attendance
      if (att && typeof att === 'object') {
        if (att.base !== undefined && att.base !== null) {
          const b = Math.max(0, parseInt(String(att.base), 10) || 0)
          await redis.set(BASE_KEY, String(b))
          touched = true
        }
        if (Array.isArray(att.records)) {
          for (const rec of att.records) {
            if (!rec || !rec.date) continue
            const norm = parseAtt({ rests: rec.rests, extras: rec.extras })
            await redis.set(`attendance:${rec.date}`, JSON.stringify(norm))
            result.attendanceDays++
            touched = true
          }
        }
      }
      // LINE（設定・ユーザー・グループの各ハッシュをマージ上書き）
      const line = body.line
      if (line && typeof line === 'object') {
        if (line.settings && typeof line.settings === 'object' && Object.keys(line.settings).length) { await redis.hset(LINE_SETTINGS_KEY, line.settings); result.line++ }
        if (line.users && typeof line.users === 'object' && Object.keys(line.users).length) { await redis.hset(LINE_USERS_KEY, line.users); result.line++ }
        if (line.groups && typeof line.groups === 'object' && Object.keys(line.groups).length) { await redis.hset(LINE_GROUPS_KEY, line.groups); result.line++ }
      }

      // 掲示板ポーリングに変更を知らせる（伝票/出欠が入ったときだけ）
      if (touched) { try { await redis.incr(REV_KEY) } catch { /* noop */ } }
      return res.status(200).json({ restored: result })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
