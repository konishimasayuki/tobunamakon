import { useState, useEffect, useLayoutEffect, useCallback, createContext, useContext, useRef, Fragment } from 'react'
import { isDemoMode, demoLogin, demoRequest } from './demo.js'

// ============================================================
// 定数
// ============================================================
const APP_VERSION = 'v0.1.2'
const ROLE_LABELS    = { admin: '管理者', manager: 'マネージャー', staff: 'スタッフ' }
const EMP_TYPE_LABELS = { office: '事務所', driver: 'ドライバー', admin: '管理者' }
const EMP_TYPES       = ['office', 'driver', 'admin']

// ============================================================
// 呼び名（ニックネーム）レジストリ
// 従業員管理で登録した「呼び名」を、各ページの担当者名表示に反映する。
// 保存データ（s.drivers[].name）は氏名のまま保持し、表示時のみ id→呼び名 に置換する。
// 呼び名が未登録なら氏名をそのまま表示する。
// ============================================================
const NICK_REG = new Map()   // employee.id -> 呼び名
function rememberEmployees(list) {
  let changed = false
  ;(Array.isArray(list) ? list : []).forEach(e => {
    if (!e || !e.id) return
    const nn = String(e.nickname || '').trim()
    const prev = NICK_REG.get(e.id)
    if (nn) { if (prev !== nn) { NICK_REG.set(e.id, nn); changed = true } }
    else if (prev !== undefined) { NICK_REG.delete(e.id); changed = true }
  })
  if (changed && typeof window !== 'undefined') window.dispatchEvent(new Event('nickreg'))
  return list
}
// 担当者1人の表示名：呼び名があれば呼び名、なければ氏名
function dispDriverName(d) {
  if (!d) return ''
  if (d.id && NICK_REG.has(d.id)) return NICK_REG.get(d.id)
  return String(d.name ?? '')
}
// レジストリ更新時に再描画させるフック（担当者名を表示するが従業員を読み込まないページで使う）
function useNickReg() {
  const [, force] = useState(0)
  useEffect(() => {
    const h = () => force(x => x + 1)
    window.addEventListener('nickreg', h)
    return () => window.removeEventListener('nickreg', h)
  }, [])
}

// ============================================================
// APIクライアント
// ============================================================
const getToken = () => localStorage.getItem('token') || ''

async function request(path, options = {}) {
  // デモモード(z/z ログイン)は Upstash/サーバに触らず localStorage で応答する
  if (isDemoMode()) {
    try { return await demoRequest(path, options) }
    catch (e) { throw new Error(e?.message || 'デモエラー') }
  }
  let res
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
        ...options.headers,
      },
    })
  } catch (e) {
    throw new Error('ネットワークエラー: ' + e.message)
  }
  let data
  try {
    const text = await res.text()
    data = text ? JSON.parse(text) : {}
  } catch {
    data = {}
  }
  if (res.status === 401 && getToken()) {
    // ログイン有効期限切れ等 → 認証情報を消してログイン画面へ
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    window.location.reload()
  }
  if (!res.ok) throw new Error(data.error || 'エラー(' + res.status + ')')
  return data
}

// --- GETの短時間キャッシュ＆同時リクエストの重複排除（Upstashの読み取りコマンド削減）---
// 5秒以内の同一GETはキャッシュを再利用し、同時に飛んだ同一GETは1本に束ねる。
// 書き込み(post/put/del)・出荷変更通知のたびに破棄して鮮度を担保する（世代カウンタ方式）。
const GET_TTL_MS = 5000
let _cacheGen = 0
const _getCache = new Map()   // path -> { ts, data, gen }
const _inflight = new Map()   // path -> Promise
function bumpGen() { _cacheGen++; _getCache.clear(); _inflight.clear() }
function cachedGet(path) {
  const gen = _cacheGen
  const hit = _getCache.get(path)
  if (hit && hit.gen === gen && Date.now() - hit.ts < GET_TTL_MS) return Promise.resolve(hit.data)
  const flying = _inflight.get(path)
  if (flying) return flying
  const p = request(path)
    .then(data => { if (_cacheGen === gen) _getCache.set(path, { ts: Date.now(), data, gen }); _inflight.delete(path); return data })
    .catch(e => { _inflight.delete(path); throw e })
  _inflight.set(path, p)
  return p
}

const api = {
  post: (path, body) => { bumpGen(); return request(path, { method: 'POST', body: JSON.stringify(body) }).finally(bumpGen) },
  get:  (path)       => cachedGet(path),
  put:  (path, body) => { bumpGen(); return request(path, { method: 'PUT',  body: JSON.stringify(body) }).finally(bumpGen) },
  del:  (path)       => { bumpGen(); return request(path, { method: 'DELETE' }).finally(bumpGen) },
}

// 出荷データの変更を他タブ/他ウィンドウに通知する（localStorage の storage イベント経由）。
// 別ウィンドウで編集→更新したとき、開いている出荷予定表タブを自動で再取得させる。
const SHIPMENTS_PING_KEY = 'shipments_updated_at'
function notifyShipmentsChanged() {
  try { localStorage.setItem(SHIPMENTS_PING_KEY, String(Date.now())) } catch {}
}
// 別タブで出荷が変わったらGETキャッシュも破棄し、再取得が必ず最新になるようにする
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e && e.key === SHIPMENTS_PING_KEY) bumpGen() })
}
// 変更通知を購読する。コールバックは別タブでの更新時に呼ばれる。
// 画面が非表示の間は再取得せず（Upstash読み取り節約）、表示に戻った時に1回だけ反映する。
function useShipmentsChanged(onChange) {
  useEffect(() => {
    let pending = false
    const run = () => { pending = false; onChange() }
    const h = (e) => {
      if (e.key !== SHIPMENTS_PING_KEY) return
      if (typeof document !== 'undefined' && document.hidden) pending = true
      else run()
    }
    const onVis = () => { if (typeof document !== 'undefined' && !document.hidden && pending) run() }
    window.addEventListener('storage', h)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('storage', h); document.removeEventListener('visibilitychange', onVis) }
  }, [onChange])
}

// Redisのハッシュ値は文字列で返ることがある（true/false が "true"/"false" 等）。
// 受信確認など真偽フラグは、文字列・数値・真偽いずれの表現でも正しく判定する。
const isOn = (v) => v === true || v === 1 || v === '1' || v === 'true'

// ローカル（端末）時刻基準の YYYY-MM-DD を返す（toISOStringはUTCで日付がずれるため）
function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// 0:00 を跨いだら、表示中の日付が「それまでの本日」のときだけ自動で新しい本日に繰り上げる。
// （ユーザーが別の日付を手動選択している間は変更しない）
function useAutoToday(setDate) {
  const lastTodayRef = useRef(localToday())
  useEffect(() => {
    const id = setInterval(() => {
      const t = localToday()
      if (t !== lastTodayRef.current) {
        const prevToday = lastTodayRef.current
        lastTodayRef.current = t
        setDate(prev => (prev === prevToday ? t : prev))
      }
    }, 30000)
    return () => clearInterval(id)
  }, [setDate])
}


// ============================================================
// 認証コンテキスト
// ============================================================
const AuthContext = createContext(null)

function AuthProvider({ children }) {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const stored = localStorage.getItem('user')
    const token  = localStorage.getItem('token')
    if (stored && token) {
      try { setUser(JSON.parse(stored)) } catch {}
    }
    setLoading(false)
  }, [])

  const login = async (username, password) => {
    // z/z はデモアカウント。サーバ(Upstash)を一切叩かず localStorage に固定ユーザを設定してログイン扱いにする。
    if (username === 'z' && password === 'z') {
      const { user: u } = demoLogin()
      setUser(u)
      return
    }
    const data = await api.post('/api/auth/login', { username, password })
    localStorage.setItem('token', data.token)
    localStorage.setItem('user', JSON.stringify(data.user))
    setUser(data.user)
  }

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

const useAuth = () => useContext(AuthContext)

// ============================================================
// CSV ユーティリティ
// ============================================================
// 列順：顧客コード → 会社名 → 会社名（カナ）→ 電話番号 → 住所 → 担当者名 → メモ
const CSV_HEADERS = ['顧客コード', '会社名', '会社名（カナ）', '電話番号', '住所', '担当者名', 'メモ・備考']
const CSV_KEYS    = ['customerCode', 'companyName', 'companyNameKana', 'phone', 'address', 'contactPerson', 'memo']

function exportCSV(customers) {
  const rows = [
    CSV_HEADERS.join(','),
    ...customers.map(c =>
      CSV_KEYS.map(k => `"${String(c[k] ?? '').replace(/"/g, '""')}"`).join(',')
    ),
  ]
  const bom  = '\uFEFF'
  const blob = new Blob([bom + rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `顧客一覧_${localToday()}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function parseCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  return lines.slice(1).map(line => {
    const cols = []
    let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = !inQ
      } else if (ch === ',' && !inQ) {
        cols.push(cur); cur = ''
      } else { cur += ch }
    }
    cols.push(cur)
    const obj = {}
    CSV_KEYS.forEach((k, i) => { obj[k] = (cols[i] || '').trim() })
    return obj
  }).filter(r => r.customerCode || r.companyName)
}

// ============================================================
// スタイル
// ============================================================
const S = {
  loginRoot:  { minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #0f3060 0%, #1a4d8f 50%, #1a6a9f 100%)' },
  loginCard:  { background: '#fff', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  loginLogo:  { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 32, paddingBottom: 24, borderBottom: '2px solid #f0f2f5' },
  company:    { fontSize: 18, fontWeight: 700, color: '#1a2332', lineHeight: 1.3 },
  systemTxt:  { fontSize: 12, color: '#6b7a8d', marginTop: 2 },
  form:       { display: 'flex', flexDirection: 'column', gap: 16 },
  field:      { display: 'flex', flexDirection: 'column', gap: 6 },
  label:      { fontSize: 13, fontWeight: 600, color: '#3a4a5c' },
  input:      { padding: '10px 14px', border: '1.5px solid #dde3ed', borderRadius: 8, fontSize: 15, outline: 'none', color: '#1a2332' },
  error:      { background: '#fef2f2', color: '#c0392b', padding: '10px 14px', borderRadius: 8, fontSize: 13, border: '1px solid #fecaca' },
  loginBtn:   { background: 'linear-gradient(135deg, #1a4d8f, #1a6a9f)', color: '#fff', border: 'none', borderRadius: 8, padding: '12px', fontSize: 15, fontWeight: 600, cursor: 'pointer', marginTop: 4 },
  appRoot:    { display: 'flex', height: '100dvh', overflow: 'hidden' },
  sidebar:    { width: 200, background: '#0f3060', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  sideHead:   { display: 'flex', alignItems: 'center', gap: 10, padding: '18px 14px 16px', paddingTop: 'calc(18px + env(safe-area-inset-top))', borderBottom: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 },
  coName:     { color: '#fff', fontWeight: 700, fontSize: 13, lineHeight: 1.3 },
  syName:     { color: 'rgba(255,255,255,0.5)', fontSize: 10, marginTop: 2 },
  nav:        { flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 2 },
  navItem:    { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderRadius: 8, background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: 500, cursor: 'pointer', textAlign: 'left', width: '100%' },
  navActive:  { background: 'rgba(255,255,255,0.15)', color: '#fff', fontWeight: 600 },
  sideFoot:   { padding: '10px 14px 14px', paddingBottom: 'calc(14px + env(safe-area-inset-bottom))', borderTop: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 },
  userName:   { color: '#fff', fontWeight: 600, fontSize: 12 },
  userRole:   { color: 'rgba(255,255,255,0.5)', fontSize: 10, marginTop: 1 },
  logoutBtn:  { width: '100%', background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 7, padding: '6px 0', fontSize: 11, fontWeight: 500, cursor: 'pointer', marginTop: 8 },
  verTxt:     { textAlign: 'center', marginTop: 8, fontSize: 10, color: 'rgba(255,255,255,0.22)' },
  main:       { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f4f6f9' },
  pageHead:   { padding: '14px 20px', background: '#fff', borderBottom: '1px solid #eef0f4', boxShadow: '0 1px 4px rgba(0,0,0,0.05)' },
  pageTitle:  { fontSize: 17, fontWeight: 700, color: '#1a2332' },
  content:    { flex: 1, overflow: 'auto' },
  toolbar:    { display: 'flex', gap: 8, alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #eef0f4', background: '#fff', flexWrap: 'wrap' },
  search:     { flex: 1, minWidth: 160, padding: '8px 12px', border: '1.5px solid #dde3ed', borderRadius: 8, fontSize: 13, outline: 'none' },
  addBtn:     { background: 'linear-gradient(135deg, #1a4d8f, #1a6a9f)', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  exportBtn:  { background: '#f0f9f0', color: '#1a8f5a', border: '1.5px solid #a0dca0', borderRadius: 7, padding: '8px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  importBtn:  { background: '#fff8f0', color: '#e8821a', border: '1.5px solid #f5c070', borderRadius: 7, padding: '8px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  countBar:   { padding: '6px 16px', background: '#f8fafc', fontSize: 11, color: '#6b7a8d', borderBottom: '1px solid #eef0f4' },
  tableWrap:  { flex: 1, overflowX: 'hidden', overflowY: 'auto' },
  table:      { width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' },
  th:         { padding: '9px 12px', background: '#f4f6f9', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#3a4a5c', borderBottom: '1px solid #dde3ed', whiteSpace: 'nowrap', position: 'sticky', top: 0, overflow: 'hidden' },
  tr:         { borderBottom: '1px solid #eef0f4' },
  td:         { padding: '10px 12px', fontSize: 13, color: '#1a2332', verticalAlign: 'middle', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tel:        { color: '#1a4d8f', fontWeight: 500 },
  code:       { fontFamily: 'monospace', fontSize: 11, color: '#6b7a8d', background: '#f4f6f9', padding: '2px 5px', borderRadius: 3 },
  editBtn:    { background: '#f0f4ff', color: '#1a4d8f', border: '1px solid #c0d0f0', borderRadius: 5, padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer', marginRight: 3 },
  delBtn:     { background: '#fff0f0', color: '#c0392b', border: '1px solid #f0c0c0', borderRadius: 5, padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  empty:      { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: '#6b7a8d', fontSize: 15, padding: 60 },
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal:      { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 560, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', maxHeight: '90vh', overflow: 'auto' },
  modalHead:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px 14px', borderBottom: '1px solid #eef0f4' },
  modalTitle: { fontSize: 16, fontWeight: 700, color: '#1a2332' },
  closeBtn:   { background: 'none', border: 'none', fontSize: 18, color: '#6b7a8d', cursor: 'pointer', padding: '4px 8px', borderRadius: 4 },
  modalForm:  { padding: '18px 22px 22px', display: 'flex', flexDirection: 'column', gap: 12 },
  grid2:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  grid3:      { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 },
  smLabel:    { fontSize: 11, fontWeight: 600, color: '#3a4a5c', marginBottom: 3 },
  smInput:    { padding: '8px 11px', border: '1.5px solid #dde3ed', borderRadius: 7, fontSize: 14, color: '#1a2332', outline: 'none', width: '100%', boxSizing: 'border-box' },
  actions:    { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 },
  cancelBtn:  { background: '#f4f6f9', color: '#3a4a5c', border: '1.5px solid #dde3ed', borderRadius: 7, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  saveBtn:    { background: 'linear-gradient(135deg, #1a4d8f, #1a6a9f)', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 22px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  confirmBox: { background: '#fff', borderRadius: 12, padding: '28px 32px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', textAlign: 'center', maxWidth: 380, width: '100%' },
  dangerBtn:  { background: '#c0392b', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  importBox:  { background: '#fff', borderRadius: 12, padding: '24px 28px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', maxWidth: 460, width: '100%' },
  successTag: { display: 'inline-block', background: '#f0f9f0', color: '#1a8f5a', border: '1px solid #a0dca0', borderRadius: 5, padding: '2px 9px', fontSize: 12, fontWeight: 600, marginRight: 6 },
  warnTag:    { display: 'inline-block', background: '#fff8f0', color: '#e8821a', border: '1px solid #f5c070', borderRadius: 5, padding: '2px 9px', fontSize: 12, fontWeight: 600, marginRight: 6 },
  skipTag:    { display: 'inline-block', background: '#f4f6f9', color: '#6b7a8d', border: '1px solid #dde3ed', borderRadius: 5, padding: '2px 9px', fontSize: 12, fontWeight: 600, marginRight: 6 },
  overlay2:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 },
  hamburger:  { background: 'none', border: 'none', color: '#1a2332', fontSize: 24, cursor: 'pointer', padding: '6px 10px', lineHeight: 1 },
  grid1:      { display: 'grid', gridTemplateColumns: '1fr', gap: 12 },
}

// ============================================================
// レスポンシブ用フック（モバイル/タブレット判定）
// ============================================================
const MOBILE_BP = 768   // これ未満をモバイル扱い（iPhone / 縦持ちスマホ）
// タッチ端末か（iPhone/iPad＝true、デスクトップPC＝false）。横向きiPadは幅だけでは
// ノートPCと区別できないため、生コン出力の「PCのみ」判定に使う。
const IS_TOUCH_DEVICE = typeof navigator !== 'undefined' &&
  ((navigator.maxTouchPoints || 0) > 0 || (typeof window !== 'undefined' && 'ontouchstart' in window))

function useIsMobile(bp = MOBILE_BP) {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < bp
  )
  useEffect(() => {
    const check = () => setMobile(window.innerWidth < bp)
    check()
    window.addEventListener('resize', check)
    window.addEventListener('orientationchange', check)
    return () => {
      window.removeEventListener('resize', check)
      window.removeEventListener('orientationchange', check)
    }
  }, [bp])
  return mobile
}

// iOS でフォーカス時の自動ズームを防ぐため、モバイルでは入力欄を 16px 以上にする
const noZoom = (style, mobile) => (mobile ? { ...style, fontSize: 16 } : style)

// 子要素を「自然な横幅(width)」で描画し、親の幅に収まるよう縮小する。
// iOS で確実に効く transform:scale を使い、縮小後の高さも詰めて余白を出さない。
function FitToWidth({ width = 700, max = 1, children, style }) {
  const outer = useRef(null)
  const inner = useRef(null)
  const [scale, setScale] = useState(max)
  const [h, setH] = useState(undefined)
  useLayoutEffect(() => {
    const calc = () => {
      if (!outer.current || !inner.current) return
      const avail = outer.current.clientWidth
      if (avail <= 0) return
      const s = Math.min(max, avail / width)
      setScale(s)
      setH(Math.ceil(inner.current.offsetHeight * s) + 2)   // 実高さ×倍率（+端数切上で最終行の見切れ防止）
    }
    calc()
    const ro = new ResizeObserver(calc)
    if (outer.current) ro.observe(outer.current)
    if (inner.current) ro.observe(inner.current)
    window.addEventListener('orientationchange', calc)
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(calc)
    return () => { ro.disconnect(); window.removeEventListener('orientationchange', calc) }
  }, [width, max])
  return (
    <div ref={outer} style={{ width: '100%', maxWidth: '100%', overflow: 'hidden', height: h, ...style }}>
      <div ref={inner} style={{ width, transform: `scale(${scale})`, transformOrigin: 'top left' }}>{children}</div>
    </div>
  )
}

// ============================================================
// ログイン画面
// ============================================================
function LoginPage() {
  const { login } = useAuth()
  const isMobile = useIsMobile()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try { await login(username, password) }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  return (
    <div style={{ ...S.loginRoot, padding: 16 }}>
      <div style={{ ...S.loginCard, padding: isMobile ? '28px 22px' : '40px 36px' }}>
        <div style={S.loginLogo}>
          <div style={{ fontSize: 36 }}>🏗</div>
          <div>
            <div style={S.company}>東部生コン株式会社</div>
            <div style={S.systemTxt}>業務管理システム</div>
          </div>
        </div>
        <form onSubmit={handleSubmit} style={S.form}>
          <div style={S.field}>
            <label style={S.label}>ユーザー名</label>
            <input style={noZoom(S.input, isMobile)} type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="username" autoComplete="username" required />
          </div>
          <div style={S.field}>
            <label style={S.label}>パスワード</label>
            <input style={noZoom(S.input, isMobile)} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" required />
          </div>
          {error && <div style={S.error}>{error}</div>}
          <button style={{ ...S.loginBtn, opacity: loading ? 0.7 : 1 }} type="submit" disabled={loading}>
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>
        {/* デモアカウント案内: z/z でクライアント完結の体験モードに入る */}
        <div style={{ marginTop: 18, padding: 12, background: 'rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 12, color: '#e6ecf5', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>🎯 デモアカウント</div>
          <div>ユーザー名: <b>z</b> / パスワード: <b>z</b></div>
          <div style={{ marginTop: 4, fontSize: 11, opacity: 0.85 }}>「日本生コン」名義。50件の架空データが入っており、変更はブラウザ内(localStorage)のみに保存されます。</div>
        </div>
        <div style={{ textAlign: 'center', marginTop: 24, fontSize: 11, color: '#c0c8d4' }}>{APP_VERSION}</div>
      </div>
    </div>
  )
}

// ============================================================
// フォームフィールド部品
// ============================================================
function Field({ label, value, onChange, required, type = 'text', fullWidth = false }) {
  const isMobile = useIsMobile()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gridColumn: fullWidth ? '1 / -1' : undefined }}>
      <label style={S.smLabel}>{label}</label>
      <input style={noZoom(S.smInput, isMobile)} type={type} value={value} onChange={onChange} required={required} />
    </div>
  )
}

// ============================================================
// 顧客追加・編集モーダル
// ============================================================
const emptyForm = { customerCode: '', companyName: '', companyNameKana: '', phone: '', address: '', contactPerson: '', memo: '', isTradingCompany: false, lineUserId: '' }

function CustomerModal({ customer, onSave, onClose }) {
  const isMobile = useIsMobile()
  const [form, setForm]       = useState(emptyForm)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setForm(customer ? {
      customerCode:    customer.customerCode    || '',
      companyName:     customer.companyName     || '',
      companyNameKana: customer.companyNameKana || '',
      phone:           customer.phone           || '',
      address:         customer.address         || '',
      contactPerson:   customer.contactPerson   || '',
      isTradingCompany: !!customer.isTradingCompany,
      lineUserId:      customer.lineUserId      || '',
    } : emptyForm)
  }, [customer])

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))
  // 商社チェック切替：顧客コードの頭文字を C↔S に入れ替える（数値部は維持）
  const toggleTrading = (checked) => setForm(f => {
    const body = String(f.customerCode || '').replace(/^[CScs]/, '')
    return { ...f, isTradingCompany: checked, customerCode: (checked ? 'S' : 'C') + body }
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try { await onSave(form); onClose() }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        <div style={S.modalHead}>
          <h2 style={S.modalTitle}>{customer ? '顧客編集' : '顧客追加'}</h2>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={S.modalForm}>
          <div style={isMobile ? S.grid1 : S.grid3}>
            <Field label="顧客コード"    value={form.customerCode}    onChange={set('customerCode')} />
            <Field label="会社名 *"      value={form.companyName}     onChange={set('companyName')}     required />
            <Field label="会社名（カナ）" value={form.companyNameKana} onChange={set('companyNameKana')} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, color: '#1a2332' }}>
            <input type="checkbox" checked={!!form.isTradingCompany} onChange={e => toggleTrading(e.target.checked)} style={{ width: 18, height: 18 }} />
            商社（チェックで顧客コードの頭文字が S になります）
          </label>
          <div style={isMobile ? S.grid1 : S.grid2}>
            <Field label="電話番号" value={form.phone}         onChange={set('phone')}         type="tel" />
            <Field label="担当者名" value={form.contactPerson} onChange={set('contactPerson')} />
          </div>
          <Field label="住所" value={form.address} onChange={set('address')} fullWidth />
          <Field label="LINEユーザーID（「現場情報取得」自動返信用）" value={form.lineUserId} onChange={set('lineUserId')} fullWidth />
          {error && <div style={S.error}>{error}</div>}
          <div style={S.actions}>
            <button type="button" style={S.cancelBtn} onClick={onClose}>キャンセル</button>
            <button type="submit" style={{ ...S.saveBtn, opacity: loading ? 0.7 : 1 }} disabled={loading}>
              {loading ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ============================================================
// CSVインポートモーダル
// ============================================================
function ImportModal({ onClose, onDone }) {
  const fileRef               = useRef()
  const [result, setResult]   = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const handleFile = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setError('')
    setLoading(true)
    try {
      const text     = await file.text()
      const rows     = parseCSV(text)
      if (rows.length === 0) { setError('有効なデータがありません'); setLoading(false); return }

      const existing = await api.get('/api/customers')
      const codeMap  = {}
      existing.forEach(c => { if (c.customerCode) codeMap[c.customerCode] = c })

      let added = 0, updated = 0, skipped = 0
      for (const row of rows) {
        if (row.customerCode && codeMap[row.customerCode]) {
          const ex      = codeMap[row.customerCode]
          const changed = CSV_KEYS.some(k => (row[k] || '') !== (ex[k] || ''))
          if (changed) { await api.put(`/api/customers/${ex.id}`, row); updated++ }
          else { skipped++ }
        } else {
          await api.post('/api/customers', row); added++
        }
      }
      setResult({ added, updated, skipped, total: rows.length })
      onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.importBox}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 style={S.modalTitle}>CSVインポート</h2>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>
        {!result ? (
          <>
            <p style={{ fontSize: 12, color: '#6b7a8d', marginBottom: 14, lineHeight: 1.7 }}>
              顧客コードが一致する場合は差分更新、新規は追加します。<br />
              列順：顧客コード・会社名・会社名（カナ）・電話番号・住所・担当者名・メモ
            </p>
            <div
              style={{ border: '2px dashed #dde3ed', borderRadius: 10, padding: '28px 20px', textAlign: 'center', cursor: 'pointer', background: '#f8fafc' }}
              onClick={() => fileRef.current.click()}
            >
              <div style={{ fontSize: 28, marginBottom: 6 }}>📂</div>
              <div style={{ fontSize: 13, color: '#3a4a5c', fontWeight: 600 }}>CSVファイルを選択</div>
              <div style={{ fontSize: 11, color: '#6b7a8d', marginTop: 3 }}>クリックしてファイルを選ぶ</div>
            </div>
            <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleFile} />
            {loading && <div style={{ textAlign: 'center', marginTop: 14, color: '#6b7a8d', fontSize: 13 }}>インポート中...</div>}
            {error   && <div style={{ ...S.error, marginTop: 10 }}>{error}</div>}
          </>
        ) : (
          <>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1a2332', marginBottom: 12 }}>インポート完了</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9, fontSize: 13, color: '#1a2332' }}>
                <div><span style={S.successTag}>追加</span>{result.added} 件</div>
                <div><span style={S.warnTag}>更新</span>{result.updated} 件</div>
                <div><span style={S.skipTag}>スキップ</span>{result.skipped} 件（変更なし）</div>
                <div style={{ borderTop: '1px solid #eef0f4', paddingTop: 9, fontWeight: 600 }}>合計 {result.total} 件処理</div>
              </div>
            </div>
            <button style={{ ...S.saveBtn, width: '100%' }} onClick={onClose}>閉じる</button>
          </>
        )}
      </div>
    </div>
  )
}


// ============================================================
// 従業員追加・編集モーダル
// ============================================================
const emptyEmpForm = { employeeId: '', name: '', nickname: '', lineId: '', type: 'office' }

function EmployeeModal({ employee, onSave, onClose }) {
  const isMobile = useIsMobile()
  const [form, setForm]       = useState(emptyEmpForm)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setForm(employee ? {
      employeeId: employee.employeeId || '',
      name:       employee.name       || '',
      nickname:   employee.nickname   || '',
      lineId:     employee.lineId     || '',
      type:       employee.type       || 'office',
    } : emptyEmpForm)
  }, [employee])

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try { await onSave(form); onClose() }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ ...S.modal, maxWidth: 460 }}>
        <div style={S.modalHead}>
          <h2 style={S.modalTitle}>{employee ? '従業員編集' : '従業員追加'}</h2>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={S.modalForm}>
          <div style={isMobile ? S.grid1 : S.grid2}>
            <Field label="従業員ID" value={form.employeeId} onChange={set('employeeId')} />
            <Field label="氏名 *"   value={form.name}       onChange={set('name')} required />
          </div>
          <div style={isMobile ? S.grid1 : S.grid2}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Field label="呼び名" value={form.nickname} onChange={set('nickname')} />
              <span style={{ fontSize: 11, color: '#6b7a8d', marginTop: 3 }}>入力すると各ページの担当者名がこの呼び名で表示されます（未入力なら氏名）</span>
            </div>
          </div>
          <div style={isMobile ? S.grid1 : S.grid2}>
            <Field label="LINE ID（U…で始まるユーザーID）" value={form.lineId} onChange={set('lineId')} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={S.smLabel}>種別 *</label>
              <select
                style={{ ...noZoom(S.smInput, isMobile), cursor: 'pointer' }}
                value={form.type}
                onChange={set('type')}
                required
              >
                {EMP_TYPES.map(t => (
                  <option key={t} value={t}>{EMP_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
          </div>
          {error && <div style={S.error}>{error}</div>}
          <div style={S.actions}>
            <button type="button" style={S.cancelBtn} onClick={onClose}>キャンセル</button>
            <button type="submit" style={{ ...S.saveBtn, opacity: loading ? 0.7 : 1 }} disabled={loading}>
              {loading ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ============================================================
// 従業員管理ページ
// ============================================================
const EMP_TYPE_COLORS = {
  office: { bg: '#f0f4ff', color: '#1a4d8f', border: '#c0d0f0' },
  driver: { bg: '#f0f9f0', color: '#1a8f5a', border: '#a0dca0' },
  admin:  { bg: '#fff8f0', color: '#e8821a', border: '#f5c070' },
}

function EmployeesPage() {
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const [employees, setEmployees]         = useState([])
  const [loading, setLoading]             = useState(true)
  const [search, setSearch]               = useState('')
  const [modalOpen, setModalOpen]         = useState(false)
  const [editing, setEditing]             = useState(null)
  const [deleteConfirm, setDeleteConfirm] = useState(null)

  const canDelete = user?.role === 'admin' || user?.role === 'manager'

  const load = useCallback(async () => {
    try {
      const data = await api.get('/api/employees')
      rememberEmployees(data)
      setEmployees(data)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = employees.filter(e => {
    if (!search) return true
    const q = String(search).toLowerCase()
    return [e.employeeId, e.name, e.lineId, EMP_TYPE_LABELS[e.type]]
      .some(v => String(v || '').toLowerCase().includes(q))
  })

  const sortEmp = (arr) => [...arr].sort((a, b) => String(a.employeeId ?? '').localeCompare(String(b.employeeId ?? '')))

  const handleSave = async (data) => {
    if (editing && editing.id) {
      const updated = await api.put(`/api/employees/${editing.id}`, data)
      rememberEmployees([updated])
      setEmployees(es => sortEmp(es.map(e => e.id === updated.id ? updated : e)))
    } else if (editing && !editing.id) {
      throw new Error('IDが取得できません。一度ページを更新してください')
    } else {
      const created = await api.post('/api/employees', data)
      rememberEmployees([created])
      setEmployees(es => sortEmp([...es, created]))
    }
  }

  const handleDelete = async (id) => {
    try {
      await api.del(`/api/employees/${id}`)
      setDeleteConfirm(null)
      setEmployees(es => es.filter(e => e.id !== id))
    } catch(e) {
      alert('エラー: ' + e.message)
    }
  }

  const cols = [
    { w: null, label: 'ID' },
    { w: null, label: '氏名' },
    { w: null, label: '呼び名' },
    { w: null, label: '種別' },
    { w: null, label: '' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={S.toolbar}>
        <input style={noZoom(S.search, isMobile)} placeholder="🔍  ID・氏名・種別などで検索" value={search} onChange={e => setSearch(e.target.value)} />
        <button style={S.addBtn} onClick={() => { setEditing(null); setModalOpen(true) }}>＋ 従業員追加</button>
      </div>
      <div style={S.countBar}>{loading ? '読み込み中...' : `${filtered.length} 件`}</div>

      {loading ? (
        <div style={S.empty}>読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div style={S.empty}>{search ? '検索結果がありません' : '従業員が登録されていません'}</div>
      ) : (
        <div className="tw-scroll" style={S.tableWrap}>
          <table style={S.table}>
            <colgroup>{cols.map((c, i) => <col key={i} style={{ width: c.w }} />)}</colgroup>
            <thead>
              <tr>{cols.map(c => <th key={c.label} style={S.th}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {filtered.map(e => {
                const tc = EMP_TYPE_COLORS[e.type] || EMP_TYPE_COLORS.office
                return (
                  <tr key={e.id} style={S.tr}>
                    <td style={S.td}><span style={S.code}>{e.employeeId || '—'}</span></td>
                    <td style={S.td}>
                      <div style={{ fontWeight: 600 }}>{e.name}</div>
                      {e.lineId && <div style={{ fontSize: 11, color: '#6b7a8d' }}>{e.lineId}</div>}
                    </td>
                    <td style={S.td}>{e.nickname ? <span style={{ fontWeight: 600, color: '#1a4d8f' }}>{e.nickname}</span> : <span style={{ color: '#9aa7b5' }}>—</span>}</td>
                    <td style={S.td}>
                      <span style={{ display: 'inline-block', background: tc.bg, color: tc.color, border: `1px solid ${tc.border}`, borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                        {EMP_TYPE_LABELS[e.type] || e.type}
                      </span>
                    </td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                      <button style={S.editBtn} onClick={() => { setEditing(e); setModalOpen(true) }}>編集</button>
                      <button style={{ ...S.delBtn, marginTop: 4, display: 'block' }} onClick={() => setDeleteConfirm(e.id)}>削除</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <EmployeeModal employee={editing} onSave={handleSave} onClose={() => { setModalOpen(false); setEditing(null) }} />
      )}
      {deleteConfirm && (
        <div style={S.overlay}>
          <div style={S.confirmBox}>
            <p style={{ marginBottom: 16, color: '#1a2332', fontSize: 14 }}>この従業員を削除しますか？</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button style={S.cancelBtn} onClick={() => setDeleteConfirm(null)}>キャンセル</button>
              <button style={S.dangerBtn} onClick={() => handleDelete(deleteConfirm)}>削除する</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// 顧客管理ページ
// ============================================================
function CustomersPage() {
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const [customers, setCustomers]         = useState([])
  const [loading, setLoading]             = useState(true)
  const [search, setSearch]               = useState('')
  const [modalOpen, setModalOpen]         = useState(false)
  const [editing, setEditing]             = useState(null)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [importOpen, setImportOpen]       = useState(false)

  const canDelete = user?.role === 'admin' || user?.role === 'manager'

  const load = useCallback(async () => {
    try {
      const data = await api.get('/api/customers')
      setCustomers(data)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // カタカナ→ひらがなに正規化（ひらがなで検索してもカナ欄にヒットする）
  const toHira = kanaToHira
  const filtered = customers.filter(c => {
    if (!search) return true
    const q = toHira(search)
    return [c.customerCode, c.companyName, c.companyNameKana, c.phone, c.address, c.contactPerson]
      .some(v => toHira(v).includes(q))
  })

  const handleSave = async (data) => {
    if (editing && editing.id) {
      const updated = await api.put(`/api/customers/${editing.id}`, data)
      setCustomers(cs => cs.map(c => c.id === updated.id ? updated : c))
    } else if (editing && !editing.id) {
      throw new Error('IDが取得できません。一度ページを更新してください')
    } else {
      const created = await api.post('/api/customers', data)
      setCustomers(cs => [created, ...cs])
    }
  }

  const handleDelete = async (id) => {
    try {
      await api.del(`/api/customers/${id}`)
      setDeleteConfirm(null)
      setCustomers(cs => cs.filter(c => c.id !== id))
    } catch(e) {
      alert('エラー: ' + e.message)
    }
  }

  // テーブル列幅定義
  const cols = [
    { w: null, label: 'コード' },
    { w: null, label: '会社名' },
    { w: null, label: '会社名（カナ）' },
    { w: null, label: '電話番号' },
    { w: null, label: '担当者名' },
    { w: null, label: '住所' },
    { w: null, label: '' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px' }}>
          <input style={noZoom({ ...S.search, width: '100%' }, isMobile)} placeholder="🔍 コード・会社名・電話番号で検索" value={search} onChange={e => setSearch(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <button style={{ ...S.addBtn, flex: '0 0 auto', padding: '11px 14px' }} onClick={() => { setEditing(null); setModalOpen(true) }}>＋ 顧客追加</button>
            <button style={{ ...S.importBtn, flex: '1 1 0', padding: '11px 8px', fontSize: 13 }} onClick={() => setImportOpen(true)}>📤 インポート</button>
            <button style={{ ...S.exportBtn, flex: '1 1 0', padding: '11px 8px', fontSize: 13 }} onClick={() => exportCSV(customers)}>📥 エクスポート</button>
          </div>
        </div>
      ) : (
        <div style={S.toolbar}>
          <input style={noZoom(S.search, isMobile)} placeholder="🔍  コード・会社名・電話番号などで検索" value={search} onChange={e => setSearch(e.target.value)} />
          <button style={S.exportBtn} onClick={() => exportCSV(customers)}>📥 エクスポート</button>
          <button style={S.importBtn} onClick={() => setImportOpen(true)}>📤 インポート</button>
          <button style={S.addBtn}    onClick={() => { setEditing(null); setModalOpen(true) }}>＋ 顧客追加</button>
        </div>
      )}
      <div style={S.countBar}>{loading ? '読み込み中...' : `${filtered.length} 件`}</div>

      {loading ? (
        <div style={S.empty}>読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div style={S.empty}>{search ? '検索結果がありません' : '顧客が登録されていません'}</div>
      ) : (
        <div className="tw-scroll" style={S.tableWrap}>
          <table style={S.table}>
            <colgroup>{cols.map((c, i) => <col key={i} style={{ width: c.w }} />)}</colgroup>
            <thead>
              <tr>{cols.map(c => <th key={c.label} style={S.th}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} style={S.tr}>
                  <td style={S.td}><span style={S.code}>{c.customerCode || '—'}</span></td>
                  <td style={{ ...S.td, fontWeight: 600 }}>{c.companyName}</td>
                  <td style={S.td}>{c.companyNameKana || '—'}</td>
                  <td style={S.td}>{c.phone ? <a href={`tel:${c.phone}`} style={S.tel}>{c.phone}</a> : '—'}</td>
                  <td style={S.td}>{c.contactPerson || '—'}</td>
                  <td style={S.td}>{c.address || '—'}</td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    <button style={S.editBtn} onClick={() => { setEditing(c); setModalOpen(true) }}>編集</button>
                    <button style={S.delBtn} onClick={() => setDeleteConfirm(c.id)}>削除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <CustomerModal customer={editing} onSave={handleSave} onClose={() => { setModalOpen(false); setEditing(null) }} />
      )}
      {deleteConfirm && (
        <div style={S.overlay}>
          <div style={S.confirmBox}>
            <p style={{ marginBottom: 16, color: '#1a2332', fontSize: 14 }}>この顧客を削除しますか？</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button style={S.cancelBtn} onClick={() => setDeleteConfirm(null)}>キャンセル</button>
              <button style={S.dangerBtn} onClick={() => handleDelete(deleteConfirm)}>削除する</button>
            </div>
          </div>
        </div>
      )}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={load} />}
    </div>
  )
}


// ============================================================
// 出荷登録ページ
// ============================================================
const VEHICLE_TYPES = ['4t', '7t', '大型']
const CEMENT_TYPES = ['N', 'B']
const PLACEMENT_TYPES = ['クレーン', 'F1', 'ポンプ', '舟下し']
const POUR_LOCATIONS = ['入力する', 'ステ', '増', '立上り', 'ベース', '土間', 'タタキ']
const NOTE_TAGS = ['領', '追']
const TEST_TAGS = ['現TP', '工TP']            // 試験（現TP=現場 / 工TP=工場）。生コン出荷予定表でのみ集計表示
const NOTE_MESSAGES = ['出荷前TEL', '出る時TEL', 'FAX', '住所TEL有', '7t確認', '大型確認']   // 備考に追加できる定型メッセージ
// 備考(notes)の並び順：手入力(manual)→荷下ろし(unload)→メッセージ追加(msg)。出力もこの順になる
const NOTE_KIND_RANK = { unload: 1, msg: 2 }
const noteRank = (n) => NOTE_KIND_RANK[n && n.kind] ?? 0
const sortNotes = (arr) => (Array.isArray(arr) ? arr : [])
  .map((n, i) => [n, i])
  .sort((a, b) => (noteRank(a[0]) - noteRank(b[0])) || (a[1] - b[1]))
  .map(x => x[0])
// 半角カタカナ→全角カタカナ（濁点・半濁点を合成）。半角カナで入力・登録された文字も検索でヒットさせる
const HK_BASE = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ'
const ZK_BASE = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン'
const DAKUON = { 'カ': 'ガ', 'キ': 'ギ', 'ク': 'グ', 'ケ': 'ゲ', 'コ': 'ゴ', 'サ': 'ザ', 'シ': 'ジ', 'ス': 'ズ', 'セ': 'ゼ', 'ソ': 'ゾ', 'タ': 'ダ', 'チ': 'ヂ', 'ツ': 'ヅ', 'テ': 'デ', 'ト': 'ド', 'ハ': 'バ', 'ヒ': 'ビ', 'フ': 'ブ', 'ヘ': 'ベ', 'ホ': 'ボ', 'ウ': 'ヴ' }
const HANDAKUON = { 'ハ': 'パ', 'ヒ': 'ピ', 'フ': 'プ', 'ヘ': 'ペ', 'ホ': 'ポ' }
function han2zenKana(str) {
  const s = String(str || '')
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const idx = HK_BASE.indexOf(s[i])
    if (idx < 0) { out += s[i]; continue }
    let z = ZK_BASE[idx]
    const next = s[i + 1]
    if (next === 'ﾞ' && DAKUON[z]) { z = DAKUON[z]; i++ }
    else if (next === 'ﾟ' && HANDAKUON[z]) { z = HANDAKUON[z]; i++ }
    out += z
  }
  return out
}
// カタカナ→ひらがなに正規化（ひらがな検索でカナ欄にヒットさせる。半角カナも対象）
const kanaToHira = (str) => han2zenKana(String(str || '').toLowerCase()).replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
const DEFAULT_SITE_ADDRESS = '〒842-0121 佐賀県神埼市神埼町志波屋２０２０'
// 全角数字→半角数字（出荷登録の入力用）。数字以外はそのまま
const z2h = (str) => String(str ?? '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))

// 数量表示（m³・+a・? と2段目の量をまとめる）
function shipVolStr(s) {
  const one = (v, a, u) => { const b = (v == null ? '' : String(v)).trim(); return (!b && !a && !u) ? '' : `${b}${b ? 'm³' : ''}${a ? '+a' : ''}${u ? '?' : ''}` }
  return [one(s.volume, s.volumePlusA, s.volumeUncertain), one(s.volume2, s.volumePlusA2, s.volumeUncertain2)].filter(Boolean).join(' / ')
}

// 量の数値表示色：整数部が3桁以上(100㎥〜)なら赤、2桁以下なら黒。常に太字（全画面共通ルール）。
// 範囲入力（例 13〜14）は「〜」より前の数値の桁で判定する。
function volIntLen(v) {
  const first = String(v ?? '').split('〜')[0]
  return first.trim().replace(/[^0-9.]/g, '').split('.')[0].replace(/^0+(?=\d)/, '').length
}
function volNumColor(v) {
  return volIntLen(v) >= 3 ? '#c81e1e' : '#111'
}
// 量の数値スタイル：2桁=黒の太字／3桁=赤の太字／それ以外(1桁・4桁以上)は太字にしない。範囲(13〜14)は先頭の数値で判定
function volNumStyle(v) {
  const n = volIntLen(v)
  if (n === 2) return { fontWeight: 700, color: '#111' }
  if (n === 3) return { fontWeight: 700, color: '#c81e1e' }
  return { fontWeight: 400, color: '#111' }
}
// 量を表示する共通レンダラ。unit=true で m³ を付与。値が無ければ fallback を返す。量の特記(volumeNote)があれば数値の前に小さく表示
function VolNum({ s, unit = false, sep = ' / ', fallback = null, stacked = false }) {
  const segs = [[s.volume, s.volumePlusA, s.volumeUncertain, s.volumeNote], [s.volume2, s.volumePlusA2, s.volumeUncertain2, s.volumeNote2]]
    .map(([v, a, u, note]) => { const b = (v == null ? '' : String(v)).trim(); return (!b && !a && !u) ? null : { num: b, note: String(note || '').trim(), text: `${b}${unit && b ? 'm³' : ''}${a ? '+a' : ''}${u ? '?' : ''}` } })
    .filter(Boolean)
  if (!segs.length) return fallback
  // stacked: 特記を数字の上に小さく表示（横幅を抑える）
  if (stacked) {
    return <>{segs.map((seg, i) => (<Fragment key={i}>{i > 0 ? sep : ''}<span style={{ display: 'inline-block', textAlign: 'center', verticalAlign: 'bottom' }}>{seg.note ? <span style={{ display: 'block', fontSize: '.68em', color: '#0f3060', lineHeight: 1.1 }}>{seg.note}</span> : null}<span style={volNumStyle(seg.num)}>{seg.text}</span></span></Fragment>))}</>
  }
  return <>{segs.map((seg, i) => (<Fragment key={i}>{i > 0 ? sep : ''}{seg.note ? <span style={{ fontSize: '.72em', color: '#0f3060', background: '#eef4ff', borderRadius: 4, padding: '0 4px', marginRight: 3 }}>{seg.note}</span> : ''}<span style={volNumStyle(seg.num)}>{seg.text}</span></Fragment>))}</>
}

// 車種表示: vehicleItems があれば車種名を「・」連結、無ければ vehicleType をそのまま（台数は表記しない）
function vehicleLabel(s) {
  if (Array.isArray(s.vehicleItems) && s.vehicleItems.length) {
    return s.vehicleItems.map(v => v.type).join('・')
  }
  return s.vehicleType || ''
}
// 車両自由入力(vehicleFree)の表示先（予定表両方で共通）:
//   全角6文字以内 / 半角12文字以内（＝半角換算12幅以内）→ 車両欄に表示
//   それを超える長い補足 → 電話番号の右（摘要）に表示
function vfWidth(t) {
  let w = 0
  for (const ch of String(t)) { const c = ch.codePointAt(0); w += (c <= 0x7F || (c >= 0xFF61 && c <= 0xFF9F)) ? 1 : 2 }   // 半角=1・全角=2
  return w
}
function vfPlace(vf) {
  const t = String(vf || '').trim()
  if (!t) return { veh: '', over: '' }
  return vfWidth(t) <= 12 ? { veh: t, over: '' } : { veh: '', over: t }
}
// 車両欄に出す補足の文字サイズ：長い(全角5〜6文字)ほど小さくしてセル幅に収める。base=短い時の基準px
function vfVehFont(t, base = 12) {
  const w = vfWidth(t)
  if (w <= 4) return base            // 〜全角2/半角4
  if (w <= 6) return base - 1        // 〜全角3
  if (w <= 8) return base - 2        // 〜全角4
  if (w <= 10) return base - 3       // 〜全角5
  return base - 4                    // 全角6
}
// 出荷予定表（一覧）専用: 車種列を 7% に絞った分、補足文字を大きめ(数量18pxと同等の読みやすさ)に
function vfVehFontSchedule(t) {
  const w = vfWidth(t)
  if (w <= 4) return 18              // 〜全角2
  if (w <= 6) return 17              // 〜全角3
  if (w <= 8) return 16              // 〜全角4
  if (w <= 10) return 14             // 〜全角5
  return 12                          // 全角6+
}
// 配合表示: mixRows があれば各行を配列で（{code,note}）、無ければ mixCode/mixNotes 1行
// 配合は3枠の位置を保持（例: 中央のみ→「-20-」、先頭のみ→「20--」）。数字が無い時は空。
function mixCodeOf(parts) {
  const c = (parts || []).slice(0, 3).join('-')
  return /[0-9]/.test(c) ? c : ''
}
// 配合コードの表示：「-」は残したまま、空セクションを全角空白で表示（例 "24--" → "24-　-　"、"-20-" → "　-20-　"）。
// 位置（先頭/中央/末尾）が分かり、桁構成も保てる。
function mixDisplay(code) {
  const s = String(code || '')
  if (!s.includes('-')) return s
  return s.split('-').map(p => (p || '').trim() || '　').join('-')
}
function mixRowsOfShip(s) {
  // モルタル(1:1〜1:4)・ドライテックは mixCode をそのまま1行として返す
  // （mixRows は数値モード用の {parts:[],note} 形式しか持たないため、
  //   モルタル/ドライテックでは mixCode を直接表示できるようフォールバックする）
  const code = String(s.mixCode || '')
  if (code === 'ドライテック' || /^1:[1-4]$/.test(code)) {
    return [{ code, note: (Array.isArray(s.mixNotes) ? s.mixNotes[1] : '') || '' }]
  }
  if (Array.isArray(s.mixRows) && s.mixRows.length) {
    return s.mixRows.map(r => ({ code: mixCodeOf(r.parts), note: r.note || '' }))
  }
  return [{ code: s.mixCode || '', note: (Array.isArray(s.mixNotes) ? s.mixNotes[1] : '') || '' }]
}

const emptyShipForm = {
  date: localToday(),
  orderDate: localToday(),   // 受注日（作成日。読み取り専用で変更不可）
  companyId: '', companyName: '',
  tradingCompany: '',
  times: [{ text: '', important: false }],
  siteName: '',
  siteAddress: '',
  vehicleType: '',
  truckCount: '',
  vehicleItems: [],     // [{ type:'4t', qty:'2' }] 車種＋数量。vehicleType は表示互換用に同期
  vehicleFree: '',      // 車種の自由入力（補足）。出荷予定表の備考列・生コン予定表の電話番号横に表示
  mixCode: '',
  specialNote: '',
  mixNotes: ['', '', ''],
  mixRows: [{ parts: ['', '', ''], note: '' }],   // 配合の複数行。1行目を mixCode/mixNotes に同期
  mixMode: 'num',   // 配合モード: 'num'=数値 / 'mortar'=モルタル(1:1〜1:4) / 'dry'=ドライテック
  cementType: '',
  cementType2: '',          // 2つ目のセメント種（2段目の配合に対応）
  hasCementType2: false,    // 2段目セメント種の表示フラグ（＋追加で出現）
  volume: '',
  volumeNote: '',            // 量の特記（数値の上に小さく表示。配合の特記と同じ要領）
  volumeUncertain: false,
  volumePlusA: false,        // 量に「+a」を付ける
  volumeRange: false,        // 量を範囲（13〜14）で入力するか（UI用）
  hasVolume2: false,         // 2段目の量を使うか（UI用）
  volume2: '',
  volumeNote2: '',           // 2段目の量の特記
  volumeUncertain2: false,
  volumePlusA2: false,
  volumeRange2: false,
  pdfName: '',               // 添付PDFのファイル名
  pdfData: '',               // 添付PDFの本体(dataURL)。保存時のみ送信、未変更は空
  hasPdf: false,             // 既存伝票にPDFが添付済みか
  pdfRemove: false,          // 既存PDFを削除する指示（保存時に反映）
  placements: [],
  pourLocation: '',
  pourFree: false,      // 打設箇所を自由入力モードにしているか
  noteTags: [],         // 領 / 追 の選択
  testTags: [],         // 試験（現TP / 工TP）
  mapReceived: false,   // 受信確認：地図が届いたか
  faxReceived: false,   // 受信確認：FAXが届いたか
  orderContact: '', siteContact: '',
  drivers: [],
  notes: [{ text: '', important: false }],
  driverMessages: [{ text: '', important: false }],
  mapView: null,        // 固定した地図の {lat,lng,zoom}（null=未固定）
  mapPin: null,          // ピン（マーカー）の正確な位置 {lat,lng}（null=未設定）
  mapArrows: [],         // 矢印 [{x1,y1,x2,y2}]（相対座標0-1）
}

// テキストをマス内に収めるよう自動縮小
function fitText(ta, min = 7) {
  if (!ta) return
  const max = 22
  let size = max
  ta.style.fontSize = size + 'px'
  let guard = 0
  while (size > min && ta.scrollHeight > ta.clientHeight && guard < 40) {
    size--; ta.style.fontSize = size + 'px'; guard++
  }
}

// 横幅に収まるよう文字サイズを自動縮小する input（現場名・現場住所など）。
// プレースホルダ（透かし）も実テキストと同じく縮小される（同じ要素の font-size を縮めるため）。
function FitField({ value, onChange, placeholder, className = 'f', baseSize = 15, min = 9, type = 'text', style, lang, dataIme }) {
  const ref = useRef(null)
  const composingRef = useRef(false)   // IME変換中フラグ
  const fit = () => {
    if (composingRef.current) return   // 変換中はフォント自動調整しない（変換が壊れるため）
    const el = ref.current
    if (!el) return
    el.style.fontSize = baseSize + 'px'
    let size = baseSize, guard = 0
    // 入力が空のときはプレースホルダ幅で測る
    while (el.scrollWidth > el.clientWidth + 1 && size > min && guard < 60) {
      size -= 0.5; el.style.fontSize = size + 'px'; guard++
    }
  }
  useLayoutEffect(() => { requestAnimationFrame(fit) })
  useEffect(() => {
    const on = () => requestAnimationFrame(fit)
    window.addEventListener('resize', on)
    window.addEventListener('orientationchange', on)
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(fit))
    return () => { window.removeEventListener('resize', on); window.removeEventListener('orientationchange', on) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    // IME変換中も onChange を常に通す（親の set が composing 中は z2h せず生値を保持）。
    // こうすると controlled value が DOM と一致し続け、外部要因（地図のidle等）で
    // 変換中に再描画が起きても React に入力欄を巻き戻されず、変換が壊れない。
    // 変換確定は onCompositionEnd でも onChange を呼んで z2h を反映する。
    // composingRef はフォント自動調整(fit)を変換中だけ止めるためにのみ使う。
    <input ref={ref} className={className} type={type} value={value} lang={lang}
      autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
      data-ime={dataIme}
      onChange={e => { onChange(e); requestAnimationFrame(fit) }}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={e => { composingRef.current = false; onChange(e); requestAnimationFrame(fit) }}
      placeholder={placeholder} style={style} />
  )
}

// 折り返し対応の自動縮小フィールド（現場名用）。まず最大 maxLines 行まで折り返し、
// それでも収まらない時だけフォントを段階的に縮小する（＝小さくする前に改行する）。
function FitArea({ value, onChange, placeholder, lang, style, maxLines = 3, baseSize = 15, min = 11 }) {
  const ref = useRef(null)
  const composingRef = useRef(false)
  const fit = () => {
    if (composingRef.current) return
    const el = ref.current
    if (!el) return
    let size = baseSize
    el.style.fontSize = size + 'px'
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
    let guard = 0
    // 内容が maxLines 行を超える間だけ、少しずつフォントを縮小する
    while (el.scrollHeight > size * 1.3 * maxLines + 2 && size > min && guard < 60) {
      size -= 0.5
      el.style.fontSize = size + 'px'
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
      guard++
    }
  }
  useLayoutEffect(() => { requestAnimationFrame(fit) })
  useEffect(() => {
    const on = () => requestAnimationFrame(fit)
    window.addEventListener('resize', on)
    window.addEventListener('orientationchange', on)
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(fit))
    return () => { window.removeEventListener('resize', on); window.removeEventListener('orientationchange', on) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <textarea ref={ref} className="f" rows={1} value={value} lang={lang}
      onChange={e => { onChange(e); requestAnimationFrame(fit) }}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={e => { composingRef.current = false; onChange(e); requestAnimationFrame(fit) }}
      placeholder={placeholder}
      style={{ resize: 'none', overflow: 'hidden', lineHeight: 1.3, whiteSpace: 'normal', wordBreak: 'break-word', flex: 'none', ...style }} />
  )
}

// カナ（ひらがな/カタカナ）でも絞り込めるオートコンプリート入力（業者名・商社名用）
// 顧客管理の検索と同じ「インライン描画」方式で確実に表示する（ポータル/座標計算は使わない）
function KanaCombo({ value, onChange, onPick, options, placeholder, className = 'f', style, required }) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)   // ▼で開いたら全件、入力中は絞り込み
  const wrapRef = useRef(null)
  const blurTimer = useRef(null)
  const q = kanaToHira(value)
  const filtered = ((value && !showAll) ? options.filter(o => kanaToHira(o.label).includes(q) || kanaToHira(o.kana).includes(q)) : options).slice(0, 200)
  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setShowAll(false) } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('touchstart', onDoc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('touchstart', onDoc) }
  }, [])
  const pick = (o) => { if (blurTimer.current) clearTimeout(blurTimer.current); onPick(o); setOpen(false); setShowAll(false) }
  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, minWidth: 0, width: '100%', display: 'flex', alignItems: 'stretch' }}>
      <input className={className} style={style} value={value} placeholder={placeholder} required={required}
        data-ime="kana"
        onChange={e => { onChange(e); setShowAll(false); setOpen(true) }}
        onFocus={() => { if (blurTimer.current) clearTimeout(blurTimer.current); setOpen(true) }}
        onBlur={() => { blurTimer.current = setTimeout(() => { setOpen(false); setShowAll(false) }, 200) }} />
      <button type="button" tabIndex={-1} title="一覧から選択"
        onMouseDown={(e) => { e.preventDefault(); setShowAll(true); setOpen(o => !o) }}
        style={{ flex: '0 0 auto', border: 'none', background: 'transparent', cursor: 'pointer', color: '#1a4d8f', fontSize: 16, padding: '0 6px', alignSelf: 'center' }}>▼</button>
      {/* 入力欄にフォーカスがある時かつ候補がある時だけ表示（該当なしのときは出さない） */}
      {open && filtered.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999, background: '#fff', border: '1px solid #cdd5e0', borderRadius: 6, boxShadow: '0 6px 18px rgba(0,0,0,.18)', maxHeight: 260, overflowY: 'auto' }}>
          {filtered.map((o, i) => (
            <div key={(o.id || o.label) + '_' + i} onMouseDown={(e) => { e.preventDefault(); pick(o) }} onClick={() => pick(o)}
              style={{ padding: '9px 10px', fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#111', borderBottom: '1px solid #f2f4f8' }}>
              {o.label}{o.kana ? <span style={{ color: '#9aa7b5', fontSize: 11, marginLeft: 6 }}>{o.kana}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 選択チップ（単一 / 配列複数 multi / 文字列複数 multiStr）
// multiStr: 値は "4t・7t" のような・連結文字列。保存形式を文字列のまま複数選択にできる。
function Chips({ options, value, multi, multiStr, onChange, big }) {
  const strList = () => String(value || '').split('・').map(s => s.trim()).filter(Boolean)
  const isOn = (o) => multiStr ? strList().includes(o) : multi ? (value || []).includes(o) : value === o
  const toggle = (o) => {
    if (multiStr) {
      const cur = strList()
      const next = cur.includes(o) ? cur.filter(x => x !== o) : [...cur, o]
      // options の並び順を保って連結（4t→7t→大型）
      onChange(options.filter(op => next.includes(op)).join('・'))
    } else if (multi) {
      const cur = value || []
      onChange(cur.includes(o) ? cur.filter(x => x !== o) : [...cur, o])
    } else {
      onChange(value === o ? '' : o)
    }
  }
  return (
    <div className={'chips' + (big ? ' big' : '')}>
      {options.map(o => (
        <span key={o} className={'chip' + (isOn(o) ? ' on' : '')} onClick={() => toggle(o)}>{o}</span>
      ))}
    </div>
  )
}

// 固定枠＋分割＋文字自動リサイズの動的マス群（時間 / 備考 / ドライバー連絡 共通）
function DenpyoGrid({ items, onChange, cols = 2, max = Infinity, height = 90, addLabel, minSize = 7, dataIme }) {
  const refs = useRef([])
  const composingRef = useRef(false)   // IME変換中フラグ
  const refit = () => requestAnimationFrame(() => {
    if (composingRef.current) return   // 変換中はフォント自動調整を行わない（変換が壊れるため）
    for (let i = 0; i < items.length; i++) fitText(refs.current[i], minSize)
  })
  useLayoutEffect(() => { refit() })
  useEffect(() => {
    const onResize = () => refit()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const update = (i, patch) => onChange(items.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  const add = () => { if (items.length < max) onChange([...items, { text: '', important: false }]) }
  const del = (i) => {
    if (items.length > 1) onChange(items.filter((_, idx) => idx !== i))
    else onChange([{ text: '', important: false }])
  }
  return (
    <>
      <div className="memo-grid" style={{ '--memo-cols': cols, '--memo-h': height + 'px' }}>
        {items.map((it, i) => (
          <div className="memo-cell" key={i}>
            {/* IME変換中も onChange で値を反映し controlled value を DOM と一致させる。
                変換中の再描画で入力が巻き戻る/効かなくなるのを防ぐ。フォント調整(refit)だけ変換中は止める。 */}
            <textarea
              ref={el => { refs.current[i] = el }}
              className={it.important ? 'is-imp' : ''}
              value={it.text}
              data-ime={dataIme}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={e => { composingRef.current = false; update(i, { text: e.target.value }); requestAnimationFrame(() => fitText(refs.current[i], minSize)) }}
              onChange={e => update(i, { text: e.target.value })}
            />
            <div className="ctl">
              <button type="button" className={'imp' + (it.important ? ' on' : '')} title="重要" onClick={() => update(i, { important: !it.important })}>!</button>
              <button type="button" className="del" title="削除" onClick={() => del(i)}>×</button>
            </div>
          </div>
        ))}
      </div>
      {items.length < max && <button type="button" className="addrow" onClick={add}>{addLabel}</button>}
    </>
  )
}

// ===== Google マップ（現場住所） =====
const GMAPS_KEY = import.meta.env.VITE_GMAPS_API_KEY || ''
let _gmapsPromise = null
function loadGoogleMaps() {
  if (typeof window !== 'undefined' && window.google && window.google.maps) return Promise.resolve(window.google.maps)
  if (_gmapsPromise) return _gmapsPromise
  _gmapsPromise = new Promise((resolve, reject) => {
    if (!GMAPS_KEY) { reject(new Error('NO_KEY')); return }
    window.__gmapsReady = () => resolve(window.google.maps)
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GMAPS_KEY}&callback=__gmapsReady&language=ja&region=JP&loading=async`
    s.async = true
    s.onerror = () => reject(new Error('LOAD_FAILED'))
    document.head.appendChild(s)
  })
  return _gmapsPromise
}

function cleanupJpAddress(s) {
  return String(s || '').replace(/^日本、?\s*/, '').replace(/〒?\s*\d{3}-?\d{4}\s*/, '').trim()
}

// 文字列中の「緯度経度」数値を取り出す（例: 33.123456, 130.123456）
function extractCoords(s) {
  const m = String(s || '').match(/(-?\d{1,3}\.\d{3,})\s*[,，]\s*(-?\d{1,3}\.\d{3,})/)
  if (!m) return null
  return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) }
}

// canvas に矢印を1本描く（line + 矢じり）
function drawArrow(ctx, x1, y1, x2, y2, w) {
  const head = Math.max(10, Math.min(w * 0.04, 26))
  const ang = Math.atan2(y2 - y1, x2 - x1)
  ctx.lineWidth = Math.max(3, Math.min(w * 0.012, 8))
  ctx.strokeStyle = '#e8211c'
  ctx.fillStyle = '#e8211c'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6))
  ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6))
  ctx.closePath(); ctx.fill()
}

// 地図のデフォルト縮尺（16からホイール4回ズームイン=20、そこから2回ズームアウト=18）
const DEFAULT_MAP_ZOOM = 18

function SiteMap({ address, onAddressChange, mapView, onMapViewChange, arrows, onArrowsChange, pin, onPinChange, actions }) {
  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const geocoderRef = useRef(null)
  const selfSetRef = useRef('')   // 地図側で設定した住所値（ループ防止）
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const overlayRef = useRef(null)  // 投影（latlng⇔px変換）取得用 OverlayView
  const draftRef = useRef(null)    // ドラッグ中の矢印（ピクセル座標 {x1,y1,x2,y2}）
  const [status, setStatus] = useState('loading')
  const [drawMode, setDrawMode] = useState(false)  // 矢印描画モード（地図をロックして描く）
  // 最新値を非同期コールバック（OverlayView.draw / idle）から参照するための ref
  const arrowsRef = useRef(arrows); arrowsRef.current = arrows
  const onViewRef = useRef(onMapViewChange); onViewRef.current = onMapViewChange
  // ピン（マーカー）の正確な位置を保存するためのコールバック。マーカーが動くたびに記録する
  const onPinRef = useRef(onPinChange); onPinRef.current = onPinChange
  const recordPin = (latLng) => {
    try {
      const lat = typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat
      const lng = typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng
      if (onPinRef.current && typeof lat === 'number' && typeof lng === 'number') onPinRef.current({ lat, lng })
    } catch { /* noop */ }
  }

  const doGeocode = (addr) => {
    const g = geocoderRef.current
    if (!g || !mapRef.current) return
    // 住所に緯度経度が含まれていればその座標を直接使う（再ジオコード不要）
    const c = extractCoords(addr)
    if (c && window.google) {
      const loc = new window.google.maps.LatLng(c.lat, c.lng)
      mapRef.current.setCenter(loc)
      mapRef.current.setZoom(DEFAULT_MAP_ZOOM)
      markerRef.current.setPosition(loc)
      recordPin(loc)
      setStatus('')
      return
    }
    g.geocode({ address: addr }, (res, st) => {
      if (st === 'OK' && res[0]) {
        const loc = res[0].geometry.location
        mapRef.current.setCenter(loc)
        mapRef.current.setZoom(DEFAULT_MAP_ZOOM)
        markerRef.current.setPosition(loc)
        recordPin(loc)
        setStatus('')
      } else {
        setStatus('notfound')
      }
    })
  }

  // 描画モード中だけ地図のパン/ズーム・ピンドラッグをロックする
  const applyLock = (opts = {}) => {
    const m = mapRef.current
    if (!m) return
    const lock = opts.draw ?? drawMode
    m.setOptions({
      gestureHandling: lock ? 'none' : 'cooperative',
      zoomControl: !lock,
      draggable: !lock,
      scrollwheel: !lock,
      disableDoubleClickZoom: lock,
      keyboardShortcuts: !lock,
      clickableIcons: !lock,
    })
    if (markerRef.current) markerRef.current.setDraggable(!lock)
  }

  // ===== 矢印キャンバス =====
  const sizeCanvas = () => {
    const cv = canvasRef.current, wrap = wrapRef.current
    if (!cv || !wrap) return
    const r = wrap.getBoundingClientRect()
    if (cv.width !== Math.round(r.width) || cv.height !== Math.round(r.height)) {
      cv.width = Math.round(r.width); cv.height = Math.round(r.height)
    }
  }
  // 緯度経度 → コンテナ内ピクセル（投影が未準備なら null）
  const latLngToPx = (lat, lng) => {
    const ov = overlayRef.current
    const proj = ov && ov.getProjection && ov.getProjection()
    if (!proj || !window.google) return null
    const p = proj.fromLatLngToContainerPixel(new window.google.maps.LatLng(lat, lng))
    return p ? { x: p.x, y: p.y } : null
  }
  // コンテナ内ピクセル → 緯度経度
  const pxToLatLng = (x, y) => {
    const ov = overlayRef.current
    const proj = ov && ov.getProjection && ov.getProjection()
    if (!proj || !window.google) return null
    const ll = proj.fromContainerPixelToLatLng(new window.google.maps.Point(x, y))
    return ll ? { lat: ll.lat(), lng: ll.lng() } : null
  }

  const redraw = () => {
    const cv = canvasRef.current
    if (!cv) return
    sizeCanvas()
    const ctx = cv.getContext('2d')
    const w = cv.width, h = cv.height
    ctx.clearRect(0, 0, w, h)
    // 矢印は緯度経度で保持 → 現在の地図位置・ズームに合わせて投影し描画（パン/ズームに追従）
    for (const a of (arrowsRef.current || [])) {
      if (typeof a.lat1 !== 'number' || typeof a.lat2 !== 'number') continue  // 旧形式は無視
      const p1 = latLngToPx(a.lat1, a.lng1), p2 = latLngToPx(a.lat2, a.lng2)
      if (p1 && p2) drawArrow(ctx, p1.x, p1.y, p2.x, p2.y, w)
    }
    const d = draftRef.current
    if (d) drawArrow(ctx, d.x1, d.y1, d.x2, d.y2, w)
  }
  useEffect(() => { redraw() }, [arrows, drawMode])
  useEffect(() => {
    const on = () => redraw()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const relPx = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width * canvasRef.current.width, y: (e.clientY - r.top) / r.height * canvasRef.current.height }
  }
  const onDown = (e) => {
    if (!drawMode) return
    e.preventDefault()
    const p = relPx(e)
    draftRef.current = { x1: p.x, y1: p.y, x2: p.x, y2: p.y }
    try { canvasRef.current.setPointerCapture(e.pointerId) } catch {}
  }
  const onMove = (e) => {
    if (!draftRef.current) return
    const p = relPx(e)
    draftRef.current.x2 = p.x; draftRef.current.y2 = p.y
    redraw()
  }
  const onUp = () => {
    const d = draftRef.current
    draftRef.current = null
    if (!d) return
    const dist = Math.hypot(d.x2 - d.x1, d.y2 - d.y1)
    if (dist > 8) {   // 短すぎる線は無視（8px）
      const a = pxToLatLng(d.x1, d.y1), b = pxToLatLng(d.x2, d.y2)
      if (a && b) onArrowsChange([...(arrowsRef.current || []), { lat1: a.lat, lng1: a.lng, lat2: b.lat, lng2: b.lng }])
      else redraw()
    } else redraw()
  }
  const undoArrow = () => onArrowsChange((arrows || []).slice(0, -1))
  const clearArrows = () => { if (window.confirm('矢印をすべて消去しますか？')) onArrowsChange([]) }

  // 矢印描画モードのオン/オフ（オン中だけ地図をロックして描きやすくする）
  const toggleDraw = () => {
    setDrawMode(d => {
      const next = !d
      applyLock({ draw: next })
      return next
    })
  }

  useEffect(() => {
    let cancelled = false
    loadGoogleMaps().then(maps => {
      if (cancelled || !mapEl.current) return
      geocoderRef.current = new maps.Geocoder()
      // 保存済みの地図ビューがあればその位置・ズームで開く（矢印を正しく重ねるため）
      const hasView = mapView && typeof mapView.lat === 'number'
      // 保存済みピン（ドラッグで決めた正確な位置）があれば最優先で復元する
      const savedPin = (pin && typeof pin.lat === 'number' && typeof pin.lng === 'number') ? { lat: pin.lat, lng: pin.lng } : null
      const start = hasView ? { lat: mapView.lat, lng: mapView.lng } : (savedPin || { lat: 35.681236, lng: 139.767125 })
      const map = new maps.Map(mapEl.current, {
        center: start, zoom: hasView ? mapView.zoom : DEFAULT_MAP_ZOOM, streetViewControl: false, mapTypeControl: false, fullscreenControl: false,
        gestureHandling: 'cooperative',
      })
      mapRef.current = map
      markerRef.current = new maps.Marker({ map, position: savedPin || start, draggable: true })
      markerRef.current.addListener('dragend', () => {
        const pos = markerRef.current.getPosition()
        recordPin(pos)   // ドラッグした正確な位置を保存（保存後に元へ戻らないように）
        geocoderRef.current.geocode({ location: pos }, (res, st) => {
          const addr = (st === 'OK' && res[0]) ? cleanupJpAddress(res[0].formatted_address) : ''
          if (addr) { selfSetRef.current = addr; onAddressChange(addr) }
        })
      })

      // 投影取得用の OverlayView。draw() が地図のパン/ズーム毎に呼ばれるので矢印を追従描画
      const ov = new maps.OverlayView()
      ov.onAdd = () => {}
      ov.onRemove = () => {}
      ov.draw = () => redraw()
      ov.setMap(map)
      overlayRef.current = ov

      // 地図が動いたら現在のビュー（中心・ズーム）を保存して矢印位置の基準を最新化
      const saveView = () => {
        const c = map.getCenter()
        if (c) onViewRef.current({ lat: c.lat(), lng: c.lng(), zoom: map.getZoom() })
      }
      map.addListener('idle', saveView)

      setStatus('')
      // 保存済みビューもピンも無いときだけ、住所からジオコードしてピンを置く
      if (!hasView && !savedPin) {
        doGeocode((address && address.trim()) ? address : DEFAULT_SITE_ADDRESS)
      }
      requestAnimationFrame(redraw)
    }).catch(err => {
      if (!cancelled) setStatus(err.message === 'NO_KEY' ? 'nokey' : 'error')
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!geocoderRef.current) return
    if (drawMode) return                         // 描画中は住所変更で地図を動かさない
    if (address === selfSetRef.current) return   // ピンドラッグ由来→再ジオコードしない
    // ユーザーが住所を編集した → 旧住所用に描いた矢印は破棄し、新住所へ地図を移動して再同期する。
    // （矢印が残ると地図が動かず、保存される地図位置と住所がズレてLINEの地図画像が一致しなくなる）
    if ((arrowsRef.current || []).length) onArrowsChange([])
    const target = (address && address.trim()) ? address : DEFAULT_SITE_ADDRESS
    const t = setTimeout(() => doGeocode(target), 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, drawMode])

  return (
    <div>
      <div ref={wrapRef} style={{ position: 'relative' }}>
        <div ref={mapEl} className="sitemap-canvas" />
        <canvas
          ref={canvasRef}
          className="sitemap-arrows"
          style={{ pointerEvents: drawMode ? 'auto' : 'none', cursor: drawMode ? 'crosshair' : 'default' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {drawMode && (
          <div className="sitemap-badge">✏️ 描画モード — 地図上をドラッグで矢印を描けます</div>
        )}
      </div>

      <div className="map-actions">
        <button type="button" onClick={toggleDraw} disabled={status !== ''}
          style={{ border: '1.5px solid #0f3060', background: drawMode ? '#0f3060' : '#fff', color: drawMode ? '#fff' : '#0f3060' }}>
          {drawMode ? '✓ 描画終了' : '✏️ 矢印'}
        </button>
        <button type="button" onClick={undoArrow} disabled={!(arrows || []).length}
          style={{ border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', opacity: (arrows || []).length ? 1 : 0.5 }}>↩ 戻す</button>
        <button type="button" onClick={clearArrows} disabled={!(arrows || []).length}
          style={{ border: '1.5px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', opacity: (arrows || []).length ? 1 : 0.5 }}>🗑 消去</button>
        {actions}
      </div>

      {status === 'loading' && <div style={{ fontSize: 12, color: '#6b7a8d', marginTop: 4 }}>地図を読み込み中...</div>}
      {status === 'notfound' && <div style={{ fontSize: 12, color: '#c0392b', marginTop: 4 }}>住所が見つかりませんでした。ピンを動かして調整してください。</div>}
      {status === 'nokey' && <div style={{ fontSize: 12, color: '#c0392b', marginTop: 4 }}>地図APIキーが未設定です（Vercelに VITE_GMAPS_API_KEY を設定してください）</div>}
      {status === 'error' && <div style={{ fontSize: 12, color: '#c0392b', marginTop: 4 }}>地図の読み込みに失敗しました</div>}
      {drawMode && (
        <div style={{ fontSize: 11, color: '#6b7a8d', marginTop: 4 }}>
          ✏️ 地図上をドラッグして矢印を描きます。描き終えたら「描画を終える」を押すと地図を動かせます
        </div>
      )}
    </div>
  )
}

// 伝票→フォーム初期値（出荷登録フォーム／スマホ予定表の編集モーダルで共用）。
// vehicleItems/mixRows/notes(kind付き)など構造化フィールドを既存伝票から復元する。
function shipmentToForm(s) {
  return ({
    date: s.date || localToday(),
    orderDate: s.orderDate || (s.createdAt ? String(s.createdAt).slice(0, 10) : (s.date || localToday())),
    companyId: s.companyId || '',
    companyName: s.companyName || '',
    tradingCompany: s.tradingCompany || '',
    times: (Array.isArray(s.times) && s.times.length ? s.times : ['']).map(t => ({ text: String((t && t.text != null) ? t.text : t ?? ''), important: !!(t && typeof t === 'object' && t.important) })),
    siteName: s.siteName || '',
    siteAddress: (s.siteAddress || '').replace(/（緯度経度:[^）]*）/g, '').trim(),
    vehicleType: s.vehicleType || '',
    truckCount: (s.truckCount ?? '') === '' ? '' : String(s.truckCount),
    vehicleFree: s.vehicleFree || '',
    vehicleItems: (Array.isArray(s.vehicleItems) && s.vehicleItems.length)
      ? s.vehicleItems.map(v => ({ type: v.type, qty: (v.qty ?? '') === '' ? '1' : String(v.qty) }))
      : String(s.vehicleType || '').split('・').map(x => x.trim()).filter(Boolean).map(t => ({ type: t, qty: '1' })),
    mixCode: s.mixCode || '',
    specialNote: s.specialNote || '',
    mixNotes: (Array.isArray(s.mixNotes) && s.mixNotes.length) ? [s.mixNotes[0] || '', s.mixNotes[1] || '', s.mixNotes[2] || ''] : [s.specialNote || '', '', ''],
    mixRows: (Array.isArray(s.mixRows) && s.mixRows.length)
      ? s.mixRows.map(r => ({ parts: [r.parts?.[0] || '', r.parts?.[1] || '', r.parts?.[2] || ''], note: r.note || '' }))
      : [{ parts: [String(s.mixCode || '').split('-')[0] || '', String(s.mixCode || '').split('-')[1] || '', String(s.mixCode || '').split('-')[2] || ''], note: (Array.isArray(s.mixNotes) ? s.mixNotes[1] : '') || '' }],
    mixMode: (s.mixMode === 'mortar' || s.mixMode === 'dry' || s.mixMode === 'num') ? s.mixMode
      : (s.mixCode === 'ドライテック' ? 'dry' : (/^1:[1-4]$/.test(s.mixCode || '') ? 'mortar' : 'num')),
    cementType: s.cementType || '',
    cementType2: s.cementType2 || '',
    hasCementType2: !!(s.cementType2 || s.hasCementType2),
    volume: (s.volume ?? '') === '' ? '' : String(s.volume),
    volumeUncertain: !!s.volumeUncertain,
    volumePlusA: !!s.volumePlusA,
    volumeRange: String(s.volume ?? '').includes('〜'),
    volumeRange2: String(s.volume2 ?? '').includes('〜'),
    volume2: (s.volume2 ?? '') === '' ? '' : String(s.volume2),
    volumeUncertain2: !!s.volumeUncertain2,
    volumePlusA2: !!s.volumePlusA2,
    hasVolume2: !!(s.volume2 || s.volumeUncertain2 || s.volumePlusA2),
    // 数量の特記。編集で開いたとき欠落して更新で消える不具合の修正（往復で保持）
    volumeNote: s.volumeNote || '',
    volumeNote2: s.volumeNote2 || '',
    pdfName: s.pdfName || '',
    pdfData: '',
    hasPdf: !!s.hasPdf,
    pdfRemove: false,
    placements: Array.isArray(s.placements) ? s.placements : [],
    pourLocation: s.pourLocation || '',
    pourFree: typeof s.pourFree === 'boolean' ? s.pourFree
      : !!(s.pourLocation && !POUR_LOCATIONS.includes(s.pourLocation)),
    noteTags: Array.isArray(s.noteTags) ? s.noteTags : [],
    testTags: Array.isArray(s.testTags) ? s.testTags : [],
    mapReceived: isOn(s.mapReceived),
    faxReceived: isOn(s.faxReceived),
    orderContact: s.orderContact || '',
    siteContact: s.siteContact || '',
    drivers: Array.isArray(s.drivers) ? s.drivers : (s.driverName ? [{ id: s.driverId || '', name: s.driverName }] : []),
    notes: sortNotes((Array.isArray(s.notes) && s.notes.length ? s.notes : [{ text: '', important: false }]).map(n => ({ text: String(n.text ?? ''), important: !!n.important, kind: n.kind || '' }))),
    driverMessages: (Array.isArray(s.driverMessages) && s.driverMessages.length ? s.driverMessages : [{ text: '', important: false }]).map(n => ({ text: String(n.text ?? ''), important: !!n.important })),
    mapView: s.mapView || null,
    mapPin: s.mapPin || null,
    mapArrows: Array.isArray(s.mapArrows) ? s.mapArrows : [],
  })
}

// フォーム→保存ペイロード（出荷登録・予定編集モーダルで共用）。
function buildShipmentPayload(form) {
  const payload = {
    ...form,
    times: form.times.map(t => ({ text: z2h(t.text).replace(/：/g, ':'), important: !!t.important })).filter(t => t.text.trim() !== ''),
    notes: form.notes.filter(n => n.text.trim() !== ''),
    driverMessages: form.driverMessages.filter(n => n.text.trim() !== ''),
  }
  if (form.pdfRemove) payload.pdfData = ''
  else if (!form.pdfData) delete payload.pdfData
  return payload
}

// 伝票フォームの各フィールド操作（出荷登録シートとスマホ予定編集フォームで共用）。
// レイアウトに依存しないハンドラのみ。form/setForm を閉じ込めて返す。
function makeDenpyoHandlers({ form, setForm, employees = [], companyComboOptions = [] }) {
  const set = (key) => (e) => { const v = e.target.value; const composing = e.nativeEvent?.isComposing; setForm(f => ({ ...f, [key]: composing ? v : z2h(v) })) }
  const setVal = (key, val) => setForm(f => ({ ...f, [key]: val }))
  const handleCompanyInput = (e) => { const v = e.target.value; const o = companyComboOptions.find(o => o.label === v); setForm(f => ({ ...f, companyId: o?.id || '', companyName: v })) }
  const syncMix = (rows) => { const r0 = rows[0] || { parts: ['', '', ''], note: '' }; return { mixRows: rows, mixCode: r0.parts.slice(0, 3).join('-'), mixNotes: [r0.parts[0] ? '' : '', r0.note || '', ''] } }
  const setMixCell = (row, i, v, raw) => setForm(f => { const rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' })); while (rows.length <= row) rows.push({ parts: ['', '', ''], note: '' }); rows[row].parts[i] = raw ? String(v).slice(0, 4) : z2h(v).replace(/\D/g, '').slice(0, 2); return { ...f, ...syncMix(rows) } })
  const setMixRowNote = (row, v) => setForm(f => { const rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' })); while (rows.length <= row) rows.push({ parts: ['', '', ''], note: '' }); rows[row].note = v; return { ...f, ...syncMix(rows) } })
  const addMixRow = () => setForm(f => { const rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' })); if (rows.length >= 2) return f; rows.push({ parts: ['', '', ''], note: '' }); return { ...f, ...syncMix(rows) } })
  const delMixRow = (row) => setForm(f => { let rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' })); rows = rows.filter((_, idx) => idx !== row); if (!rows.length) rows = [{ parts: ['', '', ''], note: '' }]; return { ...f, ...syncMix(rows) } })
  const mixRowsOf = () => (Array.isArray(form.mixRows) && form.mixRows.length ? form.mixRows : [{ parts: ['', '', ''], note: '' }])
  const syncVeh = (items) => ({ vehicleItems: items, vehicleType: items.map(v => v.type).join('・') })
  const toggleVehItem = (type) => setForm(f => { const items = Array.isArray(f.vehicleItems) ? [...f.vehicleItems] : []; const at = items.findIndex(v => v.type === type); if (at >= 0) items.splice(at, 1); else items.push({ type, qty: '1' }); items.sort((a, b) => VEHICLE_TYPES.indexOf(a.type) - VEHICLE_TYPES.indexOf(b.type)); return { ...f, ...syncVeh(items) } })
  const setVehQty = (type, qty, composing) => setForm(f => { const items = (Array.isArray(f.vehicleItems) ? f.vehicleItems : []).map(v => v.type === type ? { ...v, qty: composing ? String(qty).slice(0, 2) : z2h(qty).replace(/[^0-9]/g, '').slice(0, 2) } : v); return { ...f, ...syncVeh(items) } })
  const vehItems = () => (Array.isArray(form.vehicleItems) ? form.vehicleItems : [])
  const toggleNoteTag = (tag) => setForm(f => { const cur = Array.isArray(f.noteTags) ? f.noteTags : []; return { ...f, noteTags: cur.includes(tag) ? cur.filter(t => t !== tag) : [...cur, tag] } })
  const toggleTestTag = (tag) => setForm(f => { const cur = Array.isArray(f.testTags) ? f.testTags : []; return { ...f, testTags: cur.includes(tag) ? [] : [tag] } })
  const addNoteMessage = (msg) => setForm(f => { const notes = Array.isArray(f.notes) ? f.notes.map(n => ({ ...n })) : []; const i = notes.findIndex(n => n && n.kind === 'msg'); if (i >= 0) { const cur = String(notes[i].text || ''); if (cur.split(/\s+/).filter(Boolean).includes(msg)) return f; notes[i] = { ...notes[i], text: cur.trim() ? cur + ' ' + msg : msg } } else { notes.push({ text: msg, important: false, kind: 'msg' }) } return { ...f, notes: sortNotes(notes) } })
  const removeNoteMessage = (msg) => setForm(f => { const notes = (Array.isArray(f.notes) ? f.notes.map(n => ({ ...n })) : []); const i = notes.findIndex(n => n && n.kind === 'msg'); if (i < 0) return f; const rest = String(notes[i].text || '').split(/\s+/).filter(Boolean).filter(x => x !== msg); if (rest.length) notes[i].text = rest.join(' '); else notes.splice(i, 1); return { ...f, notes: sortNotes(notes) } })
  const unloadText = () => { const n = (form.notes || []).find(n => n && n.kind === 'unload'); return n ? n.text : '' }
  const setUnload = (val) => setForm(f => { const notes = (Array.isArray(f.notes) ? f.notes : []).filter(n => !(n && n.kind === 'unload')); if (String(val).trim() !== '') notes.push({ text: val, important: false, kind: 'unload' }); return { ...f, notes: sortNotes(notes) } })
  const addDriver = (e) => { const emp = employees.find(emp => emp.id === e.target.value); if (!emp) return; setForm(f => f.drivers.some(d => d.id === emp.id) ? f : ({ ...f, drivers: [...f.drivers, { id: emp.id, name: emp.name }] })) }
  const removeDriver = (i) => setForm(f => ({ ...f, drivers: f.drivers.filter((_, idx) => idx !== i) }))
  return { set, setVal, handleCompanyInput, syncMix, setMixCell, setMixRowNote, addMixRow, delMixRow, mixRowsOf, syncVeh, toggleVehItem, setVehQty, vehItems, toggleNoteTag, toggleTestTag, addNoteMessage, removeNoteMessage, unloadText, setUnload, addDriver, removeDriver }
}

// 出荷登録フォームの「伝票シート」本体（出荷登録ページとスマホ予定表の編集モーダルで共用）。
// form/setForm を受け取り、各フィールドのハンドラとレイアウトを内包する。地図・登録ボタンは親側で描画。
function DenpyoFields({ form, setForm, editChanged = [], editing = null, employees = [], companyComboOptions = [], tradingComboOptions = [], onPdfImport, removePdf, previewPdf }) {
  const sheetRef = useRef(null)
  const set = (key) => (e) => { const v = e.target.value; const composing = e.nativeEvent?.isComposing; setForm(f => ({ ...f, [key]: composing ? v : z2h(v) })) }
  const setVal = (key, val) => setForm(f => ({ ...f, [key]: val }))
  const redIf = (f) => editChanged.includes(f) ? { color: '#c81e1e' } : undefined
  const focusNextHg = (fromEl) => { const root = sheetRef.current; if (!root) return; const hgs = Array.from(root.querySelectorAll('input.hg')); const i = hgs.indexOf(fromEl); if (i >= 0 && i + 1 < hgs.length) hgs[i + 1].focus() }
  const handleCompanyInput = (e) => { const v = e.target.value; const o = companyComboOptions.find(o => o.label === v); setForm(f => ({ ...f, companyId: o?.id || '', companyName: v })) }
  const syncMix = (rows) => { const r0 = rows[0] || { parts: ['', '', ''], note: '' }; return { mixRows: rows, mixCode: r0.parts.slice(0, 3).join('-'), mixNotes: [r0.parts[0] ? '' : '', r0.note || '', ''] } }
  const setMixCell = (row, i, v, raw) => setForm(f => { const rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' })); while (rows.length <= row) rows.push({ parts: ['', '', ''], note: '' }); rows[row].parts[i] = raw ? String(v).slice(0, 4) : z2h(v).replace(/\D/g, '').slice(0, 2); return { ...f, ...syncMix(rows) } })
  const setMixRowNote = (row, v) => setForm(f => { const rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' })); while (rows.length <= row) rows.push({ parts: ['', '', ''], note: '' }); rows[row].note = v; return { ...f, ...syncMix(rows) } })
  const addMixRow = () => setForm(f => { const rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' })); if (rows.length >= 2) return f; rows.push({ parts: ['', '', ''], note: '' }); return { ...f, ...syncMix(rows) } })
  const delMixRow = (row) => setForm(f => { let rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' })); rows = rows.filter((_, idx) => idx !== row); if (!rows.length) rows = [{ parts: ['', '', ''], note: '' }]; return { ...f, ...syncMix(rows) } })
  const mixRowsOf = () => (Array.isArray(form.mixRows) && form.mixRows.length ? form.mixRows : [{ parts: ['', '', ''], note: '' }])
  const onHg = (ri, i) => (e) => { const c = e.nativeEvent?.isComposing; setMixCell(ri, i, e.target.value, c); if (!c && z2h(e.target.value).replace(/\D/g, '').length >= 2) focusNextHg(e.target) }
  const syncVeh = (items) => ({ vehicleItems: items, vehicleType: items.map(v => v.type).join('・') })
  const toggleVehItem = (type) => setForm(f => { const items = Array.isArray(f.vehicleItems) ? [...f.vehicleItems] : []; const at = items.findIndex(v => v.type === type); if (at >= 0) items.splice(at, 1); else items.push({ type, qty: '1' }); items.sort((a, b) => VEHICLE_TYPES.indexOf(a.type) - VEHICLE_TYPES.indexOf(b.type)); return { ...f, ...syncVeh(items) } })
  const setVehQty = (type, qty, composing) => setForm(f => { const items = (Array.isArray(f.vehicleItems) ? f.vehicleItems : []).map(v => v.type === type ? { ...v, qty: composing ? String(qty).slice(0, 2) : z2h(qty).replace(/[^0-9]/g, '').slice(0, 2) } : v); return { ...f, ...syncVeh(items) } })
  const vehItems = () => (Array.isArray(form.vehicleItems) ? form.vehicleItems : [])
  const toggleNoteTag = (tag) => setForm(f => { const cur = Array.isArray(f.noteTags) ? f.noteTags : []; return { ...f, noteTags: cur.includes(tag) ? cur.filter(t => t !== tag) : [...cur, tag] } })
  const toggleTestTag = (tag) => setForm(f => { const cur = Array.isArray(f.testTags) ? f.testTags : []; return { ...f, testTags: cur.includes(tag) ? [] : [tag] } })
  const addNoteMessage = (msg) => setForm(f => { const notes = Array.isArray(f.notes) ? f.notes.map(n => ({ ...n })) : []; const i = notes.findIndex(n => n && n.kind === 'msg'); if (i >= 0) { const cur = String(notes[i].text || ''); if (cur.split(/\s+/).filter(Boolean).includes(msg)) return f; notes[i] = { ...notes[i], text: cur.trim() ? cur + ' ' + msg : msg } } else { notes.push({ text: msg, important: false, kind: 'msg' }) } return { ...f, notes: sortNotes(notes) } })
  const unloadText = () => { const n = (form.notes || []).find(n => n && n.kind === 'unload'); return n ? n.text : '' }
  const setUnload = (val) => setForm(f => { const notes = (Array.isArray(f.notes) ? f.notes : []).filter(n => !(n && n.kind === 'unload')); if (String(val).trim() !== '') notes.push({ text: val, important: false, kind: 'unload' }); return { ...f, notes: sortNotes(notes) } })
  const addDriver = (e) => { const emp = employees.find(emp => emp.id === e.target.value); if (!emp) return; setForm(f => f.drivers.some(d => d.id === emp.id) ? f : ({ ...f, drivers: [...f.drivers, { id: emp.id, name: emp.name }] })) }
  const removeDriver = (i) => setForm(f => ({ ...f, drivers: f.drivers.filter((_, idx) => idx !== i) }))
  // 受信確認：現場住所かPDFが入っていれば「地図」を自動でチェック扱いにする（手動でも✔可）
  const mapAuto = !!(String(form.siteAddress || '').trim() || form.pdfData || form.hasPdf)
  const mapChecked = !!form.mapReceived || mapAuto
  // 受信確認（地図/FAX）の On/Off ボタンの見た目：受信済みは緑＋✔
  const recvBtnStyle = (on) => ({ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, border: on ? '1.5px solid #1a7a3a' : '1.5px solid #999', background: on ? '#eafaef' : '#fff', color: on ? '#1a7a3a' : '#333', borderRadius: 6, padding: '6px 4px', fontSize: 13, fontWeight: on ? 700 : 500, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' })
  // 時間欄に「AM」「PM」単体を入れる（1つ目の時間枠に設定。もう一度押すと解除）
  const setAmPm = (val) => setForm(f => {
    const times = (Array.isArray(f.times) && f.times.length) ? f.times.map(t => ({ ...t })) : [{ text: '', important: false }]
    const cur = String(times[0].text || '').trim().toUpperCase()
    times[0] = { ...times[0], text: cur === val ? '' : val }
    return { ...f, times }
  })
  const ampmActive = (val) => String((Array.isArray(form.times) && form.times[0] ? form.times[0].text : '') || '').trim().toUpperCase() === val
  const ampmBtnStyle = (on) => ({ flex: 1, border: on ? '2px solid #0f3060' : '1.5px solid #bbb', background: on ? '#0f3060' : '#fff', color: on ? '#fff' : '#3a4a5c', borderRadius: 6, padding: '6px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer' })
  return (
          <div className="sheet" ref={sheetRef} style={{ margin: 0 }}>
            {/* 1段: 受注日 / 日付 / 業者名 / 商社名 */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 17%' }}>
                <div className="lbl">受 注 日</div>
                <input className="f" type="date" value={form.orderDate} onChange={set('orderDate')} />
              </div>
              <div className="cell" style={{ flex: '0 0 19%' }}>
                <div className="lbl">日 付</div>
                <input className="f" type="date" value={form.date} onChange={set('date')} required />
              </div>
              <div className="cell" style={{ flex: '0 0 36%' }}>
                <div className="lbl" style={redIf('companyName')}>業 者 名</div>
                <KanaCombo value={form.companyName} onChange={handleCompanyInput}
                  onPick={o => setForm(f => ({ ...f, companyId: o.id || '', companyName: o.label }))}
                  options={companyComboOptions} placeholder="入力して検索（ひらがな可）" style={redIf('companyName')} required />
              </div>
              <div className="cell" style={{ flex: 1 }}>
                <div className="lbl" style={redIf('tradingCompany')}>商 社 名</div>
                <KanaCombo value={form.tradingCompany} onChange={set('tradingCompany')}
                  onPick={o => setVal('tradingCompany', o.label)}
                  options={tradingComboOptions} placeholder="入力して選択（ひらがな可）" style={redIf('tradingCompany')} />
              </div>
            </div>
            {/* 2段: 時間 / 現場名 */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 24%' }}>
                <div className="lbl" style={redIf('times')}>時 間</div>
                <DenpyoGrid items={form.times} onChange={v => setVal('times', v)} cols={1} max={2} height={48} addLabel="＋ 時間を追加" minSize={14} dataIme="ascii" />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button type="button" onClick={() => setAmPm('AM')} style={ampmBtnStyle(ampmActive('AM'))}>AM</button>
                  <button type="button" onClick={() => setAmPm('PM')} style={ampmBtnStyle(ampmActive('PM'))}>PM</button>
                </div>
              </div>
              <div className="cell stack" style={{ flex: 1, padding: 0 }}>
                <div className="subrow">
                  <div className="cell" style={{ flex: 1 }}>
                    <div className="lbl" style={redIf('siteName')}>現 場 名</div>
                    {/* 現場名は従来どおり1行・自動縮小（FitField）。IMEは全角かな（PC対応ブラウザのみ） */}
                    <FitField value={form.siteName} onChange={set('siteName')} lang="ja" dataIme="kana" style={{ ...redIf('siteName'), imeMode: 'active' }} />
                  </div>
                </div>
                <div className="subrow">
                  <div className="cell" style={{ flex: 1 }}>
                    <div className="lbl">現 場 住 所</div>
                    <FitField value={form.siteAddress} onChange={set('siteAddress')} placeholder={DEFAULT_SITE_ADDRESS} dataIme="kana" />
                  </div>
                </div>
              </div>
            </div>
            {/* 3段: 車種 / 打設箇所 / 試験 / 特記 / 荷下ろし / PDF（セメント種・受信確認は外し、荷下ろしを4段から移動） */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 22%', minWidth: 0 }}>
                <div className="lbl" style={{ ...redIf('vehicleType'), textAlign: 'center' }}>車 種</div>
                <div className="btn-mid" style={{ gap: 4 }}>
                  {/* 車種チップは横並びで縦をコンパクトに */}
                  <div style={{ display: 'flex', justifyContent: 'center', gap: 4, flexWrap: 'nowrap' }}>
                    {VEHICLE_TYPES.map(o => {
                      const on = vehItems().some(v => v.type === o)
                      return <span key={o} className={'chip' + (on ? ' on' : '')} onClick={() => toggleVehItem(o)}>{o}</span>
                    })}
                  </div>
                  {/* 補足は textarea で折り返し（2行まで自動拡張）。縦横とも中央寄せ */}
                  <textarea className="f" value={form.vehicleFree || ''}
                    onChange={(e) => { const v = e.target.value; const composing = e.nativeEvent?.isComposing; setForm(f => ({ ...f, vehicleFree: composing ? v : z2h(v) })) }}
                    placeholder="補足" rows={2} data-ime="kana"
                    style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box', display: 'block', fontSize: 12, padding: '10px 6px', textAlign: 'center', border: '1px solid #cdd5e0', borderRadius: 4, minWidth: 0, resize: 'none', wordBreak: 'break-all', overflowWrap: 'anywhere', lineHeight: 1.3, fontFamily: 'inherit', verticalAlign: 'middle' }} />
                </div>
              </div>
              <div className="cell" style={{ flex: '0 0 16%', minWidth: 0 }}>
                <div className="lbl sm" style={redIf('pourLocation')}>打 設 箇 所</div>
                <div className="btn-mid">
                  {!form.pourFree ? (
                    <select className="f pour-sel" style={{ ...redIf('pourLocation'), fontSize: 16, textAlign: 'center', textAlignLast: 'center' }} value={form.pourLocation}
                      onChange={e => {
                        if (e.target.value === '入力する') setForm(f => ({ ...f, pourFree: true, pourLocation: '' }))
                        else setVal('pourLocation', e.target.value)
                      }}>
                      <option value=""></option>
                      {POUR_LOCATIONS.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    /* textarea を固定高(40px)にして、placeholder「入力」が「一覧」ボタンと同じ縦中央に来るようにする。
                       1回折り返しは入力時に内部スクロール（縦40px固定・はみ出しは overflow:auto） */
                    <div style={{ position: 'relative', height: 40 }}>
                      <textarea value={form.pourLocation}
                        onChange={(e) => { const v = e.target.value; const composing = e.nativeEvent?.isComposing; setForm(f => ({ ...f, pourLocation: composing ? v : z2h(v) })) }}
                        placeholder="入力" rows={2} className="f pour-input" data-ime="kana"
                        style={{ ...redIf('pourLocation'), fontSize: 13, textAlign: 'center', border: '1.5px solid #1b4ea8', borderRadius: 6, background: '#f2f7ff', padding: '10px 42px 4px 6px', boxSizing: 'border-box', width: '100%', height: '100%', resize: 'none', wordBreak: 'break-all', overflowWrap: 'anywhere', lineHeight: 1.3, fontFamily: 'inherit', overflowY: 'auto' }} />
                      <button type="button" onClick={() => setForm(f => ({ ...f, pourFree: false, pourLocation: '' }))}
                        style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', border: '1px solid #bbb', background: '#fff', borderRadius: 4, fontSize: 11, padding: '1px 5px', cursor: 'pointer' }}>一覧</button>
                    </div>
                  )}
                </div>
              </div>
              <div className="cell" style={{ flex: '0 0 12%', minWidth: 0 }}>
                <div className="lbl sm" style={{ textAlign: 'center' }}>試験</div>
                <div className="btn-mid"><div className="chips" style={{ justifyContent: 'center', gap: 3 }}>
                  {TEST_TAGS.map(t => (
                    <span key={t} className={'chip' + ((form.testTags || []).includes(t) ? ' on' : '')} onClick={() => toggleTestTag(t)}>{t}</span>
                  ))}
                </div></div>
              </div>
              <div className="cell" style={{ flex: '0 0 10%', minWidth: 0 }}>
                <div className="lbl sm" style={{ textAlign: 'center' }}>特記</div>
                <div className="btn-mid"><div className="chips" style={{ justifyContent: 'center', gap: 3 }}>
                  {NOTE_TAGS.map(t => (
                    <span key={t} className={'chip' + ((form.noteTags || []).includes(t) ? ' on' : '')} onClick={() => toggleNoteTag(t)}>{t}</span>
                  ))}
                </div></div>
              </div>
              {/* 荷下ろし（4段から移動）: 2x2 グリッド＋自由入力 */}
              <div className="cell" style={{ flex: '0 0 22%', minWidth: 0 }}>
                <div className="lbl sm" style={{ textAlign: 'center' }}>荷下ろし</div>
                <div className="btn-mid" style={{ gap: 2 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
                    {PLACEMENT_TYPES.map(o => {
                      const on = (form.placements || []).includes(o)
                      return <span key={o} className={'chip' + (on ? ' on' : '')} style={{ textAlign: 'center' }}
                        onClick={() => setVal('placements', on ? (form.placements || []).filter(x => x !== o) : [...(form.placements || []), o])}>{o}</span>
                    })}
                  </div>
                  <input className="unload-input" value={unloadText()} onChange={e => setUnload(e.target.value)} placeholder="自由入力（備考に出力）" data-ime="kana" style={{ marginTop: 2, padding: '2px 6px', fontSize: 12 }} />
                </div>
              </div>
              <div className="cell" style={{ flex: '0 0 18%', minWidth: 0 }}>
                <div className="lbl sm" style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>PDFインポート</div>
                <div className="btn-mid" style={{ alignItems: 'center', gap: 4 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #999', background: '#fafafa', borderRadius: 6, padding: '6px 14px', fontSize: 18, cursor: 'pointer', color: '#333' }}>📄
                    <input type="file" accept="application/pdf" style={{ display: 'none' }} onChange={onPdfImport} />
                  </label>
                  {(form.pdfData || form.hasPdf) && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      {(form.pdfData || (form.hasPdf && editing)) && (
                        <button type="button" onClick={previewPdf} title="プレビュー"
                          style={{ border: '1px solid #1a4d8f', background: '#eef5ff', color: '#1a4d8f', borderRadius: 5, padding: '4px 8px', fontSize: 13, cursor: 'pointer' }}>👁</button>
                      )}
                      <button type="button" onClick={removePdf} title="削除"
                        style={{ border: '1px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 5, padding: '4px 8px', fontSize: 13, cursor: 'pointer' }}>🗑</button>
                    </div>
                  )}
                  {(form.pdfName || form.hasPdf) && (
                    <div style={{ fontSize: 10, color: '#1a8f5a', textAlign: 'center', wordBreak: 'break-all', lineHeight: 1.2 }}>
                      {form.pdfData ? '選択中' : '添付済'}
                    </div>
                  )}
                </div>
              </div>
            </div>
            {/* 4段: セメント種 / 配合 / 量 */}
            <div className="band">
              {/* セメント種（3段から移動）。
                  2つ目を追加していない時: 「1つ目」見出し → N B 横並び → ＋追加
                  2つ目を追加した時:   「1つ目」 → N B ／ 「2つ目」 → N B ／ ×（合計4行＋ボタン） */}
              <div className="cell" style={{ flex: '0 0 12%', minWidth: 0 }}>
                <div className="lbl sm" style={{ textAlign: 'center' }}>セメント種</div>
                <div className="btn-mid" style={{ alignItems: 'center', gap: 4 }}>
                  {form.hasCementType2 && (
                    <div style={{ fontFamily: "'Noto Sans JP',sans-serif", fontSize: 11, color: '#0f3060', fontWeight: 700, textAlign: 'center' }}>1つ目</div>
                  )}
                  <div className="chips" style={{ justifyContent: 'center', gap: 4, flexWrap: 'nowrap' }}>
                    {CEMENT_TYPES.map(o => (
                      <span key={o} className={'chip' + (form.cementType === o ? ' on' : '')} onClick={() => setVal('cementType', form.cementType === o ? '' : o)}>{o}</span>
                    ))}
                  </div>
                  {form.hasCementType2 ? (
                    <>
                      <div style={{ fontFamily: "'Noto Sans JP',sans-serif", fontSize: 11, color: '#0f3060', fontWeight: 700, textAlign: 'center', marginTop: 4 }}>2つ目</div>
                      <div className="chips" style={{ justifyContent: 'center', gap: 4, flexWrap: 'nowrap' }}>
                        {CEMENT_TYPES.map(o => (
                          <span key={o} className={'chip' + (form.cementType2 === o ? ' on' : '')} onClick={() => setVal('cementType2', form.cementType2 === o ? '' : o)}>{o}</span>
                        ))}
                      </div>
                      <button type="button" onClick={() => setForm(f => ({ ...f, hasCementType2: false, cementType2: '' }))} title="2つ目のセメント種を削除"
                        style={{ marginTop: 2, border: '1px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 4, fontSize: 11, lineHeight: 1, padding: '1px 8px', cursor: 'pointer' }}>×</button>
                    </>
                  ) : (
                    <button type="button" className="addrow" style={{ marginTop: 2, padding: '1px 6px', fontSize: 11, whiteSpace: 'nowrap' }}
                      onClick={() => setForm(f => ({ ...f, hasCementType2: true }))}>＋ 追加</button>
                  )}
                </div>
              </div>
              <div className="cell" style={{ flex: '0 0 44%', minWidth: 0 }}>
                {/* 「配合」ラベル + モード切替（数値/モルタル/ドライテック）を横並びに */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <div className="lbl" style={{ marginBottom: 0, flex: '0 0 auto', ...redIf('mixCode') }}>配 合</div>
                  <div style={{ flex: 1, display: 'flex', gap: 3 }}>
                    {[['num', '数値'], ['mortar', 'モルタル'], ['dry', 'ドライテック']].map(([m, label]) => (
                      <button key={m} type="button"
                        onClick={() => setForm(f => {
                          if (f.mixMode === m) return f
                          if (m === 'dry') return { ...f, mixMode: 'dry', mixCode: 'ドライテック', mixRows: [{ parts: ['', '', ''], note: '' }], mixNotes: ['', '', ''] }
                          if (m === 'mortar') return { ...f, mixMode: 'mortar', mixCode: '', mixRows: [{ parts: ['', '', ''], note: '' }], mixNotes: ['', '', ''] }
                          return { ...f, mixMode: 'num', mixCode: '', mixRows: [{ parts: ['', '', ''], note: '' }], mixNotes: ['', '', ''] }
                        })}
                        style={{ flex: 1, border: form.mixMode === m ? '1.5px solid #0f3060' : '1.5px solid #cdd5e0', background: form.mixMode === m ? '#0f3060' : '#fff', color: form.mixMode === m ? '#fff' : '#475467', borderRadius: 5, padding: '2px 4px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "'Noto Sans JP',sans-serif", letterSpacing: '.04em', lineHeight: 1.3 }}>{label}</button>
                    ))}
                  </div>
                </div>
                {/* 数値/モルタル/ドライテックの3モードで配合エリアの高さが変わらないよう、最小高を統一(147px ≒ 数値モードの内容高) */}
                <div className="btn-mid" style={{ minHeight: 147, justifyContent: 'center' }}>
                {form.mixMode === 'mortar' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '6px 14px' }}>
                    {['1:1', '1:2', '1:3', '1:4'].map(r => {
                      const on = form.mixCode === r
                      return (
                        <button key={r} type="button"
                          onClick={() => setForm(f => ({ ...f, mixCode: r, mixRows: [{ parts: ['', '', ''], note: '' }], mixNotes: ['', '', ''] }))}
                          style={{ height: 44, border: on ? '2px solid #1b4ea8' : '1.5px solid #cdd5e0', background: on ? '#e8f0ff' : '#fff', color: on ? '#1b4ea8' : '#101828', borderRadius: 6, fontSize: 20, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>{r}</button>
                      )
                    })}
                  </div>
                ) : form.mixMode === 'dry' ? (
                  <div style={{ textAlign: 'center', fontSize: 32, fontWeight: 800, color: '#111', letterSpacing: '0.1em' }}>ドライテック</div>
                ) : (() => {
                  const rows = mixRowsOf()
                  const two = rows.length > 1
                  return (
                    <>
                    <div className={'mixwrap' + (two ? ' two' : ' one')}>
                      {rows.map((r, ri) => (
                        <div key={ri} className="mixrow">
                          <div className={'haigou3' + (two ? ' compact' : '')} style={redIf('mixCode')}>
                            <div className="hgcol">
                              <div className="hgnote-spacer" />
                              <input className="hg" data-ime="ascii" inputMode="numeric" maxLength={2} value={r.parts[0] || ''} onChange={onHg(ri, 0)} onCompositionEnd={e => setMixCell(ri, 0, e.target.value, false)} />
                            </div>
                            <span className="hgsep">-</span>
                            <div className="hgcol">
                              <input className="hgnote" data-ime="kana" placeholder="特記" value={r.note || ''} onChange={e => setMixRowNote(ri, e.target.value)} />
                              <input className="hg" data-ime="ascii" inputMode="numeric" maxLength={2} value={r.parts[1] || ''} onChange={onHg(ri, 1)} onCompositionEnd={e => setMixCell(ri, 1, e.target.value, false)} />
                            </div>
                            <span className="hgsep">-</span>
                            <div className="hgcol">
                              <div className="hgnote-spacer" />
                              <input className="hg" data-ime="ascii" inputMode="numeric" maxLength={2} value={r.parts[2] || ''} onChange={onHg(ri, 2)} onCompositionEnd={e => setMixCell(ri, 2, e.target.value, false)} />
                            </div>
                          </div>
                          {ri > 0 && (
                            <button type="button" onClick={() => delMixRow(ri)} title="行を削除"
                              style={{ position: 'absolute', right: 4, bottom: 4, border: '1px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 4, fontSize: 12, lineHeight: 1, padding: '1px 5px', cursor: 'pointer' }}>×</button>
                          )}
                        </div>
                      ))}
                    </div>
                    {/* ＋追加ボタンは2行時も visibility:hidden で同じ高さを維持（フォーム全体の縦寸が動かないように） */}
                    <button type="button" className="addrow"
                      style={{ marginTop: 4, fontSize: 11, padding: '2px 8px', alignSelf: 'center', visibility: rows.length < 2 ? 'visible' : 'hidden', pointerEvents: rows.length < 2 ? 'auto' : 'none' }}
                      onClick={addMixRow}>＋ 配合を追加</button>
                    </>
                  )
                })()}
                </div>
              </div>
              {/* 量（ラベルなし。空いた縦スペースで2段表示を整える。荷下ろし subrow は3段へ移動済） */}
              <div className="cell" style={{ flex: 1, padding: 0 }}>
                <div className="subrow" style={{ flex: 1, borderBottom: 'none' }}>
                  <div className="cell m3" style={{ flex: 1, minWidth: 0, flexDirection: 'column', justifyContent: 'center', padding: '8px 6px' }}>
                    {[0, 1].map(idx => {
                      if (idx === 1 && !form.hasVolume2) return null
                      const vKey = idx === 0 ? 'volume' : 'volume2'
                      const uKey = idx === 0 ? 'volumeUncertain' : 'volumeUncertain2'
                      const aKey = idx === 0 ? 'volumePlusA' : 'volumePlusA2'
                      const rKey = idx === 0 ? 'volumeRange' : 'volumeRange2'
                      const nKey = idx === 0 ? 'volumeNote' : 'volumeNote2'
                      const raw = String(form[vKey] || '')
                      const sepI = raw.indexOf('〜')
                      const vFrom = sepI >= 0 ? raw.slice(0, sepI) : raw
                      const vTo = sepI >= 0 ? raw.slice(sepI + 1) : ''
                      const isRange = !!form[rKey] || sepI >= 0
                      const clean = (s) => z2h(s).replace(/．/g, '.').replace(/[^0-9.]/g, '')
                      const combine = (from, to) => (String(to) !== '' ? `${from}〜${to}` : from)
                      const setFrom = (val, composing) => { const f = composing ? val : clean(val); setVal(vKey, combine(f, vTo)) }
                      const setTo = (val, composing) => { const t = composing ? val : clean(val); setVal(vKey, combine(vFrom, t)) }
                      const toggleRange = () => setForm(f => { const cur = String(f[vKey] || ''); const i = cur.indexOf('〜'); const from = i >= 0 ? cur.slice(0, i) : cur; const on = !(f[rKey] || i >= 0); return { ...f, [rKey]: on, [vKey]: from } })
                      // ㎥が3桁(整数部3桁以上)のとき文字を大きく
                      const big = (s) => String(s || '').split('.')[0].replace(/[^0-9]/g, '').length >= 3
                      // 量の数値：2桁=黒太字／3桁=赤太字／それ以外は太字なし（編集で変更扱いのときは赤を優先）。3桁が収まる幅を確保
                      const boxW = isRange ? 64 : 104
                      // 特記の幅は、〜（範囲）を押しても短くならないように固定
                      const noteW = 104
                      const inStyle = (s) => ({ width: boxW, maxWidth: '100%', fontSize: isRange ? (big(s) ? 26 : 22) : (big(s) ? 36 : 30), ...(editChanged.includes('volume') ? { fontWeight: 700, color: '#c81e1e' } : volNumStyle(s)) })
                      // 量の特記入力（配合の特記=hgnote と同じ見た目：数値の真上に赤い破線の小さなラベル）
                      const noteInput = (w) => (
                        <input className="vol-note" data-ime="kana" value={form[nKey] || ''} onChange={e => setVal(nKey, e.target.value)} placeholder="特記"
                          style={{ width: w, maxWidth: '100%', fontSize: 10, fontWeight: 700, textAlign: 'center', color: '#c81e1e', border: 'none', borderBottom: '1px dashed #e7a3a3', outline: 'none', background: 'transparent', fontFamily: 'inherit', padding: '0 0 1px', marginBottom: 2 }} />
                      )
                      // 〜/?/+a ボタンは「特記」と同じ高さ（上段）に固定。〜（範囲）押下で数字入力幅が変わっても位置は動かない
                      const delSpacer = (
                        <span style={{ width: 22, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                          {idx === 1 ? (
                            <span className="qlabel" style={{ margin: 0, padding: '1px 4px' }} title="2段目を削除"
                              onClick={() => setForm(f => ({ ...f, hasVolume2: false, volume2: '', volumeNote2: '', volumeRange2: false, volumeUncertain2: false, volumePlusA2: false }))}>×</span>
                          ) : null}
                        </span>
                      )
                      return (
                        <div key={idx} style={{ display: 'flex', flexDirection: 'column', marginTop: idx ? 4 : 0, gap: 1 }}>
                          {/* 上段: ×スロット / 特記 / [〜 ? +a] ボタン（特記の真横に固定配置） */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            {delSpacer}
                            {noteInput(noteW)}
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <span className={'qlabel' + (isRange ? ' on' : '')} title="範囲入力（13〜14）" onClick={toggleRange} style={{ marginLeft: 0 }}>〜</span>
                              <span className={'qlabel' + (form[uKey] ? ' on' : '')} onClick={() => setVal(uKey, !form[uKey])} style={{ marginLeft: 0 }}>?</span>
                              <span className={'qlabel' + (form[aKey] ? ' on' : '')} onClick={() => setVal(aKey, !form[aKey])} style={{ marginLeft: 0 }}>+a</span>
                            </div>
                          </div>
                          {/* 下段: ×スロット / 数値入力 / m³ */}
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                            <span style={{ width: 22, flexShrink: 0 }} />
                            <input type="text" inputMode="decimal" data-ime="ascii" style={inStyle(vFrom)} value={vFrom}
                              onChange={e => setFrom(e.target.value, e.nativeEvent?.isComposing)}
                              onCompositionEnd={e => setFrom(e.target.value, false)} />
                            {isRange && (
                              <>
                                <span style={{ fontSize: 18, fontWeight: 700, color: '#111' }}>〜</span>
                                <input type="text" inputMode="decimal" data-ime="ascii" style={inStyle(vTo)} value={vTo}
                                  onChange={e => setTo(e.target.value, e.nativeEvent?.isComposing)}
                                  onCompositionEnd={e => setTo(e.target.value, false)} />
                              </>
                            )}
                            <span className="unit" style={redIf('volume')}>m<sup>3</sup>
                              {form[aKey] ? <span style={{ marginLeft: 4, fontWeight: 700, color: '#c81e1e' }}>+a</span> : null}
                              <span className={'qmark' + (form[uKey] ? ' on' : '')}>?</span>
                            </span>
                          </div>
                        </div>
                      )
                    })}
                    {!form.hasVolume2 && (
                      <button type="button" className="addrow" style={{ marginTop: 4, fontSize: 11, padding: '2px 8px', alignSelf: 'center' }}
                        onClick={() => setForm(f => ({ ...f, hasVolume2: true }))}>＋ 量を追加</button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            {/* 5段: 連絡先 / 現場連絡先 */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 50%', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <div className="lbl" style={{ marginBottom: 0, fontSize: 11, letterSpacing: '.08em' }}>連 絡 先</div>
                <input className="f" type="text" value={form.orderContact} onChange={set('orderContact')} data-ime="ascii" inputMode="tel" />
              </div>
              <div className="cell" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <div className="lbl" style={{ marginBottom: 0, fontSize: 11, letterSpacing: '.08em', ...redIf('siteContact') }}>現 場 連 絡 先</div>
                <input className="f" style={redIf('siteContact')} type="text" value={form.siteContact} onChange={set('siteContact')} data-ime="ascii" inputMode="tel" />
              </div>
            </div>
            {/* 6段: 備考 ＋ メッセージ追加 */}
            <div className="band">
              <div className="cell" style={{ flex: 1, minWidth: 0 }}>
                <div className="lbl" style={redIf('notes')}>備 考</div>
                <DenpyoGrid items={form.notes} onChange={v => setVal('notes', sortNotes(v))} cols={1} max={3 + (form.notes || []).filter(n => n && (n.kind === 'unload' || n.kind === 'msg')).length} height={90} addLabel="＋ 段落を追加" dataIme="kana" />
              </div>
              <div className="cell" style={{ flex: '0 0 auto', minWidth: 210 }}>
                <div className="lbl" style={{ fontSize: 11, letterSpacing: '.06em' }}>メッセージ追加</div>
                {(() => {
                  const msgNote = (form.notes || []).find(n => n && n.kind === 'msg')
                  const used = msgNote ? String(msgNote.text || '').split(/\s+/).filter(Boolean) : []
                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 2 }}>
                      {NOTE_MESSAGES.map(m => {
                        const isUsed = used.includes(m)
                        return (
                          <button key={m} type="button" disabled={isUsed} onClick={() => addNoteMessage(m)}
                            style={{ border: isUsed ? '1.5px solid #cdd5e0' : '1.5px solid #1b4ea8', background: isUsed ? '#eef0f4' : '#eef4ff', color: isUsed ? '#9aa7b5' : '#1b4ea8', borderRadius: 6, padding: '7px 10px', fontSize: 13, fontWeight: 700, cursor: isUsed ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>＋ {m}</button>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
            </div>
            {/* 7段: 担当ドライバー */}
            <div className="band">
              <div className="cell" style={{ flex: 1, minWidth: 0 }}>
                <div className="lbl" style={{ ...redIf('drivers'), fontSize: 11, letterSpacing: '.06em' }}>担当ドライバー</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginTop: 3 }}>
                  {form.drivers.map((d, i) => (
                    <span key={d.id || i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid #1b4ea8', background: '#e8f0ff', color: '#1b4ea8', borderRadius: 5, padding: '2px 6px', fontSize: 13 }}>
                      {dispDriverName(d)}
                      <button type="button" onClick={() => removeDriver(i)} style={{ border: 'none', background: 'none', color: '#1b4ea8', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                    </span>
                  ))}
                  <select className="f" value="" onChange={addDriver} style={{ width: 'auto', minWidth: 150, border: '1px solid #cdd5e0', borderRadius: 5, padding: '3px 6px' }}>
                    <option value="">＋ ドライバーを追加</option>
                    {employees.filter(e => !form.drivers.some(d => (d.id && d.id === e.id) || d.name === e.name)).map(d => <option key={d.id} value={d.id}>{dispDriverName(d)}</option>)}
                  </select>
                </div>
              </div>
            </div>
          </div>
  )
}

// 変更履歴パネル（出荷登録の地図の下に表示）。サーバが保存した history（日時＋項目＋値の前後）を新しい順に表示
function HistoryPanel({ history }) {
  const isMobile = useIsMobile()
  const list = Array.isArray(history) ? history : []
  if (!list.length) return null
  const fmtT = (t) => { const d = new Date(t); if (isNaN(d.getTime())) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}` }
  // スマホは2列、PCは4列。minmax(0,1fr)で枠内に縮めて長い住所も折り返す（横はみ出し防止）
  const cols = isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))'
  return (
    <div style={{ marginTop: 12, border: '1px solid #dde3ed', borderRadius: 8, background: '#fff', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', background: '#f4f6f9', fontSize: 13, fontWeight: 700, color: '#3a4a5c', borderBottom: '1px solid #dde3ed' }}>📝 変更履歴</div>
      <div style={{ maxHeight: 320, overflowY: 'auto', overflowX: 'hidden', display: 'grid', gridTemplateColumns: cols, gap: 8, padding: 8 }}>
        {list.map((h, i) => (
          <div key={i} style={{ border: '1px solid #eef1f5', borderRadius: 6, background: '#fafbfc', padding: '6px 8px', fontSize: 12, minWidth: 0 }}>
            <div style={{ color: '#6b7a8d', marginBottom: 3 }}>{fmtT(h.t)}</div>
            {(Array.isArray(h.items) ? h.items : []).map((it, j) => (
              <div key={j} style={{ color: '#1a2332', lineHeight: 1.55, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                <span style={{ fontWeight: 700 }}>{it.f}</span>
                <span style={{ color: '#9aa7b5' }}>：</span>
                <span style={{ color: '#c0392b', textDecoration: 'line-through' }}>{it.from || '（空）'}</span>
                <span style={{ color: '#9aa7b5' }}> → </span>
                <span style={{ color: '#0f7a3a', fontWeight: 700 }}>{it.to || '（空）'}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// 添付PDFを枠に埋め込んで表示し、右上に大きめの半透明×ボタンを重ねる（閉じて元の画面に戻れる）
function openPdfViewer(id) {
  const url = `/api/shipments?id=${encodeURIComponent(id)}&pdf=1`
  const w = window.open('', '_blank')
  if (!w) { window.open(url, '_blank'); return }
  w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PDF</title><style>html,body{margin:0;height:100%;background:#525659;overflow:hidden}iframe{border:0;position:absolute;inset:0;width:100%;height:100%}.x{position:fixed;top:14px;right:14px;width:60px;height:60px;border-radius:50%;border:none;background:rgba(20,20,20,.45);color:#fff;font-size:34px;font-weight:700;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483647;-webkit-tap-highlight-color:transparent;box-shadow:0 2px 8px rgba(0,0,0,.3)}.x:active{background:rgba(20,20,20,.7)}</style></head><body><iframe src="${url}"></iframe><button class="x" aria-label="閉じる" onclick="window.close()">×</button></body></html>`)
  w.document.close()
}

function ShipmentsPage({ editTarget, onEditConsumed, pendingEditId, onPendingConsumed, isPopup }) {
  const isMobile = useIsMobile()
  const stacked = useIsMobile(1101)   // 1101px未満はフォーム上・地図下に縦積み（iPad縦も含む）
  const [form, setForm]             = useState({ ...emptyShipForm })
  const [shipments, setShipments]   = useState([])
  const [customers, setCustomers]   = useState([])
  const [employees, setEmployees]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')
  const [search, setSearch]         = useState('')
  const [dateFilter, setDateFilter] = useState('')   // 日付ボタンで絞り込み中の日付（空=絞り込みなし）
  const [ampm, setAmpm]             = useState('both')   // AM/PM 絞り込み（'both'|'AM'|'PM'）。各フィルターと併用
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [saveConfirm, setSaveConfirm] = useState(false)   // 登録/更新の確認（ワンクッション）
  const [picked, setPicked] = useState(null)   // 一覧でシングルクリックして色が変わっている行（ダブルクリックで選択）
  const [editing, setEditing]       = useState(null)
  const [editChanged, setEditChanged] = useState([])
  const [page, setPage]             = useState(0)
  const [mapKey, setMapKey]         = useState(0)   // 別伝票を開いた/リセット時にSiteMapを再マウント（描画モード解除＋新住所で再描画）
  const topRef = useRef(null)
  const formRef = useRef(null)   // Enter/桁送りでの次項目フォーカス移動に使う
  const PAGE_SIZE = 10
  // 本日〜25日先まで（日曜を除く）の日付配列。一覧の日付ボタン用
  const weekDates = (() => {
    const base = new Date()
    const out = []
    for (let i = 0; i <= 25; i++) {
      const d = new Date(base); d.setDate(base.getDate() + i)
      if (d.getDay() === 0) continue   // 日曜は除外
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    }
    return out
  })()

  const load = useCallback(async () => {
    try {
      const [s, c, e] = await Promise.all([
        api.get('/api/shipments'),
        api.get('/api/customers'),
        api.get('/api/employees'),
      ])
      rememberEmployees(e)
      setShipments(s)
      setCustomers(c)
      setEmployees(e.filter(emp => emp.type === 'driver'))
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // テキスト入力は全角数字を半角に変換して保持（出荷登録）。ただしIME変換中は書き換えず確定後に変換（二重入力防止）
  const set = (key) => (e) => { const v = e.target.value; const composing = e.nativeEvent?.isComposing; setForm(f => ({ ...f, [key]: composing ? v : z2h(v) })) }
  const setVal = (key, val) => setForm(f => ({ ...f, [key]: val }))

  // 入力が終わったら次の項目へフォーカスを移す（Enter／配合は規定桁到達で自動送り）
  const focusNextField = (fromEl) => {
    const root = formRef.current
    if (!root || !fromEl) return
    const all = Array.from(root.querySelectorAll('input, select, textarea'))
      .filter(el => !el.disabled && el.type !== 'hidden' && el.tabIndex !== -1 && el.offsetParent !== null)
    const i = all.indexOf(fromEl)
    if (i >= 0 && i + 1 < all.length) all[i + 1].focus()
  }
  const focusNextHg = (fromEl) => {
    const root = formRef.current
    if (!root) return
    const hgs = Array.from(root.querySelectorAll('input.hg'))
    const i = hgs.indexOf(fromEl)
    if (i >= 0 && i + 1 < hgs.length) hgs[i + 1].focus()
  }
  // 配合セル：値を反映しつつ2桁入力で次のセルへ自動送り
  const onHg = (ri, i) => (e) => { const c = e.nativeEvent?.isComposing; setMixCell(ri, i, e.target.value, c); if (!c && z2h(e.target.value).replace(/\D/g, '').length >= 2) focusNextHg(e.target) }
  const onFormKeyDown = (e) => {
    if (e.key !== 'Enter') return
    // IME変換中・変換確定のEnterでは次項目に移動しない
    if (e.isComposing || e.keyCode === 229 || e.nativeEvent?.isComposing) return
    const t = e.target
    if (!t || t.tagName === 'TEXTAREA') return
    if (t.tagName === 'INPUT' && t.type !== 'button' && t.type !== 'submit') {
      e.preventDefault()
      if (t.classList && t.classList.contains('hg')) focusNextHg(t)
      else focusNextField(t)
    }
  }

  const handleCompany = (e) => {
    const c = customers.find(c => c.id === e.target.value)
    setForm(f => ({ ...f, companyId: c?.id || '', companyName: c?.companyName || '' }))
  }

  const handleCompanyInput = (e) => {
    const v = e.target.value
    const c = customers.find(c => c.companyName === v)
    setForm(f => ({ ...f, companyId: c?.id || '', companyName: v }))
  }

  // 配合（複数行）: mixRows が真。1行目を mixCode/mixNotes に同期して既存表示と互換を保つ
  const syncMix = (rows) => {
    const r0 = rows[0] || { parts: ['', '', ''], note: '' }
    return { mixRows: rows, mixCode: r0.parts.slice(0, 3).join('-'), mixNotes: [r0.parts[0] ? '' : '', r0.note || '', ''] }
  }
  // 配合の数字：IME変換中(raw)はそのまま、確定/通常入力時は全角でも強制半角（特記=hgnoteはカタカナ可）
  const setMixCell = (row, i, v, raw) => setForm(f => {
    const rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' }))
    while (rows.length <= row) rows.push({ parts: ['', '', ''], note: '' })
    rows[row].parts[i] = raw ? String(v).slice(0, 4) : z2h(v).replace(/\D/g, '').slice(0, 2)
    return { ...f, ...syncMix(rows) }
  })
  const setMixRowNote = (row, v) => setForm(f => {
    const rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' }))
    while (rows.length <= row) rows.push({ parts: ['', '', ''], note: '' })
    rows[row].note = v
    return { ...f, ...syncMix(rows) }
  })
  const addMixRow = () => setForm(f => {
    const rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' }))
    if (rows.length >= 2) return f
    rows.push({ parts: ['', '', ''], note: '' })
    return { ...f, ...syncMix(rows) }
  })
  const delMixRow = (row) => setForm(f => {
    let rows = (Array.isArray(f.mixRows) && f.mixRows.length ? f.mixRows : [{ parts: ['', '', ''], note: '' }]).map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' }))
    rows = rows.filter((_, idx) => idx !== row)
    if (!rows.length) rows = [{ parts: ['', '', ''], note: '' }]
    return { ...f, ...syncMix(rows) }
  })
  const mixRowsOf = () => (Array.isArray(form.mixRows) && form.mixRows.length ? form.mixRows : [{ parts: ['', '', ''], note: '' }])

  // 車種（複数・数量付き）: vehicleItems が真。vehicleType（・連結）にも同期して既存表示と互換
  const syncVeh = (items) => ({ vehicleItems: items, vehicleType: items.map(v => v.type).join('・') })
  const toggleVehItem = (type) => setForm(f => {
    const items = Array.isArray(f.vehicleItems) ? [...f.vehicleItems] : []
    const at = items.findIndex(v => v.type === type)
    if (at >= 0) items.splice(at, 1)
    else items.push({ type, qty: '1' })   // 選択時は既定で1台
    // VEHICLE_TYPES 並び順を保持
    items.sort((a, b) => VEHICLE_TYPES.indexOf(a.type) - VEHICLE_TYPES.indexOf(b.type))
    return { ...f, ...syncVeh(items) }
  })
  const setVehQty = (type, qty, composing) => setForm(f => {
    const items = (Array.isArray(f.vehicleItems) ? f.vehicleItems : []).map(v => v.type === type ? { ...v, qty: composing ? String(qty).slice(0, 2) : z2h(qty).replace(/[^0-9]/g, '').slice(0, 2) } : v)
    return { ...f, ...syncVeh(items) }
  })
  const vehItems = () => (Array.isArray(form.vehicleItems) ? form.vehicleItems : [])

  const toggleNoteTag = (tag) => setForm(f => {
    const cur = Array.isArray(f.noteTags) ? f.noteTags : []
    return { ...f, noteTags: cur.includes(tag) ? cur.filter(t => t !== tag) : [...cur, tag] }
  })
  const toggleTestTag = (tag) => setForm(f => {
    const cur = Array.isArray(f.testTags) ? f.testTags : []
    return { ...f, testTags: cur.includes(tag) ? [] : [tag] }
  })
  // メッセージ追加：1回目は備考にmsg段落を新規追加。2回目以降は同じmsg段落の後ろに半角スペース＋メッセージを追記
  const addNoteMessage = (msg) => setForm(f => {
    const notes = Array.isArray(f.notes) ? f.notes.map(n => ({ ...n })) : []
    const i = notes.findIndex(n => n && n.kind === 'msg')
    if (i >= 0) {
      const cur = String(notes[i].text || '')
      if (cur.split(/\s+/).filter(Boolean).includes(msg)) return f   // 追加済みは重複させない
      notes[i] = { ...notes[i], text: cur.trim() ? cur + ' ' + msg : msg }
    } else {
      notes.push({ text: msg, important: false, kind: 'msg' })
    }
    return { ...f, notes: sortNotes(notes) }
  })
  // 荷下ろしの自由入力（kind:'unload' の段落1つで保持。空なら段落を消す）。内容は備考に出力される
  const unloadText = () => { const n = (form.notes || []).find(n => n && n.kind === 'unload'); return n ? n.text : '' }
  const setUnload = (val) => setForm(f => {
    const notes = (Array.isArray(f.notes) ? f.notes : []).filter(n => !(n && n.kind === 'unload'))
    if (String(val).trim() !== '') notes.push({ text: val, important: false, kind: 'unload' })
    return { ...f, notes: sortNotes(notes) }
  })

  const addDriver = (e) => {
    const emp = employees.find(emp => emp.id === e.target.value)
    if (!emp) return
    setForm(f => f.drivers.some(d => d.id === emp.id)
      ? f : ({ ...f, drivers: [...f.drivers, { id: emp.id, name: emp.name }] }))
  }
  const removeDriver = (i) => setForm(f => ({ ...f, drivers: f.drivers.filter((_, idx) => idx !== i) }))

  // PDFインポート: 画像PDFを読み込み、保存時に開いている伝票へ添付する（更新/新規登録に紐づく）
  const onPdfImport = (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { alert('PDFファイルを選択してください'); e.target.value = ''; return }
    const MAX = 2.5 * 1024 * 1024
    if (file.size > MAX) { alert(`PDFが大きすぎます（${(file.size / 1024 / 1024).toFixed(1)}MB）。\n2.5MB以下に圧縮してください。`); e.target.value = ''; return }
    const reader = new FileReader()
    reader.onload = () => setForm(f => ({ ...f, pdfData: String(reader.result || ''), pdfName: file.name, hasPdf: true, pdfRemove: false }))
    reader.onerror = () => alert('PDFの読み込みに失敗しました')
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  // 添付PDFを削除（保存時に反映）。未保存の選択分はその場でクリア
  const removePdf = () => setForm(f => ({ ...f, pdfData: '', pdfName: '', hasPdf: false, pdfRemove: true }))

  // 添付PDFをプレビュー（新規ウィンドウで開く＝クイックルック相当）
  const previewPdf = () => {
    const feat = 'width=900,height=1000,scrollbars=yes,resizable=yes'
    if (form.pdfData) {
      const w = window.open('', '_blank', feat)
      if (w) { w.document.write(`<title>${form.pdfName || 'PDF'}</title><iframe src="${form.pdfData}" style="border:0;position:absolute;inset:0;width:100%;height:100%"></iframe>`); w.document.close() }
      return
    }
    if (editing && form.hasPdf) window.open(`/api/shipments?id=${encodeURIComponent(editing)}&pdf=1`, '_blank', feat)
  }

  const firstTime = (s) => Array.isArray(s.times) ? (s.times[0] || '') : ''
  const sortShip = (arr) => [...arr].sort((a, b) => (String(a.date) + firstTime(a)).localeCompare(String(b.date) + firstTime(b)))

  const toForm = shipmentToForm

  const startEdit = (s) => {
    setEditing(s.id)
    setEditChanged(Array.isArray(s.changedFields) ? s.changedFields : [])
    setForm(toForm(s))
    setError('')
    setMapKey(k => k + 1)   // 描画モード中でも地図を作り直して新しい伝票の位置・矢印で再描画する
    requestAnimationFrame(() => topRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
  }

  // 出荷予定表の「編集」ボタンから渡された伝票を開く（同一ウィンドウ）
  useEffect(() => {
    if (editTarget) { startEdit(editTarget); onEditConsumed && onEditConsumed() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTarget])

  // 別ウィンドウ（?editShipment=...）で開いた場合、読み込み後に該当伝票を編集状態にする
  useEffect(() => {
    if (pendingEditId && shipments.length) {
      const s = shipments.find(x => x.id === pendingEditId)
      if (s) { startEdit(s); onPendingConsumed && onPendingConsumed() }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEditId, shipments])

  // フォームから保存用ペイロードを組み立てる（handleSubmit と 行切替保存で共通）
  const buildPayload = () => buildShipmentPayload(form)

  // 編集中の伝票を「更新」と同じ処理で保存（UIはリセットしない＝直後に別伝票へ切替できる）
  const saveCurrentEdit = async () => {
    const payload = buildPayload()
    const orig = shipments.find(x => x.id === editing) || {}
    const changed = diffChangedFields(orig, payload)
    const changedFields = Array.from(new Set([...(Array.isArray(orig.changedFields) ? orig.changedFields : []), ...changed]))
    const updated = await api.put(`/api/shipments/${editing}`, { ...payload, changedFields })
    setShipments(ss => sortShip(ss.map(s => s.id === updated.id ? updated : s)))
    notifyShipmentsChanged()
    return updated
  }

  // 一覧で別の伝票を選んだとき：編集中なら更新と同じ保存を走らせてから切り替える
  const onRowClick = async (s) => {
    if (editing === s.id) return
    if (editing) {
      if (!form.date || !form.companyName) { setError('日付と業者名は必須です（更新できないため切り替えできません）'); return }
      setSaving(true)
      try { await saveCurrentEdit() }
      catch (err) { setError(err.message); setSaving(false); return }
      setSaving(false)
    }
    startEdit(s)
  }

  // 登録/更新ボタン：いきなり保存せず、確認（ワンクッション）を挟む
  const handleSubmit = (e) => {
    e.preventDefault()
    setError('')
    if (!form.date || !form.companyName) { setError('日付と業者名は必須です'); return }
    setSaveConfirm(true)
  }
  // 実際の保存処理（確認モーダルで「はい」を押したら走る）
  const doSave = async () => {
    setSaveConfirm(false)
    setError('')
    setSaving(true)
    try {
      const payload = buildPayload()
      if (editing) {
        // 予定表で赤字表示するため、編集前(orig)と比べて変わった項目（配合は桁ごと・備考は行ごと）を積む
        const orig = shipments.find(x => x.id === editing) || {}
        const changed = diffChangedFields(orig, payload)
        const changedFields = Array.from(new Set([...(Array.isArray(orig.changedFields) ? orig.changedFields : []), ...changed]))
        const updated = await api.put(`/api/shipments/${editing}`, { ...payload, changedFields })
        setShipments(ss => sortShip(ss.map(s => s.id === updated.id ? updated : s)))
        setEditing(null)
        setEditChanged([])
        setForm({ ...emptyShipForm })
        setMapKey(k => k + 1)      // 更新後は地図を作り直し（描画モードを解除して初期状態へ）
        notifyShipmentsChanged()   // 他タブ（出荷予定表）に更新を通知
        // PC等で編集用の別ウィンドウとして開かれている場合は、更新後に閉じて元タブへ戻す
        if (isPopup) { window.close(); return }
      } else {
        const created = await api.post('/api/shipments', payload)
        setShipments(ss => sortShip([...ss, created]))
        setForm({ ...emptyShipForm, date: form.date })
        setMapKey(k => k + 1)
        notifyShipmentsChanged()
      }
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const handleReset = () => { setEditing(null); setEditChanged([]); setForm({ ...emptyShipForm }); setMapKey(k => k + 1) }
  // コピーして複製：今のフォーム内容を新規扱いにする（保存すると新しい伝票になる。PDF添付は引き継がない）
  const handleDuplicate = () => {
    setEditing(null)
    setEditChanged([])
    // 複製と分かるよう現場名に「 コピー」を付ける。PDF添付は引き継がない。受注日は本日（新規作成日）に
    setForm(f => ({ ...f, orderDate: localToday(), siteName: ((f.siteName || '') + ' コピー').trim(), pdfData: '', pdfName: '', hasPdf: false, pdfRemove: false }))
    setMapKey(k => k + 1)
    topRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    alert('コピーされました')
  }

  // 出荷一覧の「削除」はキャンセル（ソフト削除）。キャンセル伝票に保管され、復元できる
  const handleDelete = async (id) => {
    try {
      await api.put(`/api/shipments/${id}?cancel=1`, { cancelled: true })
      notifyShipmentsChanged()
      setDeleteConfirm(null)
      setShipments(ss => ss.filter(s => s.id !== id))
      // 削除した伝票を編集中だった場合は入力フォームをクリア（新規状態に戻す）
      if (editing === id) { setEditing(null); setEditChanged([]); setForm({ ...emptyShipForm }); setMapKey(k => k + 1) }
      setPicked(p => p === id ? null : p)
    } catch (e) { alert('エラー: ' + e.message) }
  }

  // 商社名プルダウン候補：既存出荷で入力された商社名を重複なしで集める
  const tradingOptions = Array.from(new Set(
    shipments.map(s => (s.tradingCompany || '').trim()).filter(Boolean)
  )).sort()
  // 業者名・商社名のカナ付き候補（ひらがな/カタカナで絞り込み可能）
  const companyComboOptions = customers.map(c => ({ id: c.id, label: c.companyName, kana: c.companyNameKana || '' }))
  // 商社名：顧客マスタ（カナ付き）＋出荷履歴の商社名を結合（重複は除外）
  const tradingComboOptions = (() => {
    const seen = new Set()
    const out = []
    customers.forEach(c => { if (c.companyName && !seen.has(c.companyName)) { seen.add(c.companyName); out.push({ id: c.id, label: c.companyName, kana: c.companyNameKana || '' }) } })
    tradingOptions.forEach(t => { if (t && !seen.has(t)) { seen.add(t); out.push({ label: t, kana: '' }) } })
    return out
  })()

  // カタカナ→ひらがな正規化。業者名・商社名は顧客マスタのカナ（companyNameKana）も検索対象にする
  const toHira = kanaToHira
  const kanaOfCompany = (s) => { const c = customers.find(c => c.id === s.companyId) || customers.find(c => c.companyName === s.companyName); return c ? (c.companyNameKana || '') : '' }
  const kanaOfTrading = (s) => { if (!s.tradingCompany) return ''; const c = customers.find(c => c.companyName === s.tradingCompany); return c ? (c.companyNameKana || '') : '' }
  // 日付を色々な表記で検索できるように（例: 6/4・06/04・6月4日・6-4）
  const dateVariants = (dateStr) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''))
    if (!m) return [String(dateStr || '')]
    const [, y, mo, d] = m, moN = String(+mo), dN = String(+d)
    return [dateStr, `${y}/${mo}/${d}`, `${y}/${moN}/${dN}`, `${mo}/${d}`, `${moN}/${dN}`, `${moN}月${dN}日`, `${mo}-${d}`, `${moN}-${dN}`]
  }
  // 電話番号検索用：ハイフン・空白を除去して数字だけで比較できるようにする
  const noHyphen = (str) => String(str || '').replace(/[-－ー―‐\s]/g, '')
  // AM/PM 絞り込み：先頭時間が 12:00 より前=AM／以降=PM。各フィルター（日付・検索）と併用
  const inAmPm = (s) => { if (ampm === 'both') return true; const mm = timeToMin(firstTimeOf(s)); return ampm === 'AM' ? mm < 720 : mm >= 720 }
  // 一覧の「メモ」列：備考(notes)を ' / ' 連結で表示（{text}形式・素の文字列の両対応）
  const notesText = (s) => (Array.isArray(s.notes) ? s.notes.map(n => (n && n.text != null) ? n.text : n) : []).map(x => String(x ?? '').trim()).filter(Boolean).join(' / ')
  const filtered = shipments.filter(s => {
    if (dateFilter && s.date !== dateFilter) return false
    if (!inAmPm(s)) return false
    if (!search) return true
    const q = toHira(search)
    const fields = [s.companyName, s.tradingCompany, s.siteName, s.mixCode, s.vehicleType, s.orderContact, s.siteContact, kanaOfCompany(s), kanaOfTrading(s), ...dateVariants(s.date)]
    if (fields.some(v => toHira(v).includes(q))) return true
    // 連絡先・現場連絡先はハイフン無しでも検索可（例:「9131999」で「913-1999-…」にヒット）
    const qNo = noHyphen(q)
    if (qNo && [s.orderContact, s.siteContact].some(v => noHyphen(toHira(v)).includes(qNo))) return true
    return false
  })
  // 日付ボタンで絞り込み中（その日表示）は時間順（週間予定表と同条件）、それ以外は登録日時の新しい順
  const noPaging = !!dateFilter
  const sortedList = noPaging
    ? [...filtered].sort((a, b) => timeToMin(firstTimeOf(a)) - timeToMin(firstTimeOf(b)) || String(firstTimeOf(a)).localeCompare(String(firstTimeOf(b))))
    : [...filtered].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  // 10件ずつページング（日付絞り込み中はページ送りせず全部1ページ）
  const pageCount = noPaging ? 1 : Math.max(1, Math.ceil(sortedList.length / PAGE_SIZE))
  const curPage = noPaging ? 0 : Math.min(page, pageCount - 1)
  const pageRows = noPaging ? sortedList : sortedList.slice(curPage * PAGE_SIZE, curPage * PAGE_SIZE + PAGE_SIZE)
  // 検索・日付絞り込みが変わったら1ページ目へ
  useEffect(() => { setPage(0) }, [search, dateFilter, ampm])

  // 予定表で変更された項目を赤く表示
  const redIf = (f) => editChanged.includes(f) ? { color: '#c81e1e' } : undefined

  return (
    <div ref={topRef} style={{ height: '100%', overflow: 'auto' }}>
      {/* 手配伝票フォーム */}
      <div className="denpyo" style={{ padding: isMobile ? '12px 8px' : '16px 12px', background: '#f3f1ec', borderBottom: '2px solid #dde3ed' }}>
        <form onSubmit={handleSubmit} ref={formRef} onKeyDown={onFormKeyDown}>
          <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', flexWrap: 'nowrap', gap: stacked ? 12 : 20, alignItems: 'stretch', justifyContent: 'center', maxWidth: '100%', minWidth: 0 }}>
          <FitToWidth width={700} max={stacked ? 1 : 1} style={{ flex: stacked ? '0 0 auto' : '0 1 700px', minWidth: 0 }}>
          <DenpyoFields form={form} setForm={setForm} editChanged={editChanged} editing={editing}
            employees={employees} companyComboOptions={companyComboOptions} tradingComboOptions={tradingComboOptions}
            onPdfImport={onPdfImport} removePdf={removePdf} previewPdf={previewPdf} />
          </FitToWidth>
          <div style={{ flex: stacked ? '0 0 auto' : '1 1 480px', width: stacked ? '100%' : undefined, minWidth: 0, maxWidth: stacked ? undefined : 640 }}>
            <SiteMap
              key={mapKey}
              address={form.siteAddress}
              onAddressChange={(a) => setVal('siteAddress', a)}
              mapView={form.mapView}
              onMapViewChange={(v) => setVal('mapView', v)}
              pin={form.mapPin}
              onPinChange={(p) => setVal('mapPin', p)}
              arrows={form.mapArrows}
              onArrowsChange={(a) => setVal('mapArrows', a)}
              actions={
                <>
                  <button type="button" style={{ border: '1.5px solid #dde3ed', background: '#f4f6f9', color: '#3a4a5c', fontWeight: 600 }} onClick={handleReset}>{editing ? '新規に戻す' : 'リセット'}</button>
                  <button type="submit" style={{ border: 'none', background: 'linear-gradient(135deg,#1a4d8f,#1a6a9f)', color: '#fff', fontWeight: 600, opacity: saving ? 0.7 : 1 }} disabled={saving}>
                    {saving ? (editing ? '更新中…' : '登録中…') : (editing ? '更新' : '登録')}
                  </button>
                </>
              }
            />
            {/* 矢印/戻す/消去・リセット/登録 の下の段左：コピーして複製。編集中は地図の下に削除ボタンも置く */}
            <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" onClick={handleDuplicate}
                style={{ border: '1.5px solid #1a8f5a', background: '#f0f9f0', color: '#1a8f5a', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>📋 コピーして複製</button>
              {editing && (
                <button type="button" onClick={() => setDeleteConfirm(editing)}
                  style={{ marginLeft: 'auto', border: '1.5px solid #f0b0b0', background: '#fff0f0', color: '#c0392b', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>🗑 この伝票を削除</button>
              )}
            </div>
            {editing && <div style={{ marginTop: 10, padding: '6px 12px', background: '#fff8e1', border: '1px solid #f0d089', borderRadius: 6, fontSize: 13, color: '#8a6d1a' }}>編集中の伝票を更新します（「新規作成に戻す」で取消）</div>}
            {(() => {
              // mix0/note0 等のサブキーは親(配合/備考)に集約し、ラベルが付くものだけ重複なく表示
              const labels = Array.from(new Set(editChanged.map(f => SCHEDULE_FIELD_LABELS[f]).filter(Boolean)))
              return editing && labels.length > 0 && <div style={{ marginTop: 8, padding: '6px 12px', background: '#fdecec', border: '1px solid #f0b0b0', borderRadius: 6, fontSize: 13, color: '#c81e1e', fontWeight: 600 }}>予定表で変更された項目: {labels.join('・')}</div>
            })()}
            {error && <div style={{ ...S.error, marginTop: 10 }}>{error}</div>}
          </div>
          </div>
          {/* 変更履歴：フォーム＋地図と同じ幅（最大1360px）で中央寄せして表示 */}
          {editing && (
            <div style={{ maxWidth: 1360, margin: '0 auto', width: '100%', minWidth: 0 }}>
              <HistoryPanel history={(shipments.find(x => x.id === editing) || {}).history} />
            </div>
          )}
        </form>
      </div>

      {/* 一覧 */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ ...S.toolbar, flexWrap: 'nowrap', gap: 10, alignItems: 'center', overflow: 'hidden' }}>
          {/* 検索バー（短め）。検索中は解除ボタンを表示 */}
          <div style={{ flex: '0 0 auto', position: 'relative', width: isMobile ? 132 : 280, marginRight: 6 }}>
            <input style={{ ...noZoom({ ...S.search }, isMobile), flex: 'none', minWidth: 0, width: '100%', boxSizing: 'border-box', paddingRight: 38 }}
              placeholder="🔍 検索" value={search}
              onChange={e => { setSearch(e.target.value); if (e.target.value) setDateFilter('') }} />
            {search && (
              <button type="button" onClick={() => setSearch('')}
                style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: '#c0392b', color: '#fff', borderRadius: 6, width: 24, height: 24, fontSize: 14, cursor: 'pointer', lineHeight: 1, zIndex: 2 }}>×</button>
            )}
          </div>
          {/* AM/PM 絞り込み（本日の左に固定。横スクロールしない）。各フィルター＋AM/PM で併用 */}
          <div style={{ flex: '0 0 auto', display: 'flex', gap: 6, paddingRight: 8, marginRight: 2, borderRight: '2px solid #e3e8ef' }}>
            {['AM', 'PM'].map(p => {
              const on = ampm === p
              return (
                <button key={p} type="button" onClick={() => setAmpm(a => a === p ? 'both' : p)}
                  style={{ flex: '0 0 auto', whiteSpace: 'nowrap', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    border: on ? '2px solid #0f3060' : '1.5px solid #bbb', background: on ? '#0f3060' : '#fff', color: on ? '#fff' : '#3a4a5c' }}>{p}</button>
              )
            })}
          </div>
          {/* カレンダー：過去日も含め任意の伝票日付で絞り込み（受注日ではなく伝票日付 s.date で照合） */}
          <input type="date" value={dateFilter} onChange={e => { setDateFilter(e.target.value); if (e.target.value) setSearch('') }}
            title="日付で検索（過去日も可・伝票日付で照合）"
            style={{ flex: '0 0 auto', padding: '7px 8px', border: '1.5px solid #cdd5e0', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#1a4d8f', marginRight: 4 }} />
          {/* 本日〜2週間先（日曜除く）の日付ボタン（横スクロール可）。押したボタンは解除ボタンに変化 */}
          <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', gap: 6, overflowX: 'auto', padding: '2px 0', WebkitOverflowScrolling: 'touch' }}>
            {weekDates.map((d) => {
              const active = dateFilter === d
              const label = d === localToday() ? '本日' : `${parseInt(d.slice(5, 7), 10)}/${parseInt(d.slice(8, 10), 10)}`
              return (
                <button key={d} type="button"
                  onClick={() => { if (active) setDateFilter(''); else { setDateFilter(d); setSearch('') } }}
                  style={{
                    flex: '0 0 auto', whiteSpace: 'nowrap', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    border: active ? '1.5px solid #c0392b' : '1.5px solid #cdd5e0',
                    background: active ? '#c0392b' : '#fff',
                    color: active ? '#fff' : '#1a4d8f',
                  }}>
                  {active ? '× 解除' : label}
                </button>
              )
            })}
          </div>
        </div>
        <div style={S.countBar}>{loading ? '読み込み中...' : noPaging ? `${dateFilter} の伝票 ${filtered.length} 件を表示` : `${filtered.length} 件中 ${filtered.length === 0 ? 0 : curPage * PAGE_SIZE + 1}〜${Math.min((curPage + 1) * PAGE_SIZE, filtered.length)} 件を表示`}</div>

        {loading ? (
          <div style={S.empty}>読み込み中...</div>
        ) : filtered.length === 0 ? (
          <div style={S.empty}>{search ? '検索結果がありません' : '出荷登録がありません'}</div>
        ) : (
          <div className="tw-scroll" style={{ ...S.tableWrap, overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {['日付', '時間', '業者名', '商社名', '現場名', '地図', '車種', '配合', '種', 'm³', '荷下ろし', '打設箇所', 'メモ', ''].map((h, i) => (
                    <th key={i} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map(s => (
                  <tr key={s.id} title="シングルクリックで選択（色）／ダブルクリックで開く"
                    style={{ ...S.tr, cursor: 'pointer', background: editing === s.id ? '#eef5ff' : picked === s.id ? '#fff2cc' : undefined }}
                    onClick={() => setPicked(s.id)} onDoubleClick={() => onRowClick(s)}>
                    <td style={S.td}>{s.date}</td>
                    <td style={S.td}>{Array.isArray(s.times) && s.times.length ? s.times.map(t => (t && t.text != null) ? t.text : t).filter(Boolean).join(' / ') : '—'}</td>
                    <td style={{ ...S.td, fontWeight: 600 }}>{s.companyName}</td>
                    <td style={S.td}>{s.tradingCompany || '—'}</td>
                    <td style={S.td}>{s.siteName || '—'}</td>
                    {/* 地図：現場住所 または PDF のどちらかが入っていればチェック */}
                    <td style={{ ...S.td, textAlign: 'center' }}>{(String(s.siteAddress || '').trim() || s.hasPdf) ? <span style={{ color: '#1a8f5a', fontWeight: 800 }}>✔</span> : '—'}</td>
                    <td style={S.td}>{vehicleLabel(s) || '—'}</td>
                    <td style={{ ...S.td, maxWidth: 90 }}>{(() => {
                      const rs = mixRowsOfShip(s).filter(r => mixDisplay(r.code))
                      if (!rs.length) return '—'
                      return rs.map((r, i) => (<Fragment key={i}>{i > 0 ? ' / ' : ''}<span style={{ display: 'inline-block', textAlign: 'center', verticalAlign: 'bottom' }}>{r.note ? <span style={{ display: 'block', fontSize: '.68em', color: '#c81e1e', lineHeight: 1.1 }}>{r.note}</span> : null}<span>{mixDisplay(r.code)}</span></span></Fragment>))
                    })()}</td>
                    {/* 種：N は通常・B は太字、フォント少し大きめ */}
                    <td style={{ ...S.td, maxWidth: 44, textAlign: 'center', fontSize: 15, fontWeight: String(s.cementType || '').trim() === 'B' ? 800 : 400 }}>{s.cementType || '—'}</td>
                    <td style={{ ...S.td, maxWidth: 70 }}><VolNum s={s} unit stacked fallback="—" /></td>
                    <td style={{ ...S.td, maxWidth: 64 }}>{Array.isArray(s.placements) && s.placements.length ? s.placements.join('・') : '—'}</td>
                    <td style={{ ...S.td, maxWidth: 80 }}>{s.pourLocation || '—'}</td>
                    {/* 備考（メモ）：手入力等の備考を ' / ' 連結で表示 */}
                    <td style={{ ...S.td, maxWidth: 220 }} title={notesText(s)}>{notesText(s) || '—'}</td>
                    {/* 削除：行を開かずにキャンセル確認へ（右端・横スクロール不要） */}
                    <td style={{ ...S.td, textAlign: 'center', overflow: 'visible' }}>
                      <button type="button" title="この伝票を削除（キャンセル）"
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirm(s.id) }}
                        style={{ border: '1.5px solid #e3b4b4', background: '#fff5f5', color: '#c0392b', borderRadius: 6, padding: '4px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}>削除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !noPaging && filtered.length > PAGE_SIZE && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, padding: '12px 16px' }}>
            <button type="button" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={curPage === 0}
              style={{ border: '1.5px solid #dde3ed', background: '#fff', color: curPage === 0 ? '#c0c8d4' : '#1a4d8f', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: curPage === 0 ? 'default' : 'pointer' }}>← 戻る</button>
            <span style={{ fontSize: 13, color: '#3a4a5c' }}>{curPage + 1} / {pageCount} ページ</span>
            <button type="button" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={curPage >= pageCount - 1}
              style={{ border: '1.5px solid #dde3ed', background: '#fff', color: curPage >= pageCount - 1 ? '#c0c8d4' : '#1a4d8f', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: curPage >= pageCount - 1 ? 'default' : 'pointer' }}>次へ →</button>
          </div>
        )}
      </div>

      {deleteConfirm && (
        <div style={S.overlay}>
          <div style={S.confirmBox}>
            <p style={{ marginBottom: 16, color: '#1a2332', fontSize: 14 }}>この伝票を削除（キャンセル）しますか？<br /><span style={{ fontSize: 12, color: '#6b7a8d' }}>「キャンセル伝票」に保管され、復元できます。</span></p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button style={S.cancelBtn} onClick={() => setDeleteConfirm(null)}>やめる</button>
              <button style={S.dangerBtn} onClick={() => handleDelete(deleteConfirm)}>削除する</button>
            </div>
          </div>
        </div>
      )}

      {saveConfirm && (() => {
        const payload = buildPayload()
        // 編集時のみ：編集前(orig)と比べて変わった項目を計算し、プレビューで赤く表示
        const orig = editing ? (shipments.find(x => x.id === editing) || {}) : null
        const changedFields = orig ? diffChangedFields(orig, payload) : []
        return (
          <div style={S.overlay} onClick={e => e.target === e.currentTarget && setSaveConfirm(false)}>
            <div style={{ background: '#fff', borderRadius: 10, width: 'min(960px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #e3e8ef' }}>
                <h2 style={{ margin: 0, color: '#1a2332', fontSize: 17 }}>📋 {editing ? '更新内容のプレビュー' : '登録内容のプレビュー'}</h2>
                <button onClick={() => setSaveConfirm(false)} style={{ border: '1px solid #cdd5e0', background: '#fff', borderRadius: 6, padding: '5px 10px', fontSize: 13, cursor: 'pointer' }}>✕ 閉じる</button>
              </div>
              {editing && (
                <div style={{ padding: '8px 16px', background: '#fff5f5', borderBottom: '1px solid #f0d8d8', fontSize: 12, color: '#c81e1e' }}>
                  {changedFields.length === 0
                    ? '※変更箇所はありません'
                    : <>※赤字＝変更された箇所</>}
                </div>
              )}
              <div style={{ overflow: 'auto', padding: '12px 16px', flex: 1 }}>
                <DenpyoView s={payload} changedFields={changedFields} />
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderTop: '1px solid #e3e8ef' }}>
                <button style={S.dangerBtn} onClick={() => { if (window.confirm('入力内容を破棄します。よろしいですか？')) { setSaveConfirm(false); handleReset() } }}>キャンセル</button>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button style={S.cancelBtn} onClick={() => setSaveConfirm(false)}>訂正</button>
                  <button style={{ ...S.dangerBtn, background: '#1a6a9f', borderColor: '#1a6a9f' }} onClick={doSave}>{editing ? '更新' : '登録'}</button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ============================================================
// 出荷予定表ページ
// ============================================================
const SCHEDULE_FIELD_LABELS = {
  companyName: '業者名', tradingCompany: '商社名', siteName: '現場名',
  vehicleType: '車種', mixCode: '配合', volume: '数量', drivers: '担当',
  times: '時間', notes: '備考', siteContact: '現場連絡先', pourLocation: '打設箇所',
}

// 編集前(orig)と保存値(next)を比べ、変更項目の配列を返す。
// 配合は桁グループごと(mix0/mix1/mix2)＋中央特記(mixnote)、備考は行ごと(note0,note1,…)に細分化し、
// 一部だけ変えたときに該当サブ要素だけ赤くできるようにする。
function diffChangedFields(orig, next) {
  const norm = (v) => String(v ?? '').trim()
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const changed = []
  const origTimes = (Array.isArray(orig.times) ? orig.times.map(t => (t && t.text != null) ? t.text : t) : []).map(norm).filter(Boolean)
  const nextTimes = (Array.isArray(next.times) ? next.times.map(t => (t && t.text != null) ? t.text : t) : []).map(norm).filter(Boolean)
  if (!eq(origTimes, nextTimes)) changed.push('times')
  if (norm(orig.date) !== norm(next.date)) changed.push('date')
  if (norm(orig.companyName) !== norm(next.companyName)) changed.push('companyName')
  if (norm(orig.tradingCompany) !== norm(next.tradingCompany)) changed.push('tradingCompany')
  if (norm(orig.siteName) !== norm(next.siteName)) changed.push('siteName')
  if (norm(orig.siteAddress) !== norm(next.siteAddress)) changed.push('siteAddress')
  if (norm(orig.vehicleType) !== norm(next.vehicleType)) changed.push('vehicleType')
  if (norm(orig.vehicleFree) !== norm(next.vehicleFree)) changed.push('vehicleFree')
  // 配合：桁グループごとに比較（mix0/mix1/mix2）。1つでも違えば 'mixCode' も付与（旧表示の互換）
  const op = norm(orig.mixCode).split('-')
  const np = norm(next.mixCode).split('-')
  let mixDiff = false
  for (let i = 0; i < 3; i++) { if ((op[i] || '') !== (np[i] || '')) { changed.push('mix' + i); mixDiff = true } }
  // 中央特記
  const on = (Array.isArray(orig.mixNotes) ? orig.mixNotes : []).map(norm)
  const nn = (Array.isArray(next.mixNotes) ? next.mixNotes : []).map(norm)
  if ((on[1] || '') !== (nn[1] || '')) { changed.push('mixnote'); mixDiff = true }
  if (mixDiff) changed.push('mixCode')
  if (norm(orig.cementType) !== norm(next.cementType)) changed.push('cementType')
  if (norm(orig.volume) !== norm(next.volume) || !!orig.volumeUncertain !== !!next.volumeUncertain
    || !!orig.volumePlusA !== !!next.volumePlusA
    || norm(orig.volume2) !== norm(next.volume2) || !!orig.volumeUncertain2 !== !!next.volumeUncertain2
    || !!orig.volumePlusA2 !== !!next.volumePlusA2) changed.push('volume')
  const origPlace = Array.isArray(orig.placements) ? orig.placements : []
  const nextPlace = Array.isArray(next.placements) ? next.placements : []
  if (!eq(origPlace, nextPlace)) changed.push('placements')
  const origTags = Array.isArray(orig.noteTags) ? orig.noteTags : []
  const nextTags = Array.isArray(next.noteTags) ? next.noteTags : []
  if (!eq(origTags, nextTags)) changed.push('noteTags')
  const origTests = Array.isArray(orig.testTags) ? orig.testTags : []
  const nextTests = Array.isArray(next.testTags) ? next.testTags : []
  if (!eq(origTests, nextTests)) changed.push('testTags')
  if (norm(orig.pourLocation) !== norm(next.pourLocation)) changed.push('pourLocation')
  const origDrivers = (Array.isArray(orig.drivers) ? orig.drivers : []).map(d => ({ id: d.id || '', name: d.name }))
  const nextDrivers = (Array.isArray(next.drivers) ? next.drivers : []).map(d => ({ id: d.id || '', name: d.name }))
  if (!eq(origDrivers, nextDrivers)) changed.push('drivers')
  // 備考：行ごとに比較（note0,note1,…）。追加/変更された行だけ赤くする
  const origNotes = (Array.isArray(orig.notes) ? orig.notes : []).map(n => norm(n.text)).filter(Boolean)
  const nextNotes = (Array.isArray(next.notes) ? next.notes : []).map(n => norm(n.text)).filter(Boolean)
  let noteDiff = false
  for (let i = 0; i < nextNotes.length; i++) { if (nextNotes[i] !== (origNotes[i] || '')) { changed.push('note' + i); noteDiff = true } }
  if (nextNotes.length < origNotes.length) noteDiff = true   // 行が減った場合も変更扱い
  if (noteDiff) changed.push('notes')
  if (norm(orig.orderContact) !== norm(next.orderContact)) changed.push('orderContact')
  if (norm(orig.siteContact) !== norm(next.siteContact)) changed.push('siteContact')
  return changed
}

function SchedulePage({ onEditShipment, isPopup }) {
  // 出荷予定表: スマホ(<768px)は1件=1カードの縦リスト。
  // iPad(768〜1024) と PC(>=1025) は従来テーブル＋セル直接編集。
  const isMobile = useIsMobile(768)
  // 別ウィンドウ（isPopup）では幅に関わらず常にPC版テーブルを表示する。
  // → スマホで「別ウィンドウで開く」を押すと、横画面でPCレイアウトの予定表が出る。
  const compact = isMobile && !isPopup
  // PC版の表（アプリ内・別ウィンドウでない・スマホカードでない）はセルを直接書き換え可能にする。
  // 別ウィンドウ（共有ボード）は閲覧専用のまま（inlineEdit=false）。
  const inlineEdit = !isPopup && !compact
  // 別ウィンドウで画面が表の基準幅より狭いか（スマホ縦＝縮小、PC/横＝幅いっぱい）
  const popupNarrow = useIsMobile(880)
  // 別ウィンドウからは ?date= で表示日を引き継ぐ
  const [date, setDate] = useState(() => {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search).get('date')
      if (p && /^\d{4}-\d{2}-\d{2}$/.test(p)) return p
    }
    return localToday()
  })
  useAutoToday(setDate)   // 0:00を跨いだら本日表示中は自動で当日へ繰り上げ
  const [ampm, setAmpm] = useState('both')   // 表示の絞り込み（'both' | 'AM' | 'PM'）
  const [all, setAll] = useState([])
  const [loading, setLoading] = useState(true)
  const [editModal, setEditModal] = useState(null)   // スマホ：編集モーダルで開いている伝票
  const [drivers, setDrivers] = useState([])         // 担当ドライバー選択用（従業員=driver）
  const [customers, setCustomers] = useState([])     // 編集モーダルの業者名・商社名サジェスト用
  const [lineTarget, setLineTarget] = useState(null) // LINE送信モーダルで開いている伝票
  const [lineSel, setLineSel] = useState([])         // LINE送信の送り先（従業員id）

  // 表示日だけを取得（日付索引で当日ぶんのみ＝読み取り削減）。ポーリング等から最新の日付を参照するためref併用
  const dateRef = useRef(date); dateRef.current = date
  const load = useCallback(async () => {
    try { setAll(await api.get('/api/shipments?date=' + encodeURIComponent(dateRef.current))) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [])
  // 初回＋表示日が変わるたびに読み直す（日付変更時は「読み込み中」を出さず、取得完了時に差し替え＝チラつき防止）
  useEffect(() => { load() }, [date, load])
  useEffect(() => {
    api.get('/api/employees').then(e => { rememberEmployees(e); setDrivers((e || []).filter(emp => emp.type === 'driver')) }).catch(() => {})
  }, [])
  // 編集モーダルの業者名・商社名サジェスト用に顧客マスタを読み込む（別ウィンドウ＝ログイン不要時は失敗しても無視）
  useEffect(() => {
    api.get('/api/customers').then(c => setCustomers(c || [])).catch(() => {})
  }, [])

  // 業者名・商社名のカナ付き候補（出荷登録フォームと同じロジック）
  const companyComboOptions = customers.map(c => ({ id: c.id, label: c.companyName, kana: c.companyNameKana || '' }))
  const tradingComboOptions = (() => {
    const seen = new Set()
    const out = []
    customers.forEach(c => { if (c.companyName && !seen.has(c.companyName)) { seen.add(c.companyName); out.push({ id: c.id, label: c.companyName, kana: c.companyNameKana || '' }) } })
    Array.from(new Set(all.map(s => (s.tradingCompany || '').trim()).filter(Boolean))).sort()
      .forEach(t => { if (t && !seen.has(t)) { seen.add(t); out.push({ label: t, kana: '' }) } })
    return out
  })()

  // ?print=1 の別ウィンドウ（設定のPDF出力）は、データ読み込み完了後に自動で印刷ダイアログ（A4横）を開く
  useEffect(() => {
    if (loading) return
    const wantPrint = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('print') === '1'
    if (!wantPrint) return
    const t = setTimeout(() => { try { window.print() } catch {} }, 600)   // 描画・フォント反映を待つ
    return () => clearTimeout(t)
  }, [loading])

  // 差分更新：別ウィンドウ（閲覧専用）では1分ごとに再取得し、変更があった伝票だけ差し替える。
  // 全画面 reload しないのでスクロール位置やピンチズーム状態を保ったまま最新化できる。
  const mergeDiff = useCallback((fresh) => {
    setAll(prev => {
      if (!Array.isArray(fresh)) return prev
      const byId = new Map(prev.map(s => [s.id, s]))
      let changed = fresh.length !== prev.length
      const next = fresh.map(f => {
        const old = byId.get(f.id)
        if (old && JSON.stringify(old) === JSON.stringify(f)) return old  // 変化なし→参照維持で再描画抑制
        changed = true
        return f
      })
      return changed ? next : prev
    })
  }, [])
  useEffect(() => {
    if (!isPopup) return
    // 共有ボードの自動更新。1分ごとに「表示中の当日ぶんだけ」を取得（日付索引で軽量）。
    // 非表示タブでは更新を止め、表示に戻った時は即時更新。同一端末の保存は storage 通知で即反映。
    const tick = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      try { mergeDiff(await api.get('/api/shipments?date=' + encodeURIComponent(dateRef.current))) } catch (e) { /* 一時的な失敗は無視 */ }
    }
    const t = setInterval(tick, 60000)
    const onVis = () => { if (typeof document !== 'undefined' && !document.hidden) tick() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [isPopup, mergeDiff])

  // 別タブ（出荷登録の編集ウィンドウ等）で更新が入ったら即座に再取得して反映する
  const refetch = useCallback(async () => {
    try { mergeDiff(await api.get('/api/shipments?date=' + encodeURIComponent(dateRef.current))) } catch (e) { /* 無視 */ }
  }, [mergeDiff])
  useShipmentsChanged(refetch)

  const firstT = (s) => (Array.isArray(s.times) && s.times.length) ? (s.times[0]?.text ?? s.times[0] ?? '') : ''
  // 時間を分に変換してソート。午前/AM=11:59(719分)・午後/PM=23:59(1439分)扱い、空欄は最後。"08:30"と"8:30"は同一
  const timeToMin = (t) => {
    const str = String(t || '').trim()
    if (!str) return 100000
    const m = str.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/)
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
    const up = str.toUpperCase()
    if (str.includes('午前') || up.includes('AM')) return 11 * 60 + 59   // 11:59
    if (str.includes('午後') || up.includes('PM')) return 23 * 60 + 59   // 23:59
    const h = str.match(/(\d{1,2})\s*時/)
    if (h) return parseInt(h[1], 10) * 60
    return 99999   // 解析できない文字 → 空欄の手前
  }
  const inAmPm = (s) => { if (ampm === 'both') return true; const mm = timeToMin(firstT(s)); return ampm === 'AM' ? mm < 720 : mm >= 720 }
  // all は日付索引で表示日ぶんのみ取得済み。日付変更中も前日の表示を残すため date 判定はしない（AM/PMのみ）
  const rows = all.filter(s => inAmPm(s))
    .sort((a, b) => timeToMin(firstT(a)) - timeToMin(firstT(b)) || String(firstT(a)).localeCompare(String(firstT(b))))

  const isChanged = (s, f) => Array.isArray(s.changedFields) && s.changedFields.includes(f)

  const getVal = (s, f) => {
    switch (f) {
      case 'drivers': {
        const names = Array.isArray(s.drivers) ? s.drivers.map(dispDriverName) : (s.driverName ? [s.driverName] : [])
        // 1人=1行、2人=各人1行ずつ（2行）、3人以降=2人ごとに改行
        if (names.length <= 2) return names.join('\n')
        const lines = []
        for (let i = 0; i < names.length; i += 2) lines.push(names.slice(i, i + 2).join('・'))
        return lines.join('\n')
      }
      case 'times': return (Array.isArray(s.times) ? s.times.map(t => (t && t.text != null) ? t.text : t) : []).join('\n')  // 1つごとに改行
      case 'vehicleType': return vehicleLabel(s)   // 数量付き（4t×2・7t）
      case 'notes': return (Array.isArray(s.notes) ? s.notes.map(n => n.text) : []).join(' / ')
      case 'noteTags': return (Array.isArray(s.noteTags) ? s.noteTags : []).join('・')
      case 'mixCode': return mixRowsOfShip(s).map(r => mixDisplay(r.code)).filter(Boolean).join(' / ')
      // 1行目/2行目の配合コード・特記を個別に編集できるよう分割
      case 'mixCode0': return mixDisplay(mixRowsOfShip(s)[0]?.code || '')
      case 'mixCode1': return mixDisplay(mixRowsOfShip(s)[1]?.code || '')
      case 'mixnote': return (mixRowsOfShip(s)[0]?.note || '')   // 1行目の配合特記
      case 'mixnote2': return (mixRowsOfShip(s)[1]?.note || '')  // 2行目の配合特記
      case 'volume': {
        // 直接編集できるよう1段目のみ返す（2段目は volume2 として別に編集）
        const b = (s.volume == null ? '' : String(s.volume)).trim()
        return (!b && !s.volumePlusA && !s.volumeUncertain) ? '' : `${b}${s.volumePlusA ? '+a' : ''}${s.volumeUncertain ? '  ?' : ''}`
      }
      case 'volume2': {
        const b = (s.volume2 == null ? '' : String(s.volume2)).trim()
        return (!b && !s.volumePlusA2 && !s.volumeUncertain2) ? '' : `${b}${s.volumePlusA2 ? '+a' : ''}${s.volumeUncertain2 ? '  ?' : ''}`
      }
      default: return s[f] == null ? '' : String(s[f])
    }
  }
  const applyField = (s, f, raw) => {
    if (f === 'drivers') return { ...s, drivers: raw.split(/[・,、/\n]/).map(x => x.trim()).filter(Boolean).map(n => ({ id: '', name: n })) }
    if (f === 'times') return { ...s, times: raw.split(/[/\n]/).map(x => x.trim()).filter(Boolean) }
    if (f === 'notes') return { ...s, notes: raw.split('/').map(x => x.trim()).filter(Boolean).map(t => ({ text: t, important: false })) }
    if (f === 'volume' || f === 'volume2') {
      // 範囲(13〜14)・+a・? を許容しつつ数値部を保持。volume2 は2段目を更新
      const uncertain = /[?？]/.test(raw)
      const plusA = /\+\s*a/i.test(raw)
      const num = raw.replace(/[?？]/g, '').replace(/\+\s*a/i, '').replace(/[^0-9.〜]/g, '').trim()
      if (f === 'volume2') return { ...s, volume2: num, volumeUncertain2: uncertain, volumePlusA2: plusA }
      return { ...s, volume: num, volumeUncertain: uncertain, volumePlusA: plusA }
    }
    if (f === 'vehicleType') {
      const types = raw.split(/[・,、/\s]+/).map(x => x.trim()).filter(Boolean)
      return { ...s, vehicleType: types.join('・'), vehicleItems: types.map(t => ({ type: t, qty: '' })) }
    }
    // s.mixRows から編集可能な配列(parts/note)を得るヘルパ。mixRows が無ければ mixCode/mixNotes からフォールバック
    const getEditableMixRows = (s) => {
      if (Array.isArray(s.mixRows) && s.mixRows.length) {
        return s.mixRows.map(r => ({ parts: [...(r.parts || ['', '', ''])], note: r.note || '' }))
      }
      const p = String(s.mixCode || '').split('-')
      return [{ parts: [(p[0] || '').trim(), (p[1] || '').trim(), (p[2] || '').trim()], note: (Array.isArray(s.mixNotes) ? s.mixNotes[1] : '') || '' }]
    }
    if (f === 'mixCode') {
      // 表示の整形（"24　　" や "18-15-20"）を解析。既存の note は同じ行の index で温存する。
      const oldRows = getEditableMixRows(s)
      const rows = raw.split('/').map(x => x.trim()).filter(Boolean).slice(0, 2)
        .map((r, i) => { const p = r.split(/[-　 ]/); return { parts: [(p[0] || '').trim(), (p[1] || '').trim(), (p[2] || '').trim()], note: oldRows[i]?.note || '' } })
      const list = rows.length ? rows : [{ parts: ['', '', ''], note: oldRows[0]?.note || '' }]
      return { ...s, mixRows: list, mixCode: list[0].parts.slice(0, 3).join('-') }
    }
    if (f === 'mixCode0' || f === 'mixCode1') {
      // 1行目/2行目のコードだけ更新。他行 parts/note を温存
      const idx = f === 'mixCode0' ? 0 : 1
      const rows = getEditableMixRows(s)
      while (rows.length <= idx) rows.push({ parts: ['', '', ''], note: '' })
      const p = raw.split(/[-　 ]/)
      rows[idx].parts = [(p[0] || '').trim(), (p[1] || '').trim(), (p[2] || '').trim()]
      return { ...s, mixRows: rows, mixCode: rows[0].parts.slice(0, 3).join('-') }
    }
    if (f === 'mixnote' || f === 'mixnote2') {
      const idx = f === 'mixnote' ? 0 : 1
      const rows = getEditableMixRows(s)
      while (rows.length <= idx) rows.push({ parts: ['', '', ''], note: '' })
      rows[idx].note = raw
      return { ...s, mixRows: rows }
    }
    return { ...s, [f]: raw }
  }
  const saveField = async (s, f, raw) => {
    if (raw === getVal(s, f)) return
    const updated = applyField(s, f, raw)
    const changedFields = Array.from(new Set([...(Array.isArray(s.changedFields) ? s.changedFields : []), f]))
    try {
      const res = await api.put(`/api/shipments/${s.id}`, { ...updated, changedFields })
      setAll(arr => arr.map(x => x.id === res.id ? res : x))
      notifyShipmentsChanged()
    } catch (e) { alert('保存エラー: ' + e.message) }
  }

  // 受信確認（地図/FAX）をタップで切替。連続タップ・応答の前後ズレでも壊れないようにする。
  //  方針：押された「最終状態(desired)」を伝票ごとにrefで管理し、伝票単位で1リクエストずつ直列保存する。
  //   - 楽観UIは即時反映。next は ref の desired を反転して決める（closureのsが古くても・連打でも正しい）
  //   - 保存中に再度押されたら、進行中の保存完了後に最新 desired を再送（差が無くなるまでループ）
  //   - 地図/FAX は同じ伝票ハッシュを更新するため、両方まとめて1リクエストで送る（同時更新の取りこぼし防止）
  //   - 確定後にサーバ実値へ同期し、他タブへ通知（自タブには storage イベントは飛ばない）
  const recvRef = useRef(new Map())   // id -> { desired:{mapReceived,faxReceived}, saving }
  const saveRecv = async (id) => {
    const entry = recvRef.current.get(id)
    if (!entry || entry.saving) return
    entry.saving = true
    try {
      let res, guard = 0
      while (guard++ < 50) {
        const snap = { mapReceived: !!entry.desired.mapReceived, faxReceived: !!entry.desired.faxReceived }
        res = await api.put(`/api/shipments/${id}?assign=1`, snap)
        // 保存中に新しいタップが無ければ確定（あれば最新値で再送）
        if (entry.desired.mapReceived === snap.mapReceived && entry.desired.faxReceived === snap.faxReceived) break
      }
      recvRef.current.delete(id)
      if (res) setAll(arr => arr.map(x => x.id === id ? { ...x, mapReceived: isOn(res.mapReceived), faxReceived: isOn(res.faxReceived) } : x))
      notifyShipmentsChanged()
    } catch (e) {
      recvRef.current.delete(id)
      alert('保存エラー: ' + (e?.message || e))
      try { mergeDiff(await api.get('/api/shipments?date=' + encodeURIComponent(dateRef.current))) } catch { /* 無視 */ }
    }
  }
  const toggleRecv = (s, key) => {
    let entry = recvRef.current.get(s.id)
    if (!entry) {
      entry = { desired: { mapReceived: isOn(s.mapReceived), faxReceived: isOn(s.faxReceived) }, saving: false }
      recvRef.current.set(s.id, entry)
    }
    const next = !entry.desired[key]
    entry.desired = { ...entry.desired, [key]: next }
    setAll(arr => arr.map(x => x.id === s.id ? { ...x, [key]: next } : x))   // 楽観UI
    saveRecv(s.id)
  }

  // モーダル編集：構造化パッチ（patch=実データ、changed=変更フィールド名）を一括保存
  const saveStructured = async (s, patch, changedKeys) => {
    const merged = { ...s, ...patch }
    // 業者名が空だとAPIが400を返すため、空なら元の値を温存して保存失敗を防ぐ
    if (!String(merged.companyName || '').trim()) merged.companyName = s.companyName || ''
    if (!String(merged.date || '').trim()) merged.date = s.date
    const changedFields = Array.from(new Set([...(Array.isArray(s.changedFields) ? s.changedFields : []), ...changedKeys]))
    try {
      const res = await api.put(`/api/shipments/${s.id}`, { ...merged, changedFields })
      setAll(arr => arr.map(x => x.id === res.id ? res : x))
      notifyShipmentsChanged()
    } catch (e) { alert('保存に失敗しました: ' + e.message); throw e }
  }

  const weekday = (() => { const d = new Date(date); return isNaN(d) ? '' : '日月火水木金土'[d.getDay()] })()

  // ===== セル文字の自動リサイズ（見切れたら改行ではなくフォントを縮小して収める）=====
  const fitEls = useRef(new Set())
  const fitOne = (el) => {
    if (!el || !el.isConnected) return
    el.style.fontSize = ''                 // いったんCSSの基準サイズ（clamp）に戻す
    // 編集できる現場名(sc-editwrap)：まず内容に合わせて最大3行まで高さを広げ、3行を超える時だけフォントを段階縮小（＝小さくする前に改行）
    if (el.classList && el.classList.contains('sc-editwrap')) {
      let size = parseFloat(getComputedStyle(el).fontSize) || 16
      let guard = 0
      const grow = () => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
      grow()
      while (el.scrollHeight > size * 1.3 * 3 + 2 && size > 11 && guard < 80) {
        size -= 0.5; el.style.fontSize = size + 'px'; grow(); guard++
      }
      return
    }
    const base = parseFloat(getComputedStyle(el).fontSize) || 16
    let size = base, guard = 0
    // 横（および textarea の縦）がはみ出す間、収まるまで縮める。
    // 現場名(sc-wrap2)は3行まで使うので下限を高め(12px)にして、長い名前でも読める大きさを保つ
    const minSize = (el.classList && el.classList.contains('sc-wrap2')) ? 12 : 8
    const over = () => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
    while (over() && size > minSize && guard < 80) { size -= 0.5; el.style.fontSize = size + 'px'; guard++ }
  }
  const fitAll = () => fitEls.current.forEach(el => { if (el && el.isConnected) fitOne(el); else fitEls.current.delete(el) })
  const fitRef = (el) => { if (el) { fitEls.current.add(el); requestAnimationFrame(() => fitOne(el)) } }
  useLayoutEffect(() => { requestAnimationFrame(() => requestAnimationFrame(fitAll)) })
  useEffect(() => {
    const on = () => requestAnimationFrame(fitAll)
    window.addEventListener('resize', on)
    window.addEventListener('orientationchange', on)
    // Webフォント（Noto Sans JP）読み込み完了後に再計測（読み込み前は幅がずれて見切れるため）
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(fitAll))
    return () => { window.removeEventListener('resize', on); window.removeEventListener('orientationchange', on) }
  }, [])

  // PC版の直接編集セル（inlineEdit時のみ）。フォーカスを外す（onBlur）と保存→予定表・出荷登録に反映
  const editCell = (s, f, opts = {}) => {
    const v = getVal(s, f)
    // 数量は編集中も「2桁=黒 / 3桁=赤」の太字を保つ（変更扱いのときは赤優先）。印刷でも赤を保つため sc-vol3 クラスも付与
    const isVol = f === 'volume' || f === 'volume2'
    const vol3 = isVol && (isChanged(s, f) || volNumColor(v) === '#c81e1e')
    // 「！」重要マーカー: 時間/備考に1つでも important があれば編集モードでも赤太字で表示
    const timeImp = f === 'times' && Array.isArray(s.times) && s.times.some(t => t && t.important)
    const noteImp = f === 'notes' && Array.isArray(s.notes) && s.notes.some(n => n && n.important)
    const imp = timeImp || noteImp
    const cls = 'sc-in sc-edit'
      + (isChanged(s, f) ? ' changed' : '')
      + (opts.center ? ' center' : '')
      + (opts.big ? ' big' : '')
      + (opts.xl ? ' xl' : '')
      + (opts.plain ? ' plain' : '')
      + (vol3 ? ' sc-vol3' : '')
      + (imp ? ' imp' : '')
    const editStyle = isVol
      ? { fontWeight: 700, color: vol3 ? '#c81e1e' : '#111' }
      : (imp ? { color: '#c81e1e', fontWeight: 700 } : undefined)
    const common = {
      key: f + '_e' + (isChanged(s, f) ? '_c' : ''),
      ref: fitRef,
      defaultValue: v,
      placeholder: opts.ph || '',
      onBlur: (e) => saveField(s, f, e.target.value),
      style: editStyle,
    }
    if (opts.wrap) {
      // 現場名など：編集できるが、小さくする前に最大3行まで折り返す（sc-editwrap を fitOne が処理）
      return <textarea {...common} className={cls + ' sc-ta sc-editwrap'} rows={1}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing) { e.preventDefault(); e.currentTarget.blur() } }} />
    }
    if (opts.multiline) {
      const rows = Math.max(1, (v.match(/\n/g) || []).length + 1)
      return <textarea {...common} className={cls + ' sc-ta'} rows={rows} />
    }
    return <input {...common} className={cls} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing) { e.preventDefault(); e.currentTarget.blur() } }} />
  }

  const cell = (s, f, ph, opts = {}) => {
    if (inlineEdit) return editCell(s, f, { ...opts, ph })
    const imp = f === 'notes' && Array.isArray(s.notes) && s.notes.some(n => n.important)
    const cls = 'sc-in'
      + (isChanged(s, f) ? ' changed' : '')
      + (opts.center ? ' center' : '')
      + (opts.big ? ' big' : '')
      + (opts.xl ? ' xl' : '')
      + (opts.tokki ? ' tokki' : '')
      + (imp ? ' imp' : (opts.plain ? ' plain' : ''))
    // 現場名など：1行で見切れる前に2行まで折り返し、3行目に行く前にフォントを縮小する
    if (opts.wrap) {
      const v = getVal(s, f)
      return (
        <div key={f + (isChanged(s, f) ? '_c' : '')} ref={fitRef} className={cls + ' sc-wrap2' + (v ? '' : ' sc-wrap2-ph')}>{v || ph || ''}</div>
      )
    }
    return (
      <input
        key={f + (isChanged(s, f) ? '_c' : '') + (imp ? '_i' : '')}
        ref={fitRef}
        className={cls}
        defaultValue={getVal(s, f)}
        placeholder={ph || ''}
        readOnly
        tabIndex={-1}
        style={{ pointerEvents: 'none' }}
      />
    )
  }

  const cellMulti = (s, f, ph, opts = {}) => {
    if (inlineEdit) return editCell(s, f, { ...opts, ph, multiline: true })
    const v = getVal(s, f)
    const rows = Math.max(1, (v.match(/\n/g) || []).length + 1)
    const timeImp = f === 'times' && Array.isArray(s.times) && s.times.some(t => t && t.important)
    const cls = 'sc-in sc-ta'
      + (isChanged(s, f) ? ' changed' : '')
      + (timeImp ? ' imp' : '')
      + (opts.center ? ' center' : '')
      + (opts.big ? ' big' : '')
    return (
      <textarea
        key={f + (isChanged(s, f) ? '_c' : '') + '_r' + rows}
        ref={fitRef}
        className={cls}
        rows={rows}
        defaultValue={v}
        placeholder={ph || ''}
        readOnly
        tabIndex={-1}
        style={{ pointerEvents: 'none' }}
      />
    )
  }

  // 時刻（スマホカード用）：2つ以上あるときは横並びにして間に「〜」を入れる
  const cellTimes = (s) => {
    const times = (Array.isArray(s.times) ? s.times.map(t => (t && t.text != null) ? t.text : t) : [])
      .map(x => String(x ?? '').trim()).filter(Boolean)
    const cls = 'sc-in sc-timeitem' + (isChanged(s, 'times') ? ' changed' : '') + (Array.isArray(s.times) && s.times.some(t => t && t.important) ? ' imp' : '')
    const saveAll = (container) => {
      const inputs = Array.from(container.querySelectorAll('input.sc-timeitem'))
      saveField(s, 'times', inputs.map(i => i.value.trim()).filter(Boolean).join('\n'))
    }
    const items = times.length ? times : ['']
    return (
      <div className={'sc-times' + (items.length === 1 ? ' single' : '')} key={'times' + (isChanged(s, 'times') ? '_c' : '') + '_n' + items.length}>
        {items.map((t, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="sc-timesep">　</span>}
            <input className={cls} defaultValue={t} placeholder={i === 0 ? '時間' : ''}
              size={5} readOnly tabIndex={-1} style={{ pointerEvents: 'none' }} />
          </Fragment>
        ))}
      </div>
    )
  }

  // 配合：複数行対応。各行は桁グループごとに分割描画。変更された桁(mix0/mix1/mix2)だけ赤くする（1行目のみ桁単位、追加行は行単位）
  // 空セクションは「-」を出さず全角空白で表示（例 24-- → 24　　）。数字が入った隣同士だけ「-」でつなぐ。
  const cellMix = (s, opts = {}) => {
    // 配合モード判定（mortar/dry/num）
    const mode = s.mixMode || (s.mixCode === 'ドライテック' ? 'dry' : (/^1:[1-4]$/.test(s.mixCode || '') ? 'mortar' : 'num'))
    if (inlineEdit) {
      if (mode === 'num') {
        // 数値モード: 行ごとに「特記(上) / 配合(下)」を縦に並べる（数量2段表示と同じ流儀）
        const rowsSrc = (Array.isArray(s.mixRows) && s.mixRows.length) ? s.mixRows : [{ parts: ['', '', ''], note: '' }]
        const hasRow1 = rowsSrc.length > 1 || (rowsSrc[1] && (rowsSrc[1].note || (rowsSrc[1].parts || []).some(p => p && String(p).trim())))
        // small オプションのとき: フォント / 行間 / padding を詰めて高さを縮める
        const codeStyle = opts.small ? { fontSize: 13, lineHeight: 1.1, padding: '0 2px' } : undefined
        const noteInput = (field) => {
          const changed = isChanged(s, field) || isChanged(s, 'mixCode')
          return (
            <input type="text"
              key={field + '_e' + (changed ? '_c' : '')}
              defaultValue={getVal(s, field)}
              placeholder="特記"
              onBlur={(e) => saveField(s, field, e.target.value)}
              style={{ width: '80%', alignSelf: 'center', fontSize: 9, lineHeight: 1, fontWeight: 700, color: '#c81e1e', textAlign: 'center', border: 'none', borderBottom: '1px dashed #e7a3a3', background: 'transparent', outline: 'none', padding: '0 2px 0', fontFamily: 'inherit' }} />
          )
        }
        const renderCode = (field) => {
          if (!opts.small) return editCell(s, field, { ...opts })
          // small モード: editCell の big を外して style override
          const sub = { ...opts }
          delete sub.big
          const el = editCell(s, field, sub)
          return el ? <span style={codeStyle}>{el}</span> : el
        }
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 0, lineHeight: 1.1 }}>
            {/* 1行目 */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
              {noteInput('mixnote')}
              {renderCode('mixCode0')}
            </div>
            {/* 2行目（存在時のみ） */}
            {hasRow1 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', marginTop: 1 }}>
                {noteInput('mixnote2')}
                {renderCode('mixCode1')}
              </div>
            )}
          </div>
        )
      }
      return editCell(s, 'mixCode', { ...opts })
    }
    const cls = 'sc-mixcode' + (opts.big ? ' big' : '') + (opts.center ? ' center' : '') + (opts.small ? ' sc-mixcode-small' : '')
    if (mode === 'dry') {
      return (
        <span ref={fitRef} className={cls} style={{ pointerEvents: 'none', fontSize: 14, fontWeight: 800, letterSpacing: '.04em', whiteSpace: 'nowrap' }}>ドライテック</span>
      )
    }
    if (mode === 'mortar') {
      return (
        <span ref={fitRef} className={cls} style={{ pointerEvents: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 }}>
          <span style={{ fontSize: 10, color: '#7a5d00', background: '#fff8e1', border: '1px solid #f0d089', borderRadius: 3, padding: '0 4px', fontWeight: 700, letterSpacing: '.05em', marginBottom: 2 }}>モルタル</span>
          <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: '.05em' }}>{s.mixCode || ''}</span>
        </span>
      )
    }
    const rows = mixRowsOfShip(s).filter(r => r.code || r.note)
    if (!rows.length) {
      return <span ref={fitRef} className={cls} style={{ pointerEvents: 'none' }} />
    }
    const wholeRed = isChanged(s, 'mixCode') && !['mix0', 'mix1', 'mix2'].some(k => isChanged(s, k))
    return (
      <span ref={fitRef} className={cls} key={'mix' + (isChanged(s, 'mixCode') ? '_c' : '') + '_n' + rows.length} style={{ pointerEvents: 'none' }}>
        {rows.map((r, ri) => {
          const parts = String(r.code || '').split('-')
          // 各配合行の「上」にその行の特記を表示（特記→配合→特記→配合…）
          const noteRed = (ri === 0 && (isChanged(s, 'mixnote') || isChanged(s, 'mixCode'))) || (ri === 1 && isChanged(s, 'mixnote2'))
          return (
            <Fragment key={ri}>
              {(r.note && r.note.trim()) ? (
                <span className="sc-mixnote-line" style={noteRed ? { color: '#c81e1e' } : undefined}>{r.note}</span>
              ) : null}
              {r.code ? (
                <span style={{ display: 'block', whiteSpace: 'nowrap' }}>
                  {parts.map((p, i) => (
                    <Fragment key={i}>
                      {i > 0 && <span>-</span>}
                      <span style={{ color: (wholeRed || (ri === 0 && isChanged(s, 'mix' + i))) ? '#c81e1e' : undefined }}>{p || '　'}</span>
                    </Fragment>
                  ))}
                </span>
              ) : null}
            </Fragment>
          )
        })}
      </span>
    )
  }

  // 数量：2つあるときは上下2行で表示（各行に +a / ? を付与）。
  // 表示色は「2桁=黒太字 / 3桁=赤太字」。変更（赤）扱いのときは赤を優先。整形表示のため直接編集はせず、編集はフォーム(✏️)で。
  // 数量の特記（volumeNote / volumeNote2）は数値の上に小さく赤で表示
  const cellVolume = (s) => {
    const has2 = s.volume2 != null && String(s.volume2).trim() !== ''
    const note1 = String(s.volumeNote || '').trim()
    const note2 = String(s.volumeNote2 || '').trim()
    const volNoteLabel = (text) => text
      ? <span style={{ display: 'block', fontSize: 10, color: '#c81e1e', fontWeight: 700, lineHeight: 1, textAlign: 'center' }}>{text}</span>
      : null
    // 直接編集できる量の特記 input（配合特記と同じ赤・破線下線スタイル）
    const volNoteInput = (field) => {
      const changed = isChanged(s, field) || isChanged(s, 'volume')
      return (
        <input type="text"
          key={field + '_e' + (changed ? '_c' : '')}
          defaultValue={getVal(s, field)}
          placeholder="特記"
          onBlur={(e) => saveField(s, field, e.target.value)}
          style={{ width: '80%', alignSelf: 'center', fontSize: 10, lineHeight: 1, fontWeight: 700, color: '#c81e1e', textAlign: 'center', border: 'none', borderBottom: '1px dashed #e7a3a3', background: 'transparent', outline: 'none', padding: '0 2px 0', fontFamily: 'inherit' }} />
      )
    }
    // PC直接編集：1段はそのまま、2段は上下に分けてそれぞれ直接編集できるようにする（色は editCell 側で桁により付与）
    if (inlineEdit) {
      if (!has2) return (
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
          {volNoteInput('volumeNote')}
          {editCell(s, 'volume', { center: true, big: true })}
        </span>
      )
      return (
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
          {volNoteInput('volumeNote')}
          {editCell(s, 'volume', { center: true, big: true })}
          {volNoteInput('volumeNote2')}
          {editCell(s, 'volume2', { center: true, big: true })}
        </span>
      )
    }
    const segs = [[s.volume, s.volumePlusA, s.volumeUncertain, s.volumeNote], [s.volume2, s.volumePlusA2, s.volumeUncertain2, s.volumeNote2]]
      .map(([v, a, u, n]) => { const b = (v == null ? '' : String(v)).trim(); return (!b && !a && !u) ? null : { num: b, text: `${b}${a ? '+a' : ''}${u ? '?' : ''}`, note: String(n || '').trim() } })
      .filter(Boolean)
    const red = isChanged(s, 'volume')
    if (!segs.length) return <span ref={fitRef} className="sc-mixcode big center" style={{ pointerEvents: 'none' }} />
    return (
      <span ref={fitRef} className="sc-mixcode big center" key={'vol' + (red ? '_c' : '') + '_n' + segs.length} style={{ pointerEvents: 'none' }}>
        {segs.map((seg, i) => {
          const r3 = red || volNumColor(seg.num) === '#c81e1e'
          return (
            <span key={i} className={r3 ? 'sc-vol3' : undefined} style={{ display: 'block', whiteSpace: 'nowrap', fontWeight: 700, color: r3 ? '#c81e1e' : '#111' }}>
              {seg.note ? <span style={{ display: 'block', fontSize: 10, color: '#c81e1e', fontWeight: 700, lineHeight: 1, marginBottom: 1 }}>{seg.note}</span> : null}
              {seg.text}
            </span>
          )
        })}
      </span>
    )
  }

  // 備考：行ごとに分割描画。追加/変更された行(note0,note1,…)だけ赤くする
  // 先頭に特記（領/追）を太字・赤で表示。車種の自由入力（vehicleFree）は備考の末尾に半角スペースを空けて追加する
  const cellNotes = (s, opts = {}) => {
    if (inlineEdit) return editCell(s, 'notes', { ...opts, multiline: true })
    const arr = Array.isArray(s.notes) ? s.notes : []
    // 車両自由入力：noVf のときは備考に出さない（車両欄／電話の右に別途表示するため）
    const vf = opts.noVf ? '' : String(s.vehicleFree || '').trim()
    // 特記タグ(領/追): noTags のときは備考に出さない（特記列で別途表示するため）
    const tags = opts.noTags ? [] : (Array.isArray(s.noteTags) ? s.noteTags : []).filter(Boolean)
    const cls = 'sc-in sc-notes' + (opts.plain ? ' plain' : '')
    const wholeRed = isChanged(s, 'notes') && !arr.some((_, i) => isChanged(s, 'note' + i))
    if (!arr.length && !vf && !tags.length) {
      return <span ref={fitRef} className={cls} style={{ pointerEvents: 'none', color: '#cbd2dc' }}>{opts.ph || '備考'}</span>
    }
    return (
      <span ref={fitRef} className={cls} key={'notes' + (isChanged(s, 'notes') ? '_c' : '') + '_vf' + vf.length + '_t' + tags.length} style={{ pointerEvents: 'none' }}>
        {tags.length ? <span style={{ color: '#c81e1e', fontWeight: 700, fontSize: '1.1em' }}>{tags.join('・')}{(arr.length || vf) ? '　' : ''}</span> : null}
        {arr.map((n, i) => {
          const red = wholeRed || isChanged(s, 'note' + i) || (n && n.important)
          return (
            <Fragment key={i}>
              {i > 0 && <span> / </span>}
              <span style={{ color: red ? '#c81e1e' : undefined, fontWeight: (n && n.important) ? 700 : undefined }}>{n.text}</span>
            </Fragment>
          )
        })}
        {vf ? <span style={{ color: '#1b4ea8', fontWeight: 700 }}>{arr.length ? ' ' : ''}{vf}</span> : null}
      </span>
    )
  }

  // 担当：1行=2人。各行を独立した入力にして、行ごとに別々の自動リサイズを行う
  // opts.oneEach=true のときは1人ずつ1行（縦並び）にする（スマホカード用）
  const cellDrivers = (s, opts = {}) => {
    if (inlineEdit) return editCell(s, 'drivers', { ...opts, multiline: true })
    const v = getVal(s, 'drivers')               // 2人ごとに改行された文字列
    let lines = v ? v.split('\n') : ['']
    if (opts.oneEach) {                           // 各行をさらに分解して1人=1行に
      const names = (Array.isArray(s.drivers) ? s.drivers.map(dispDriverName) : (s.driverName ? [s.driverName] : []))
        .map(x => String(x ?? '').trim()).filter(Boolean)
      lines = names.length ? names : ['']
    }
    const display = lines.length ? lines : ['']
    const cls = 'sc-in sc-driverline' + (isChanged(s, 'drivers') ? ' changed' : '') + (opts.big ? ' big' : '')
    return (
      <div className="sc-drivers" key={'drivers' + (isChanged(s, 'drivers') ? '_c' : '') + '_n' + display.length}>
        {display.map((line, i) => (
          <input
            key={i}
            ref={fitRef}
            className={cls}
            defaultValue={line}
            placeholder={i === 0 ? '担当' : ''}
            readOnly
            tabIndex={-1}
            style={{ pointerEvents: 'none' }}
          />
        ))}
      </div>
    )
  }

  // 担当（スマホカード用）：1人=大きく1段、2人=2段（各1人）、3人以上=2人ずつ（3人＝上2・下1）
  const cellDriversCard = (s) => {
    const names = (Array.isArray(s.drivers) ? s.drivers.map(dispDriverName) : (s.driverName ? [s.driverName] : []))
      .map(x => String(x ?? '').trim()).filter(Boolean)
    const n = names.length
    const rows = []
    if (n <= 2) names.forEach(nm => rows.push([nm]))
    else for (let i = 0; i < n; i += 2) rows.push(names.slice(i, i + 2))
    if (rows.length === 0) rows.push([''])
    const single = n <= 1
    const changed = isChanged(s, 'drivers')
    const cls = 'sc-in sc-driverline' + (changed ? ' changed' : '') + (single ? ' xbig' : ' big')
    let idx = 0
    return (
      <div className="sc-drivers-card" key={'drv' + (changed ? '_c' : '') + '_n' + n}>
        {rows.map((row, ri) => (
          <div className="sc-drv-row" key={ri}>
            {row.map((nm) => {
              const i = idx++
              return (
                <input key={i} className={cls} defaultValue={nm}
                  placeholder={i === 0 ? '担当' : ''} readOnly tabIndex={-1} style={{ pointerEvents: 'none' }} />
              )
            })}
          </div>
        ))}
      </div>
    )
  }

  const openEditWindow = (s) => {
    const url = `${window.location.pathname}?editShipment=${encodeURIComponent(s.id)}&popup=1`
    const w = window.open(url, '_blank', 'width=900,height=950,scrollbars=yes,resizable=yes')
    if (!w) {
      alert('別ウィンドウを開けませんでした。ブラウザのポップアップを許可するか、下のリンクから開いてください。')
      window.open(url, '_blank')
    }
  }

  const openScheduleWindow = () => {
    const url = `${window.location.pathname}?view=schedule&popup=1`
    const w = window.open(url, '_blank', 'width=1200,height=820,scrollbars=yes,resizable=yes')
    if (!w) { alert('別ウィンドウを開けませんでした。ブラウザのポップアップを許可してください。'); window.open(url, '_blank') }
  }

  // 添付PDFを新規ウィンドウで開く
  const openPdfWin = (id) => openPdfViewer(id)

  // LINE送信：送り先（従業員管理のドライバー）を選んで一括送信→送信できたら担当に追加していく
  const cleanLineId = (v) => String(v || '').replace(/[\s　​-‍﻿]/g, '').trim()
  const openLine = (s) => { setLineTarget(s); setLineSel([]) }
  const toggleLineSel = (id) => setLineSel(sel => sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id])
  const doSendLine = async () => {
    const s = lineTarget
    if (!s) return
    const chosen = drivers.filter(d => lineSel.includes(d.id))
    if (chosen.length === 0) { alert('送り先を選択してください'); return }
    const withId = chosen.map(d => ({ id: d.id, name: d.name, lineId: cleanLineId(d.lineId) })).filter(r => r.lineId)
    const without = chosen.filter(d => !cleanLineId(d.lineId))
    if (withId.length === 0) { alert('選択した送り先にLINEユーザーIDが設定されていません。\n従業員管理でLINE IDを設定してください。'); return }
    try {
      const res = await api.post('/api/line', { action: 'pushShipment', shipmentId: s.id, lineUserIds: withId.map(r => r.lineId) })
      // 送信できたら担当に追加（既存とマージ・重複除外）
      const cur = Array.isArray(s.drivers) ? s.drivers : []
      const merged = [...cur]
      chosen.forEach(d => { if (!merged.some(x => (x.id && x.id === d.id) || x.name === d.name)) merged.push({ id: d.id, name: d.name }) })
      try {
        const updated = await saveShipmentDrivers(s, merged)
        setAll(arr => arr.map(x => x.id === updated.id ? updated : x))
        notifyShipmentsChanged()
      } catch { /* 担当追加に失敗しても送信自体は完了 */ }
      const fails = (res.results || []).filter(r => !r.ok)
      let msg = `送信しました（${res.sent}/${res.total} 件成功）`
      if (without.length) msg += `\n（LINE未設定でスキップ: ${without.map(d => d.name).join('、')}）`
      if (fails.length) {
        const lines = fails.map(f => { const who = withId.find(w => w.lineId === f.to); return `・${who ? who.name : ''}（${f.to}）\n  ${f.error || '不明なエラー'}` })
        msg += `\n\n■ 送信失敗:\n${lines.join('\n')}`
      }
      alert(msg)
      setLineTarget(null)
    } catch (e) {
      alert('送信に失敗しました: ' + e.message)
    }
  }
  // LINE送信（担当変更なし）：割り当て済みの担当者へそのままpush送信する
  const sendToAssigned = async (s) => {
    const assigned = Array.isArray(s.drivers) ? s.drivers : (s.driverName ? [{ id: s.driverId || '', name: s.driverName }] : [])
    if (!assigned.length) { alert('担当者が割り当てられていません。\n先に「担当」を割り当ててください（出荷登録／配送割り当て）。'); return }
    const resolved = assigned.map(d => { const emp = drivers.find(e => (d.id && e.id === d.id) || e.name === d.name); return { name: d.name, lineId: cleanLineId(emp?.lineId || d.lineId) } })
    const withId = resolved.filter(r => r.lineId)
    const without = resolved.filter(r => !r.lineId)
    if (!withId.length) { alert('担当者にLINEユーザーIDが設定されていません。\n（従業員管理でLINE IDを設定してください）'); return }
    if (!window.confirm(`${withId.map(r => r.name).join('、')} にLINEを送信しますか？`)) return
    try {
      const res = await api.post('/api/line', { action: 'pushShipment', shipmentId: s.id, lineUserIds: withId.map(r => r.lineId) })
      const fails = (res.results || []).filter(r => !r.ok)
      let msg = `送信しました（${res.sent}/${res.total} 件成功）`
      if (without.length) msg += `\n（LINE未設定でスキップ: ${without.map(r => r.name).join('、')}）`
      if (fails.length) msg += `\n\n■ 送信失敗:\n${fails.map(f => { const who = withId.find(w => w.lineId === f.to); return `・${who ? who.name : ''}（${f.error || '不明なエラー'}）` }).join('\n')}`
      alert(msg)
    } catch (e) { alert('送信に失敗しました: ' + e.message) }
  }
  // 伝票を削除（キャンセル＝キャンセル伝票に保管・復元可）
  const deleteShip = async (s) => {
    if (!window.confirm(`この伝票を削除しますか？\n${firstTimeOf(s) || ''}　${s.companyName || ''}\n（キャンセル伝票に保管され、復元できます）`)) return
    try {
      await api.put(`/api/shipments/${s.id}?cancel=1`, { cancelled: true })
      setAll(arr => arr.filter(x => x.id !== s.id))
      notifyShipmentsChanged()
    } catch (e) { alert('削除に失敗しました: ' + e.message) }
  }

  // 「修正＝赤文字」表示をリセットする（表示日ぶん）。
  // 消すのは changedFields（=編集された目印）だけ。下記は触らない＝赤のまま保たれる:
  //  ・値ベースの赤（3桁数量＝volNumColorで色付け、配合の桁数など）
  //  ・特記タグ（領/追）の固定赤・試験タグ（現/工）・vehicleFree の青  …値・タグそのものを参照しているため
  //  ・時間/備考の「！」指定赤  …times[i].important / notes[i].important に保存されており、
  //    PUTで times/notes を丸ごと送り直しても important フラグは欠落しない
  const resetReds = async () => {
    const targets = rows.filter(s => Array.isArray(s.changedFields) && s.changedFields.length)
    if (targets.length === 0) { alert('赤（修正）表示はありません'); return }
    if (!window.confirm(`この日の「修正＝赤」表示を${targets.length}件分リセットしますか？\n（時間・備考の「！」指定赤と、3桁の数量・特記タグの赤はそのまま残ります）`)) return
    for (const s of targets) {
      try {
        const res = await api.put(`/api/shipments/${s.id}`, { ...s, changedFields: [] })
        setAll(arr => arr.map(x => x.id === res.id ? res : x))
      } catch (e) { console.error(e) }
    }
    notifyShipmentsChanged()
  }

  // AM/PM表示切替（未選択=全体）。印刷には出さない
  const ampmButtons = (
    <span className="no-print" style={{ display: 'inline-flex', gap: 6 }}>
      {['AM', 'PM'].map(p => (
        <button key={p} type="button" onClick={() => setAmpm(a => a === p ? 'both' : p)}
          style={{ border: ampm === p ? '2px solid #0f3060' : '1.5px solid #bbb', background: ampm === p ? '#0f3060' : '#fff', color: ampm === p ? '#fff' : '#3a4a5c', borderRadius: 6, padding: '4px 10px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{p}</button>
      ))}
    </span>
  )

  return (
    <div className={isPopup ? 'schedule-popup-root' : ''} style={{ height: '100%', overflow: 'auto', background: '#fff' }}>
      {isPopup ? (
        /* 別ウィンドウ: 日付・曜日(左)／タイトル(中央)／閉じる(右)、その下にAM/PM(中央) */
        <div style={{ borderBottom: '1px solid #e5e9f0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 8, padding: '10px 12px 4px' }}>
            <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                style={{ fontSize: 13, padding: '4px 6px', border: '1.5px solid #bbb', borderRadius: 6, minWidth: 0 }} />
              <span style={{ fontSize: 13, color: '#111', whiteSpace: 'nowrap' }}>（{weekday}）</span>
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#111', letterSpacing: '0.2em', whiteSpace: 'nowrap', textAlign: 'center' }}>出荷予定表</div>
            {/* 掲示板形式（共有ボード）は閉じるボタンを置かない（ブラウザのタブ/ウィンドウで閉じる） */}
            <div className="no-print" />
          </div>
          <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '0 12px 10px' }}>
            {ampmButtons}
          </div>
        </div>
      ) : (
      <div style={{ position: 'relative', padding: '12px 16px', minHeight: 44, display: compact ? 'flex' : 'block', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <div style={{ textAlign: 'center', fontSize: compact ? 18 : 22, fontWeight: 700, color: '#111', letterSpacing: compact ? '0.15em' : '0.35em' }}>出荷予定表</div>
        <div style={compact
          ? { display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8, color: '#111' }
          : { position: 'absolute', left: 16, top: 10, display: 'flex', alignItems: 'center', gap: 8, color: '#111' }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ fontSize: compact ? 16 : 14, padding: '5px 8px', border: '1.5px solid #bbb', borderRadius: 6 }} />
          <span style={{ fontSize: 15 }}>（{weekday}）</span>
          <button type="button" onClick={openScheduleWindow}
            style={{ border: '1.5px solid #0f3060', background: '#fff', color: '#0f3060', borderRadius: 7, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>{compact ? '📋 掲示板形式で表示' : '⛶ 別ウィンドウで開く'}</button>
          {compact && ampmButtons}
        </div>
        {/* PC/iPad: AM/PMはタイトルに被らないよう右端に配置 */}
        {!compact && <div className="no-print" style={{ position: 'absolute', right: 16, top: 10 }}>{ampmButtons}</div>}
      </div>
      )}
      {compact ? (
        <div className="schedule sc-cards">
          {loading ? (
            <div style={{ padding: 20, color: '#6b7a8d' }}>読み込み中...</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 20, color: '#6b7a8d' }}>この日（{date}）の出荷登録はありません</div>
          ) : (
            <>
              {rows.map(s => (
                <div className="sc-card" key={s.id}>
                  {/* 時刻 | 業者名（上）/ 商社名（下） */}
                  <div className="sc-card-head">
                    <div className="sc-time">{cellTimes(s)}</div>
                    <div className="sc-names">
                      <div className="sc-company">{cell(s, 'companyName', '業者名')}</div>
                      <div className="sc-trading">{cell(s, 'tradingCompany', '商社名')}</div>
                    </div>
                  </div>
                  {/* 現場名（中央・大きく） */}
                  <div className="sc-row sc-site"><span className="sc-val">{cell(s, 'siteName', '現場名', { big: true, wrap: true })}</span></div>
                  {/* ブロック形式：担当 / 車種 ・ 配合 / 量 */}
                  <div className="sc-grid2">
                    <div className="sc-box"><span className="sc-lbl">担当</span>{cellDriversCard(s)}</div>
                    <div className="sc-box sc-vehbox"><span className="sc-lbl">車種</span>
                      <div className="sc-veh">
                        {/* 補足(vehicleFree) は車種数字の上に表示（備考には出さない） */}
                        {String(s.vehicleFree || '').trim() ? (
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#1b4ea8', lineHeight: 1.1, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.vehicleFree}</div>
                        ) : null}
                        {cell(s, 'vehicleType', '', { center: true, big: true })}
                      </div>
                    </div>
                    <div className="sc-box"><span className="sc-lbl">配合</span>{cellMix(s, { center: true, big: true })}</div>
                    <div className="sc-box sc-volbox"><span className="sc-lbl">数量</span>{cellVolume(s)}</div>
                  </div>
                  {/* 打設 / 種 / 特記 / 地図 */}
                  <div className="sc-row"><span className="sc-lbl">打設</span><span className="sc-val">{cell(s, 'pourLocation', '打設箇所')}</span></div>
                  <div className="sc-row"><span className="sc-lbl">種</span><span className="sc-val">{(() => {
                    const ct = (v) => v === 'B' ? <b style={{ fontWeight: 800 }}>B</b> : (v || '—')
                    return s.cementType2 ? <span>{ct(s.cementType)} / {ct(s.cementType2)}</span> : ct(s.cementType)
                  })()}</span></div>
                  {/* 特記: 領追(赤太字) + 現工(testTags 略表記) */}
                  <div className="sc-row"><span className="sc-lbl">特記</span><span className="sc-val">{(() => {
                    const tags = (Array.isArray(s.noteTags) ? s.noteTags : []).filter(Boolean).join('')
                    const tests = (Array.isArray(s.testTags) ? s.testTags : []).map(t => t === '現TP' ? '現' : t === '工TP' ? '工' : t).filter(Boolean).join('')
                    if (!tags && !tests) return <span style={{ color: '#cbd2dc' }}>—</span>
                    return (
                      <span>
                        {tags ? <b style={{ color: '#c81e1e', fontSize: '1.05em' }}>{tags}</b> : null}
                        {tags && tests ? <span style={{ marginLeft: 8 }} /> : null}
                        {tests ? <b style={{ color: '#111' }}>{tests}</b> : null}
                      </span>
                    )
                  })()}</span></div>
                  <div className="sc-row"><span className="sc-lbl">地図</span><span className="sc-val" style={{ fontWeight: 800, color: '#1a7a3a' }}>
                    {(String(s.siteAddress || '').trim() || s.hasPdf === '1' || s.hasPdf === true || s.hasPdf === 1) ? '✔' : '—'}
                  </span></div>
                  {/* 備考（横並び）: 領追は特記行・vehicleFree は車種に統合したので noTags + noVf */}
                  <div className="sc-row"><span className="sc-lbl">備考</span><span className="sc-val">{cellNotes(s, { plain: true, noTags: true, noVf: true })}</span></div>
                  {/* 現場連絡先 */}
                  <div className="sc-row"><span className="sc-lbl">現場連絡先</span><span className="sc-val">{cell(s, 'siteContact', '現場連絡先')}</span></div>
                  <div className="sc-card-actions">
                    <button type="button" onClick={() => setEditModal(s)}
                      style={{ flex: 1, border: '1px solid #1a8f5a', background: '#f0f9f0', color: '#1a8f5a', borderRadius: 8, padding: '11px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>✏️ 編集</button>
                    <button type="button" onClick={() => openLine(s)}
                      style={{ flex: 1, border: '1px solid #06c755', background: '#06c755', color: '#fff', borderRadius: 8, padding: '11px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>LINE送信</button>
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 12, color: '#6b7a8d', padding: '4px 2px' }}>
                黒＝出荷登録の値／赤＝変更した値・重要（出荷登録にも反映されます）
              </div>
              {!isPopup && (
                <div className="no-print" style={{ marginTop: 8, textAlign: 'right' }}>
                  <button type="button" onClick={resetReds}
                    style={{ border: '1px dashed #c0392b', background: '#fff', color: '#c0392b', borderRadius: 6, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                    title="この日の「修正＝赤」表示をリセット（時間・備考の「！」と元から赤の値はそのまま）">
                    🧹 赤文字（修正）をリセット
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ) : (() => {
        const inner = (<>
        <table>
          {/* 列構成: 時間 / 業者+商社 / 現場 / 打設 / 車種(7%) / 配合 / 数量 / 種(3%) / 担当 / 備考+連絡先(16%) / 特記(2.5%) / 地図(2.5%) / (編集) */}
          <colgroup>
            <col style={{ width: '7%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '3%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '2.5%' }} />
            <col style={{ width: '2.5%' }} />
            {!isPopup && <col style={{ width: '7%' }} />}
          </colgroup>
          <thead>
            <tr>
              <th>時間</th>
              <th><div>業者名</div><div>商社</div></th>
              <th>現場名</th>
              <th className="th-tight">打設</th>
              <th className="th-tight">車種</th>
              <th>配合</th>
              <th>数量</th>
              <th className="th-tight">種</th>
              <th>担当</th>
              <th><div>備考</div><div>現場連絡先</div></th>
              <th className="th-tight">特記</th>
              <th className="th-tight">地図</th>
              {!isPopup && <th className="th-tight">編集</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(s => (
              <tr key={s.id}>
                <td className="sc-nowrap">{cellMulti(s, 'times', '', { center: true, big: true })}</td>
                <td>{cell(s, 'companyName', '業者名', { wrap: true })}{cell(s, 'tradingCompany', '商社', { wrap: true })}</td>
                <td>{cell(s, 'siteName', '', { big: true, wrap: true })}</td>
                <td>{cell(s, 'pourLocation', '', { center: true, wrap: true })}</td>
                {/* 車種: 補足(vehicleFree) も inline 編集可。表示時のみ vfPlace で長い文字は備考列にあふれさせる */}
                <td className="sc-nowrap">
                  {inlineEdit ? (
                    <input type="text"
                      key={'vf' + (isChanged(s, 'vehicleFree') ? '_c' : '')}
                      defaultValue={s.vehicleFree || ''}
                      placeholder="補足"
                      onBlur={(e) => saveField(s, 'vehicleFree', e.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, fontWeight: 700, color: '#1b4ea8', textAlign: 'center', border: 'none', borderBottom: '1px dashed #c0d0e3', background: 'transparent', outline: 'none', padding: '0 2px 1px' }} />
                  ) : (
                    vfPlace(s.vehicleFree).veh ? <div style={{ fontSize: vfVehFontSchedule(vfPlace(s.vehicleFree).veh), fontWeight: 700, lineHeight: 1.05, whiteSpace: 'nowrap', color: '#1b4ea8', textAlign: 'center' }}>{vfPlace(s.vehicleFree).veh}</div> : null
                  )}
                  {cell(s, 'vehicleType', '', { center: true, big: true, xl: true })}
                </td>
                <td className="sc-nowrap">{cellMix(s, { center: true, small: true })}</td>
                <td className="sc-nowrap">{cellVolume(s)}</td>
                {/* 種: 1つだけ=従来どおり / 2つあれば縦並び（B/N など） */}
                <td className="sc-nowrap" style={{ textAlign: 'center' }}>{(() => {
                  const ct = (v) => v === 'B'
                    ? <b style={{ fontWeight: 800, fontSize: 18 }}>B</b>
                    : <span style={{ fontSize: 16 }}>{v || ''}</span>
                  const c1 = s.cementType || ''
                  const c2 = s.cementType2 || ''
                  if (c1 && c2) {
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.05 }}>
                        <span>{ct(c1)}</span>
                        <span style={{ fontSize: 9, color: '#999', lineHeight: 1 }}>─</span>
                        <span>{ct(c2)}</span>
                      </div>
                    )
                  }
                  return ct(c1)
                })()}</td>
                <td>{cellDrivers(s, { big: true })}</td>
                {/* 備考: 領追インラインは特記列に統合したので noTags で抑制 */}
                <td>{cellNotes(s, { plain: true, noVf: true, noTags: true })}{cell(s, 'siteContact', '現場連絡先')}{!inlineEdit && vfPlace(s.vehicleFree).over ? <span style={{ marginLeft: 8, color: '#1b4ea8', fontWeight: 700 }}>{vfPlace(s.vehicleFree).over}</span> : null}</td>
                {/* 特記: 上=領/追(赤太字)、下=現/工(testTags の TP を除く略表記) */}
                <td className="sc-nowrap" style={{ textAlign: 'center', padding: '2px 2px' }}>{(() => {
                  const tags = (Array.isArray(s.noteTags) ? s.noteTags : []).filter(Boolean).join('')
                  const tests = (Array.isArray(s.testTags) ? s.testTags : []).map(t => t === '現TP' ? '現' : t === '工TP' ? '工' : t).filter(Boolean).join('')
                  if (!tags && !tests) return null
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1 }}>
                      {tags ? <div style={{ fontSize: 11, fontWeight: 800, color: '#c81e1e', lineHeight: 1.1 }}>{tags}</div> : null}
                      {tests ? <div style={{ fontSize: 10, fontWeight: 800, color: '#111', marginTop: tags ? 1 : 0, lineHeight: 1.1 }}>{tests}</div> : null}
                    </div>
                  )
                })()}</td>
                {/* 地図: 現場住所が入っているか PDF添付があれば ✔（生コン予定表と同ロジック） */}
                <td style={{ textAlign: 'center', fontWeight: 800, color: '#1a7a3a', fontSize: 16 }}>
                  {(String(s.siteAddress || '').trim() || s.hasPdf === '1' || s.hasPdf === true || s.hasPdf === 1) ? '✔' : ''}
                </td>
                {!isPopup && (
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <button type="button" className="sc-act edit" onClick={() => openEditWindow(s)}>✏️ 編集</button>
                        <button type="button" className="sc-act line" style={{ marginTop: 0 }} onClick={() => openLine(s)}>LINE送信</button>
                      </div>
                      <button type="button" className="sc-act del" style={{ flex: '0 0 auto', width: 'auto', marginTop: 0, alignSelf: 'stretch', padding: '4px 6px' }} onClick={() => deleteShip(s)} title="この伝票を削除（キャンセル伝票に保管・復元可）">削除</button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {loading ? (
          <div style={{ padding: 20, color: '#6b7a8d' }}>読み込み中...</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, color: '#6b7a8d' }}>この日（{date}）の出荷登録はありません</div>
        ) : (
          <div style={{ marginTop: 8, fontSize: 12, color: '#6b7a8d', lineHeight: 1.5, padding: isPopup ? '8px 8px 16px' : 0 }}>
            黒＝出荷登録の値／赤＝変更した値・重要（出荷登録にも反映されます）
          </div>
        )}
        {!isPopup && rows.length > 0 && (
          <div className="no-print" style={{ marginTop: 12, textAlign: 'right' }}>
            <button type="button" onClick={resetReds}
              style={{ border: '1px dashed #c0392b', background: '#fff', color: '#c0392b', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              title="この日の「修正＝赤」表示をリセット（時間・備考の「！」と元から赤の値はそのまま）">
              🧹 赤文字（修正）をリセット
            </button>
          </div>
        )}
        </>)
        if (!isPopup) return <div className="schedule" style={{ overflowX: 'auto', padding: '0 16px 24px' }}>{inner}</div>
        // 別ウィンドウ:
        //   ・PC幅(>=880)では画面いっぱいに表示
        //   ・スマホ幅(<880)では FitToWidth による縮小だと地図など右端の列が見切れるため、
        //     横スクロール可能にして全列を読めるようにする
        return popupNarrow
          ? <div className="schedule popup-view" style={{ padding: '4px 0 24px', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <div style={{ minWidth: 760 }}>{inner}</div>
            </div>
          : <div className="schedule popup-view" style={{ padding: '4px 12px 24px' }}>{inner}</div>
      })()}
      {editModal && (
        <ScheduleEditModal
          shipment={editModal}
          driverOptions={drivers}
          companyComboOptions={companyComboOptions}
          tradingComboOptions={tradingComboOptions}
          onClose={() => setEditModal(null)}
          onSave={async (patch, changedKeys) => { await saveStructured(editModal, patch, changedKeys); setEditModal(null) }}
        />
      )}
      {lineTarget && (
        <div onClick={() => setLineTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', width: '100%', maxWidth: 460, borderRadius: 14, padding: 18, maxHeight: '88dvh', overflowY: 'auto' }}>
            <DriverAssignBody shipment={lineTarget} mode="send" drivers={drivers} onClose={() => setLineTarget(null)} onSaved={() => setLineTarget(null)} />
          </div>
        </div>
      )}
    </div>
  )
}

// スマホ予定表の編集モーダル。更新で差分保存→閉じると予定表に戻り変更が赤文字反映される。
// スマホ予定編集の縦並びフォーム本体（片手で見やすく打ち込めるレイアウト）。
// 出荷登録と同じ操作ロジック(makeDenpyoHandlers)を共用しつつ、伝票風の横並びではなく
// 1項目=1ブロックの縦積みで、入力欄・ボタンを指で押しやすい大きさにする。
function MobileEditForm({ form, setForm, editing, employees = [], companyComboOptions = [], tradingComboOptions = [], onPdfImport, removePdf, previewPdf }) {
  const H = makeDenpyoHandlers({ form, setForm, employees, companyComboOptions })
  const { set, setVal, handleCompanyInput, setMixCell, setMixRowNote, addMixRow, delMixRow, mixRowsOf,
    toggleVehItem, setVehQty, vehItems, toggleNoteTag, toggleTestTag, addNoteMessage, removeNoteMessage, unloadText, setUnload, addDriver, removeDriver } = H

  // 時間（最大2）
  const setTime = (i, v) => setForm(f => ({ ...f, times: f.times.map((t, idx) => idx === i ? { ...t, text: v } : t) }))
  const addTime = () => setForm(f => f.times.length < 2 ? { ...f, times: [...f.times, { text: '', important: false }] } : f)
  const delTime = (i) => setForm(f => ({ ...f, times: f.times.length > 1 ? f.times.filter((_, idx) => idx !== i) : [{ text: '', important: false }] }))
  // 備考（手入力段落のみ。荷下ろし・メッセージは別UIで管理し保存時に結合）
  const manualText = (form.notes || []).filter(n => n && !n.kind).map(n => n.text).join('\n')
  const setManualText = (v) => setForm(f => {
    const keep = (f.notes || []).filter(n => n && (n.kind === 'unload' || n.kind === 'msg'))
    const manual = v.split('\n').map(t => ({ text: t, important: false }))
    return { ...f, notes: sortNotes([...manual, ...keep]) }
  })
  const msgNote = (form.notes || []).find(n => n && n.kind === 'msg')
  const usedMsgs = msgNote ? String(msgNote.text || '').split(/\s+/).filter(Boolean) : []

  // ---- styles（16px以上でiOS自動ズーム回避・タップ領域大・横はみ出し防止） ----
  const card = { background: '#fff', borderRadius: 16, padding: 16, marginBottom: 12, border: '1px solid #eceff3', boxShadow: '0 1px 2px rgba(16,24,40,.04)', display: 'flex', flexDirection: 'column', gap: 15, boxSizing: 'border-box' }
  const lbl = { display: 'block', fontSize: 12.5, fontWeight: 700, color: '#667085', marginBottom: 6, letterSpacing: '.02em' }
  const inp = { width: '100%', minWidth: 0, boxSizing: 'border-box', fontSize: 16, padding: '13px 13px', border: '1.5px solid #d4dbe5', borderRadius: 11, fontFamily: 'inherit', color: '#101828', background: '#fff', outline: 'none' }
  const chip = (on) => ({ flex: '1 1 0', minWidth: 0, height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 11, fontSize: 16, fontWeight: 700, cursor: 'pointer', userSelect: 'none', boxSizing: 'border-box', border: on ? '2px solid #1b4ea8' : '1.5px solid #d4dbe5', background: on ? '#1b4ea8' : '#fff', color: on ? '#fff' : '#475467' })
  const smallBtn = { border: '1.5px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 11, width: 48, minWidth: 48, height: 50, fontSize: 18, cursor: 'pointer', flex: '0 0 auto' }
  const addBtn = { border: '1px dashed #b6c0cf', background: '#f8fafc', color: '#475467', borderRadius: 11, padding: '12px 14px', fontSize: 14, fontWeight: 600, cursor: 'pointer', width: '100%', boxSizing: 'border-box' }
  const chipRow = (opts, isOn, onTap) => (
    <div style={{ display: 'flex', gap: 8 }}>
      {opts.map(o => <div key={o} onClick={() => onTap(o)} style={chip(isOn(o))}>{o}</div>)}
    </div>
  )

  return (
    <div style={{ maxWidth: '100%' }}>
      {/* 基本：受注日/日付・時間 */}
      <div style={card}>
        {/* 受注日・日付は日付が収まる幅に固定し、間隔をあけて隣接させない */}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ flex: '0 0 auto' }}>
            <label style={lbl}>受注日</label>
            <input type="date" value={form.orderDate} onChange={set('orderDate')} style={{ ...inp, width: 150, padding: '13px 10px', textAlign: 'left' }} />
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <label style={lbl}>日付</label>
            <input type="date" value={form.date} onChange={set('date')} style={{ ...inp, width: 150, padding: '13px 10px', textAlign: 'left' }} />
          </div>
        </div>
        <div>
          <label style={lbl}>時間（最大2）</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {form.times.map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input value={t.text} onChange={e => setTime(i, e.target.value)} placeholder="例: 08:00 / 午前" style={{ ...inp, flex: 1 }} data-ime="ascii" inputMode="text" />
                {form.times.length > 1 && <button type="button" onClick={() => delTime(i)} style={smallBtn}>×</button>}
              </div>
            ))}
          </div>
          {form.times.length < 2 && <button type="button" onClick={addTime} style={{ ...addBtn, marginTop: 8 }}>＋ 時間を追加</button>}
        </div>
      </div>

      {/* 取引先・現場 */}
      <div style={card}>
        <div>
          <label style={lbl}>業者名</label>
          <div className="denpyo">
            <KanaCombo value={form.companyName} onChange={handleCompanyInput}
              onPick={o => setForm(f => ({ ...f, companyId: o.id || '', companyName: o.label }))}
              options={companyComboOptions} placeholder="入力して検索（ひらがな可）" className="f-mobile" style={inp} />
          </div>
        </div>
        <div>
          <label style={lbl}>商社名</label>
          <div className="denpyo">
            <KanaCombo value={form.tradingCompany} onChange={set('tradingCompany')}
              onPick={o => setVal('tradingCompany', o.label)}
              options={tradingComboOptions} placeholder="入力して選択（ひらがな可）" className="f-mobile" style={inp} />
          </div>
        </div>
        <div>
          <label style={lbl}>現場名</label>
          <input value={form.siteName} onChange={set('siteName')} style={inp} data-ime="kana" />
        </div>
        <div>
          <label style={lbl}>現場住所</label>
          <input value={form.siteAddress} onChange={set('siteAddress')} placeholder={DEFAULT_SITE_ADDRESS} style={inp} data-ime="kana" />
          <div style={{ marginTop: 10 }}>
            <SiteMap
              address={form.siteAddress}
              onAddressChange={(a) => setVal('siteAddress', a)}
              mapView={form.mapView}
              onMapViewChange={(v) => setVal('mapView', v)}
              pin={form.mapPin}
              onPinChange={(p) => setVal('mapPin', p)}
              arrows={form.mapArrows}
              onArrowsChange={(a) => setVal('mapArrows', a)}
            />
          </div>
        </div>
      </div>

      {/* 出荷内容：車種・配合・量 */}
      <div style={card}>
        <div>
          <label style={lbl}>車種（タップで選択）</label>
          {chipRow(VEHICLE_TYPES, o => vehItems().some(v => v.type === o), toggleVehItem)}
          {/* 車種の自由記述（補足） */}
          <input value={form.vehicleFree || ''} onChange={set('vehicleFree')} placeholder="補足（例: ポンプ車）"
            data-ime="kana"
            style={{ ...inp, marginTop: 8, textAlign: 'center', color: '#1b4ea8', fontWeight: 700 }} />
        </div>
        <div>
          <label style={lbl}>配合</label>
          {/* 配合モード切替（数値 / モルタル / ドライテック） */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {[['num', '数値'], ['mortar', 'モルタル'], ['dry', 'ドライテック']].map(([m, label]) => {
              const on = (form.mixMode || (form.mixCode === 'ドライテック' ? 'dry' : (/^1:[1-4]$/.test(form.mixCode || '') ? 'mortar' : 'num'))) === m
              return (
                <button key={m} type="button"
                  onClick={() => setForm(f => {
                    if ((f.mixMode || 'num') === m) return f
                    if (m === 'dry') return { ...f, mixMode: 'dry', mixCode: 'ドライテック', mixRows: [{ parts: ['', '', ''], note: '' }], mixNotes: ['', '', ''] }
                    if (m === 'mortar') return { ...f, mixMode: 'mortar', mixCode: '', mixRows: [{ parts: ['', '', ''], note: '' }], mixNotes: ['', '', ''] }
                    return { ...f, mixMode: 'num', mixCode: '', mixRows: [{ parts: ['', '', ''], note: '' }], mixNotes: ['', '', ''] }
                  })}
                  style={{ flex: 1, border: on ? '2px solid #0f3060' : '1.5px solid #d4dbe5', background: on ? '#0f3060' : '#fff', color: on ? '#fff' : '#475467', borderRadius: 10, padding: '10px 6px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {label}
                </button>
              )
            })}
          </div>
          {/* モード別のフォーム */}
          {(form.mixMode === 'mortar' || (!form.mixMode && /^1:[1-4]$/.test(form.mixCode || ''))) ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {['1:1', '1:2', '1:3', '1:4'].map(r => {
                const on = form.mixCode === r
                return (
                  <button key={r} type="button"
                    onClick={() => setForm(f => ({ ...f, mixMode: 'mortar', mixCode: r, mixRows: [{ parts: ['', '', ''], note: '' }], mixNotes: ['', '', ''] }))}
                    style={{ height: 56, border: on ? '2px solid #1b4ea8' : '1.5px solid #d4dbe5', background: on ? '#e8f0ff' : '#fff', color: on ? '#1b4ea8' : '#101828', borderRadius: 11, fontSize: 22, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>{r}</button>
                )
              })}
            </div>
          ) : (form.mixMode === 'dry' || (!form.mixMode && form.mixCode === 'ドライテック')) ? (
            <div style={{ textAlign: 'center', padding: '18px 0', fontSize: 28, fontWeight: 800, color: '#111', letterSpacing: '0.1em', border: '1.5px solid #d4dbe5', borderRadius: 11, background: '#fff' }}>ドライテック</div>
          ) : (
            <>
              {mixRowsOf().map((r, ri) => (
                <div key={ri} style={{ display: 'flex', alignItems: 'flex-end', gap: 6, marginTop: ri > 0 ? 12 : 0 }}>
                  {[0, 1, 2].map(i => (
                    <Fragment key={i}>
                      {i > 0 && <span style={{ fontSize: 24, fontWeight: 700, color: '#101828', paddingBottom: 11 }}>-</span>}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {i === 1
                          ? <input value={r.note || ''} onChange={e => setMixRowNote(ri, e.target.value)} placeholder="特記" data-ime="kana"
                              style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, color: '#c0392b', textAlign: 'center', border: 'none', borderBottom: '1px dashed #e7a3a3', outline: 'none', padding: '0 0 3px', fontFamily: 'inherit' }} />
                          : <div style={{ height: 16 }} />}
                        <input value={r.parts[i] || ''} inputMode="numeric" data-ime="ascii" placeholder="00"
                          onChange={e => setMixCell(ri, i, e.target.value, e.nativeEvent?.isComposing)}
                          onCompositionEnd={e => setMixCell(ri, i, e.target.value, false)}
                          style={{ width: '100%', boxSizing: 'border-box', fontSize: 22, fontWeight: 700, textAlign: 'center', border: '1.5px solid #d4dbe5', borderRadius: 11, padding: '12px 4px', fontFamily: 'inherit', color: '#101828', marginTop: 4 }} />
                      </div>
                    </Fragment>
                  ))}
                  {ri > 0 && <button type="button" onClick={() => delMixRow(ri)} style={{ ...smallBtn, height: 52 }}>×</button>}
                </div>
              ))}
              {mixRowsOf().length < 2 && <button type="button" onClick={addMixRow} style={{ ...addBtn, marginTop: 10 }}>＋ 配合を追加</button>}
            </>
          )}
        </div>
        <div>
          <label style={lbl}>量（m³）</label>
          {[0, 1].map(idx => {
            if (idx === 1 && !form.hasVolume2) return null
            const vKey = idx === 0 ? 'volume' : 'volume2'
            const uKey = idx === 0 ? 'volumeUncertain' : 'volumeUncertain2'
            const aKey = idx === 0 ? 'volumePlusA' : 'volumePlusA2'
            const rKey = idx === 0 ? 'volumeRange' : 'volumeRange2'
            const nKey = idx === 0 ? 'volumeNote' : 'volumeNote2'
            const raw = String(form[vKey] || '')
            const sepI = raw.indexOf('〜')
            const vFrom = sepI >= 0 ? raw.slice(0, sepI) : raw
            const vTo = sepI >= 0 ? raw.slice(sepI + 1) : ''
            const isRange = !!form[rKey] || sepI >= 0
            const clean = (s) => z2h(s).replace(/．/g, '.').replace(/[^0-9.]/g, '')
            const combine = (from, to) => (String(to) !== '' ? `${from}〜${to}` : from)
            const setFrom = (val, c) => setVal(vKey, combine(c ? val : clean(val), vTo))
            const setTo = (val, c) => setVal(vKey, combine(vFrom, c ? val : clean(val)))
            const toggleRange = () => setForm(f => { const cur = String(f[vKey] || ''); const i = cur.indexOf('〜'); const from = i >= 0 ? cur.slice(0, i) : cur; return { ...f, [rKey]: !(f[rKey] || i >= 0), [vKey]: from } })
            const big = (s) => String(s || '').split('.')[0].replace(/[^0-9]/g, '').length >= 3
            const sq = (on, label, onClick) => (
              <button type="button" onClick={onClick} style={{ flex: '0 0 auto', minWidth: 48, height: 50, padding: '0 10px', borderRadius: 11, fontSize: 16, fontWeight: 700, cursor: 'pointer', boxSizing: 'border-box', border: on ? '2px solid #c0392b' : '1.5px solid #d4dbe5', background: on ? '#c0392b' : '#fff', color: on ? '#fff' : '#98a2b3' }}>{label}</button>
            )
            return (
              <div key={idx} style={{ marginTop: idx ? 8 : 0 }}>
                {/* 量の特記（数値の上に小さく赤・破線下線） */}
                <input value={form[nKey] || ''} onChange={e => setVal(nKey, e.target.value)} placeholder="特記" data-ime="kana"
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, color: '#c0392b', fontWeight: 700, textAlign: 'center', border: 'none', borderBottom: '1px dashed #e7a3a3', outline: 'none', padding: '0 0 3px', fontFamily: 'inherit', marginBottom: 4 }} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input value={vFrom} inputMode="decimal" data-ime="ascii" placeholder="0"
                    onChange={e => setFrom(e.target.value, e.nativeEvent?.isComposing)}
                    onCompositionEnd={e => setFrom(e.target.value, false)}
                    style={{ ...inp, flex: 1, fontSize: big(vFrom) ? 22 : 16, fontWeight: big(vFrom) ? 700 : 400 }} />
                  {isRange && (
                    <>
                      <span style={{ fontSize: 18, fontWeight: 700, color: '#101828', flex: '0 0 auto' }}>〜</span>
                      <input value={vTo} inputMode="decimal" data-ime="ascii" placeholder="0"
                        onChange={e => setTo(e.target.value, e.nativeEvent?.isComposing)}
                        onCompositionEnd={e => setTo(e.target.value, false)}
                        style={{ ...inp, flex: 1, fontSize: big(vTo) ? 22 : 16, fontWeight: big(vTo) ? 700 : 400 }} />
                    </>
                  )}
                  <span style={{ fontSize: 16, color: '#475467', flex: '0 0 auto' }}>m³</span>
                  {sq(isRange, '〜', toggleRange)}
                  {sq(form[aKey], '+a', () => setVal(aKey, !form[aKey]))}
                  {sq(form[uKey], '?', () => setVal(uKey, !form[uKey]))}
                  {idx === 1 && sq(false, '×', () => setForm(f => ({ ...f, hasVolume2: false, volume2: '', volumeNote2: '', volumeRange2: false, volumeUncertain2: false, volumePlusA2: false })))}
                </div>
              </div>
            )
          })}
          {!form.hasVolume2 && <button type="button" onClick={() => setForm(f => ({ ...f, hasVolume2: true }))} style={{ ...addBtn, marginTop: 8 }}>＋ 量を追加</button>}
        </div>
      </div>

      {/* 仕様：打設箇所・セメント種・試験・特記・荷下ろし・メッセージ */}
      <div style={card}>
        <div>
          <label style={lbl}>打設箇所</label>
          {!form.pourFree ? (
            <select value={form.pourLocation} style={{ ...inp, cursor: 'pointer' }}
              onChange={e => { if (e.target.value === '入力する') setForm(f => ({ ...f, pourFree: true, pourLocation: '' })); else setVal('pourLocation', e.target.value) }}>
              <option value=""></option>
              {POUR_LOCATIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={form.pourLocation} onChange={set('pourLocation')} placeholder="打設箇所を入力" style={{ ...inp, flex: 1 }} />
              <button type="button" onClick={() => setForm(f => ({ ...f, pourFree: false, pourLocation: '' }))} style={{ border: '1.5px solid #d4dbe5', background: '#fff', color: '#475467', borderRadius: 11, padding: '0 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer', flex: '0 0 auto' }}>一覧</button>
            </div>
          )}
        </div>
        {/* セメント種・試験・特記：3グループとも同じ大きさのボタンに統一。2つ目は ＋追加 / × で出し入れ */}
        <div>
          <label style={lbl}>セメント種{form.hasCementType2 ? '（1つ目）' : ''}</label>
          {chipRow(CEMENT_TYPES, o => form.cementType === o, o => setVal('cementType', form.cementType === o ? '' : o))}
          {form.hasCementType2 ? (
            <div style={{ marginTop: 10 }}>
              <label style={lbl}>セメント種（2つ目）
                <button type="button" onClick={() => setForm(f => ({ ...f, hasCementType2: false, cementType2: '' }))}
                  style={{ marginLeft: 8, border: '1px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>× 削除</button>
              </label>
              {chipRow(CEMENT_TYPES, o => form.cementType2 === o, o => setVal('cementType2', form.cementType2 === o ? '' : o))}
            </div>
          ) : (
            <button type="button" onClick={() => setForm(f => ({ ...f, hasCementType2: true }))} style={{ ...addBtn, marginTop: 8 }}>＋ セメント種を追加</button>
          )}
        </div>
        <div><label style={lbl}>試験</label>{chipRow(TEST_TAGS, o => (form.testTags || []).includes(o), toggleTestTag)}</div>
        <div><label style={lbl}>特記</label>{chipRow(NOTE_TAGS, o => (form.noteTags || []).includes(o), toggleNoteTag)}</div>
        <div>
          <label style={lbl}>受信確認</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {[['地図', 'mapReceived'], ['FAX', 'faxReceived']].map(([label, key]) => {
              const on = !!form[key]
              return <div key={key} onClick={() => setVal(key, !on)} style={{ flex: '1 1 0', minWidth: 0, height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 11, fontSize: 16, fontWeight: 700, cursor: 'pointer', userSelect: 'none', boxSizing: 'border-box', border: on ? '2px solid #1a7a3a' : '1.5px solid #d4dbe5', background: on ? '#eafaef' : '#fff', color: on ? '#1a7a3a' : '#475467' }}>{on ? '✔ ' : ''}{label}</div>
            })}
          </div>
        </div>
        <div>
          <label style={lbl}>荷下ろし</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {PLACEMENT_TYPES.map(t => {
              const on = (form.placements || []).includes(t)
              return <div key={t} onClick={() => setVal('placements', on ? form.placements.filter(x => x !== t) : [...(form.placements || []), t])} style={{ ...chip(on), flex: '1 1 calc(50% - 4px)' }}>{t}</div>
            })}
          </div>
          <input value={unloadText()} onChange={e => setUnload(e.target.value)} placeholder="自由入力（備考に出力）" data-ime="kana" style={{ ...inp, marginTop: 8 }} />
        </div>
        <div>
          <label style={lbl}>メッセージ追加（備考に出力）</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {NOTE_MESSAGES.map(m => {
              const isUsed = usedMsgs.includes(m)
              return (
                <button key={m} type="button" onClick={() => isUsed ? removeNoteMessage(m) : addNoteMessage(m)}
                  style={{ flex: '1 1 calc(50% - 4px)', boxSizing: 'border-box', height: 50, border: isUsed ? '2px solid #1b4ea8' : '1.5px solid #d4dbe5', background: isUsed ? '#eef4ff' : '#fff', color: '#1b4ea8', borderRadius: 11, fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
                  {isUsed ? '✓ ' : '＋ '}{m}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* 備考・連絡・担当・PDF */}
      <div style={card}>
        <div>
          <label style={lbl}>備考（改行で段落）</label>
          <textarea value={manualText} onChange={e => setManualText(e.target.value)} rows={3} style={{ ...inp, resize: 'vertical', lineHeight: 1.5 }} data-ime="kana" />
        </div>
        <div>
          <label style={lbl}>連絡先</label>
          <input value={form.orderContact} onChange={set('orderContact')} inputMode="tel" style={inp} data-ime="ascii" />
        </div>
        <div>
          <label style={lbl}>現場連絡先</label>
          <input value={form.siteContact} onChange={set('siteContact')} inputMode="tel" style={inp} data-ime="ascii" />
        </div>
        <div>
          <label style={lbl}>担当ドライバー</label>
          {form.drivers.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {form.drivers.map((d, i) => (
                <span key={d.id || i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: '1.5px solid #1b4ea8', background: '#e8f0ff', color: '#1b4ea8', borderRadius: 11, padding: '9px 12px', fontSize: 15, fontWeight: 700 }}>
                  {dispDriverName(d)}
                  <button type="button" onClick={() => removeDriver(i)} style={{ border: 'none', background: 'none', color: '#1b4ea8', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
                </span>
              ))}
            </div>
          )}
          <select value="" onChange={addDriver} style={{ ...inp, cursor: 'pointer' }}>
            <option value="">＋ ドライバーを追加</option>
            {employees.filter(e => !form.drivers.some(d => (d.id && d.id === e.id) || d.name === e.name)).map(d => <option key={d.id} value={d.id}>{dispDriverName(d)}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>PDFインポート</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px dashed #b6c0cf', background: '#f8fafc', borderRadius: 11, padding: '12px 16px', fontSize: 15, cursor: 'pointer', color: '#475467' }}>📄 ファイルを選択
              <input type="file" accept="application/pdf" style={{ display: 'none' }} onChange={onPdfImport} />
            </label>
            {(form.pdfData || (form.hasPdf && editing)) && (
              <button type="button" onClick={previewPdf} style={{ border: '1px solid #1a4d8f', background: '#eef5ff', color: '#1a4d8f', borderRadius: 11, padding: '11px 14px', fontSize: 14, cursor: 'pointer' }}>👁 プレビュー</button>
            )}
            {(form.pdfData || form.hasPdf) && (
              <button type="button" onClick={removePdf} style={{ border: '1px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 11, padding: '11px 14px', fontSize: 14, cursor: 'pointer' }}>🗑 削除</button>
            )}
            {(form.pdfName || form.hasPdf) && <span style={{ fontSize: 13, color: '#1a8f5a' }}>{form.pdfData ? '選択中' : '添付済'}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

function ScheduleEditModal({ shipment, driverOptions = [], companyComboOptions = [], tradingComboOptions = [], onClose, onSave }) {
  const [form, setForm] = useState(() => shipmentToForm(shipment))
  const [saving, setSaving] = useState(false)

  const onPdfImport = (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { alert('PDFファイルを選択してください'); e.target.value = ''; return }
    const MAX = 2.5 * 1024 * 1024
    if (file.size > MAX) { alert(`PDFが大きすぎます（${(file.size / 1024 / 1024).toFixed(1)}MB）。\n2.5MB以下に圧縮してください。`); e.target.value = ''; return }
    const reader = new FileReader()
    reader.onload = () => setForm(f => ({ ...f, pdfData: String(reader.result || ''), pdfName: file.name, hasPdf: true, pdfRemove: false }))
    reader.onerror = () => alert('PDFの読み込みに失敗しました')
    reader.readAsDataURL(file)
    e.target.value = ''
  }
  const removePdf = () => setForm(f => ({ ...f, pdfData: '', pdfName: '', hasPdf: false, pdfRemove: true }))
  const previewPdf = () => {
    const feat = 'width=900,height=1000,scrollbars=yes,resizable=yes'
    if (form.pdfData) {
      const w = window.open('', '_blank', feat)
      if (w) { w.document.write(`<title>${form.pdfName || 'PDF'}</title><iframe src="${form.pdfData}" style="border:0;position:absolute;inset:0;width:100%;height:100%"></iframe>`); w.document.close() }
      return
    }
    if (shipment.id && form.hasPdf) window.open(`/api/shipments?id=${encodeURIComponent(shipment.id)}&pdf=1`, '_blank', feat)
  }

  const submit = async () => {
    if (!String(form.companyName || '').trim() || !String(form.date || '').trim()) { alert('日付と業者名は必須です'); return }
    setSaving(true)
    const payload = buildShipmentPayload(form)
    const changed = diffChangedFields(shipment, payload)
    try { await onSave(payload, changed) } catch { setSaving(false) }
  }

  return (
    <div onClick={() => { if (!saving) onClose() }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#eef1f6', width: '100%', maxWidth: 560, maxHeight: '94dvh', overflowX: 'hidden', display: 'flex', flexDirection: 'column', borderRadius: '16px 16px 0 0', boxShadow: '0 -4px 24px rgba(0,0,0,0.2)', paddingTop: 'env(safe-area-inset-top)' }}>
        {/* ヘッダー（固定・スクロール追従しない） */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 12px', borderBottom: '1px solid #dde3ed', background: '#fff', borderRadius: '16px 16px 0 0', flex: '0 0 auto' }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#111' }}>✏️ 予定を編集</div>
          <button type="button" onClick={onClose} disabled={saving}
            style={{ border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 10, padding: '9px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>✕ 閉じる</button>
        </div>
        {/* 本体：スクロール領域（縦並びフォーム）。横スクロールは禁止して横ブレを防ぐ */}
        <div style={{ flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', padding: '14px 14px 16px' }}>
          <MobileEditForm form={form} setForm={setForm} editing={shipment.id}
            employees={driverOptions} companyComboOptions={companyComboOptions} tradingComboOptions={tradingComboOptions}
            onPdfImport={onPdfImport} removePdf={removePdf} previewPdf={previewPdf} />
        </div>
        {/* フッター（固定・親指で押せる位置に更新ボタン） */}
        <div style={{ flex: '0 0 auto', borderTop: '1px solid #dde3ed', background: '#fff', padding: '10px 16px calc(10px + env(safe-area-inset-bottom))' }}>
          <button type="button" onClick={submit} disabled={saving}
            style={{ width: '100%', border: 'none', background: 'linear-gradient(135deg,#1a4d8f,#1a6a9f)', color: '#fff', borderRadius: 12, padding: '16px', fontSize: 17, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? '更新中…' : '更新する'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// 集計・レポート系ページ
// ============================================================
const WD = ['日', '月', '火', '水', '木', '金', '土']
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const mondayOf = (dateStr) => { const d = new Date(dateStr); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); return d }
const firstTimeOf = (s) => (Array.isArray(s.times) && s.times.length) ? (s.times[0]?.text ?? s.times[0] ?? '') : ''
// 時間文字列を分に変換（午前/AM=11:59 / 午後/PM=23:59 / 空欄や未解析は最後）。"08:30"と"8:30"は同一
const timeToMin = (t) => {
  const str = String(t || '').trim()
  if (!str) return 100000
  const m = str.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/)
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
  const up = str.toUpperCase()
  if (str.includes('午前') || up.includes('AM')) return 11 * 60 + 59
  if (str.includes('午後') || up.includes('PM')) return 23 * 60 + 59
  const h = str.match(/(\d{1,2})\s*時/)
  if (h) return parseInt(h[1], 10) * 60
  return 99999
}
const driversOf = (s) => Array.isArray(s.drivers) ? s.drivers.map(dispDriverName) : (s.driverName ? [s.driverName] : [])

// query を渡すと日付索引で範囲取得（例 '?from=...&to=...'）。未指定は全件（フォールバック）。
function useShipments(query = '') {
  const [all, setAll] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { api.get('/api/shipments' + (query || '')).then(setAll).catch(e => console.error(e)).finally(() => setLoading(false)) }, [query])
  return { all, loading }
}

const RPT = {
  wrap: { height: '100%', overflow: 'auto', padding: 18 },
  head: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 },
  date: { padding: '6px 10px', border: '1.5px solid #bbb', borderRadius: 6, fontSize: 16 },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 13 },
  th: { border: '1px solid #cfd6e0', background: '#f4f6f9', padding: '5px 8px', fontWeight: 700, whiteSpace: 'nowrap' },
  td: { border: '1px solid #e3e8ef', padding: '5px 8px' },
}

function DashboardPage() {
  useNickReg()
  // 先月〜来月（今日・今週も含む）の範囲だけを日付索引で取得（読み取り削減）
  const dashRange = (() => {
    const b = new Date(localToday())
    const f = new Date(b.getFullYear(), b.getMonth() - 1, 1)
    const t = new Date(b.getFullYear(), b.getMonth() + 2, 0)
    const z = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return `?from=${z(f)}&to=${z(t)}`
  })()
  const { all, loading } = useShipments(dashRange)
  const isMobile = useIsMobile()
  const today = localToday()
  const ms = mondayOf(today)
  const weekDates = Array.from({ length: 7 }, (_, i) => { const d = new Date(ms); d.setDate(d.getDate() + i); return ymd(d) })
  const todays = all.filter(s => s.date === today)
  const weeks = all.filter(s => weekDates.includes(s.date))
  const vol = arr => arr.reduce((a, s) => a + (parseFloat(s.volume) || 0), 0)
  const fmtVol = n => (Math.round(n * 100) / 100).toLocaleString('ja-JP')
  // 月別合計（先月・今月・来月）。数量は1段目+2段目の合計m³
  const baseNow = new Date(today)
  const monKey = (off) => { const d = new Date(baseNow.getFullYear(), baseNow.getMonth() + off, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
  const monLabel = (off) => monKey(off).replace('-', '/')
  const inMonth = (s, off) => String(s.date || '').startsWith(monKey(off))
  const lastMonthShips = all.filter(s => inMonth(s, -1))
  const thisMonthShips = all.filter(s => inMonth(s, 0))
  const nextMonthShips = all.filter(s => inMonth(s, 1))
  const volBoth = arr => arr.reduce((acc, s) => acc + (parseFloat(s.volume) || 0) + (parseFloat(s.volume2) || 0), 0)
  // 今月分の「?」「+a」の数（1段目・2段目それぞれ数える）
  const marks = (() => {
    let q = 0, a = 0
    thisMonthShips.forEach(s => {
      if (s.volumeUncertain) q++; if (s.volumeUncertain2) q++
      if (s.volumePlusA) a++; if (s.volumePlusA2) a++
    })
    return { q, a }
  })()
  // 本日分を時間順に並べる（午前=11:59 / 午後=23:59 換算・空欄は最後）
  const timeMin = (s) => {
    const t = String(firstTimeOf(s) || '').trim()
    if (!t) return 99999
    if (/午前/.test(t)) return 719
    if (/午後/.test(t)) return 1439
    const m = t.match(/(\d{1,2}):(\d{2})/)
    return m ? (+m[1]) * 60 + (+m[2]) : 99999
  }
  const todaysSorted = [...todays].sort((a, b) => timeMin(a) - timeMin(b))

  const card = (label, value, unit, sub, accent) => (
    <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      <div style={{ fontSize: 12, color: '#6b7a8d', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent || '#0f3060', lineHeight: 1.1 }}>
        {value}{unit && <span style={{ fontSize: 13, fontWeight: 600, color: '#6b7a8d', marginLeft: 3 }}>{unit}</span>}
      </div>
      {sub && <div style={{ fontSize: 11, color: '#9aa7b5', marginTop: 3 }}>{sub}</div>}
    </div>
  )
  const breakdown = (title, entries, empty) => (
    <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 12, padding: '14px 16px', flex: '1 1 240px', minWidth: 0 }}>
      <h3 style={{ fontSize: 13, color: '#3a4a5c', margin: '0 0 10px' }}>{title}</h3>
      {entries.length === 0 ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>{empty}</div>
        : entries.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #f2f4f8' }}>
            <span style={{ color: '#1a2332', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
            <span style={{ color: '#0f3060', fontWeight: 700, flex: '0 0 auto', marginLeft: 8 }}>{v}件</span>
          </div>
        ))}
    </div>
  )

  // 便別（第一便=9時まで／第二便=9時以降の午前／午後）の車種別台数
  const vehStats = (list) => {
    const c = {}; VEHICLE_TYPES.forEach(v => { c[v] = 0 })
    list.forEach(s => {
      if (Array.isArray(s.vehicleItems) && s.vehicleItems.length) s.vehicleItems.forEach(v => { if (v.type) c[v.type] = (c[v.type] || 0) + (parseInt(v.qty, 10) || 1) })
      else String(s.vehicleType || '').split('・').map(x => x.trim()).filter(Boolean).forEach(v => { c[v] = (c[v] || 0) + 1 })
    })
    const total = VEHICLE_TYPES.reduce((a, v) => a + (c[v] || 0), 0)
    const items = VEHICLE_TYPES.filter(v => c[v] > 0).map(v => `${v} ${c[v]}台`)
    return { items, total }
  }
  const binOf = (s) => { const m = timeToMin(firstTimeOf(s)); return m < 540 ? 0 : m < 720 ? 1 : 2 }
  const todayBins = [0, 1, 2].map(b => todays.filter(s => binOf(s) === b))
  const BIN_LABELS = [{ main: '第一便', sub: '（9時まで）' }, { main: '第二便', sub: '（9時以降）' }, { main: '午後', sub: '' }]

  const drvEntries = (() => {
    const m = {}; todays.forEach(s => { const ds = driversOf(s); (ds.length ? ds : ['未割当']).forEach(n => m[n] = (m[n] || 0) + 1) })
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  })()

  return (
    <div style={RPT.wrap}>
      <h2 style={{ margin: '0 0 16px', color: '#1a2332' }}>📊 ダッシュボード</h2>
      {loading ? <div style={{ color: '#6b7a8d' }}>読み込み中...</div> : (
        <>
          {/* サマリーカード（レスポンシブなグリッドで折り返し） */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(auto-fill,minmax(150px,1fr))', gap: 12, marginBottom: 20 }}>
            {card('今日の出荷', todays.length, '件', `${today}（${WD[new Date(today).getDay()]}）`, '#1a6a9f')}
            {card('今日の合計', fmtVol(vol(todays)), 'm³')}
            {card('今週の出荷', weeks.length, '件', `${weekDates[0].slice(5)}〜${weekDates[6].slice(5)}`)}
            {card('今週の合計', fmtVol(vol(weeks)), 'm³')}
            {card('登録総数', all.length, '件')}
          </div>

          {/* 月別の合計m³（先月・今月・来月）。今月の?・+aは今月の合計の下に表示 */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(auto-fill,minmax(150px,1fr))', gap: 12, marginBottom: 20 }}>
            {card('先月の合計', fmtVol(volBoth(lastMonthShips)), 'm³', monLabel(-1))}
            {card('今月の合計', fmtVol(volBoth(thisMonthShips)), 'm³', `${monLabel(0)}　? ${marks.q}　+a ${marks.a}`, '#1a6a9f')}
            {card('来月の合計', fmtVol(volBoth(nextMonthShips)), 'm³', monLabel(1))}
          </div>

          {/* 内訳（車種別＝便別・担当別） */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
            <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 12, padding: '14px 16px', flex: '1 1 240px', minWidth: 0 }}>
              <h3 style={{ fontSize: 13, color: '#3a4a5c', margin: '0 0 10px' }}>今日の車種別（便別）</h3>
              {todays.length === 0 ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>本日の出荷はありません</div>
                : BIN_LABELS.map((lb, bi) => {
                  const st = vehStats(todayBins[bi])
                  return (
                    <div key={bi} style={{ padding: '6px 0', borderBottom: '1px solid #f2f4f8' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                        <span style={{ color: '#0f3060', fontWeight: 700 }}>{lb.main}{lb.sub}</span>
                        <span style={{ color: '#0f3060', fontWeight: 700 }}>計{st.total}台</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#3a4a5c', marginTop: 2 }}>{st.items.length ? st.items.join('　') : '—'}</div>
                    </div>
                  )
                })}
            </div>
            {/* 「今日の担当別」は非表示（担当者表示を画面から省く方針）。再表示する場合は下行を有効化
            {breakdown('今日の担当別', drvEntries, '本日の出荷はありません')} */}
          </div>

          {/* 本日の予定（時間順） */}
          <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 12, padding: '14px 16px' }}>
            <h3 style={{ fontSize: 13, color: '#3a4a5c', margin: '0 0 10px' }}>本日の予定（時間順）</h3>
            {todaysSorted.length === 0 ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>本日の出荷はありません</div>
              : todaysSorted.map(s => (
                <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13, padding: '7px 0', borderBottom: '1px solid #f2f4f8' }}>
                  <span style={{ flex: '0 0 auto', fontWeight: 700, color: '#c0392b', minWidth: 52 }}>{firstTimeOf(s) || '—'}</span>
                  <span style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <b>{s.companyName}</b>{s.siteName ? <span style={{ color: '#6b7a8d' }}> ／ {s.siteName}</span> : ''}
                  </span>
                  <span style={{ flex: '0 0 auto', color: '#3a4a5c' }}>{s.vehicleType || ''}{s.volume ? <span style={volNumStyle(s.volume)}> {s.volume}m³</span> : ''}</span>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  )
}

function WeeklySchedulePage() {
  const [date, setDate] = useState(() => localToday())
  const ms = new Date(date)   // 選択日（既定は本日）を左端に10日分表示
  const days = Array.from({ length: 10 }, (_, i) => { const d = new Date(ms); d.setDate(d.getDate() + i); return d })
  // 表示中の10日ぶんだけ日付索引で取得（読み取り削減）。日付変更で自動再取得
  const { all, loading } = useShipments(`?from=${ymd(days[0])}&to=${ymd(days[9])}`)
  const todayStr = localToday()
  return (
    <div style={RPT.wrap}>
      <div style={RPT.head}>
        <h2 style={{ margin: 0, color: '#1a2332' }}>🗓️ 週間出荷予定表</h2>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={RPT.date} />
        <span style={{ fontSize: 13, color: '#6b7a8d' }}>{ymd(days[0])} 〜 {ymd(days[9])}</span>
      </div>
      {loading ? <div>読み込み中...</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, minmax(130px,1fr))', gap: 6, minWidth: 1300 }}>
          {days.map(d => {
            const ds = ymd(d), wd = WD[d.getDay()]
            const list = all.filter(s => s.date === ds).sort((a, b) => timeToMin(firstTimeOf(a)) - timeToMin(firstTimeOf(b)) || String(firstTimeOf(a)).localeCompare(String(firstTimeOf(b))))
            // 便ごとの車種別合計台数を集計（数量があれば加算・無ければ1台）
            const vehStats = (rows) => {
              const c = {}
              VEHICLE_TYPES.forEach(v => { c[v] = 0 })
              rows.forEach(s => {
                if (Array.isArray(s.vehicleItems) && s.vehicleItems.length) {
                  s.vehicleItems.forEach(v => { if (v.type) c[v.type] = (c[v.type] || 0) + (parseInt(v.qty, 10) || 1) })
                } else {
                  String(s.vehicleType || '').split('・').map(x => x.trim()).filter(Boolean).forEach(v => { c[v] = (c[v] || 0) + 1 })
                }
              })
              const total = VEHICLE_TYPES.reduce((a, v) => a + (c[v] || 0), 0)
              return { total, c }
            }
            // 便の区分：第一便=9時まで(<9:00)／第二便=9時以降の午前(9:00〜11:59)／午後=12:00以降
            const bin = (s) => { const m = timeToMin(firstTimeOf(s)); return m < 540 ? 0 : m < 720 ? 1 : 2 }
            const binList = [list.filter(s => bin(s) === 0), list.filter(s => bin(s) === 1), list.filter(s => bin(s) === 2)]
            const BIN_LABELS = [{ main: '第一便', sub: '（9時まで）' }, { main: '第二便', sub: '（9時以降）' }, { main: '午後', sub: '' }]
            // 1日合計（3便の台数合計）と量の合計（m³。範囲入力は上限値で計上・2段目の量も加算）
            const dayTrucks = binList.reduce((a, bl) => a + vehStats(bl).total, 0)
            const volUpper = (v) => { if (v == null || String(v).trim() === '') return 0; const last = String(v).split('〜').pop(); const n = parseFloat(String(last).replace(/[^0-9.]/g, '')); return isNaN(n) ? 0 : n }
            const dayVol = list.reduce((a, s) => a + volUpper(s.volume) + volUpper(s.volume2), 0)
            const fmtV = (n) => (Math.round(n * 100) / 100).toLocaleString('ja-JP')
            return (
              <div key={ds} style={{ border: '1px solid #dde3ed', borderRadius: 8, minHeight: 220, background: ds === todayStr ? '#eef5ff' : '#fff' }}>
                <div style={{ padding: '6px 8px', borderBottom: '1px solid #dde3ed', fontWeight: 700, fontSize: 13, textAlign: 'center', color: wd === '日' ? '#c0392b' : wd === '土' ? '#1b4ea8' : '#1a2332' }}>{d.getMonth() + 1}/{d.getDate()}（{wd}）</div>
                {/* 便別サマリー：第一便／第二便／午後の車種別台数と合計台数 */}
                {binList.map((bl, bi) => {
                  const st = vehStats(bl)
                  const lb = BIN_LABELS[bi]
                  const binVol = bl.reduce((a, s) => a + volUpper(s.volume) + volUpper(s.volume2), 0)   // この便の量合計（m³）
                  // 内訳：4t/7t を1行目、大型を2行目。常に2行ぶんの高さを確保して下の一覧の開始位置を揃える
                  const small = ['4t', '7t'].filter(v => st.c[v] > 0).map(v => `${v}:${st.c[v]}台`).join('　')
                  const big = st.c['大型'] > 0 ? `大型:${st.c['大型']}台` : ''
                  return (
                    <div key={bi} style={{ padding: '6px 8px', borderBottom: '1px solid #eef0f4', background: '#f8fafc', fontSize: 13, color: '#3a4a5c', lineHeight: 1.4 }}>
                      <div style={{ fontWeight: 800, color: '#0f3060', fontSize: 15 }}>
                        <span style={{ whiteSpace: 'nowrap' }}>{lb.main}</span>
                        {lb.sub && <span style={{ display: 'block', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{lb.sub}</span>}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontWeight: 700, color: '#0f3060', fontSize: 14 }}>
                        <span>計{st.total}台</span>
                        <span style={{ color: '#c0392b' }}>{fmtV(binVol)}m³</span>
                      </div>
                      <div style={{ fontSize: 13, marginTop: 1, lineHeight: 1.3 }}>
                        <div style={{ whiteSpace: 'nowrap', minHeight: '1.3em' }}>{st.total === 0 ? '—' : small}</div>
                        <div style={{ whiteSpace: 'nowrap', minHeight: '1.3em' }}>{big}</div>
                      </div>
                    </div>
                  )
                })}
                {/* 1日合計（台数）・量の合計（m³） */}
                <div style={{ padding: '6px 8px', borderBottom: '1px solid #dde3ed', background: '#eef5ff', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13 }}>
                  <span style={{ fontWeight: 700, color: '#0f3060' }}>1日合計</span>
                  <span style={{ fontWeight: 800, color: '#0f3060', fontSize: 15 }}>{dayTrucks}台</span>
                </div>
                <div style={{ padding: '6px 8px', borderBottom: '1px solid #dde3ed', background: '#fff3f3', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13 }}>
                  <span style={{ fontWeight: 700, color: '#c0392b' }}>量の合計</span>
                  <span><b style={{ fontWeight: 800, color: '#c0392b', fontSize: 15 }}>{fmtV(dayVol)}</b><span style={{ fontSize: 11, color: '#6b7a8d' }}>m³</span></span>
                </div>
                <div style={{ padding: 6 }}>
                  {list.length === 0 ? <div style={{ fontSize: 11, color: '#c0c8d4' }}>—</div>
                    : list.map(s => { const pls = Array.isArray(s.placements) ? s.placements.filter(Boolean) : []; return <div key={s.id} style={{ fontSize: 11, borderBottom: '1px dashed #eee', padding: '3px 0' }}><b>{firstTimeOf(s)}</b> {s.companyName}<br /><span style={{ color: '#6b7a8d' }}>{s.siteName || ''}{s.volume ? <span style={volNumStyle(s.volume)}> /{s.volume}m³</span> : ''}</span>{pls.length ? <><br /><span style={{ color: '#1a6a9f' }}>荷下ろし：{pls.join('・')}</span></> : ''}</div> })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 生コン出荷予定表（手書き様式に寄せた帳票・印刷/PDF出力）
function SeikonOutputPage({ isPopup }) {
  const params = (typeof window !== 'undefined') ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const urlDate = params.get('date') || ''
  const wantPrint = params.get('print') === '1'
  const urlAmpm = params.get('ampm') || 'both'
  const [date, setDate] = useState(urlDate || localToday())
  const [ampm, setAmpm] = useState(urlAmpm)   // 'both' | 'AM' | 'PM'
  const { all, loading } = useShipments('?date=' + encodeURIComponent(date))   // その日だけ日付索引で取得
  const [customers, setCustomers] = useState([])
  useEffect(() => { api.get('/api/customers').then(setCustomers).catch(() => { /* noop */ }) }, [])
  const custCode = (s) => { const c = customers.find(c => c.id === s.companyId); return c ? (c.customerCode || '') : '' }
  // 休みの呼び名を選択して追加するためのドライバー一覧
  const [drivers, setDrivers] = useState([])
  useEffect(() => { api.get('/api/employees?drivers=1').then(setDrivers).catch(() => { /* noop */ }) }, [])
  const nickList = [...new Set(drivers.map(dispDriverName).map(x => String(x ?? '').trim()).filter(Boolean))]
  // 出社/休み：出社数のデフォルトを保存し、当日 欄に入れた休みの呼び名の数だけ引く
  const PRESENT_KEY = 'seikon_present_default'
  const [presentDefault, setPresentDefault] = useState(() => { try { const v = parseInt(localStorage.getItem(PRESENT_KEY), 10); return Number.isFinite(v) ? v : 16 } catch { return 16 } })
  const savePresentDefault = (n) => { setPresentDefault(n); try { localStorage.setItem(PRESENT_KEY, String(n)) } catch { /* noop */ } }
  const [presentEdit, setPresentEdit] = useState(false)
  const [restOpen, setRestOpen] = useState(false)
  const restKey = 'seikon_rest_' + date
  const [restText, setRestText] = useState('')
  useEffect(() => { try { setRestText(localStorage.getItem('seikon_rest_' + date) || '') } catch { setRestText('') } }, [date])
  const saveRest = (v) => { setRestText(v); try { localStorage.setItem(restKey, v) } catch { /* noop */ } }
  const restNames = restText.split(/[\s,、・／/]+/).map(x => x.trim()).filter(Boolean)
  const addRest = (n) => { const t = String(n ?? '').trim(); if (t && !restNames.includes(t)) saveRest([...restNames, t].join(' ')) }
  const removeRest = (n) => saveRest(restNames.filter(x => x !== n).join(' '))
  const presentCount = Math.max(0, presentDefault - restNames.length)   // 出社数＝デフォルト－休みの人数
  const inAmPm = (s) => { if (ampm === 'both') return true; const m = timeToMin(firstTimeOf(s)); return ampm === 'AM' ? m < 720 : m >= 720 }
  // all は日付索引で表示日ぶんのみ取得済み。日付変更中も前日の表示を残すため date 判定はしない（AM/PMのみ）
  const rows = all.filter(s => inAmPm(s))
    .sort((a, b) => timeToMin(firstTimeOf(a)) - timeToMin(firstTimeOf(b)) || String(firstTimeOf(a)).localeCompare(String(firstTimeOf(b))))

  // 試験集計（その日の全出荷から：現TP=現場 / 工TP=工場）
  const dayShips = all   // 表示日ぶんのみ取得済み
  // 試験件数を AM/PM 別に集計（現TP=現場 / 工TP=工場）。AM=先頭時間が12:00前 / PM=12:00以降
  const isAM = (s) => timeToMin(firstTimeOf(s)) < 720
  const hasTest = (s, tag) => (Array.isArray(s.testTags) ? s.testTags : []).includes(tag)
  const testGenAM = dayShips.filter(s => hasTest(s, '現TP') && isAM(s)).length
  const testGenPM = dayShips.filter(s => hasTest(s, '現TP') && !isAM(s)).length
  const testKoAM = dayShips.filter(s => hasTest(s, '工TP') && isAM(s)).length
  const testKoPM = dayShips.filter(s => hasTest(s, '工TP') && !isAM(s)).length
  // 試験：行(現場/工場)・列(AM/PM)のラベルは常に維持。値が0は空欄で表示する。
  // ただし全件0(その日に試験データ無し)のときは見出しごと非表示にする。
  const testAll = [
    { label: '現場', am: testGenAM, pm: testGenPM },
    { label: '工場', am: testKoAM, pm: testKoPM },
  ]
  const testHasAny = testAll.some(r => r.am > 0 || r.pm > 0)
  const testRows = testAll        // 常に2行表示
  const testShowAM = true         // 常にAM列表示
  const testShowPM = true         // 常にPM列表示

  const d = new Date(date)
  const reiwa = isNaN(d.getTime()) ? '' : `令和${d.getFullYear() - 2018}年${d.getMonth() + 1}月${d.getDate()}日${WD[d.getDay()]}曜日`
  // 帳票タイトル用の日付（曜日なし・スペース区切り）。例: 令和　8年　6月　6日
  const titleDate = isNaN(d.getTime()) ? '' : `令和　${d.getFullYear() - 2018}年　${d.getMonth() + 1}月　${d.getDate()}日`

  // 印刷：別ウィンドウ（サイドバー無し）で開き、読み込み後に自動で印刷ダイアログ（A4縦）
  const openPrint = () => {
    const url = `${window.location.pathname}?view=seikon&popup=1&print=1&date=${encodeURIComponent(date)}&ampm=${ampm}`
    const w = window.open(url, '_blank', 'width=900,height=1200,scrollbars=yes,resizable=yes')
    if (!w) { alert('別ウィンドウを開けませんでした。ブラウザのポップアップを許可してください。'); window.open(url, '_blank') }
  }
  useEffect(() => {
    if (loading || !wantPrint) return
    const t = setTimeout(() => { try { window.print() } catch { /* noop */ } }, 500)
    return () => clearTimeout(t)
  }, [loading, wantPrint])

  const timesArr = (s) => (Array.isArray(s.times) ? s.times.map(t => (t && t.text != null) ? t.text : t) : []).map(x => String(x ?? '').trim()).filter(Boolean)
  const notesOf = (s) => (Array.isArray(s.notes) ? s.notes.map(n => (n && n.text != null) ? n.text : n) : []).map(x => String(x ?? '').trim()).filter(Boolean).join(' / ')
  const tagsOf = (s) => (Array.isArray(s.noteTags) ? s.noteTags : []).filter(Boolean).join('')
  const testOf = (s) => (Array.isArray(s.testTags) ? s.testTags : []).filter(Boolean).join('・')
  const volOne = (v, a, u) => { const b = (v == null ? '' : String(v)).trim(); return (!b && !a && !u) ? '' : `${b}${b ? 'm³' : ''}${a ? '+a' : ''}${u ? '?' : ''}` }

  const placementsOf = (s) => (Array.isArray(s.placements) ? s.placements : []).filter(Boolean).join('・')
  // 配合の数値が入っていない枠は半角2つ( )で埋めてダッシュ位置を揃える（例: 24-- → 24-□□-□□）
  const padMix = (code) => { const c = String(code || ''); return c ? c.split('-').map(p => p === '' ? '  ' : p).join('-') : '' }

  // 配合/数量が2種ある行は、下に分割行（数値のみ・その他はコピーしない）を出す
  const lineRows = []
  rows.forEach(s => {
    const mixes = mixRowsOfShip(s).map(r => r.code).filter(Boolean)
    const v1 = volOne(s.volume, s.volumePlusA, s.volumeUncertain)
    const v2 = volOne(s.volume2, s.volumePlusA2, s.volumeUncertain2)
    const split = mixes.length >= 2 || !!v2
    lineRows.push({ s, mix: mixes[0] || '', vol: v1, volNum: s.volume || '', primary: true })
    if (split) lineRows.push({ s, mix: mixes[1] || '', vol: v2 || '', volNum: s.volume2 || '', primary: false })
  })

  // 販売大臣CSVエクスポート（カンマ区切り・ダブルクォーテーション囲み・タイトル行あり・UTF-8 BOM）
  const exportCsv = () => {
    const header = ['伝票日付', '得意先コード', '業者名', '商社名', '現場名', '打設場所', '車両', '配合', 'セメント種', '数量', '時間', '連絡先', '現場連絡先', '備考', '特記', '荷下ろし', '担当']
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
    const dateStr = date.replace(/-/g, '/')
    const out = [header.map(esc).join(',')]
    lineRows.forEach(r => {
      const s = r.s
      out.push([
        dateStr, custCode(s), s.companyName || '', s.tradingCompany || '', s.siteName || '', s.pourLocation || '',
        vehicleLabel(s) || '', r.mix, s.cementType || '', r.volNum, timesArr(s).join(' '),
        s.orderContact || '', s.siteContact || '', notesOf(s), tagsOf(s),
        (Array.isArray(s.placements) ? s.placements.join('・') : ''), driversOf(s).join('・'),
      ].map(esc).join(','))
    })
    if (lineRows.length === 0) { alert('この日の出荷登録がありません'); return }
    const blob = new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `生コン出荷予定表_${date}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // テーブル用の行: 配合は1つにつき1行に分ける。数量(2種)は先頭行の数量セル内で改行表示する
  const tableRows = []
  rows.forEach(s => {
    const mixes = mixRowsOfShip(s).filter(r => r.code)   // {code, note=配合の特記}
    const v1 = volOne(s.volume, s.volumePlusA, s.volumeUncertain)
    const v2 = volOne(s.volume2, s.volumePlusA2, s.volumeUncertain2)
    // 数量は値ごとに特記(volumeNote)を持たせる
    const vols = [{ v: v1, note: (s.volumeNote || '').trim() }, { v: v2, note: (s.volumeNote2 || '').trim() }].filter(x => x.v)
    const n = Math.max(1, mixes.length)
    for (let k = 0; k < n; k++) tableRows.push({ s, mix: mixes[k]?.code || '', mixNote: mixes[k]?.note || '', vols: k === 0 ? vols : [], primary: k === 0 })
  })

  // 1行を描画。配合の2行目以降（!primary）は配合のみ（その他は空）
  const renderRow = (r, key) => {
    const s = r.s
    if (!r.primary) {
      return (
        <tr key={key}>
          <td></td><td></td><td></td><td></td>
          <td className="seikon-mix">{r.mixNote ? <div className="seikon-mnote">{r.mixNote}</div> : null}<div>{padMix(r.mix)}</div></td>
          <td></td><td></td><td></td><td></td><td></td><td></td><td></td>
        </tr>
      )
    }
    const ts = timesArr(s)
    const tekiyo1 = [notesOf(s), placementsOf(s)].filter(Boolean).join(' / ')   // 備考 ＋ 荷下ろし
    const vf = vfPlace(s.vehicleFree)   // 車両自由入力の配置（全角=上段／半角=電話の右）
    const tags = tagsOf(s)   // 出荷登録の特記（領/追）
    const testAbbr = (Array.isArray(s.testTags) ? s.testTags : []).map(t => t === '現TP' ? '現' : t === '工TP' ? '工' : t).filter(Boolean).join('')   // 試験 現/工（区切りなし）
    const isB = String(s.cementType || '').trim() === 'B'
    // 編集・修正された箇所は赤文字（保存済み changedFields を参照）。時間・備考はさらに太字で強調
    const cf = Array.isArray(s.changedFields) ? s.changedFields : []
    const chg = (...keys) => keys.some(k => cf.includes(k))
    const chgNote = cf.some(k => k === 'notes' || /^note\d+$/.test(k))
    const timeImp = Array.isArray(s.times) && s.times.some(t => t && t.important)   // 時間の「！」
    const noteImp = Array.isArray(s.notes) && s.notes.some(n => n && n.important)    // 備考の「！」
    const red = (on, bold) => on ? { color: '#c81e1e', ...(bold ? { fontWeight: 800 } : {}) } : undefined
    return (
      <tr key={key}>
        <td className="seikon-comp" style={red(chg('companyName'))}>{s.companyName || ''}</td>
        <td style={red(chg('siteName'))}>{s.siteName || ''}</td>
        <td className="seikon-datsu" style={red(chg('pourLocation'))}>{s.pourLocation || ''}</td>
        <td className="seikon-veh" style={red(chg('vehicleType', 'vehicleFree'))}>{vf.veh ? <div style={{ fontSize: vfVehFont(vf.veh, 12), fontWeight: 700, lineHeight: 1.05, whiteSpace: 'nowrap', color: chg('vehicleFree') ? '#c81e1e' : '#1b4ea8' }}>{vf.veh}</div> : null}<div>{vehicleLabel(s) || ''}</div></td>
        <td className="seikon-mix" style={red(chg('mixCode', 'mix0', 'mix1', 'mix2', 'mixnote'))}>{r.mixNote ? <div className="seikon-mnote">{r.mixNote}</div> : null}<div>{padMix(r.mix)}</div></td>
        <td style={{ textAlign: 'center', fontWeight: isB ? 800 : 400, ...red(chg('cementType')) }}>{s.cementType || ''}</td>
        <td style={{ textAlign: 'center', ...red(chg('volume')) }}>{r.vols.length ? r.vols.map((x, i) => <div key={i}>{x.note ? <div className="seikon-qnote">{x.note}</div> : null}<div>{x.v}</div></div>) : ''}</td>
        <td style={{ textAlign: 'center', ...red(chg('times') || timeImp, true) }}>{ts.length ? ts.map((t, i) => <div key={i}>{t}</div>) : null}</td>
        <td className="seikon-tekiyo">
          <div style={red(chgNote || chg('placements') || noteImp, true)}>{tekiyo1}</div>
          <div className="seikon-phone" style={red(chg('siteContact', 'vehicleFree'))}>
            <span style={{ display: 'inline-block', minWidth: s.siteContact ? '13ch' : 0 }}>{s.siteContact || ''}</span>
            {vf.over ? <span style={{ fontWeight: 700 }}>{vf.over}</span> : null}
          </div>
        </td>
        <td className="seikon-toku">
          <div className="seikon-toku-tag" style={red(chg('noteTags'))}>{tags}</div>
          <div className="seikon-test" style={red(chg('testTags'))}>{testAbbr}</div>
        </td>
        <td style={{ textAlign: 'center' }}>{(String(s.siteAddress || '').trim() || s.hasPdf === '1' || s.hasPdf === true || s.hasPdf === 1) ? '✔' : ''}</td>
        <td></td>
      </tr>
    )
  }

  const ROWS = 23
  const blanks = Math.max(0, ROWS - tableRows.length)
  const cols = ['業者名', '現場名', '打設', '車輌', '配合', '種', '数量', '時間', '摘要', '特記', '地図', 'メモ']
  const ampmBtn = (on) => ({ border: on ? '2px solid #0f3060' : '1.5px solid #bbb', background: on ? '#0f3060' : '#fff', color: on ? '#fff' : '#3a4a5c', borderRadius: 6, padding: '6px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer' })

  return (
    <div className="seikon-wrap" style={{ height: '100%', overflow: 'auto', padding: isPopup ? 8 : 18, background: '#fff' }}>
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ padding: '6px 10px', border: '1.5px solid #bbb', borderRadius: 6, fontSize: 16 }} />
        <span style={{ fontSize: 13, color: '#6b7a8d' }}>{reiwa}</span>
        <button type="button" onClick={() => setAmpm(a => a === 'AM' ? 'both' : 'AM')} style={ampmBtn(ampm === 'AM')}>AM</button>
        <button type="button" onClick={() => setAmpm(a => a === 'PM' ? 'both' : 'PM')} style={ampmBtn(ampm === 'PM')}>PM</button>
        <button type="button" onClick={openPrint}
          style={{ border: '1.5px solid #0f3060', background: '#0f3060', color: '#fff', borderRadius: 7, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>🖨 印刷 / PDF出力</button>
        <button type="button" onClick={exportCsv}
          style={{ border: '1.5px solid #1a8f5a', background: '#1a8f5a', color: '#fff', borderRadius: 7, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>📥 販売大臣CSVエクスポート</button>
      </div>
      <div className="seikon-sheet">
        <div className="seikon-title">
          <span className="st-name">生コン出荷予定表</span>
          <span className="st-rest" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: '#111', whiteSpace: 'nowrap' }}>
            <span style={{ color: '#2b3a4d', fontSize: 12, fontWeight: 700 }}>休み</span>
            {/* 自由入力テキスト（呼び名/コメントなど自由に） */}
            <input type="text" value={restText} onChange={e => saveRest(e.target.value)}
              placeholder="例: 田中 高橋"
              style={{ width: '12em', fontSize: 12, padding: '2px 6px', border: '1px solid #b9c4d4', borderRadius: 4, fontFamily: 'inherit', color: '#111' }} />
            {/* 出社人数: 直接編集できる number input（基準デフォルトも localStorage 保存） */}
            <input type="number" min="0" value={presentDefault}
              onChange={e => savePresentDefault(Math.max(0, parseInt(e.target.value, 10) || 0))}
              title="出社人数（基準デフォルトとして保存）"
              style={{ width: '3.4em', fontSize: 12, padding: '2px 4px', border: '1px solid #888', borderRadius: 4, color: '#0f3060', fontWeight: 700, textAlign: 'center' }} />
            <span style={{ color: '#0f3060', fontWeight: 700 }}>名</span>
          </span>
          <span className="st-date">{titleDate}</span>
          <span className="st-ampm">
            <b style={{ opacity: ampm === 'PM' ? 0.3 : 1 }}>AM</b> ・ <b style={{ opacity: ampm === 'AM' ? 0.3 : 1 }}>PM</b>
          </span>
          <span className="st-test"><span className="st-test-label">試験</span>
            {testHasAny && (
              <span className="st-test-grid" style={{ gridTemplateColumns: 'auto auto auto' }}>
                <span className="h" /><span className="h">AM</span><span className="h">PM</span>
                {testRows.map(r => (
                  <Fragment key={r.label}><span className="rl">{r.label}</span><b>{r.am || ''}</b><b>{r.pm || ''}</b></Fragment>
                ))}
              </span>
            )}
          </span>
        </div>
        <table className="seikon-table">
          {/* 列: 業者名10 / 現場名18 / 打設4 / 車輌6(↑+2) / 配合13 / 種3 / 数量8 / 時間6 / 摘要15(↓-2) / 特記4 / 地図4 / メモ9 */}
          <colgroup>
            <col style={{ width: '10%' }} /><col style={{ width: '18%' }} /><col style={{ width: '4%' }} /><col style={{ width: '6%' }} />
            <col style={{ width: '13%' }} /><col style={{ width: '3%' }} /><col style={{ width: '8%' }} /><col style={{ width: '6%' }} />
            <col style={{ width: '15%' }} /><col style={{ width: '4%' }} /><col style={{ width: '4%' }} /><col style={{ width: '9%' }} />
          </colgroup>
          <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {tableRows.map((r, i) => renderRow(r, r.s.id + '_' + i))}
            {Array.from({ length: blanks }).map((_, i) => (
              <tr key={'b' + i}>{cols.map((_, j) => <td key={j}>&nbsp;</td>)}</tr>
            ))}
          </tbody>
        </table>
        {loading && <div style={{ padding: 12, color: '#6b7a8d' }} className="no-print">読み込み中...</div>}
      </div>
    </div>
  )
}

function ShipReportPage() {
  useNickReg()
  const [date, setDate] = useState(() => localToday())
  const { all, loading } = useShipments('?date=' + encodeURIComponent(date))
  const rows = all.filter(s => s.date === date).sort((a, b) => timeToMin(firstTimeOf(a)) - timeToMin(firstTimeOf(b)) || String(firstTimeOf(a)).localeCompare(String(firstTimeOf(b))))
  const totalVol = rows.reduce((a, s) => a + (parseFloat(s.volume) || 0), 0)
  return (
    <div style={RPT.wrap}>
      <div style={RPT.head}>
        <h2 style={{ margin: 0, color: '#1a2332' }}>📑 出荷日報</h2>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={RPT.date} />
        <span style={{ fontSize: 13, color: '#6b7a8d' }}>（{(() => { const d = new Date(date); return isNaN(d) ? '' : WD[d.getDay()] })()}）</span>
      </div>
      {loading ? <div>読み込み中...</div> : rows.length === 0 ? <div style={{ color: '#6b7a8d' }}>この日の出荷はありません</div> : (
        <table style={RPT.table}>
          <thead><tr>{['時間', '業者名', '商社', '現場名', '車種', '配合', '量', '担当'].map(h => <th key={h} style={RPT.th}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map(s => (
              <tr key={s.id}>
                <td style={RPT.td}>{firstTimeOf(s)}</td>
                <td style={RPT.td}>{s.companyName}</td>
                <td style={RPT.td}>{s.tradingCompany || ''}</td>
                <td style={RPT.td}>{s.siteName || ''}</td>
                <td style={RPT.td}>{s.vehicleType || ''}</td>
                <td style={RPT.td}>{s.mixCode || ''}</td>
                <td style={RPT.td}><VolNum s={s} unit /></td>
                <td style={RPT.td}>{driversOf(s).join('・')}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td style={{ ...RPT.td, textAlign: 'right', fontWeight: 700 }} colSpan={6}>合計</td><td style={{ ...RPT.td, fontWeight: 700 }}>{totalVol.toFixed(2)}m³</td><td style={{ ...RPT.td, fontWeight: 700 }}>{rows.length}件</td></tr></tfoot>
        </table>
      )}
    </div>
  )
}

function DriverReportPage() {
  useNickReg()
  const [date, setDate] = useState(() => localToday())
  const { all, loading } = useShipments('?date=' + encodeURIComponent(date))
  const rows = all.filter(s => s.date === date)
  const groups = {}
  rows.forEach(s => { const ds = driversOf(s); (ds.length ? ds : ['未割当']).forEach(n => { (groups[n] = groups[n] || []).push(s) }) })
  const names = Object.keys(groups).sort()
  return (
    <div style={RPT.wrap}>
      <div style={RPT.head}>
        <h2 style={{ margin: 0, color: '#1a2332' }}>🚚 運行日報（担当別）</h2>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={RPT.date} />
      </div>
      {loading ? <div>読み込み中...</div> : names.length === 0 ? <div style={{ color: '#6b7a8d' }}>この日の出荷はありません</div> : (
        names.map(n => {
          const list = groups[n].sort((a, b) => timeToMin(firstTimeOf(a)) - timeToMin(firstTimeOf(b)) || String(firstTimeOf(a)).localeCompare(String(firstTimeOf(b))))
          const vol = list.reduce((a, s) => a + (parseFloat(s.volume) || 0), 0)
          return (
            <div key={n} style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 700, color: '#0f3060', marginBottom: 6 }}>👤 {n}（{list.length}件 / {vol.toFixed(2)}m³）</div>
              <table style={RPT.table}>
                <thead><tr>{['時間', '業者名', '現場名', '車種', '配合', '量'].map(h => <th key={h} style={RPT.th}>{h}</th>)}</tr></thead>
                <tbody>{list.map(s => (
                  <tr key={s.id}>
                    <td style={RPT.td}>{firstTimeOf(s)}</td><td style={RPT.td}>{s.companyName}</td><td style={RPT.td}>{s.siteName || ''}</td>
                    <td style={RPT.td}>{s.vehicleType || ''}</td><td style={RPT.td}>{s.mixCode || ''}</td><td style={RPT.td}><VolNum s={s} unit /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )
        })
      )}
    </div>
  )
}

// 出荷の担当者だけを更新（ログイン不要の assign エンドポイント。担当者以外は保持）
async function saveShipmentDrivers(shipment, newDrivers) {
  const nd = newDrivers.map(d => ({ id: d.id, name: d.name }))
  return api.put(`/api/shipments/${shipment.id}?assign=1`, { drivers: nd })
}

// 担当者を選ぶUI（チップ）。accent=選択時の色
function DriverPicker({ value, options, onChange, accent = '#1b4ea8' }) {
  const has = (id) => value.some(d => d.id === id)
  const toggle = (emp) => {
    if (has(emp.id)) onChange(value.filter(d => d.id !== emp.id))
    else onChange([...value, { id: emp.id, name: emp.name }])   // 上限なし
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.length === 0 ? <span style={{ fontSize: 13, color: '#9aa7b5' }}>ドライバーが登録されていません（従業員管理で登録してください）</span>
        : options.map(emp => {
          const on = has(emp.id)
          return <button key={emp.id} type="button" onClick={() => toggle(emp)}
            style={{ border: on ? `2px solid ${accent}` : '1.5px solid #cdd5e0', background: on ? accent : '#fff', color: on ? '#fff' : '#3a4a5c', borderRadius: 8, padding: '9px 14px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>{dispDriverName(emp)}</button>
        })}
    </div>
  )
}

// 担当割当 / LINE送信 の本体（モーダル共用）。mode='assign'（担当を割り当てるだけ）／'send'（送信先へLINE送信）
// 開いた時、割り当て済みの担当者を初期選択にする（送信先・担当者とも）
function DriverAssignBody({ shipment, drivers, onSaved, onClose, mode = 'send' }) {
  const isAssign = mode === 'assign'
  const cleanId = (v) => String(v || '').replace(/[\s　​-‍﻿]/g, '').trim()
  const initSel = () => {
    const assigned = Array.isArray(shipment.drivers) ? shipment.drivers : (shipment.driverName ? [{ id: shipment.driverId || '', name: shipment.driverName }] : [])
    return assigned.filter(Boolean).map(d => {
      const emp = drivers.find(e => (d.id && e.id === d.id) || e.name === d.name)
      return emp ? { id: emp.id, name: emp.name } : { id: d.id || '', name: d.name }
    })
  }
  const [sel, setSel] = useState(initSel)
  const [busy, setBusy] = useState(false)
  // 担当割当：担当者を保存するだけ（LINE送信はしない）
  const doAssign = async () => {
    setBusy(true)
    try {
      const u = await saveShipmentDrivers(shipment, sel)
      notifyShipmentsChanged()
      alert(sel.length ? `担当者を割り当てました（${sel.map(d => d.name).join('、')}）` : '担当者を解除しました')
      onSaved && onSaved(u)
    } catch (e) { alert('エラー: ' + e.message); setBusy(false) }
  }
  // LINE送信：選んだ送信先へpush送信するだけ。担当（s.drivers）は変更しない
  const doSend = async () => {
    if (!sel.length) { alert('送信先が選択されていません。'); return }
    const resolved = sel.map(d => { const emp = drivers.find(e => (d.id && e.id === d.id) || e.name === d.name); return { name: d.name, lineId: cleanId(emp?.lineId || d.lineId) } })
    const withId = resolved.filter(r => r.lineId)
    const without = resolved.filter(r => !r.lineId)
    if (!withId.length) { alert('送信先にLINEユーザーIDが紐づいていないため送信できません。\n（従業員管理でLINE IDを設定してください）'); return }
    setBusy(true)
    try {
      const res = await api.post('/api/line', { action: 'pushShipment', shipmentId: shipment.id, lineUserIds: withId.map(r => r.lineId) })
      let m = `${withId.map(r => r.name).join('、')} にLINEを送信しました（${res.sent ?? '?'}/${res.total ?? '?'} 件成功）`
      if (without.length) m += `\n（LINE未設定のためスキップ: ${without.map(r => r.name).join('、')}）`
      alert(m)
      onClose && onClose()   // 担当は変更しない。送信後は閉じるだけ
    } catch (e) { alert('LINE送信でエラー: ' + e.message); setBusy(false) }
  }
  const accent = isAssign ? '#1a6a9f' : '#06c755'
  return (
    <>
      <div style={{ fontSize: 17, fontWeight: 700, color: '#111', marginBottom: 6 }}>{isAssign ? '👤 担当割当' : '💬 LINE送信'}</div>
      <div style={{ fontSize: 14, color: '#3a4a5c' }}><b style={{ color: '#c0392b' }}>{firstTimeOf(shipment) || '—'}</b>　<b>{shipment.companyName}</b></div>
      <div style={{ fontSize: 13, color: '#6b7a8d', marginBottom: 12 }}>{shipment.siteName || ''}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#3a4a5c', marginBottom: 6 }}>{isAssign ? '担当者（タップで選択／解除）' : '送信先（タップで選択／解除）'}</div>
      <DriverPicker value={sel} options={drivers} onChange={setSel} accent={accent} />
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button type="button" onClick={onClose} disabled={busy} style={{ flex: 1, border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>キャンセル</button>
        <button type="button" onClick={() => (isAssign ? doAssign() : doSend())} disabled={busy}
          style={{ flex: 1, border: `1.5px solid ${accent}`, background: accent, color: '#fff', borderRadius: 10, padding: '12px', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.7 : 1 }}>{busy ? (isAssign ? '保存中…' : '送信中…') : (isAssign ? '👤 担当に割り当て' : '💬 LINE送信')}</button>
      </div>
    </>
  )
}

// 現場住所のジオコード余り（緯度経度メモ）を除いた表示用住所
function cleanAddr(a) { return String(a || '').replace(/（緯度経度:[^）]*）/g, '').trim() }
// 一覧の住所列：市区郡までを表示し、それ以降（町名・番地）は省く（例 "佐賀県神埼市神埼町志波屋2020" → "佐賀県神埼市"）
function addrCity(a) {
  const s = cleanAddr(a)
  const m = s.match(/^(.*?[市区郡])/)
  return m ? m[1] : s
}

// 住所設定（モーダル共用）：住所入力＋地図反映で登録
function AddressAssignBody({ shipment, onSaved, onClose }) {
  const [address, setAddress] = useState(shipment.siteAddress || '')
  const [mapView, setMapView] = useState(shipment.mapView || null)
  const [pin, setPin] = useState(shipment.mapPin || null)
  const [arrows, setArrows] = useState(Array.isArray(shipment.mapArrows) ? shipment.mapArrows : [])
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const u = await api.put(`/api/shipments/${shipment.id}?assign=1`, { siteAddress: address, mapView, mapPin: pin, mapArrows: arrows })
      notifyShipmentsChanged(); onSaved && onSaved(u)
    } catch (e) { alert('エラー: ' + e.message); setSaving(false) }
  }
  return (
    <>
      <div style={{ fontSize: 17, fontWeight: 700, color: '#111', marginBottom: 6 }}>📍 住所設定</div>
      <div style={{ fontSize: 14, color: '#3a4a5c' }}><b>{shipment.companyName}</b></div>
      <div style={{ fontSize: 13, color: '#6b7a8d', marginBottom: 10 }}>{shipment.siteName || ''}</div>
      <label style={{ fontSize: 12, fontWeight: 700, color: '#3a4a5c', display: 'block', marginBottom: 4 }}>現場住所（入力すると地図に反映されます）</label>
      <input value={address} onChange={e => setAddress(e.target.value)} placeholder={DEFAULT_SITE_ADDRESS}
        style={{ width: '100%', fontSize: 15, padding: '9px 10px', border: '1.5px solid #cdd5e0', borderRadius: 8, boxSizing: 'border-box', marginBottom: 10 }} />
      <SiteMap address={address} onAddressChange={setAddress} mapView={mapView} onMapViewChange={setMapView} pin={pin} onPinChange={setPin} arrows={arrows} onArrowsChange={setArrows} />
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button type="button" onClick={onClose} disabled={saving} style={{ flex: 1, border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>キャンセル</button>
        <button type="button" onClick={save} disabled={saving} style={{ flex: 1, border: 'none', background: 'linear-gradient(135deg,#1a4d8f,#1a6a9f)', color: '#fff', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? '保存中…' : '登録'}</button>
      </div>
    </>
  )
}

// PC用：担当者振替の別ウィンドウページ
function DriverAssignPopupPage({ id }) {
  const [shipment, setShipment] = useState(null)
  const [drivers, setDrivers] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    Promise.all([api.get('/api/shipments/' + encodeURIComponent(id)), api.get('/api/employees?drivers=1')])
      .then(([s, es]) => { rememberEmployees(es); setShipment(s && s.id ? s : null); setDrivers(es.filter(e => e.type === 'driver')) })
      .catch(e => console.error(e)).finally(() => setLoading(false))
  }, [id])
  if (loading) return <div style={{ padding: 20, color: '#6b7a8d' }}>読み込み中...</div>
  if (!shipment) return <div style={{ padding: 20, color: '#6b7a8d' }}>対象の出荷が見つかりません。</div>
  return <div style={{ padding: 18, maxWidth: 480, margin: '0 auto' }}><DriverAssignBody shipment={shipment} drivers={drivers} onSaved={() => window.close()} onClose={() => window.close()} /></div>
}

// 伝票キャンセル：伝票を選んでキャンセルすると全リストから非表示になり、ここに保管される
// 出荷登録の伝票（denpyo）レイアウトを流用した読み取り専用ビュー
// changedFields: 変更されたフィールド名の配列。該当セルのラベル・値を赤く表示（更新確認プレビューで使用）
function DenpyoView({ s, changedFields = [] }) {
  const times = (Array.isArray(s.times) ? s.times.map(t => (t && t.text != null) ? t.text : t) : []).map(x => String(x ?? '').trim()).filter(Boolean)
  const notes = (Array.isArray(s.notes) ? s.notes.map(n => (n && n.text != null) ? n.text : n) : []).map(x => String(x ?? '').trim()).filter(Boolean)
  const orderDate = String(s.orderDate || (s.createdAt ? String(s.createdAt).slice(0, 10) : '') || '').replace(/-/g, '/')
  const mixes = mixRowsOfShip(s).filter(r => r.code || r.note)
  const isRed = (...keys) => keys.some(k => changedFields.includes(k))
  const cell = (label, flex, content, ...keys) => {
    const red = isRed(...keys)
    return (
      <div className="cell" style={{ flex }}>
        <div className="lbl" style={red ? { color: '#c81e1e' } : undefined}>{label}</div>
        <div style={{ fontSize: 15, color: red ? '#c81e1e' : '#111', fontWeight: red ? 700 : undefined, minHeight: 18, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</div>
      </div>
    )
  }
  return (
    <div className="denpyo">
      <div className="sheet" style={{ margin: 0 }}>
        <div className="band">
          {cell('受 注 日', '0 0 18%', orderDate || '—')}
          {cell('日 付', '0 0 18%', s.date, 'date')}
          {cell('業 者 名', '1 1 0', s.companyName || '—', 'companyName')}
          {cell('商 社 名', '1 1 0', s.tradingCompany || '—', 'tradingCompany')}
        </div>
        <div className="band">
          {cell('時 間', '0 0 24%', times.join(' / ') || '—', 'times')}
          {cell('現 場 名', '1 1 0', s.siteName || '—', 'siteName')}
        </div>
        <div className="band">
          {cell('現 場 住 所', '1 1 0', cleanAddr(s.siteAddress) || '未入力', 'siteAddress')}
        </div>
        <div className="band">
          {cell('車 種', '0 0 16%', <>{vehicleLabel(s) || '—'}{s.vehicleFree ? <div style={{ fontSize: 12, color: isRed('vehicleFree') ? '#c81e1e' : '#1b4ea8', fontWeight: 700, marginTop: 2 }}>{s.vehicleFree}</div> : null}</>, 'vehicleType', 'vehicleFree')}
          {cell('打設箇所', '0 0 16%', s.pourLocation || '—', 'pourLocation')}
          {cell('配 合', '1 1 0', mixes.length ? mixes.map((r, i) => <div key={i}>{r.code}{r.note ? `（${r.note}）` : ''}</div>) : '—', 'mixCode', 'mix0', 'mix1', 'mix2', 'mixnote')}
          {cell('セメント種', '0 0 12%', s.cementType || '—', 'cementType')}
          {cell('試 験', '0 0 14%', (s.testTags || []).join('・') || '—', 'testTags')}
        </div>
        <div className="band">
          {cell('数 量', '0 0 24%', <VolNum s={s} unit fallback="—" />, 'volume')}
          {cell('荷下ろし', '1 1 0', (Array.isArray(s.placements) ? s.placements : []).join('・') || '—', 'placements')}
          {cell('特 記', '0 0 24%', (Array.isArray(s.noteTags) ? s.noteTags : []).join('・') || '—', 'noteTags')}
        </div>
        <div className="band">
          {cell('連 絡 先', '1 1 0', s.orderContact || '—', 'orderContact')}
          {cell('現場連絡先', '1 1 0', s.siteContact || '—', 'siteContact')}
        </div>
        <div className="band">
          {cell('備 考', '1 1 0', notes.length ? notes.map((n, i) => <div key={i}>・{n}</div>) : '—', 'notes')}
        </div>
        <div className="band">
          {cell('担当ドライバー', '1 1 0', driversOf(s).join('・') || '—', 'drivers')}
          {cell('PDF', '0 0 22%', s.hasPdf
            ? <a href={`/api/shipments?id=${encodeURIComponent(s.id)}&pdf=1`} onClick={(e) => { e.preventDefault(); window.open(`/api/shipments?id=${encodeURIComponent(s.id)}&pdf=1`, '_blank', 'width=900,height=1000') }} style={{ color: '#1a4d8f', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' }}>📄 PDFを開く</a>
            : '—')}
        </div>
      </div>
    </div>
  )
}

// キャンセル伝票：削除（キャンセル）した伝票の保管庫。復元すると元に戻り一覧から消える
function CancelPage({ onRestoreEdit }) {
  const [cancelled, setCancelled] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(null)        // 復元/削除処理中の伝票id
  const [detail, setDetail] = useState(null)    // フォーム表示中の伝票
  const [selectMode, setSelectMode] = useState(false)   // 選択削除モード
  const [selected, setSelected] = useState(() => new Set())  // 選択中の伝票id
  const [deleting, setDeleting] = useState(false)       // 一括削除中
  const load = useCallback(async () => {
    try { const c = await api.get('/api/shipments?cancelled=1'); setCancelled(Array.isArray(c) ? c : []) }
    catch (e) { console.error(e) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useShipmentsChanged(load)

  // 復元の実処理（プレビュー＝detailモーダル内の「復元する」ボタンから呼ばれる）
  const doRestore = async (s) => {
    setBusy(s.id)
    try {
      await api.put(`/api/shipments/${s.id}?cancel=1`, { cancelled: false })
      notifyShipmentsChanged()
      setDetail(null)
      await load()
      // 復元後、出荷登録の編集画面を直接開く（親に通知）
      if (onRestoreEdit) onRestoreEdit(s.id)
    }
    catch (e) { alert('エラー: ' + e.message) } finally { setBusy(null) }
  }

  // 完全削除の実処理（プレビュー内の「完全に削除」ボタンから呼ばれる）。元に戻せないため最終確認を残す
  const doDelete = async (s) => {
    if (!window.confirm(`「${s.companyName}」${s.date} の伝票を完全に削除します。\n元に戻せません。よろしいですか？`)) return
    setBusy(s.id)
    try {
      await api.del(`/api/shipments/${s.id}`)
      notifyShipmentsChanged(); setDetail(null)
      setSelected(prev => { const n = new Set(prev); n.delete(s.id); return n })
      await load()
    } catch (e) { alert('エラー: ' + e.message) } finally { setBusy(null) }
  }

  const q = search.trim().toLowerCase()
  const matchS = (s) => !q || [s.date, s.companyName, s.tradingCompany, s.siteName, firstTimeOf(s)].some(v => String(v || '').toLowerCase().includes(q))
  const rows = [...cancelled.filter(matchS)].sort((a, b) => String(b.cancelledAt || b.date || '').localeCompare(String(a.cancelledAt || a.date || '')))

  const toggleSel = (id) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allChecked = rows.length > 0 && rows.every(s => selected.has(s.id))
  const toggleAll = () => setSelected(() => allChecked ? new Set() : new Set(rows.map(s => s.id)))
  const selCount = rows.filter(s => selected.has(s.id)).length
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()) }
  // 選択した伝票をまとめて完全削除（1件ずつ削除APIを順に実行）
  const delSelected = async () => {
    const ids = rows.filter(s => selected.has(s.id)).map(s => s.id)
    if (!ids.length) return
    if (!window.confirm(`選択した ${ids.length}件 の伝票を完全に削除します。\n元に戻せません。よろしいですか？`)) return
    setDeleting(true)
    try {
      for (const id of ids) { await api.del(`/api/shipments/${id}`) }
      notifyShipmentsChanged(); exitSelect(); await load()
    } catch (e) { alert('一部の削除に失敗しました: ' + e.message); await load() } finally { setDeleting(false) }
  }

  return (
    <div style={RPT.wrap}>
      <h2 style={{ margin: '0 0 6px', color: '#1a2332' }}>🗑️ キャンセル伝票</h2>
      <div style={{ fontSize: 13, color: '#6b7a8d', marginBottom: 12 }}>削除（キャンセル）した伝票がここに保管されます。「復元」で元に戻せます。「完全削除」は元に戻せません。</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 日付・業者名・現場名で絞り込み"
          style={{ flex: '1 1 280px', maxWidth: 420, padding: '9px 12px', border: '1.5px solid #dde3ed', borderRadius: 8, fontSize: 14, outline: 'none' }} />
        {!selectMode
          ? <button type="button" onClick={() => setSelectMode(true)} disabled={rows.length === 0}
              style={{ flex: '0 0 auto', border: '1.5px solid #c0392b', background: '#fff', color: '#c0392b', borderRadius: 8, padding: '9px 14px', fontSize: 13, fontWeight: 700, cursor: rows.length ? 'pointer' : 'default', opacity: rows.length ? 1 : 0.5, whiteSpace: 'nowrap' }}>☑ 選択して削除</button>
          : <button type="button" onClick={exitSelect} style={{ flex: '0 0 auto', border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 8, padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>選択をやめる</button>}
      </div>

      {/* 選択削除モードの操作バー */}
      {selectMode && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: '#fff5f5', border: '1px solid #f0c0c0', borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#3a4a5c', cursor: 'pointer' }}>
            <input type="checkbox" checked={allChecked} onChange={toggleAll} style={{ width: 18, height: 18 }} />全て選択
          </label>
          <span style={{ fontSize: 13, color: '#c0392b', fontWeight: 700 }}>{selCount}件 選択中</span>
          <button type="button" onClick={delSelected} disabled={selCount === 0 || deleting}
            style={{ marginLeft: 'auto', border: 'none', background: '#c0392b', color: '#fff', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: (selCount && !deleting) ? 'pointer' : 'default', opacity: (selCount && !deleting) ? 1 : 0.5, whiteSpace: 'nowrap' }}>
            {deleting ? '削除中…' : `🗑 選択した${selCount}件を削除`}
          </button>
        </div>
      )}

      {loading ? <div style={{ color: '#6b7a8d' }}>読み込み中...</div>
        : rows.length === 0 ? <div style={{ color: '#9aa7b5', fontSize: 13 }}>キャンセル伝票はありません</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: '10px 14px', opacity: 0.92 }}>
                  {selectMode && (
                    <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSel(s.id)} style={{ flex: '0 0 auto', width: 20, height: 20 }} />
                  )}
                  <span onClick={() => setDetail(s)} style={{ flex: '1 1 240px', minWidth: 0, cursor: 'pointer' }} title="クリックで伝票を表示">
                    <span style={{ fontSize: 13, color: '#3a4a5c' }}>{s.date}　<b style={{ color: '#c0392b' }}>{firstTimeOf(s) || ''}</b>　</span>
                    <b>{s.companyName}</b>{s.siteName ? <span style={{ color: '#6b7a8d' }}> ／ {s.siteName}</span> : ''}
                  </span>
                  <button type="button" onClick={() => setDetail(s)} style={{ flex: '0 0 auto', border: '1.5px solid #1a4d8f', background: '#fff', color: '#1a4d8f', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>📄 表示</button>
                </div>
              ))}
            </div>
          )}
      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, overflowY: 'auto' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', width: '100%', maxWidth: 780, borderRadius: 14, padding: 16, margin: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>🗑️ キャンセル伝票</div>
              <button type="button" onClick={() => setDetail(null)} style={{ border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>✕ 閉じる</button>
            </div>
            <FitToWidth width={720}><DenpyoView s={detail} /></FitToWidth>
            <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => setDetail(null)} disabled={busy} style={{ flex: '1 1 120px', border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>閉じる</button>
              <button type="button" onClick={() => doDelete(detail)} disabled={busy} style={{ flex: '1 1 120px', border: '1.5px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.7 : 1 }}>🗑 完全に削除</button>
              <button type="button" onClick={() => doRestore(detail)} disabled={busy} style={{ flex: '1 1 120px', border: 'none', background: '#1a8f5a', color: '#fff', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.7 : 1 }}>{busy ? '処理中…' : '↩ 復元する'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 配送臨時割り当て：当日(既定)の出荷を時間順に表示し、担当者を素早く振り替える
// isPopup: 別ウィンドウ（ログイン不要で誰でも振替可能）
function AssignPage({ isPopup }) {
  const stacked = useIsMobile(1101)   // スマホ/iPad
  const narrow = useIsMobile(760)     // スマホ（狭い縦画面）。iPad以上は横並びカード
  const useModal = isPopup || stacked   // 別ウィンドウ内 or スマホ/iPad は振替モーダル、PC(アプリ内)は別ウィンドウ
  const urlDate = (typeof window !== 'undefined') ? new URLSearchParams(window.location.search).get('date') : null
  const [date, setDate] = useState(() => (isPopup && urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate)) ? urlDate : localToday())
  const [ampm, setAmpm] = useState('both')   // AM/PM表示の絞り込み（'both'|'AM'|'PM'）
  const [all, setAll] = useState([])
  const [drivers, setDrivers] = useState([])
  const [loading, setLoading] = useState(true)
  const [assignTarget, setAssignTarget] = useState(null)
  const [addrTarget, setAddrTarget] = useState(null)
  // 表示日だけを取得（日付索引で当日ぶんのみ＝読み取り削減）。ポーリング/通知から最新日付を参照するためref併用
  const dateRef = useRef(date); dateRef.current = date
  const load = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([api.get('/api/shipments?date=' + encodeURIComponent(dateRef.current)), api.get('/api/employees?drivers=1')])
      rememberEmployees(e); setAll(s); setDrivers(e.filter(x => x.type === 'driver'))
    } catch (err) { console.error(err) } finally { setLoading(false) }
  }, [])
  // 初回＋表示日が変わるたびに読み直す（日付変更時は「読み込み中」を出さず、取得完了時に差し替え＝チラつき防止）
  useEffect(() => { load() }, [date, load])
  useShipmentsChanged(load)   // 別ウィンドウで保存されたら再取得して反映

  // all は日付索引で表示日ぶんのみ取得済み。日付変更中も前日の表示を残すため date 判定はしない
  // AM/PM絞り込み（'both'|'AM'|'PM'）。午前=12:00より前、午後=12:00以降
  const inAmPm = (s) => { if (ampm === 'both') return true; const mm = timeToMin(firstTimeOf(s)); return ampm === 'AM' ? mm < 720 : mm >= 720 }
  const rows = [...all].filter(inAmPm)
    .sort((a, b) => timeToMin(firstTimeOf(a)) - timeToMin(firstTimeOf(b)) || String(firstTimeOf(a)).localeCompare(String(firstTimeOf(b))))

  const openBoard = () => {
    const url = `${window.location.pathname}?view=assign&popup=1&date=${encodeURIComponent(date)}`
    const w = window.open(url, '_blank', 'width=860,height=900,scrollbars=yes,resizable=yes')
    if (!w) { alert('別ウィンドウを開けませんでした。ポップアップを許可してください。'); window.open(url, '_blank') }
  }
  const openAssign = (s) => {
    if (useModal) { setAssignTarget(s); return }
    const url = `${window.location.pathname}?view=assigndriver&id=${encodeURIComponent(s.id)}&popup=1`
    const w = window.open(url, '_blank', 'width=520,height=640,scrollbars=yes,resizable=yes')
    if (!w) { alert('別ウィンドウを開けませんでした。ポップアップを許可してください。'); window.open(url, '_blank') }
  }
  const onModalSaved = (updated) => { setAll(prev => prev.map(x => x.id === updated.id ? updated : x)); setAssignTarget(null); setAddrTarget(null) }
  // LINE送信（担当変更なし）：割り当て済みの担当者へそのままpush送信する
  const sendLineDirect = async (s) => {
    const cleanLineId = (v) => String(v || '').replace(/[\s　​-‍﻿]/g, '').trim()
    const assigned = Array.isArray(s.drivers) ? s.drivers : (s.driverName ? [{ id: s.driverId || '', name: s.driverName }] : [])
    if (!assigned.length) { alert('担当者が割り当てられていません。\n先に「担当割当」で担当者を割り当ててください。'); return }
    const resolved = assigned.map(d => { const emp = drivers.find(e => (d.id && e.id === d.id) || e.name === d.name); return { name: d.name, lineId: cleanLineId(emp?.lineId || d.lineId) } })
    const withId = resolved.filter(r => r.lineId)
    const without = resolved.filter(r => !r.lineId)
    if (!withId.length) { alert('担当者にLINEユーザーIDが設定されていません。\n（従業員管理でLINE IDを設定してください）'); return }
    if (!window.confirm(`${withId.map(r => r.name).join('、')} にLINEを送信しますか？`)) return
    try {
      const res = await api.post('/api/line', { action: 'pushShipment', shipmentId: s.id, lineUserIds: withId.map(r => r.lineId) })
      let m = `送信しました（${res.sent ?? '?'}/${res.total ?? '?'} 件成功）`
      if (without.length) m += `\n（LINE未設定でスキップ: ${without.map(r => r.name).join('、')}）`
      alert(m)
    } catch (e) { alert('送信に失敗しました: ' + e.message) }
  }
  const wd = (() => { const d = new Date(date); return isNaN(d.getTime()) ? '' : WD[d.getDay()] })()

  return (
    <div style={RPT.wrap}>
      <div style={RPT.head}>
        <h2 style={{ margin: 0, color: '#1a2332' }}>🔁 配送割り当て{isPopup ? '（共有）' : ''}</h2>
        {/* 日付と曜日は必ず隣接（日付が左・曜日が右）。スマホでもこの2つは離れない */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={RPT.date} />
          <span style={{ fontSize: 13, color: '#6b7a8d', whiteSpace: 'nowrap' }}>（{wd}）</span>
        </span>
        {/* AM/PM 絞り込み（押した方だけ表示。もう一度押すと全件） */}
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {['AM', 'PM'].map(p => (
            <button key={p} type="button" onClick={() => setAmpm(a => a === p ? 'both' : p)}
              style={{ border: ampm === p ? '2px solid #0f3060' : '1.5px solid #bbb', background: ampm === p ? '#0f3060' : '#fff', color: ampm === p ? '#fff' : '#3a4a5c', borderRadius: 6, padding: '5px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{p}</button>
          ))}
        </span>
        {!isPopup && (
          <button type="button" onClick={openBoard}
            style={{ border: '1.5px solid #0f3060', background: '#fff', color: '#0f3060', borderRadius: 7, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>{narrow ? '⛶ 共有（別ウィンドウ）' : '⛶ 別ウィンドウで開く（ログイン不要・共有可）'}</button>
        )}
        {/* 別ウィンドウ（共有）は閉じるボタンを置かない（ブラウザのタブ/ウィンドウで閉じる） */}
      </div>
      {loading ? <div style={{ color: '#6b7a8d' }}>読み込み中...</div>
        : rows.length === 0 ? <div style={{ color: '#6b7a8d' }}>この日（{date}）の出荷登録はありません</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map(s => {
                const addr = cleanAddr(s.siteAddress)
                const addrCell = addr ? <span style={{ color: '#3a4a5c' }}>{addr}</span> : <span style={{ color: '#c0392b' }}>未入力</span>
                const mixStr = mixRowsOfShip(s).map(r => r.code).filter(Boolean).join(' / ')   // 登録した配合
                const volStr = shipVolStr(s)                                                   // 登録した量
                const drv = driversOf(s)                                                       // 割り当て済みの担当者
                const assigned = drv.length > 0
                const cardBg = assigned ? '#e6f1fb' : '#fff'   // 割り当て済みは薄い水色
                if (narrow) {
                  // スマホ（狭い縦画面）：縦カード。操作ボタンは下に横並び
                  return (
                    <div key={s.id} style={{ position: 'relative', background: cardBg, border: '1px solid #d7e0ea', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {s.hasPdf && (
                        <button type="button" onClick={() => openPdfViewer(s.id)}
                          style={{ position: 'absolute', top: 12, right: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, border: '1.5px solid #8a97a6', background: '#fff', color: '#3a4a5c', borderRadius: 9, padding: '6px 8px', fontSize: 12, fontWeight: 700, lineHeight: 1.1, cursor: 'pointer' }}>📄<span>PDF確認</span></button>
                      )}
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', paddingRight: s.hasPdf ? 78 : 0 }}>
                        <span style={{ fontWeight: 800, color: '#c0392b', fontSize: 18 }}>{firstTimeOf(s) || '—'}</span>
                        <span style={{ fontWeight: 700, fontSize: 18 }}>{s.companyName}</span>
                        <span style={{ color: '#6b7a8d', fontSize: 15 }}>{s.siteName || ''}</span>
                      </div>
                      <div style={{ fontSize: 16 }}><span style={{ color: '#6b7a8d', marginRight: 6 }}>担当</span>{assigned ? <b style={{ color: '#0f3060' }}>{drv.join('・')}</b> : <span style={{ color: '#c0392b', fontWeight: 700 }}>未割り当て</span>}</div>
                      <div style={{ fontSize: 16, color: '#3a4a5c' }}>配合 <b style={{ color: '#111' }}>{mixStr || '—'}</b>　量 <VolNum s={s} unit fallback="—" /></div>
                      <div style={{ fontSize: 16, color: '#3a4a5c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>住所 {addrCell}</div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
                        <button type="button" onClick={() => setAddrTarget(s)} style={{ flex: 1, border: '1.5px solid #1a6a9f', background: '#fff', color: '#1a6a9f', borderRadius: 9, padding: '12px 0', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>📍 住所設定</button>
                        <button type="button" onClick={() => setAssignTarget({ ship: s, mode: 'assign' })} style={{ flex: 1, border: '1.5px solid #1a6a9f', background: '#1a6a9f', color: '#fff', borderRadius: 9, padding: '12px 0', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>👤 担当割当</button>
                      </div>
                      <button type="button" onClick={() => setAssignTarget({ ship: s, mode: 'send' })} style={{ border: '1.5px solid #06c755', background: '#06c755', color: '#fff', borderRadius: 9, padding: '12px 0', fontSize: 17, fontWeight: 700, cursor: 'pointer' }}>💬 LINE送信</button>
                    </div>
                  )
                }
                // iPad/PC：左に情報（縦に積む）＋右に操作ボタン縦並び（住所設定の下にLINE送信）
                const lbl = { color: '#6b7a8d', marginRight: 8, fontSize: 13 }
                if (stacked) {
                  // iPad：左に情報＋右に操作ボタン縦並び。縦の間隔を広めにとる
                  return (
                    <div key={s.id} style={{ display: 'flex', gap: 14, alignItems: 'stretch', background: cardBg, border: '1px solid #d7e0ea', borderRadius: 12, padding: '18px 16px' }}>
                      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 800, color: '#c0392b', fontSize: 19 }}>{firstTimeOf(s) || '—'}</span>
                          <span style={{ fontWeight: 700, fontSize: 19 }}>{s.companyName}</span>
                          <span style={{ color: '#6b7a8d', fontSize: 15 }}>{s.siteName || ''}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: '13px 18px', fontSize: 16 }}>
                          <div style={{ minWidth: 0 }}><span style={lbl}>担当</span>{assigned ? <b style={{ color: '#0f3060' }}>{drv.join('・')}</b> : <span style={{ color: '#c0392b', fontWeight: 700 }}>未割り当て</span>}</div>
                          <div style={{ minWidth: 0 }}><span style={lbl}>配合</span><b style={{ color: '#111' }}>{mixStr || '—'}</b></div>
                          <div style={{ minWidth: 0 }}><span style={lbl}>量</span><VolNum s={s} unit fallback="—" /></div>
                          <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={lbl}>住所</span><span style={{ color: '#3a4a5c' }}>{addrCell}</span></div>
                        </div>
                      </div>
                      {s.hasPdf && (
                        <button type="button" onClick={() => openPdfViewer(s.id)}
                          style={{ flex: '0 0 74px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, border: '1.5px solid #8a97a6', background: '#fff', color: '#3a4a5c', borderRadius: 10, fontSize: 13, fontWeight: 700, lineHeight: 1.15, cursor: 'pointer' }}>📄<span>PDF確認</span></button>
                      )}
                      <div style={{ flex: '0 0 170px', display: 'flex', flexDirection: 'column', gap: 12, justifyContent: 'center' }}>
                        <button type="button" onClick={() => setAddrTarget(s)} style={{ border: '1.5px solid #1a6a9f', background: '#fff', color: '#1a6a9f', borderRadius: 10, padding: '13px 0', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>📍 住所設定</button>
                        <button type="button" onClick={() => setAssignTarget({ ship: s, mode: 'assign' })} style={{ border: '1.5px solid #1a6a9f', background: '#1a6a9f', color: '#fff', borderRadius: 10, padding: '13px 0', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>👤 担当割当</button>
                      </div>
                      <button type="button" onClick={() => setAssignTarget({ ship: s, mode: 'send' })} style={{ flex: '0 0 120px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid #06c755', background: '#06c755', color: '#fff', borderRadius: 10, fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>💬 LINE送信</button>
                    </div>
                  )
                }
                // PC：コンパクトな2行カード（ボタン小さめ・縦並び）。1画面に多く表示できる
                return (
                  <div key={s.id} style={{ display: 'flex', gap: 12, alignItems: 'stretch', background: cardBg, border: '1px solid #d7e0ea', borderRadius: 10, padding: '8px 14px' }}>
                    <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, justifyContent: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 800, color: '#c0392b', fontSize: 16 }}>{firstTimeOf(s) || '—'}</span>
                        <span style={{ fontWeight: 700, fontSize: 16 }}>{s.companyName}</span>
                        <span style={{ color: '#6b7a8d', fontSize: 13 }}>{s.siteName || ''}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 14, color: '#3a4a5c', alignItems: 'baseline' }}>
                        <span>担当 {assigned ? <b style={{ color: '#0f3060' }}>{drv.join('・')}</b> : <span style={{ color: '#c0392b', fontWeight: 700 }}>未割り当て</span>}</span>
                        <span>配合 <b style={{ color: '#111' }}>{mixStr || '—'}</b></span>
                        <span>量 <VolNum s={s} unit fallback="—" /></span>
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>住所 {addrCell}</span>
                      </div>
                    </div>
                    {s.hasPdf && (
                      <button type="button" onClick={() => openPdfViewer(s.id)}
                        style={{ flex: '0 0 62px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, border: '1.5px solid #8a97a6', background: '#fff', color: '#3a4a5c', borderRadius: 7, fontSize: 12, fontWeight: 700, lineHeight: 1.1, cursor: 'pointer' }}>📄<span>PDF確認</span></button>
                    )}
                    <div style={{ flex: '0 0 130px', display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'center' }}>
                      <button type="button" onClick={() => setAddrTarget(s)} style={{ border: '1.5px solid #1a6a9f', background: '#fff', color: '#1a6a9f', borderRadius: 7, padding: '6px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>📍 住所設定</button>
                      <button type="button" onClick={() => setAssignTarget({ ship: s, mode: 'assign' })} style={{ border: '1.5px solid #1a6a9f', background: '#1a6a9f', color: '#fff', borderRadius: 7, padding: '6px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>👤 担当割当</button>
                    </div>
                    <button type="button" onClick={() => setAssignTarget({ ship: s, mode: 'send' })} style={{ flex: '0 0 110px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid #06c755', background: '#06c755', color: '#fff', borderRadius: 7, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>💬 LINE送信</button>
                  </div>
                )
              })}
            </div>
          )}
      {assignTarget && (
        <div onClick={() => setAssignTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', width: '100%', maxWidth: 480, borderRadius: 14, padding: 18, maxHeight: '88dvh', overflowY: 'auto' }}>
            <DriverAssignBody shipment={assignTarget.ship} mode={assignTarget.mode} drivers={drivers} onSaved={onModalSaved} onClose={() => setAssignTarget(null)} />
          </div>
        </div>
      )}
      {addrTarget && (
        <div onClick={() => setAddrTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', width: '100%', maxWidth: 560, borderRadius: 14, padding: 18, maxHeight: '92dvh', overflowY: 'auto' }}>
            <AddressAssignBody shipment={addrTarget} onSaved={onModalSaved} onClose={() => setAddrTarget(null)} />
          </div>
        </div>
      )}
    </div>
  )
}

// デバッグ依頼用の掲示板（PC専用）。
// ・スレッド一覧（新しい順、自動更新なし。手動の「🔄 更新」ボタン）
// ・新規スレッド作成（タイトル + 本文 + 画像）
// ・スレッドを開くと本文と返信が時系列に並び、自分も返信できる
function DebugPage() {
  const { user } = useAuth()
  const [threads, setThreads] = useState([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState(null)   // 詳細表示中のスレッドID（null=一覧）
  const [newTitle, setNewTitle] = useState('')
  const [newBody, setNewBody] = useState('')
  const [newImg, setNewImg] = useState('')
  const [posting, setPosting] = useState(false)

  const reload = async () => {
    setLoading(true)
    try { setThreads(await api.get('/api/debug')) }
    catch (e) { alert('取得エラー: ' + (e?.message || e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { reload() }, [])   // 初回のみ。自動更新なし
  const opened = openId ? threads.find(t => t.id === openId) : null

  const onImg = (e, setter) => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''
    if (!f) return
    if (!/^image\//.test(f.type)) { alert('画像ファイルを選んでください'); return }
    if (f.size > 3 * 1024 * 1024) { alert('画像が大きすぎます（最大3MB）。スクショを縮小して下さい'); return }
    const r = new FileReader()
    r.onload = () => setter(String(r.result || ''))
    r.onerror = () => alert('画像の読込に失敗しました')
    r.readAsDataURL(f)
  }

  const postThread = async () => {
    if (!newTitle.trim() && !newBody.trim() && !newImg) { alert('タイトル・本文・画像のいずれかを入力してください'); return }
    setPosting(true)
    try {
      const t = await api.post('/api/debug', { title: newTitle, body: newBody, image: newImg })
      setThreads(prev => [t, ...prev])
      setNewTitle(''); setNewBody(''); setNewImg('')
    } catch (e) { alert('投稿エラー: ' + (e?.message || e)) }
    finally { setPosting(false) }
  }

  const delThread = async (t) => {
    if (!window.confirm(`スレッドを削除しますか？\n「${t.title || t.body.slice(0, 30)}」`)) return
    try {
      await api.del('/api/debug?id=' + encodeURIComponent(t.id))
      setThreads(prev => prev.filter(x => x.id !== t.id))
      if (openId === t.id) setOpenId(null)
    } catch (e) { alert('削除エラー: ' + (e?.message || e)) }
  }

  const fmt = (iso) => {
    try { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }
    catch { return '' }
  }

  const card = { background: '#fff', border: '1px solid #dde3ed', borderRadius: 10, padding: 14, marginBottom: 12 }
  const lbl = { fontSize: 12, fontWeight: 700, color: '#475467', marginBottom: 4 }
  const inp = { width: '100%', boxSizing: 'border-box', fontSize: 14, padding: '8px 10px', border: '1.5px solid #d4dbe5', borderRadius: 8, fontFamily: 'inherit' }
  const btn = (variant) => ({ border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer',
    background: variant === 'primary' ? 'linear-gradient(135deg,#1a4d8f,#1a6a9f)' : variant === 'ghost' ? '#fff' : '#eef0f4',
    color: variant === 'primary' ? '#fff' : variant === 'ghost' ? '#3a4a5c' : '#475467',
    ...(variant === 'ghost' ? { border: '1.5px solid #cdd5e0' } : {}) })

  if (opened) {
    return (
      <div style={{ height: '100%', overflow: 'auto', padding: 20, background: '#f3f5f9' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <button type="button" onClick={() => setOpenId(null)} style={btn('ghost')}>← 一覧へ戻る</button>
          <h2 style={{ margin: 0, fontSize: 18, color: '#1a2332' }}>🐛 デバッグ依頼</h2>
        </div>
        <DebugThreadView thread={opened} user={user} fmt={fmt} onImg={onImg} onPosted={(t) => { setThreads(prev => prev.map(x => x.id === t.id ? t : x)) }} onDelete={() => delThread(opened)} />
      </div>
    )
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 20, background: '#f3f5f9' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, color: '#1a2332' }}>🐛 デバッグ依頼</h2>
        <button type="button" onClick={reload} disabled={loading} style={btn('ghost')}>🔄 更新</button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7a8d' }}>※ 自動更新はしません。新着確認は手動で🔄 更新を押してください</span>
      </div>

      {/* 新規スレッド作成 */}
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1a2332', marginBottom: 8 }}>＋ 新規依頼を投稿</div>
        <div style={{ marginBottom: 8 }}>
          <div style={lbl}>タイトル</div>
          <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="例: 出荷予定表で配合の特記が消える" style={inp} maxLength={200} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <div style={lbl}>本文（再現手順や期待動作など）</div>
          <textarea value={newBody} onChange={e => setNewBody(e.target.value)} rows={4} style={{ ...inp, resize: 'vertical', lineHeight: 1.5 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ ...btn('ghost'), display: 'inline-flex', alignItems: 'center', gap: 6 }}>📷 スクショ添付
            <input type="file" accept="image/*" onChange={e => onImg(e, setNewImg)} style={{ display: 'none' }} />
          </label>
          {newImg && (
            <>
              <img src={newImg} alt="preview" style={{ height: 60, border: '1px solid #cdd5e0', borderRadius: 6 }} />
              <button type="button" onClick={() => setNewImg('')} style={{ border: '1px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>🗑 画像を外す</button>
            </>
          )}
          <button type="button" onClick={postThread} disabled={posting} style={{ ...btn('primary'), marginLeft: 'auto', opacity: posting ? 0.6 : 1 }}>{posting ? '投稿中…' : '投稿する'}</button>
        </div>
      </div>

      {/* スレッド一覧 */}
      {loading ? <div style={{ padding: 20, color: '#6b7a8d' }}>読み込み中…</div>
        : threads.length === 0 ? <div style={{ padding: 20, color: '#6b7a8d' }}>まだ依頼はありません。最初の投稿をしてください。</div>
        : threads.map(t => {
          const last = t.replies && t.replies.length ? t.replies[t.replies.length - 1] : null
          return (
            <div key={t.id} style={{ ...card, cursor: 'pointer' }} onClick={() => setOpenId(t.id)}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#1a2332' }}>{t.title || '(無題)'}</span>
                <span style={{ fontSize: 12, color: '#6b7a8d' }}>{t.author?.name || '匿名'} ／ {fmt(t.createdAt)}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: '#1b4ea8', fontWeight: 700 }}>💬 {(t.replies || []).length}</span>
              </div>
              {t.body ? <div style={{ marginTop: 6, fontSize: 13, color: '#3a4a5c', whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.body}</div> : null}
              {t.image ? <img src={t.image} alt="" style={{ marginTop: 8, maxHeight: 80, border: '1px solid #cdd5e0', borderRadius: 6 }} /> : null}
              {last && <div style={{ marginTop: 8, fontSize: 12, color: '#6b7a8d' }}>↳ 最新返信: {last.author?.name || '匿名'} ／ {fmt(last.createdAt)}</div>}
            </div>
          )
        })}
    </div>
  )
}

// スレッド詳細：親投稿 + 返信一覧 + 返信フォーム
function DebugThreadView({ thread, user, fmt, onImg, onPosted, onDelete }) {
  const [body, setBody] = useState('')
  const [img, setImg] = useState('')
  const [posting, setPosting] = useState(false)
  const isOwner = thread.author && user && thread.author.id === user.id
  const canDelete = isOwner || user?.role === 'admin'
  const submit = async () => {
    if (!body.trim() && !img) { alert('本文または画像を入力してください'); return }
    setPosting(true)
    try {
      const t = await api.post('/api/debug?id=' + encodeURIComponent(thread.id), { body, image: img })
      setBody(''); setImg('')
      onPosted(t)
    } catch (e) { alert('返信エラー: ' + (e?.message || e)) }
    finally { setPosting(false) }
  }
  const post = ({ author, body, image, createdAt }, opts = {}) => (
    <div style={{ background: '#fff', border: '1px solid #dde3ed', borderRadius: 10, padding: 14, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: '#1a2332', fontSize: 14 }}>{author?.name || '匿名'}</span>
        <span style={{ fontSize: 12, color: '#6b7a8d' }}>{fmt(createdAt)}</span>
        {opts.head && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#fff', background: '#1a4d8f', borderRadius: 4, padding: '1px 6px', fontWeight: 700 }}>親投稿</span>}
      </div>
      {opts.title ? <div style={{ marginTop: 6, fontSize: 16, fontWeight: 700, color: '#1a2332' }}>{opts.title}</div> : null}
      {body ? <div style={{ marginTop: 8, fontSize: 14, color: '#1a2332', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{body}</div> : null}
      {image ? <a href={image} target="_blank" rel="noopener noreferrer"><img src={image} alt="" style={{ marginTop: 10, maxWidth: '100%', maxHeight: 480, border: '1px solid #cdd5e0', borderRadius: 6 }} /></a> : null}
    </div>
  )
  return (
    <div>
      {post({ author: thread.author, body: thread.body, image: thread.image, createdAt: thread.createdAt }, { head: true, title: thread.title })}
      {(thread.replies || []).map(r => <Fragment key={r.id}>{post(r)}</Fragment>)}
      {/* 返信フォーム */}
      <div style={{ background: '#fff', border: '1px solid #dde3ed', borderRadius: 10, padding: 14, marginTop: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#475467', marginBottom: 6 }}>💬 返信を投稿</div>
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={3} placeholder="本文を入力（誰でも返信できます）" style={{ width: '100%', boxSizing: 'border-box', fontSize: 14, padding: '8px 10px', border: '1.5px solid #d4dbe5', borderRadius: 8, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1.5px solid #cdd5e0', background: '#fff', color: '#3a4a5c', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>📷 スクショ添付
            <input type="file" accept="image/*" onChange={e => onImg(e, setImg)} style={{ display: 'none' }} />
          </label>
          {img && (
            <>
              <img src={img} alt="preview" style={{ height: 50, border: '1px solid #cdd5e0', borderRadius: 6 }} />
              <button type="button" onClick={() => setImg('')} style={{ border: '1px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>🗑 外す</button>
            </>
          )}
          {canDelete && (
            <button type="button" onClick={onDelete} style={{ border: '1px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>🗑 スレッドを削除</button>
          )}
          <button type="button" onClick={submit} disabled={posting} style={{ marginLeft: 'auto', border: 'none', borderRadius: 8, padding: '8px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer', background: 'linear-gradient(135deg,#1a4d8f,#1a6a9f)', color: '#fff', opacity: posting ? 0.6 : 1 }}>{posting ? '送信中…' : '返信する'}</button>
        </div>
      </div>
    </div>
  )
}

function SettingsPage() {
  const isMobile = useIsMobile()
  const [token, setToken] = useState('')
  const [data, setData] = useState({ users: [], groups: [], activeGroupCount: 0, hasToken: false, hasSecret: false })
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [usersOpen, setUsersOpen] = useState(false)
  const [unassignedOpen, setUnassignedOpen] = useState(true)
  const [employees, setEmployees] = useState([])
  const [pdfDate, setPdfDate] = useState(() => localToday())
  const [backupBusy, setBackupBusy] = useState(false)
  const fileRef = useRef(null)

  // 全データ（伝票・顧客・従業員）を1ファイル(JSON)でダウンロード
  const downloadBackup = async () => {
    setBackupBusy(true)
    try {
      const data = await api.get('/api/backup')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const d = new Date(); const p = n => String(n).padStart(2, '0')
      a.href = url
      a.download = `tobunamakon-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      const c = data.counts || {}
      alert(`バックアップを保存しました\n伝票 ${c.shipments ?? 0} 件 / 顧客 ${c.customers ?? 0} 件 / 従業員 ${c.employees ?? 0} 件`)
    } catch (e) { alert('バックアップに失敗しました: ' + e.message) }
    finally { setBackupBusy(false) }
  }
  // バックアップファイルから復元（追加・上書き。今あるデータは消えない）
  const onRestoreFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    let data
    try { data = JSON.parse(await file.text()) }
    catch { alert('ファイルを読み込めませんでした（JSON形式のバックアップを選んでください）'); return }
    if (!data || data.type !== 'backup') { alert('これは当システムのバックアップファイルではありません'); return }
    const c = data.counts || {}
    if (!window.confirm(`このバックアップから復元します。\n伝票 ${c.shipments ?? 0} / 顧客 ${c.customers ?? 0} / 従業員 ${c.employees ?? 0} 件\n\n同じデータは上書きされます（今あるデータは消えません）。よろしいですか？`)) return
    setBackupBusy(true)
    try {
      const r = await api.post('/api/backup', data)
      const rr = r.restored || {}
      alert(`復元しました\n伝票 ${rr.shipments ?? 0} / 顧客 ${rr.customers ?? 0} / 従業員 ${rr.employees ?? 0} 件\n\n画面を更新します。`)
      notifyShipmentsChanged()
      window.location.reload()
    } catch (e) { alert('復元に失敗しました: ' + e.message) }
    finally { setBackupBusy(false) }
  }

  // PDF出力：出荷予定表を A4横で別ウィンドウに開き、読み込み後に自動で印刷ダイアログを出す
  const openSchedulePdf = () => {
    const url = `${window.location.pathname}?view=schedule&popup=1&print=1&date=${encodeURIComponent(pdfDate)}`
    const w = window.open(url, '_blank', 'width=1200,height=820,scrollbars=yes,resizable=yes')
    if (!w) { alert('別ウィンドウを開けませんでした。ブラウザのポップアップを許可してください。'); window.open(url, '_blank') }
  }

  const load = useCallback(async () => {
    try { setData(await api.get('/api/line')) } catch (e) { console.error(e) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  // 従業員管理のLINE IDを参照して、登録済みLINEユーザーと突き合わせる
  useEffect(() => { api.get('/api/employees').then(e => setEmployees(Array.isArray(e) ? e : [])).catch(() => {}) }, [])
  const cleanLineId = (v) => String(v || '').replace(/[\s　​-‍﻿]/g, '').trim()
  const empOfUser = (u) => employees.find(e => cleanLineId(e.lineId) && cleanLineId(e.lineId) === cleanLineId(u.userId))
  const allUsers = data.users || []
  const assignedUsers = allUsers.filter(u => empOfUser(u))     // 従業員に紐付け済み
  const unassignedUsers = allUsers.filter(u => !empOfUser(u))  // 未割り当て

  const webhookUrl = `${window.location.origin}/api/line`

  const saveSettings = async () => {
    setSaving(true)
    try {
      await api.put('/api/line', { channelAccessToken: token })
      alert('保存しました')
      setToken(''); load()
    } catch (e) { alert('エラー: ' + e.message) } finally { setSaving(false) }
  }
  const delUser = async (userId) => {
    if (!window.confirm('このLINEユーザーを削除しますか？')) return
    try { await api.del(`/api/line?userId=${encodeURIComponent(userId)}`); load() } catch (e) { alert(e.message) }
  }
  const copy = () => { navigator.clipboard?.writeText(webhookUrl); alert('Webhook URLをコピーしました') }

  const inp = { padding: '9px 11px', border: '1.5px solid #dde3ed', borderRadius: 7, fontSize: 16, width: '100%', boxSizing: 'border-box' }
  const box = { background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: 18, maxWidth: 620, marginBottom: 18 }

  return (
    <div style={RPT.wrap}>
      <h2 style={{ margin: '0 0 16px', color: '#1a2332' }}>⚙️ 設定</h2>

      <div style={box}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>LINE API設定</h3>
        <label style={{ fontSize: 12, color: '#6b7a8d' }}>チャネルアクセストークン {data.hasToken && <span style={{ color: '#1a8f5a' }}>（設定済み）</span>}</label>
        <input style={{ ...inp, marginTop: 4 }} value={token} onChange={e => setToken(e.target.value)} placeholder={data.hasToken ? '変更する場合のみ入力' : 'LINE Messaging API のチャネルアクセストークン'} />
        <button onClick={saveSettings} disabled={saving} style={{ ...S.saveBtn, marginTop: 12, opacity: saving ? 0.7 : 1 }}>{saving ? '保存中...' : '保存'}</button>
      </div>

      <div style={box}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>🖨 出荷予定表 PDF出力（暫定）</h3>
        <div style={{ fontSize: 13, color: '#3a4a5c', marginBottom: 12, lineHeight: 1.7 }}>
          指定日の出荷予定表を A4横・1ページで印刷（PDF保存）します。<br />
          別ウィンドウが開き、自動で印刷ダイアログが表示されます（用紙: A4／向き: 横 を選択してください）。
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" value={pdfDate} onChange={e => setPdfDate(e.target.value)}
            style={{ ...inp, width: 'auto', fontSize: 14, padding: '8px 10px' }} />
          <button onClick={openSchedulePdf}
            style={{ ...S.addBtn, padding: '10px 16px', fontSize: 13 }}>🖨 PDF出力</button>
        </div>
      </div>

      <div style={box}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>💾 データのバックアップ</h3>
        <div style={{ fontSize: 13, color: '#3a4a5c', marginBottom: 12, lineHeight: 1.7 }}>
          伝票・顧客・従業員の全データを1ファイル（JSON）で保存できます。<br />
          定期的にダウンロードして、パソコンやハードディスクに保管してください。
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={downloadBackup} disabled={backupBusy}
            style={{ ...S.addBtn, padding: '10px 16px', fontSize: 13, opacity: backupBusy ? 0.7 : 1 }}>📥 バックアップをダウンロード</button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={backupBusy}
            style={{ ...S.editBtn, padding: '10px 16px', fontSize: 13, opacity: backupBusy ? 0.7 : 1 }}>📤 バックアップから復元</button>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onRestoreFile} />
        </div>
        <div style={{ fontSize: 11, color: '#9aa7b5', marginTop: 8, lineHeight: 1.6 }}>
          ※復元は「追加・上書き」です（同じデータは置き換え、今あるデータは消しません）。<br />
          ※添付PDFはバックアップに含まれません（データ本体のみ）。
        </div>
      </div>

      {/* 拡張機能ダウンロード */}
      <div style={box}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>🧩 IME 自動切替 拡張機能（Windows/Chrome・Edge）</h3>
        <div style={{ fontSize: 13, color: '#3a4a5c', marginBottom: 12, lineHeight: 1.7 }}>
          出荷登録の入力欄で、フィールドに応じて IME モード（かな / 半角英数）のヒントを送るブラウザ拡張機能です。
          <br />初回フォーカス時のみヒントを送ります。ユーザーが手動で IME を切り替えた後は上書きしません。
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <a href="/tobu-ime-ext.zip" download style={{ ...S.addBtn, padding: '10px 16px', fontSize: 13, display: 'inline-block', textDecoration: 'none' }}>📥 拡張機能をダウンロード (ZIP)</a>
        </div>
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 13, fontWeight: 700, color: '#1a4d8f', cursor: 'pointer' }}>▶ インストール手順（Chrome / Edge）</summary>
          <ol style={{ fontSize: 12.5, color: '#3a4a5c', lineHeight: 1.8, marginTop: 8, paddingLeft: 22 }}>
            <li>ダウンロードした ZIP を任意の場所に展開する</li>
            <li>ブラウザのアドレスバーに <code style={{ background: '#f4f6f9', padding: '1px 6px', borderRadius: 3 }}>chrome://extensions</code>（Edge は <code style={{ background: '#f4f6f9', padding: '1px 6px', borderRadius: 3 }}>edge://extensions</code>）と入力</li>
            <li>右上の「デベロッパーモード」を <b>ON</b> にする</li>
            <li>「パッケージ化されていない拡張機能を読み込む」ボタンで、展開したフォルダを選択</li>
            <li>拡張機能一覧に「東部生コン IME 自動切替」が表示されれば完了</li>
          </ol>
        </details>
        <div style={{ fontSize: 11, color: '#9aa7b5', marginTop: 8, lineHeight: 1.6 }}>
          ⚠ 対象: 全角かな = 業者名 / 商社名 / 現場名 / 現場住所 / 車種補足 / 打設箇所 / 荷下ろし / 特記 / 備考<br />
          ⚠ 対象: 半角英数 = 受注日 / 日付 / 時間 / 配合 / 量 / 連絡先 / 現場連絡先<br />
          ※ Web の制約により IME モードを「必ず」切り替えることは保証できません（ベストエフォート）。
        </div>
      </div>

      <div style={box}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Webhook URL</h3>
        <div style={{ fontSize: 13, color: '#3a4a5c', marginBottom: 8 }}>このURLを LINE Developers の Messaging API「Webhook URL」に登録し、Webhookを「オン」にしてください。</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={{ background: '#f4f6f9', border: '1px solid #dde3ed', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}>{webhookUrl}</code>
          <button onClick={copy} style={S.editBtn}>コピー</button>
        </div>
      </div>

      {/* 未割り当て：従業員管理のLINE IDに紐付いていないLINEユーザー（折りたたみ・既定で開く） */}
      <div style={{ ...box, maxWidth: 980 }}>
        <button
          onClick={() => setUnassignedOpen(o => !o)}
          style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 15, fontWeight: 700, color: '#1a2332', textAlign: 'left' }}
        >
          <span style={{ fontSize: 12, color: '#6b7a8d', width: 12, display: 'inline-block' }}>{unassignedOpen ? '▼' : '▶'}</span>
          未割り当て（従業員に紐付いていないLINEユーザー）
          <span style={{ fontSize: 12, fontWeight: 400, color: '#c0392b' }}>{unassignedUsers.length}件</span>
        </button>
        {unassignedOpen && (
          <div style={{ marginTop: 12 }}>
            {loading ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>読み込み中...</div>
              : unassignedUsers.length === 0 ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>未割り当てのLINEユーザーはありません</div>
                : unassignedUsers.map((u) => (
                  <div key={u.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid #eef0f4' }}>
                    <span style={{ fontSize: 13, minWidth: 0 }}><b>{u.name}</b> <span style={{ color: '#6b7a8d', fontSize: 11, wordBreak: 'break-all' }}>{u.userId}</span></span>
                    <span style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                      <button onClick={() => { navigator.clipboard?.writeText(u.userId); alert('LINEユーザーIDをコピーしました。\n従業員管理の「LINE ID」欄に貼り付けると割り当て済みになります。') }}
                        style={{ border: '1.5px solid #1a4d8f', background: '#fff', color: '#1a4d8f', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>📋 IDコピー</button>
                      <button onClick={() => delUser(u.userId)} style={S.delBtn}>削除</button>
                    </span>
                  </div>
                ))}
          </div>
        )}
      </div>

      {/* 登録済みLINEユーザー（従業員管理のLINE IDと紐付け済み・従業員名を並べて表示） */}
      <div style={{ ...box, maxWidth: 980 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: usersOpen ? 12 : 0, gap: 8 }}>
          <button
            onClick={() => setUsersOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 15, fontWeight: 700, color: '#1a2332', textAlign: 'left' }}
          >
            <span style={{ fontSize: 12, color: '#6b7a8d', width: 12, display: 'inline-block' }}>{usersOpen ? '▼' : '▶'}</span>
            登録済みLINEユーザー（友だち追加時に自動登録・従業員に紐付け済み）
            <span style={{ fontSize: 12, fontWeight: 400, color: '#6b7a8d' }}>{assignedUsers.length}件</span>
          </button>
          {usersOpen && <button onClick={load} style={S.editBtn}>🔄 更新</button>}
        </div>
        {usersOpen && (
          <div>
            {loading ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>読み込み中...</div>
              : assignedUsers.length === 0 ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>従業員に紐付いたLINEユーザーはありません（従業員管理でLINE IDを設定してください）</div>
                : assignedUsers.map((u) => {
                  const emp = empOfUser(u)
                  return (
                    <div key={u.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid #eef0f4' }}>
                      <span style={{ fontSize: 13, minWidth: 0 }}>
                        <b style={{ color: '#1a4d8f' }}>👤 {emp?.name}</b>
                        <span style={{ color: '#1a8f5a', fontSize: 12, marginLeft: 6 }}>← LINE: {u.name}</span>
                        <span style={{ display: 'block', color: '#9aa7b5', fontSize: 11, wordBreak: 'break-all', marginTop: 1 }}>{u.userId}</span>
                      </span>
                      <span style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                        <button onClick={() => { navigator.clipboard?.writeText(u.userId); alert('LINEユーザーIDをコピーしました') }}
                          style={{ border: '1.5px solid #1a4d8f', background: '#fff', color: '#1a4d8f', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>📋 IDコピー</button>
                        <button onClick={() => delUser(u.userId)} style={S.delBtn}>削除</button>
                      </span>
                    </div>
                  )
                })}
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// レイアウト
// ============================================================
const TABS = [
  { id: 'dashboard', label: 'ダッシュボード', icon: '📊' },
  { id: 'shipments', label: '出荷登録', icon: '🚛' },
  { id: 'schedule', label: '出荷予定表', icon: '📋' },
  { id: 'weekly', label: '週間出荷予定表', icon: '🗓️' },
  { id: 'seikon', label: '生コン出荷予定表出力', icon: '📝' },
  { id: 'assign', label: '配送割り当て', icon: '🔁' },
  { id: 'cancel', label: 'キャンセル伝票', icon: '🗑️' },
  { id: 'settings', label: '設定', icon: '⚙️' },
  { id: 'customers', label: '顧客管理', icon: '👥' },
  { id: 'employees', label: '従業員管理', icon: '👷' },
  { id: 'debug', label: 'デバッグ依頼', icon: '🐛', pcOnly: true },
]

function Layout({ children, activeTab, onTabChange }) {
  const { user, logout } = useAuth()
  const [open, setOpen]   = useState(false)
  const isMobile = useIsMobile()
  const isPC = !isMobile
  // 生コン出荷予定表出力・デバッグ依頼はPCのみ。タッチ端末(iPhone/iPad)＝横向きで幅が広くても非表示
  const notPC = IS_TOUCH_DEVICE || useIsMobile(1025)
  const navTabs = TABS.filter(t => !(notPC && (t.id === 'seikon' || t.pcOnly)))

  // モバイルでドロワーを開いている間は背面スクロールを止める
  useEffect(() => {
    if (isMobile && open) {
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = '' }
    }
  }, [isMobile, open])

  const closeSidebar = () => setOpen(false)

  const handleTab = (id) => {
    onTabChange(id)
    closeSidebar()
  }

  const sidebarStyle = {
    ...S.sidebar,
    position: 'fixed',
    top: 0, left: 0, bottom: 0,
    zIndex: 999,
    transform: open ? 'translateX(0)' : 'translateX(-100%)',
    transition: 'transform 0.25s ease',
  }

  return (
    <div style={S.appRoot}>
      {/* PC用サイドバー（常時表示） */}
      <aside style={{ ...S.sidebar, position: 'relative', transform: 'none', display: isPC ? 'flex' : 'none' }}>
        <div style={S.sideHead}>
          <div style={{ fontSize: 26 }}>🏗</div>
          <div>
            <div style={S.coName}>東部生コン</div>
            <div style={S.syName}>業務管理システム</div>
          </div>
        </div>
        <nav style={S.nav}>
          {navTabs.map(tab => (
            <button key={tab.id} style={{ ...S.navItem, ...(activeTab === tab.id ? S.navActive : {}) }} onClick={() => onTabChange(tab.id)}>
              <span style={{ fontSize: 15 }}>{tab.icon}</span>{tab.label}
            </button>
          ))}
        </nav>
        <div style={S.sideFoot}>
          <div style={S.userName}>{user?.displayName}</div>
          <div style={S.userRole}>{user?.role ? ROLE_LABELS[user.role] : ''}</div>
          <button style={S.logoutBtn} onClick={logout}>ログアウト</button>
          <div style={S.verTxt}>{APP_VERSION}</div>
        </div>
      </aside>

      {/* モバイル用オーバーレイ */}
      {!isPC && open && <div style={S.overlay2} onClick={closeSidebar} />}

      {/* モバイル用サイドバー（スライド） */}
      {!isPC && (
        <aside style={sidebarStyle}>
          <div style={{ ...S.sideHead, justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 26 }}>🏗</div>
              <div>
                <div style={S.coName}>東部生コン</div>
                <div style={S.syName}>業務管理システム</div>
              </div>
            </div>
            <button style={{ ...S.hamburger, color: '#fff' }} onClick={closeSidebar}>✕</button>
          </div>
          <nav style={S.nav}>
            {navTabs.map(tab => (
              <button key={tab.id} style={{ ...S.navItem, padding: '13px 12px', fontSize: 15, ...(activeTab === tab.id ? S.navActive : {}) }} onClick={() => handleTab(tab.id)}>
                <span style={{ fontSize: 17 }}>{tab.icon}</span>{tab.label}
              </button>
            ))}
          </nav>
          <div style={S.sideFoot}>
            <div style={S.userName}>{user?.displayName}</div>
            <div style={S.userRole}>{user?.role ? ROLE_LABELS[user.role] : ''}</div>
            <button style={S.logoutBtn} onClick={logout}>ログアウト</button>
            <div style={S.verTxt}>{APP_VERSION}</div>
          </div>
        </aside>
      )}

      <main style={{ ...S.main, width: '100%' }}>
        <div style={{ ...S.pageHead, display: 'flex', alignItems: 'center', gap: 8, padding: isMobile ? '10px 12px' : '14px 20px', paddingTop: isMobile ? 'calc(10px + env(safe-area-inset-top))' : 14 }}>
          {!isPC && (
            <button style={S.hamburger} onClick={() => setOpen(true)} aria-label="メニュー">☰</button>
          )}
          <h1 style={{ ...S.pageTitle, fontSize: isMobile ? 16 : 17 }}>{TABS.find(t => t.id === activeTab)?.icon}{' '}{TABS.find(t => t.id === activeTab)?.label}</h1>
        </div>
        <div style={S.content}>{children}</div>
      </main>
    </div>
  )
}

// ============================================================
// アプリ本体
// ============================================================
// 準備中タブのパスワードロック画面。正しいパスワードでアンロックすると本来の画面へ。
const LOCK_PASSWORD = '0383'
function LockedPage({ onUnlock }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState(false)
  const submit = (e) => {
    e.preventDefault()
    if (pw === LOCK_PASSWORD) onUnlock()
    else { setErr(true); setPw('') }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 18, padding: 24 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#3a4a5c' }}>🚧 準備中</div>
      <div style={{ fontSize: 14, color: '#6b7a8d' }}>この機能は準備中です。パスワードを入力してください。</div>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 280 }}>
        <input type="password" inputMode="numeric" value={pw} autoFocus
          onChange={e => { setPw(e.target.value); setErr(false) }}
          placeholder="パスワード"
          style={{ fontSize: 16, padding: '11px 12px', border: `1.5px solid ${err ? '#c0392b' : '#cdd5e0'}`, borderRadius: 8, textAlign: 'center' }} />
        {err && <div style={{ fontSize: 12, color: '#c0392b', textAlign: 'center' }}>パスワードが違います</div>}
        <button type="submit" style={{ border: 'none', background: 'linear-gradient(135deg,#1a4d8f,#1a6a9f)', color: '#fff', borderRadius: 8, padding: '12px', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>解除して開く</button>
      </form>
    </div>
  )
}

function AppInner() {
  const { user, loading } = useAuth()
  const isMobile = useIsMobile()
  // 呼び名レジストリを起動時に読み込む（担当者名を表示するが従業員を取得しないページ向け）
  useEffect(() => { api.get('/api/employees?drivers=1').then(rememberEmployees).catch(() => {}) }, [])
  const notPC = IS_TOUCH_DEVICE || useIsMobile(1025)   // 生コン出荷予定表出力はPCのみ（スマホ・iPadは案内表示）
  const params = (typeof window !== 'undefined') ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const initialEditId = params.get('editShipment') || ''
  const view = params.get('view') || ''
  const isPopup = params.get('popup') === '1'
  // 別ウィンドウ（ログイン不要）：出荷予定表(掲示板)・配送臨時割り当て・担当者振替
  const isBoard = isPopup && (view === 'schedule' || view === 'assign' || view === 'assigndriver') && !initialEditId
  const [activeTab, setActiveTab] = useState(initialEditId ? 'shipments' : (view === 'schedule' ? 'schedule' : view === 'seikon' ? 'seikon' : view === 'assign' ? 'assign' : 'dashboard'))
  const [editTarget, setEditTarget] = useState(null)
  const [pendingEditId, setPendingEditId] = useState(initialEditId)
  // 準備中（パスワード保護）タブ。セッション中はアンロック状態を保持
  const LOCKED_TABS = ['shipreport', 'driverreport']
  const [unlocked, setUnlocked] = useState({})

  // 別ウィンドウの自動更新は SchedulePage 内で差分更新（再取得して変更分のみ反映）する。
  // 全画面 reload は入力内容やスクロール位置が失われるため行わない。

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', background: '#f4f6f9' }}>
      <div style={{ color: '#6b7a8d', fontSize: 15 }}>読み込み中...</div>
    </div>
  )

  if (!user && !isBoard) return <LoginPage />

  // PC用：担当者振替の別ウィンドウ（?view=assigndriver&id=...&popup=1）
  if (isPopup && view === 'assigndriver') {
    return <div className="popup-print-root" style={{ height: '100dvh', overflow: 'auto', background: '#fff', boxSizing: 'border-box', paddingTop: 'env(safe-area-inset-top)' }}><DriverAssignPopupPage id={params.get('id') || ''} /></div>
  }

  let page = activeTab === 'dashboard' ? <DashboardPage />
    : activeTab === 'customers' ? <CustomersPage />
    : activeTab === 'employees' ? <EmployeesPage />
    : activeTab === 'shipments' ? <ShipmentsPage editTarget={editTarget} onEditConsumed={() => setEditTarget(null)} pendingEditId={pendingEditId} onPendingConsumed={() => setPendingEditId('')} isPopup={isPopup} />
    : activeTab === 'schedule' ? <SchedulePage isPopup={isPopup} onEditShipment={(s) => { setEditTarget(s); setActiveTab('shipments') }} />
    : activeTab === 'weekly' ? <WeeklySchedulePage />
    : activeTab === 'seikon' ? (notPC && !isPopup
      ? <div style={{ padding: 24, color: '#6b7a8d' }}>生コン出荷予定表出力はパソコンからご利用ください。</div>
      : <SeikonOutputPage isPopup={isPopup} />)
    : activeTab === 'assign' ? <AssignPage isPopup={isPopup} />
    : activeTab === 'cancel' ? <CancelPage onRestoreEdit={(id) => { setPendingEditId(id); setActiveTab('shipments') }} />
    : activeTab === 'shipreport' ? <ShipReportPage />
    : activeTab === 'driverreport' ? <DriverReportPage />
    : activeTab === 'settings' ? <SettingsPage />
    : activeTab === 'debug' ? (notPC
      ? <div style={{ padding: 24, color: '#6b7a8d' }}>デバッグ依頼はパソコンからご利用ください。</div>
      : <DebugPage />)
    : null
  // 準備中タブは未アンロックならパスワード画面を表示
  if (LOCKED_TABS.includes(activeTab) && !unlocked[activeTab]) {
    page = <LockedPage onUnlock={() => setUnlocked(u => ({ ...u, [activeTab]: true }))} />
  }

  // 別ウィンドウ（ポップアップ）はサイドバー無しでその画面だけ表示
  if (isPopup) return <div className="popup-print-root" style={{ height: '100dvh', overflow: 'auto', background: '#fff', boxSizing: 'border-box', paddingTop: 'env(safe-area-inset-top)' }}>{page}</div>

  return <Layout activeTab={activeTab} onTabChange={setActiveTab}>{page}</Layout>
}

export default function App() {
  return <AuthProvider><AppInner /></AuthProvider>
}
