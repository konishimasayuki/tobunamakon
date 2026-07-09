// デモモード（z/z ログイン）用のクライアント完結バックエンド。
// Upstash / サーバに一切触らず、localStorage に全データを持たせる。
// 起動時に 50件の架空データをシードする。

const TOKEN = 'demo-token'
const USER = { id: 'demo', username: 'z', displayName: '日本生コン', role: 'admin', demo: true }
const KEY = 'demo_db_v1'

export function isDemoMode() {
  try { return localStorage.getItem('token') === TOKEN } catch { return false }
}

export function demoLogin() {
  localStorage.setItem('token', TOKEN)
  localStorage.setItem('user', JSON.stringify(USER))
  seedIfNeeded()
  return { token: TOKEN, user: USER }
}

// ---------- ストレージ ----------
function load() {
  try { const s = localStorage.getItem(KEY); if (s) return JSON.parse(s) } catch { /* noop */ }
  return { shipments: {}, customers: {}, employees: {}, debug: {}, users: {} }
}
function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)) } catch { /* noop */ } }
export function resetDemo() { try { localStorage.removeItem(KEY) } catch { /* noop */ } seedIfNeeded() }

// ---------- 乱数 ユーティリティ（seedable） ----------
function makeRng(seed = 12345) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]
const chance = (rng, p) => rng() < p
const uuid = () => 'demo-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// ---------- シード ----------
const COMPANIES = [
  { name: '東部生コン', kana: 'とうぶなまこん', code: 'C001' },
  { name: '中部コンクリート', kana: 'ちゅうぶこんくりーと', code: 'C002' },
  { name: '西部生コン', kana: 'せいぶなまこん', code: 'C003' },
  { name: '北部コンクリート', kana: 'ほくぶこんくりーと', code: 'C004' },
  { name: '南部生コン工業', kana: 'なんぶなまこんこうぎょう', code: 'C005' },
  { name: '関東ミキサー', kana: 'かんとうみきさー', code: 'C006' },
  { name: '日本生コン', kana: 'にほんなまこん', code: 'C007' },
  { name: '首都圏コンクリ', kana: 'しゅとけんこんくり', code: 'C008' },
]
const TRADING = ['〇〇商事', '△△工業', '□□コーポ', '☆☆産業', '〇商事']
const SITES = [
  '市庁舎新築工事', '○○マンション基礎', '県道改良工事 橋脚', '学校体育館改修',
  '駅前再開発ビル', '○○病院増築', '○○幼稚園園舎', 'マンション擁壁工事',
  '公園整備 タタキ', '国道拡幅 橋脚', '倉庫増築 基礎', '駐車場舗装工事',
  '住宅基礎 A地区', '住宅基礎 B地区', '道路補修', 'マンホール周り補修',
]
const ADDRESSES = [
  '東京都新宿区西新宿1-2-3', '東京都渋谷区代々木2-3-4', '神奈川県横浜市中区山下町5-6',
  '埼玉県さいたま市大宮区桜木町1-1', '千葉県千葉市中央区中央3-2-1', '東京都台東区上野4-5-6',
  '東京都文京区本郷7-8-9', '', '', '',
]
const POUR = ['基礎', 'スラブ', '立上り', 'タタキ', '土間', '橋脚', 'ステ', '増']
const VEHICLE_FREES = ['', '', 'ポンプ車', '大型ミキサー', 'ミキサー', 'ポンプ', '大型ポンプ車', '']
const DRIVERS = ['田中', '佐藤', '山田', '鈴木', '高橋', '伊藤', '中村', '渡辺', '小林', '加藤']
const NOTES = [
  '9時厳守', '2回打ち', '時間厳守', '硬化早め', '通常配送', '少量配送',
  '', '', '', '朝一で開始', '慎重運搬', '',
]

function seedIfNeeded() {
  const db = load()
  if (db.shipments && Object.keys(db.shipments).length > 0) return db
  const rng = makeRng(20260101)

  // employees (ドライバー10 + 事務3)
  const employees = {}
  DRIVERS.forEach((n, i) => {
    const id = 'e-drv-' + i
    employees[id] = { id, name: n, type: 'driver', lineId: '', createdAt: new Date().toISOString() }
  })
  ;['山本', '斎藤', '松本'].forEach((n, i) => {
    const id = 'e-stf-' + i
    employees[id] = { id, name: n, type: 'staff', lineId: '', createdAt: new Date().toISOString() }
  })

  // customers
  const customers = {}
  COMPANIES.forEach((c, i) => {
    const id = 'c-' + i
    customers[id] = {
      id, companyName: c.name, companyNameKana: c.kana, customerCode: c.code,
      tel: '03-' + (1000 + i) + '-' + (2000 + i * 3),
      address: pick(rng, ADDRESSES.filter(x => x)),
      staffName: pick(rng, DRIVERS),
      memo: '',
      createdAt: new Date().toISOString(),
    }
  })

  // 50 shipments  (today ±15日)
  const shipments = {}
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const drvKeys = Object.keys(employees).filter(k => employees[k].type === 'driver')
  for (let i = 0; i < 50; i++) {
    const dayOff = Math.floor(rng() * 30) - 15   // -15 〜 +14
    const d = new Date(now); d.setDate(now.getDate() + dayOff)
    const h = 8 + Math.floor(rng() * 9)
    const m = pick(rng, [0, 15, 30, 45])
    const timeText = `${h}:${pad(m)}`
    const comp = pick(rng, COMPANIES)
    const site = pick(rng, SITES)
    const vt = pick(rng, ['4t', '7t', '大型'])
    const vf = pick(rng, VEHICLE_FREES)
    const p1 = pick(rng, [21, 24, 27, 30])
    const p2 = pick(rng, [12, 15, 18, 21])
    const p3 = 20
    const mixMode = chance(rng, 0.15)
      ? (chance(rng, 0.5) ? 'mortar' : 'dry')
      : 'num'
    let mixCode, mixRows
    if (mixMode === 'dry') { mixCode = 'ドライテック'; mixRows = [{ parts: ['', '', ''], note: '' }] }
    else if (mixMode === 'mortar') { mixCode = '1:' + (2 + Math.floor(rng() * 3)); mixRows = [{ parts: ['', '', ''], note: '' }] }
    else { mixCode = `${p1}-${p2}-${p3}`; mixRows = [{ parts: [String(p1), String(p2), String(p3)], note: chance(rng, 0.2) ? pick(rng, ['速', '中', '軟', '硬']) : '' }] }
    const cement = pick(rng, ['N', 'B'])
    const hasCT2 = chance(rng, 0.1)
    const vol = chance(rng, 0.1) ? 100 + Math.floor(rng() * 40) : 5 + Math.floor(rng() * 25)
    const hasV2 = chance(rng, 0.15)
    const numDrivers = 1 + Math.floor(rng() * 3)
    const drivers = []
    const used = new Set()
    for (let j = 0; j < numDrivers; j++) {
      let k; do { k = pick(rng, drvKeys) } while (used.has(k))
      used.add(k); drivers.push({ id: employees[k].id, name: employees[k].name })
    }
    const noteTags = []
    if (chance(rng, 0.2)) noteTags.push('領')
    if (chance(rng, 0.2)) noteTags.push('追')
    const testTags = []
    if (chance(rng, 0.15)) testTags.push('現TP')
    if (chance(rng, 0.15)) testTags.push('工TP')
    const notes = []
    const nt = pick(rng, NOTES)
    if (nt) notes.push({ text: nt, important: chance(rng, 0.15) })
    const placements = []
    if (chance(rng, 0.3)) placements.push(pick(rng, ['クレーン', 'F1', 'ポンプ', '舟下し']))
    const id = uuid()
    const iso = new Date().toISOString()
    shipments[id] = {
      id,
      date: ymd(d),
      orderDate: ymd(d),
      companyId: 'c-' + COMPANIES.indexOf(comp),
      companyName: comp.name,
      tradingCompany: chance(rng, 0.5) ? pick(rng, TRADING) : '',
      times: [{ text: timeText, important: chance(rng, 0.08) }],
      siteName: site,
      siteAddress: chance(rng, 0.6) ? pick(rng, ADDRESSES.filter(a => a)) : '',
      vehicleType: vt,
      vehicleFree: vf,
      vehicleItems: [{ type: vt, qty: '1' }],
      truckCount: '',
      mixCode,
      mixMode,
      mixRows,
      mixNotes: ['', mixRows[0].note || '', ''],
      cementType: cement,
      cementType2: hasCT2 ? (cement === 'N' ? 'B' : 'N') : '',
      hasCementType2: hasCT2,
      volume: String(vol),
      volumeNote: chance(rng, 0.1) ? pick(rng, ['実', '予', '目安']) : '',
      volumeUncertain: chance(rng, 0.05),
      volumePlusA: chance(rng, 0.05),
      volume2: hasV2 ? String(5 + Math.floor(rng() * 15)) : '',
      volumeNote2: '',
      volumeUncertain2: false,
      volumePlusA2: false,
      hasVolume2: hasV2,
      placements,
      pourLocation: pick(rng, POUR),
      pourFree: false,
      noteTags,
      testTags,
      mapReceived: chance(rng, 0.4),
      faxReceived: chance(rng, 0.2),
      orderContact: '03-1234-56' + pad(Math.floor(rng() * 100)),
      siteContact: '090-' + (1000 + Math.floor(rng() * 9000)) + '-' + (1000 + Math.floor(rng() * 9000)),
      drivers,
      notes,
      driverMessages: [],
      mapView: null, mapPin: null, mapArrows: [],
      hasPdf: false, pdfName: '',
      cancelled: false, cancelledAt: '',
      changedFields: [],
      history: [],
      createdAt: iso, updatedAt: iso,
    }
  }

  const users = { demo: { ...USER, passwordHash: '(demo)', createdAt: new Date().toISOString() } }
  const db2 = { shipments, customers, employees, debug: {}, users }
  save(db2)
  return db2
}

// ---------- クエリ解析 ----------
function parseUrl(path) {
  const [base, query = ''] = path.split('?')
  const q = {}
  query.split('&').filter(Boolean).forEach(kv => { const [k, v] = kv.split('='); q[k] = decodeURIComponent(v || '') })
  return { path: base, q }
}
const inRange = (date, from, to) => (!from || date >= from) && (!to || date <= to)

// ---------- API エミュレータ ----------
export async function demoRequest(rawPath, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const body = options.body ? (() => { try { return JSON.parse(options.body) } catch { return {} } })() : {}
  const { path, q } = parseUrl(rawPath)
  const db = seedIfNeeded()

  // ---- auth ----
  if (path === '/api/auth/login' && method === 'POST') {
    if (body.username === 'z' && body.password === 'z') return { token: TOKEN, user: USER }
    throw new Error('ユーザー名またはパスワードが違います')
  }
  if (path === '/api/auth/me') return { user: USER }

  // ---- shipments ----
  if (path === '/api/shipments') {
    // ?id=... 単一/PDF
    if (q.id && q.pdf === '1') throw new Error('デモではPDFは表示できません')
    if (q.id && method === 'GET') { const s = db.shipments[q.id]; if (!s) throw new Error('見つかりません'); return s }
    if (method === 'GET') {
      const list = Object.values(db.shipments)
      const showCancelled = q.cancelled === '1'
      const from = q.date || q.from
      const to = q.date || q.to
      const filtered = list.filter(s => (!!s.cancelled) === !!showCancelled && inRange(s.date, from, to))
      return filtered
    }
    if (method === 'POST') {
      const id = uuid()
      const now = new Date().toISOString()
      const s = { ...body, id, createdAt: now, updatedAt: now, cancelled: false, changedFields: body.changedFields || [], history: [] }
      db.shipments[id] = s; save(db); return s
    }
    if (method === 'PUT' && q.id) {
      const s = db.shipments[q.id]; if (!s) throw new Error('見つかりません')
      const now = new Date().toISOString()
      if (q.cancel === '1') { s.cancelled = true; s.cancelledAt = now }
      else if (q.assign === '1') { Object.assign(s, body) }
      else { Object.assign(s, body) }
      s.updatedAt = now
      db.shipments[q.id] = s; save(db); return s
    }
    if (method === 'DELETE' && q.id) { delete db.shipments[q.id]; save(db); return { ok: true } }
    if (method === 'DELETE' && (q.all === '1')) { db.shipments = {}; save(db); return { deleted: 0 } }
  }
  // /api/shipments/:id 形式（PUT 更新）
  const shipMatch = path.match(/^\/api\/shipments\/([^/?]+)$/)
  if (shipMatch) {
    const id = shipMatch[1]
    const s = db.shipments[id]
    if (method === 'PUT') {
      if (!s) throw new Error('見つかりません')
      const now = new Date().toISOString()
      const cancel = q.cancel === '1'
      const assign = q.assign === '1'
      if (cancel) { s.cancelled = true; s.cancelledAt = now; save(db); return s }
      Object.assign(s, body)
      s.updatedAt = now
      db.shipments[id] = s; save(db); return s
    }
    if (method === 'DELETE') { delete db.shipments[id]; save(db); return { ok: true } }
    if (method === 'GET') { if (!s) throw new Error('見つかりません'); return s }
  }

  // ---- customers ----
  if (path === '/api/customers') {
    if (method === 'GET') return Object.values(db.customers)
    if (method === 'POST') { const id = uuid(); const c = { ...body, id, createdAt: new Date().toISOString() }; db.customers[id] = c; save(db); return c }
    if (method === 'PUT' && q.id) { const c = { ...db.customers[q.id], ...body, id: q.id }; db.customers[q.id] = c; save(db); return c }
    if (method === 'DELETE' && q.id) { delete db.customers[q.id]; save(db); return { ok: true } }
  }
  const custMatch = path.match(/^\/api\/customers\/([^/?]+)$/)
  if (custMatch) {
    const id = custMatch[1]
    if (method === 'PUT') { const c = { ...db.customers[id], ...body, id }; db.customers[id] = c; save(db); return c }
    if (method === 'DELETE') { delete db.customers[id]; save(db); return { ok: true } }
    if (method === 'GET') return db.customers[id] || null
  }

  // ---- employees ----
  if (path === '/api/employees') {
    if (method === 'GET') {
      const list = Object.values(db.employees)
      return q.drivers === '1' ? list.filter(e => e.type === 'driver') : list
    }
    if (method === 'POST') { const id = uuid(); const e = { ...body, id, createdAt: new Date().toISOString() }; db.employees[id] = e; save(db); return e }
    if (method === 'PUT' && q.id) { const e = { ...db.employees[q.id], ...body, id: q.id }; db.employees[q.id] = e; save(db); return e }
    if (method === 'DELETE' && q.id) { delete db.employees[q.id]; save(db); return { ok: true } }
  }
  const empMatch = path.match(/^\/api\/employees\/([^/?]+)$/)
  if (empMatch) {
    const id = empMatch[1]
    if (method === 'PUT') { const e = { ...db.employees[id], ...body, id }; db.employees[id] = e; save(db); return e }
    if (method === 'DELETE') { delete db.employees[id]; save(db); return { ok: true } }
    if (method === 'GET') return db.employees[id] || null
  }

  // ---- debug（掲示板）: localStorage 保持 ----
  if (path === '/api/debug') {
    if (method === 'GET' && !q.id) return Object.values(db.debug).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    if (method === 'GET' && q.id) return db.debug[q.id] || null
    if (method === 'POST' && !q.id) { const id = uuid(); const now = new Date().toISOString(); const t = { id, title: body.title || '', body: body.body || '', image: body.image || '', author: { id: USER.id, name: USER.username }, createdAt: now, updatedAt: now, replies: [] }; db.debug[id] = t; save(db); return t }
    if (method === 'POST' && q.id) { const t = db.debug[q.id]; if (!t) throw new Error('見つかりません'); const now = new Date().toISOString(); t.replies.push({ id: uuid(), body: body.body || '', image: body.image || '', author: { id: USER.id, name: USER.username }, createdAt: now }); t.updatedAt = now; save(db); return t }
    if (method === 'DELETE' && q.id) { delete db.debug[q.id]; save(db); return { ok: true } }
  }

  // ---- users ----
  if (path === '/api/users') return Object.values(db.users)

  // ---- line / backup / その他はスタブ応答 ----
  if (path === '/api/line') return { sent: 0, total: 0, results: [{ ok: true, mock: true }] }
  if (path === '/api/backup') {
    if (method === 'GET') return { shipments: Object.values(db.shipments), customers: Object.values(db.customers), employees: Object.values(db.employees), users: Object.values(db.users) }
    if (method === 'POST') { const b = body || {}; if (Array.isArray(b.shipments)) b.shipments.forEach(s => { if (s.id) db.shipments[s.id] = s }); if (Array.isArray(b.customers)) b.customers.forEach(c => { if (c.id) db.customers[c.id] = c }); if (Array.isArray(b.employees)) b.employees.forEach(e => { if (e.id) db.employees[e.id] = e }); save(db); return { ok: true } }
  }

  // 未対応
  return {}
}
