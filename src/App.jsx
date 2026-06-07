import { useState, useEffect, useLayoutEffect, useCallback, createContext, useContext, useRef, Fragment } from 'react'

// ============================================================
// 定数
// ============================================================
const APP_VERSION = 'v0.1.2'
const ROLE_LABELS    = { admin: '管理者', manager: 'マネージャー', staff: 'スタッフ' }
const EMP_TYPE_LABELS = { office: '事務所', driver: 'ドライバー', admin: '管理者' }
const EMP_TYPES       = ['office', 'driver', 'admin']

// ============================================================
// APIクライアント
// ============================================================
const getToken = () => localStorage.getItem('token') || ''

async function request(path, options = {}) {
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

const api = {
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }),
  get:  (path)       => request(path),
  put:  (path, body) => request(path, { method: 'PUT',  body: JSON.stringify(body) }),
  del:  (path)       => request(path, { method: 'DELETE' }),
}

// 出荷データの変更を他タブ/他ウィンドウに通知する（localStorage の storage イベント経由）。
// 別ウィンドウで編集→更新したとき、開いている出荷予定表タブを自動で再取得させる。
const SHIPMENTS_PING_KEY = 'shipments_updated_at'
function notifyShipmentsChanged() {
  try { localStorage.setItem(SHIPMENTS_PING_KEY, String(Date.now())) } catch {}
}
// 変更通知を購読する。コールバックは別タブでの更新時に呼ばれる。
function useShipmentsChanged(onChange) {
  useEffect(() => {
    const h = (e) => { if (e.key === SHIPMENTS_PING_KEY) onChange() }
    window.addEventListener('storage', h)
    return () => window.removeEventListener('storage', h)
  }, [onChange])
}

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
const emptyEmpForm = { employeeId: '', name: '', lineId: '', type: 'office' }

function EmployeeModal({ employee, onSave, onClose }) {
  const isMobile = useIsMobile()
  const [form, setForm]       = useState(emptyEmpForm)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setForm(employee ? {
      employeeId: employee.employeeId || '',
      name:       employee.name       || '',
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
      setEmployees(es => sortEmp(es.map(e => e.id === updated.id ? updated : e)))
    } else if (editing && !editing.id) {
      throw new Error('IDが取得できません。一度ページを更新してください')
    } else {
      const created = await api.post('/api/employees', data)
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
  const toHira = (str) => String(str || '').toLowerCase().replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
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
const NOTE_MESSAGES = ['出荷前TEL', '出る時TEL', 'FAX', '住所TEL有']   // 備考に追加できる定型メッセージ
// 備考(notes)の並び順：手入力(manual)→荷下ろし(unload)→メッセージ追加(msg)。出力もこの順になる
const NOTE_KIND_RANK = { unload: 1, msg: 2 }
const noteRank = (n) => NOTE_KIND_RANK[n && n.kind] ?? 0
const sortNotes = (arr) => (Array.isArray(arr) ? arr : [])
  .map((n, i) => [n, i])
  .sort((a, b) => (noteRank(a[0]) - noteRank(b[0])) || (a[1] - b[1]))
  .map(x => x[0])
// カタカナ→ひらがなに正規化（ひらがな検索でカナ欄にヒットさせる）
const kanaToHira = (str) => String(str || '').toLowerCase().replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
const DEFAULT_SITE_ADDRESS = '〒842-0121 佐賀県神埼市神埼町志波屋２０２０'
// 全角数字→半角数字（出荷登録の入力用）。数字以外はそのまま
const z2h = (str) => String(str ?? '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))

// 数量表示（m³・+a・? と2段目の量をまとめる）
function shipVolStr(s) {
  const one = (v, a, u) => { const b = (v == null ? '' : String(v)).trim(); return (!b && !a && !u) ? '' : `${b}${b ? 'm³' : ''}${a ? '+a' : ''}${u ? '?' : ''}` }
  return [one(s.volume, s.volumePlusA, s.volumeUncertain), one(s.volume2, s.volumePlusA2, s.volumeUncertain2)].filter(Boolean).join(' / ')
}

// 車種表示: vehicleItems があれば車種名を「・」連結、無ければ vehicleType をそのまま（台数は表記しない）
function vehicleLabel(s) {
  if (Array.isArray(s.vehicleItems) && s.vehicleItems.length) {
    return s.vehicleItems.map(v => v.type).join('・')
  }
  return s.vehicleType || ''
}
// 配合表示: mixRows があれば各行を配列で（{code,note}）、無ければ mixCode/mixNotes 1行
// 配合は3枠の位置を保持（例: 中央のみ→「-20-」、先頭のみ→「20--」）。数字が無い時は空。
function mixCodeOf(parts) {
  const c = (parts || []).slice(0, 3).join('-')
  return /[0-9]/.test(c) ? c : ''
}
function mixRowsOfShip(s) {
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
  mixCode: '',
  specialNote: '',
  mixNotes: ['', '', ''],
  mixRows: [{ parts: ['', '', ''], note: '' }],   // 配合の複数行。1行目を mixCode/mixNotes に同期
  cementType: '',
  volume: '',
  volumeUncertain: false,
  volumePlusA: false,        // 量に「+a」を付ける
  hasVolume2: false,         // 2段目の量を使うか（UI用）
  volume2: '',
  volumeUncertain2: false,
  volumePlusA2: false,
  pdfName: '',               // 添付PDFのファイル名
  pdfData: '',               // 添付PDFの本体(dataURL)。保存時のみ送信、未変更は空
  hasPdf: false,             // 既存伝票にPDFが添付済みか
  pdfRemove: false,          // 既存PDFを削除する指示（保存時に反映）
  placements: [],
  pourLocation: '',
  pourFree: false,      // 打設箇所を自由入力モードにしているか
  noteTags: [],         // 領 / 追 の選択
  testTags: [],         // 試験（現TP / 工TP）
  orderContact: '', siteContact: '',
  drivers: [],
  notes: [{ text: '', important: false }],
  driverMessages: [{ text: '', important: false }],
  mapView: null,        // 固定した地図の {lat,lng,zoom}（null=未固定）
  mapArrows: [],         // 矢印 [{x1,y1,x2,y2}]（相対座標0-1）
}

// テキストをマス内に収めるよう自動縮小
function fitText(ta) {
  if (!ta) return
  const max = 22, min = 7
  let size = max
  ta.style.fontSize = size + 'px'
  let guard = 0
  while (size > min && ta.scrollHeight > ta.clientHeight && guard < 40) {
    size--; ta.style.fontSize = size + 'px'; guard++
  }
}

// 横幅に収まるよう文字サイズを自動縮小する input（現場名・現場住所など）。
// プレースホルダ（透かし）も実テキストと同じく縮小される（同じ要素の font-size を縮めるため）。
function FitField({ value, onChange, placeholder, className = 'f', baseSize = 15, min = 9, type = 'text', style }) {
  const ref = useRef(null)
  const fit = () => {
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
    <input ref={ref} className={className} type={type} value={value}
      onChange={e => { onChange(e); requestAnimationFrame(fit) }}
      placeholder={placeholder} style={style} />
  )
}

// カナ（ひらがな/カタカナ）でも絞り込めるオートコンプリート入力（業者名・商社名用）
// 顧客管理の検索と同じ「インライン描画」方式で確実に表示する（ポータル/座標計算は使わない）
function KanaCombo({ value, onChange, onPick, options, placeholder, className = 'f', style, required }) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)   // ▼で開いたら全件、入力中は絞り込み
  const wrapRef = useRef(null)
  const q = kanaToHira(value)
  const filtered = ((value && !showAll) ? options.filter(o => kanaToHira(o.label).includes(q) || kanaToHira(o.kana).includes(q)) : options).slice(0, 200)
  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setShowAll(false) } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('touchstart', onDoc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('touchstart', onDoc) }
  }, [])
  const pick = (o) => { onPick(o); setOpen(false); setShowAll(false) }
  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, minWidth: 0, width: '100%', display: 'flex', alignItems: 'stretch' }}>
      <input className={className} style={style} value={value} placeholder={placeholder} required={required}
        onChange={e => { onChange(e); setShowAll(false); setOpen(true) }}
        onFocus={() => setOpen(true)} />
      <button type="button" tabIndex={-1} title="一覧から選択"
        onMouseDown={(e) => { e.preventDefault(); setShowAll(true); setOpen(o => !o) }}
        style={{ flex: '0 0 auto', border: 'none', background: 'transparent', cursor: 'pointer', color: '#1a4d8f', fontSize: 16, padding: '0 6px', alignSelf: 'center' }}>▼</button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999, background: '#fff', border: '1px solid #cdd5e0', borderRadius: 6, boxShadow: '0 6px 18px rgba(0,0,0,.18)', maxHeight: 260, overflowY: 'auto' }}>
          {filtered.length > 0 ? filtered.map((o, i) => (
            <div key={(o.id || o.label) + '_' + i} onClick={() => pick(o)}
              style={{ padding: '9px 10px', fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#111', borderBottom: '1px solid #f2f4f8' }}>
              {o.label}{o.kana ? <span style={{ color: '#9aa7b5', fontSize: 11, marginLeft: 6 }}>{o.kana}</span> : null}
            </div>
          )) : (
            <div style={{ padding: '9px 10px', fontSize: 12, color: '#9aa7b5', lineHeight: 1.5 }}>該当なし（顧客管理で会社名カナを登録してください）</div>
          )}
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
function DenpyoGrid({ items, onChange, cols = 2, max = Infinity, height = 90, addLabel }) {
  const refs = useRef([])
  const composingRef = useRef(false)   // IME変換中フラグ
  const refit = () => requestAnimationFrame(() => {
    if (composingRef.current) return   // 変換中はフォント自動調整を行わない（変換が壊れるため）
    for (let i = 0; i < items.length; i++) fitText(refs.current[i])
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
            <textarea
              ref={el => { refs.current[i] = el }}
              className={it.important ? 'is-imp' : ''}
              value={it.text}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={e => { composingRef.current = false; update(i, { text: e.target.value }); requestAnimationFrame(() => fitText(refs.current[i])) }}
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

function SiteMap({ address, onAddressChange, mapView, onMapViewChange, arrows, onArrowsChange, actions }) {
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
      setStatus('')
      return
    }
    g.geocode({ address: addr }, (res, st) => {
      if (st === 'OK' && res[0]) {
        const loc = res[0].geometry.location
        mapRef.current.setCenter(loc)
        mapRef.current.setZoom(DEFAULT_MAP_ZOOM)
        markerRef.current.setPosition(loc)
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
      const start = hasView ? { lat: mapView.lat, lng: mapView.lng } : { lat: 35.681236, lng: 139.767125 }
      const map = new maps.Map(mapEl.current, {
        center: start, zoom: hasView ? mapView.zoom : DEFAULT_MAP_ZOOM, streetViewControl: false, mapTypeControl: false, fullscreenControl: false,
        gestureHandling: 'cooperative',
      })
      mapRef.current = map
      markerRef.current = new maps.Marker({ map, position: start, draggable: true })
      markerRef.current.addListener('dragend', () => {
        const pos = markerRef.current.getPosition()
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
      if (!hasView) {
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
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [editing, setEditing]       = useState(null)
  const [editChanged, setEditChanged] = useState([])
  const [page, setPage]             = useState(0)
  const [mapKey, setMapKey]         = useState(0)   // 別伝票を開いた/リセット時にSiteMapを再マウント（描画モード解除＋新住所で再描画）
  const topRef = useRef(null)
  const formRef = useRef(null)   // Enter/桁送りでの次項目フォーカス移動に使う
  const PAGE_SIZE = 10
  // 本日〜2週間先まで（日曜を除く）の日付配列。一覧の日付ボタン用
  const weekDates = (() => {
    const base = new Date()
    const out = []
    for (let i = 0; i <= 14; i++) {
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
    return { ...f, testTags: cur.includes(tag) ? cur.filter(t => t !== tag) : [...cur, tag] }
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

  const toForm = (s) => ({
    date: s.date || localToday(),
    orderDate: s.orderDate || (s.createdAt ? String(s.createdAt).slice(0, 10) : (s.date || localToday())),
    companyId: s.companyId || '',
    companyName: s.companyName || '',
    tradingCompany: s.tradingCompany || '',
    times: (Array.isArray(s.times) && s.times.length ? s.times : ['']).map(t => ({ text: String(t ?? ''), important: false })),
    siteName: s.siteName || '',
    siteAddress: (s.siteAddress || '').replace(/（緯度経度:[^）]*）/g, '').trim(),
    vehicleType: s.vehicleType || '',
    truckCount: (s.truckCount ?? '') === '' ? '' : String(s.truckCount),
    vehicleItems: (Array.isArray(s.vehicleItems) && s.vehicleItems.length)
      ? s.vehicleItems.map(v => ({ type: v.type, qty: (v.qty ?? '') === '' ? '' : String(v.qty) }))
      : String(s.vehicleType || '').split('・').map(x => x.trim()).filter(Boolean).map(t => ({ type: t, qty: '' })),
    mixCode: s.mixCode || '',
    specialNote: s.specialNote || '',
    mixNotes: (Array.isArray(s.mixNotes) && s.mixNotes.length) ? [s.mixNotes[0] || '', s.mixNotes[1] || '', s.mixNotes[2] || ''] : [s.specialNote || '', '', ''],
    mixRows: (Array.isArray(s.mixRows) && s.mixRows.length)
      ? s.mixRows.map(r => ({ parts: [r.parts?.[0] || '', r.parts?.[1] || '', r.parts?.[2] || ''], note: r.note || '' }))
      : [{ parts: [String(s.mixCode || '').split('-')[0] || '', String(s.mixCode || '').split('-')[1] || '', String(s.mixCode || '').split('-')[2] || ''], note: (Array.isArray(s.mixNotes) ? s.mixNotes[1] : '') || '' }],
    cementType: s.cementType || '',
    volume: (s.volume ?? '') === '' ? '' : String(s.volume),
    volumeUncertain: !!s.volumeUncertain,
    volumePlusA: !!s.volumePlusA,
    volume2: (s.volume2 ?? '') === '' ? '' : String(s.volume2),
    volumeUncertain2: !!s.volumeUncertain2,
    volumePlusA2: !!s.volumePlusA2,
    hasVolume2: !!(s.volume2 || s.volumeUncertain2 || s.volumePlusA2),
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
    orderContact: s.orderContact || '',
    siteContact: s.siteContact || '',
    drivers: Array.isArray(s.drivers) ? s.drivers : (s.driverName ? [{ id: s.driverId || '', name: s.driverName }] : []),
    notes: sortNotes((Array.isArray(s.notes) && s.notes.length ? s.notes : [{ text: '', important: false }]).map(n => ({ text: String(n.text ?? ''), important: !!n.important, kind: n.kind || '' }))),
    driverMessages: (Array.isArray(s.driverMessages) && s.driverMessages.length ? s.driverMessages : [{ text: '', important: false }]).map(n => ({ text: String(n.text ?? ''), important: !!n.important })),
    mapView: s.mapView || null,
    mapArrows: Array.isArray(s.mapArrows) ? s.mapArrows : [],
  })

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
  const buildPayload = () => {
    const payload = {
      ...form,
      times: form.times.map(t => z2h(t.text).replace(/：/g, ':')).filter(t => t.trim() !== ''),
      notes: form.notes.filter(n => n.text.trim() !== ''),
      driverMessages: form.driverMessages.filter(n => n.text.trim() !== ''),
    }
    // PDF: 削除指示なら空を送って消す／新規選択時はその本体を送る／いずれでもなければ既存維持のためキーを外す
    if (form.pdfRemove) payload.pdfData = ''
    else if (!form.pdfData) delete payload.pdfData
    return payload
  }

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

  const handleSubmit = async (e) => {
    e.preventDefault()
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
  const toHira = (str) => String(str || '').toLowerCase().replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
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
  const filtered = shipments.filter(s => {
    if (dateFilter && s.date !== dateFilter) return false
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
  useEffect(() => { setPage(0) }, [search, dateFilter])

  // 予定表で変更された項目を赤く表示
  const redIf = (f) => editChanged.includes(f) ? { color: '#c81e1e' } : undefined

  return (
    <div ref={topRef} style={{ height: '100%', overflow: 'auto' }}>
      {/* 手配伝票フォーム */}
      <div className="denpyo" style={{ padding: isMobile ? '12px 8px' : '16px 12px', background: '#f3f1ec', borderBottom: '2px solid #dde3ed' }}>
        <form onSubmit={handleSubmit} ref={formRef} onKeyDown={onFormKeyDown}>
          <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', flexWrap: 'nowrap', gap: stacked ? 12 : 20, alignItems: 'stretch', justifyContent: 'center', maxWidth: '100%', minWidth: 0 }}>
          <FitToWidth width={700} max={stacked ? 1 : 1} style={{ flex: stacked ? '0 0 auto' : '0 1 700px', minWidth: 0 }}>
          <div className="sheet" style={{ margin: 0 }}>
            {/* 1段: 受注日(作成日・変更不可) / 日付 / 業者名 / 商社名 */}
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
                <DenpyoGrid items={form.times} onChange={v => setVal('times', v)} cols={1} max={2} height={48} addLabel="＋ 時間を追加" />
              </div>
              <div className="cell stack" style={{ flex: 1, padding: 0 }}>
                <div className="subrow">
                  <div className="cell" style={{ flex: 1 }}>
                    <div className="lbl" style={redIf('siteName')}>現 場 名</div>
                    <FitField value={form.siteName} onChange={set('siteName')} style={redIf('siteName')} />
                  </div>
                </div>
                <div className="subrow">
                  <div className="cell" style={{ flex: 1 }}>
                    <div className="lbl">現 場 住 所</div>
                    <FitField value={form.siteAddress} onChange={set('siteAddress')} placeholder={DEFAULT_SITE_ADDRESS} />
                  </div>
                </div>
              </div>
            </div>

            {/* 3段: 車種 / 打設箇所 / セメント種 / 試験 / 特記 / PDFインポート（小項目をまとめてコンパクトに） */}
            <div className="band">
              {/* 車種：縦並び・各チップを大型幅に揃え、台数入力欄の開始位置を統一 */}
              <div className="cell" style={{ flex: '0 0 16%', minWidth: 0 }}>
                <div className="lbl" style={redIf('vehicleType')}>車 種</div>
                <div className="btn-mid"><div className="veh-chips">
                  {VEHICLE_TYPES.map(o => {
                    const it = vehItems().find(v => v.type === o)
                    const on = !!it
                    return (
                      <span key={o} className="vehpill">
                        <span className={'chip' + (on ? ' on' : '')} onClick={() => toggleVehItem(o)}>{o}</span>
                        {on && (
                          <><input className="vehqty" inputMode="numeric" placeholder="台" value={it.qty || ''} onChange={e => setVehQty(o, e.target.value, e.nativeEvent?.isComposing)} /><span className="vehu">台</span></>
                        )}
                      </span>
                    )
                  })}
                </div></div>
              </div>
              {/* 打設箇所：プルダウン or 自由入力 */}
              <div className="cell" style={{ flex: '0 0 19%', minWidth: 0 }}>
                <div className="lbl sm" style={redIf('pourLocation')}>打 設 箇 所</div>
                <div className="btn-mid">
                  {!form.pourFree ? (
                    <select className="f pour-sel" style={{ ...redIf('pourLocation'), fontSize: 18, textAlign: 'center', textAlignLast: 'center' }} value={form.pourLocation}
                      onChange={e => {
                        if (e.target.value === '入力する') setForm(f => ({ ...f, pourFree: true, pourLocation: '' }))
                        else setVal('pourLocation', e.target.value)
                      }}>
                      <option value=""></option>
                      {POUR_LOCATIONS.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <div style={{ position: 'relative' }}>
                      <FitField value={form.pourLocation} onChange={set('pourLocation')} baseSize={13} placeholder="入力" className="f pour-input"
                        style={{ ...redIf('pourLocation'), fontSize: 13, textAlign: 'center', border: '1.5px solid #1b4ea8', borderRadius: 6, background: '#f2f7ff', padding: '5px 42px 5px 6px', boxSizing: 'border-box' }} />
                      <button type="button" onClick={() => setForm(f => ({ ...f, pourFree: false, pourLocation: '' }))}
                        style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', border: '1px solid #bbb', background: '#fff', borderRadius: 4, fontSize: 11, padding: '1px 5px', cursor: 'pointer' }}>一覧</button>
                    </div>
                  )}
                </div>
              </div>
              {/* セメント種（中央揃え） */}
              <div className="cell" style={{ flex: '0 0 14%', minWidth: 0 }}>
                <div className="lbl sm" style={{ textAlign: 'center' }}>セメント種</div>
                <div className="btn-mid"><div className="chips big" style={{ flexDirection: 'column', alignItems: 'center' }}>
                  {CEMENT_TYPES.map(o => (
                    <span key={o} className={'chip' + (form.cementType === o ? ' on' : '')} onClick={() => setVal('cementType', form.cementType === o ? '' : o)}>{o}</span>
                  ))}
                </div></div>
              </div>
              {/* 試験（中央揃え） */}
              <div className="cell" style={{ flex: '0 0 14%', minWidth: 0 }}>
                <div className="lbl sm" style={{ textAlign: 'center' }}>試験</div>
                <div className="btn-mid"><div className="chips big" style={{ flexDirection: 'column', alignItems: 'center' }}>
                  {TEST_TAGS.map(t => (
                    <span key={t} className={'chip' + ((form.testTags || []).includes(t) ? ' on' : '')} onClick={() => toggleTestTag(t)}>{t}</span>
                  ))}
                </div></div>
              </div>
              {/* 特記（中央揃え） */}
              <div className="cell" style={{ flex: '0 0 14%', minWidth: 0 }}>
                <div className="lbl sm" style={{ textAlign: 'center' }}>特記</div>
                <div className="btn-mid"><div className="chips big" style={{ flexDirection: 'column', alignItems: 'center' }}>
                  {NOTE_TAGS.map(t => (
                    <span key={t} className={'chip' + ((form.noteTags || []).includes(t) ? ' on' : '')} onClick={() => toggleNoteTag(t)}>{t}</span>
                  ))}
                </div></div>
              </div>
              {/* PDFインポート（アイコンのみ・中央寄せ。保存時に開いている伝票へ添付） */}
              <div className="cell" style={{ flex: 1, minWidth: 0 }}>
                <div className="lbl sm" style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>PDFインポート</div>
                <div className="btn-mid" style={{ alignItems: 'center', gap: 4 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #999', background: '#fafafa', borderRadius: 6, padding: '7px 16px', fontSize: 20, cursor: 'pointer', color: '#333' }}>📄
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

            {/* 4段: 配合 / 量・荷下ろし */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 42%', minWidth: 0 }}>
                <div className="lbl" style={redIf('mixCode')}>配 合</div>
                <div className="btn-mid">
                {(() => {
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
                              <input className="hg" inputMode="numeric" maxLength={2} value={r.parts[0] || ''} onChange={onHg(ri, 0)} onCompositionEnd={e => setMixCell(ri, 0, e.target.value, false)} />
                            </div>
                            <span className="hgsep">-</span>
                            <div className="hgcol">
                              <input className="hgnote" placeholder="特記" value={r.note || ''} onChange={e => setMixRowNote(ri, e.target.value)} />
                              <input className="hg" inputMode="numeric" maxLength={2} value={r.parts[1] || ''} onChange={onHg(ri, 1)} onCompositionEnd={e => setMixCell(ri, 1, e.target.value, false)} />
                            </div>
                            <span className="hgsep">-</span>
                            <div className="hgcol">
                              <div className="hgnote-spacer" />
                              <input className="hg" inputMode="numeric" maxLength={2} value={r.parts[2] || ''} onChange={onHg(ri, 2)} onCompositionEnd={e => setMixCell(ri, 2, e.target.value, false)} />
                            </div>
                          </div>
                          {ri > 0 && (
                            <button type="button" onClick={() => delMixRow(ri)} title="行を削除"
                              style={{ position: 'absolute', right: 4, bottom: 4, border: '1px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 4, fontSize: 12, lineHeight: 1, padding: '1px 5px', cursor: 'pointer' }}>×</button>
                          )}
                        </div>
                      ))}
                    </div>
                    {/* 「配合を追加」はmixwrapの外に出して固定高で見切れないように */}
                    {rows.length < 2 && (
                      <button type="button" className="addrow" style={{ marginTop: 4, fontSize: 11, padding: '2px 8px', alignSelf: 'center' }} onClick={addMixRow}>＋ 配合を追加</button>
                    )}
                    </>
                  )
                })()}
                </div>
              </div>
              <div className="cell stack" style={{ flex: 1, padding: 0 }}>
                <div className="subrow" style={{ flex: '0 0 auto' }}>
                  <div className="cell m3" style={{ flex: 1, minWidth: 0, flexDirection: 'column', justifyContent: 'center', padding: '8px 6px' }}>
                    {/* 量（1段目／2段目）。各段に「?」「+a」ボタン */}
                    {[0, 1].map(idx => {
                      if (idx === 1 && !form.hasVolume2) return null
                      const vKey = idx === 0 ? 'volume' : 'volume2'
                      const uKey = idx === 0 ? 'volumeUncertain' : 'volumeUncertain2'
                      const aKey = idx === 0 ? 'volumePlusA' : 'volumePlusA2'
                      return (
                        <div className="inline" key={idx} style={{ justifyContent: 'center', alignItems: 'center', marginTop: idx ? 4 : 0 }}>
                          <span style={{ flex: '0 0 22px', display: 'flex', justifyContent: 'center' }}>
                            {idx === 1 ? (
                              <span className="qlabel" style={{ margin: 0, padding: '1px 5px' }} title="2段目を削除"
                                onClick={() => setForm(f => ({ ...f, hasVolume2: false, volume2: '', volumeUncertain2: false, volumePlusA2: false }))}>×</span>
                            ) : null}
                          </span>
                          <input type="text" inputMode="decimal" style={redIf('volume')} value={form[vKey]}
                            onChange={e => { const v = e.target.value; setVal(vKey, e.nativeEvent?.isComposing ? v : z2h(v).replace(/．/g, '.').replace(/[^0-9.]/g, '')) }}
                            onCompositionEnd={e => setVal(vKey, z2h(e.target.value).replace(/．/g, '.').replace(/[^0-9.]/g, ''))} />
                          <span className="unit" style={redIf('volume')}>m<sup>3</sup>
                            {form[aKey] ? <span style={{ marginLeft: 4, fontWeight: 700, color: '#c81e1e' }}>+a</span> : null}
                            <span className={'qmark' + (form[uKey] ? ' on' : '')}>?</span>
                          </span>
                          <span className={'qlabel' + (form[uKey] ? ' on' : '')} onClick={() => setVal(uKey, !form[uKey])}>?</span>
                          <span className={'qlabel' + (form[aKey] ? ' on' : '')} onClick={() => setVal(aKey, !form[aKey])}>+a</span>
                        </div>
                      )
                    })}
                    {!form.hasVolume2 && (
                      <button type="button" className="addrow" style={{ marginTop: 4, fontSize: 11, padding: '2px 8px', alignSelf: 'center' }}
                        onClick={() => setForm(f => ({ ...f, hasVolume2: true }))}>＋ 量を追加</button>
                    )}
                  </div>
                </div>
                <div className="subrow" style={{ flex: 1 }}>
                  <div className="cell" style={{ flex: 1, minWidth: 0 }}>
                    <div className="lbl">荷下ろし</div>
                    <div className="btn-mid">
                      <Chips options={PLACEMENT_TYPES} value={form.placements} multi onChange={v => setVal('placements', v)} big />
                      {/* 荷下ろし自由入力は1つだけ。内容は備考に出力される */}
                      <input className="unload-input" value={unloadText()} onChange={e => setUnload(e.target.value)} placeholder="自由入力（備考に出力）" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 5段: 連絡先 / 現場連絡先（ラベル左・入力右） */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 50%', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <div className="lbl" style={{ marginBottom: 0, fontSize: 11, letterSpacing: '.08em' }}>連 絡 先</div>
                <input className="f" type="text" value={form.orderContact} onChange={set('orderContact')} />
              </div>
              <div className="cell" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <div className="lbl" style={{ marginBottom: 0, fontSize: 11, letterSpacing: '.08em', ...redIf('siteContact') }}>現 場 連 絡 先</div>
                <input className="f" style={redIf('siteContact')} type="text" value={form.siteContact} onChange={set('siteContact')} />
              </div>
            </div>

            {/* 6段: 備考（段落は下に追加）＋ メッセージ追加ボタン */}
            <div className="band">
              <div className="cell" style={{ flex: 1, minWidth: 0 }}>
                <div className="lbl" style={redIf('notes')}>備 考</div>
                {/* 備考の並び順：手入力→荷下ろし→メッセージ追加（sortNotesで常に整列） */}
                <DenpyoGrid items={form.notes} onChange={v => setVal('notes', sortNotes(v))} cols={1} max={6} height={90} addLabel="＋ 段落を追加" />
              </div>
              <div className="cell" style={{ flex: '0 0 auto', minWidth: 130 }}>
                <div className="lbl" style={{ fontSize: 11, letterSpacing: '.06em' }}>メッセージ追加</div>
                {(() => {
                  // 既に備考に追加済みのメッセージは判定（msg段落のスペース区切り）。使用済みはグレーで押せない
                  const msgNote = (form.notes || []).find(n => n && n.kind === 'msg')
                  const used = msgNote ? String(msgNote.text || '').split(/\s+/).filter(Boolean) : []
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
                      {NOTE_MESSAGES.map(m => {
                        const isUsed = used.includes(m)
                        return (
                          <button key={m} type="button" disabled={isUsed} onClick={() => addNoteMessage(m)}
                            style={{
                              border: isUsed ? '1.5px solid #cdd5e0' : '1.5px solid #1b4ea8',
                              background: isUsed ? '#eef0f4' : '#eef4ff',
                              color: isUsed ? '#9aa7b5' : '#1b4ea8',
                              borderRadius: 6, padding: '7px 10px', fontSize: 13, fontWeight: 700,
                              cursor: isUsed ? 'default' : 'pointer', whiteSpace: 'nowrap',
                            }}>＋ {m}</button>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
            </div>

            {/* 担当ドライバー（備考の下・横幅いっぱい・上限なし） */}
            <div className="band">
              <div className="cell" style={{ flex: 1, minWidth: 0 }}>
                <div className="lbl" style={{ ...redIf('drivers'), fontSize: 11, letterSpacing: '.06em' }}>担当ドライバー</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginTop: 3 }}>
                  {form.drivers.map((d, i) => (
                    <span key={d.id || i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid #1b4ea8', background: '#e8f0ff', color: '#1b4ea8', borderRadius: 5, padding: '2px 6px', fontSize: 13 }}>
                      {d.name}
                      <button type="button" onClick={() => removeDriver(i)} style={{ border: 'none', background: 'none', color: '#1b4ea8', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                    </span>
                  ))}
                  <select className="f" value="" onChange={addDriver} style={{ width: 'auto', minWidth: 150, border: '1px solid #cdd5e0', borderRadius: 5, padding: '3px 6px' }}>
                    <option value="">＋ ドライバーを追加</option>
                    {employees.filter(e => !form.drivers.some(d => (d.id && d.id === e.id) || d.name === e.name)).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              </div>
            </div>
          </div>
          </FitToWidth>
          <div style={{ flex: stacked ? '0 0 auto' : '1 1 480px', width: stacked ? '100%' : undefined, minWidth: 0, maxWidth: stacked ? undefined : 640 }}>
            <SiteMap
              key={mapKey}
              address={form.siteAddress}
              onAddressChange={(a) => setVal('siteAddress', a)}
              mapView={form.mapView}
              onMapViewChange={(v) => setVal('mapView', v)}
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
            {/* 矢印/戻す/消去・リセット/登録 の下の段左：コピーして複製 */}
            <div style={{ marginTop: 10, display: 'flex' }}>
              <button type="button" onClick={handleDuplicate}
                style={{ border: '1.5px solid #1a8f5a', background: '#f0f9f0', color: '#1a8f5a', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>📋 コピーして複製</button>
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
                  {['日付', 'PDF', '時間', '業者名', '商社名', '現場名', 'ドライバー', '車種', '配合', 'セメント', 'm³', '荷下ろし', ''].map((h, i) => (
                    <th key={i} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map(s => (
                  <tr key={s.id} style={{ ...S.tr, cursor: 'pointer', background: editing === s.id ? '#eef5ff' : undefined }} onClick={() => onRowClick(s)}>
                    <td style={S.td}>{s.date}</td>
                    <td style={{ ...S.td, maxWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      {s.hasPdf
                        ? <a href={`/api/shipments?id=${encodeURIComponent(s.id)}&pdf=1`}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(`/api/shipments?id=${encodeURIComponent(s.id)}&pdf=1`, '_blank', 'width=900,height=1000,scrollbars=yes,resizable=yes') }}
                            style={{ color: '#1a4d8f', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' }}>PDF</a>
                        : '—'}
                    </td>
                    <td style={S.td}>{Array.isArray(s.times) && s.times.length ? s.times.join(' / ') : '—'}</td>
                    <td style={{ ...S.td, fontWeight: 600 }}>{s.companyName}</td>
                    <td style={S.td}>{s.tradingCompany || '—'}</td>
                    <td style={S.td}>{s.siteName || '—'}</td>
                    <td style={S.td}>{Array.isArray(s.drivers) && s.drivers.length ? s.drivers.map(d => d.name).join('・') : (s.driverName || '—')}</td>
                    <td style={S.td}>{vehicleLabel(s) || '—'}</td>
                    <td style={S.td}>{mixRowsOfShip(s).map(r => r.code).filter(Boolean).join(' / ') || '—'}</td>
                    <td style={S.td}>{s.cementType || '—'}</td>
                    <td style={S.td}>{shipVolStr(s) || '—'}</td>
                    <td style={S.td}>{Array.isArray(s.placements) && s.placements.length ? s.placements.join('・') : '—'}</td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                      <button style={S.delBtn} onClick={(e) => { e.stopPropagation(); setDeleteConfirm(s.id) }}>削除</button>
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
  // 出荷予定表は縦持ち（スマホ・iPhone・iPad）前提。横スクロールのテーブルではなく
  // 1件=1カードの縦リストで表示する。PC・横向き（>=1025px）のみ従来テーブル。
  const isMobile = useIsMobile(1025)
  // 別ウィンドウ（isPopup）では幅に関わらず常にPC版テーブルを表示する。
  // → スマホで「別ウィンドウで開く」を押すと、横画面でPCレイアウトの予定表が出る。
  const compact = isMobile && !isPopup
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
  const [lineTarget, setLineTarget] = useState(null) // LINE送信モーダルで開いている伝票
  const [lineSel, setLineSel] = useState([])         // LINE送信の送り先（従業員id）

  const load = useCallback(async () => {
    try { setAll(await api.get('/api/shipments')) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.get('/api/employees').then(e => setDrivers((e || []).filter(emp => emp.type === 'driver'))).catch(() => {})
  }, [])

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
    const t = setInterval(async () => {
      try { mergeDiff(await api.get('/api/shipments')) } catch (e) { /* 一時的な失敗は無視 */ }
    }, 60000)
    return () => clearInterval(t)
  }, [isPopup, mergeDiff])

  // 別タブ（出荷登録の編集ウィンドウ等）で更新が入ったら即座に再取得して反映する
  const refetch = useCallback(async () => {
    try { mergeDiff(await api.get('/api/shipments')) } catch (e) { /* 無視 */ }
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
  const rows = all.filter(s => s.date === date && inAmPm(s))
    .sort((a, b) => timeToMin(firstT(a)) - timeToMin(firstT(b)) || String(firstT(a)).localeCompare(String(firstT(b))))

  const isChanged = (s, f) => Array.isArray(s.changedFields) && s.changedFields.includes(f)

  const getVal = (s, f) => {
    switch (f) {
      case 'drivers': {
        const names = Array.isArray(s.drivers) ? s.drivers.map(d => d.name) : (s.driverName ? [s.driverName] : [])
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
      case 'volume': {
        const one = (v, a, u) => { const b = (v == null ? '' : String(v)).trim(); return (!b && !a && !u) ? '' : `${b}${a ? '+a' : ''}${u ? '  ?' : ''}` }
        return [one(s.volume, s.volumePlusA, s.volumeUncertain), one(s.volume2, s.volumePlusA2, s.volumeUncertain2)].filter(Boolean).join(' / ')
      }
      default: return s[f] == null ? '' : String(s[f])
    }
  }
  const applyField = (s, f, raw) => {
    if (f === 'drivers') return { ...s, drivers: raw.split(/[・,、/\n]/).map(x => x.trim()).filter(Boolean).map(n => ({ id: '', name: n })) }
    if (f === 'times') return { ...s, times: raw.split(/[/\n]/).map(x => x.trim()).filter(Boolean) }
    if (f === 'notes') return { ...s, notes: raw.split('/').map(x => x.trim()).filter(Boolean).map(t => ({ text: t, important: false })) }
    if (f === 'volume') { const uncertain = /[?？]/.test(raw); return { ...s, volume: raw.replace(/[?？]/g, '').trim(), volumeUncertain: uncertain } }
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
    const base = parseFloat(getComputedStyle(el).fontSize) || 16
    let size = base, guard = 0
    // 横（および textarea の縦）がはみ出す間、収まるまで縮める
    const over = () => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
    while (over() && size > 8 && guard < 80) { size -= 0.5; el.style.fontSize = size + 'px'; guard++ }
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

  const cell = (s, f, ph, opts = {}) => {
    const imp = f === 'notes' && Array.isArray(s.notes) && s.notes.some(n => n.important)
    const cls = 'sc-in'
      + (isChanged(s, f) ? ' changed' : '')
      + (opts.center ? ' center' : '')
      + (opts.big ? ' big' : '')
      + (opts.xl ? ' xl' : '')
      + (opts.tokki ? ' tokki' : '')
      + (imp ? ' imp' : (opts.plain ? ' plain' : ''))
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
    const v = getVal(s, f)
    const rows = Math.max(1, (v.match(/\n/g) || []).length + 1)
    const cls = 'sc-in sc-ta'
      + (isChanged(s, f) ? ' changed' : '')
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
    const cls = 'sc-in sc-timeitem' + (isChanged(s, 'times') ? ' changed' : '')
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
  const cellMix = (s, opts = {}) => {
    const cls = 'sc-mixcode' + (opts.big ? ' big' : '') + (opts.center ? ' center' : '')
    const rows = mixRowsOfShip(s).filter(r => r.code || r.note)
    if (!rows.length) {
      return <span ref={fitRef} className={cls} style={{ pointerEvents: 'none' }} />
    }
    const wholeRed = isChanged(s, 'mixCode') && !['mix0', 'mix1', 'mix2'].some(k => isChanged(s, k))
    return (
      <span ref={fitRef} className={cls} key={'mix' + (isChanged(s, 'mixCode') ? '_c' : '') + '_n' + rows.length} style={{ pointerEvents: 'none' }}>
        {rows.map((r, ri) => {
          const parts = String(r.code || '').split('-')
          // 各配合行の下にその行の特記を表示（配合→特記→配合→特記…）
          const noteRed = ri === 0 && (isChanged(s, 'mixnote') || isChanged(s, 'mixCode'))
          return (
            <Fragment key={ri}>
              {r.code ? (
                <span style={{ display: 'block', whiteSpace: 'nowrap' }}>
                  {parts.map((p, i) => (
                    <Fragment key={i}>
                      {i > 0 && <span>-</span>}
                      <span style={{ color: (wholeRed || (ri === 0 && isChanged(s, 'mix' + i))) ? '#c81e1e' : undefined }}>{p}</span>
                    </Fragment>
                  ))}
                </span>
              ) : null}
              {(r.note && r.note.trim()) ? (
                <span className="sc-mixnote-line" style={noteRed ? { color: '#c81e1e' } : undefined}>{r.note}</span>
              ) : null}
            </Fragment>
          )
        })}
      </span>
    )
  }

  // 数量：2つあるときは上下2行で表示（各行に +a / ? を付与）
  const cellVolume = (s) => {
    const one = (v, a, u) => { const b = (v == null ? '' : String(v)).trim(); return (!b && !a && !u) ? '' : `${b}${a ? '+a' : ''}${u ? '?' : ''}` }
    const lines = [one(s.volume, s.volumePlusA, s.volumeUncertain), one(s.volume2, s.volumePlusA2, s.volumeUncertain2)].filter(Boolean)
    if (lines.length <= 1) return cell(s, 'volume', '', { center: true, big: true })
    const red = isChanged(s, 'volume')
    return (
      <span ref={fitRef} className="sc-mixcode big center" style={{ pointerEvents: 'none', color: red ? '#c81e1e' : undefined }}>
        {lines.map((l, i) => <span key={i} style={{ display: 'block', whiteSpace: 'nowrap' }}>{l}</span>)}
      </span>
    )
  }

  // 備考：行ごとに分割描画。追加/変更された行(note0,note1,…)だけ赤くする
  const cellNotes = (s, opts = {}) => {
    const arr = Array.isArray(s.notes) ? s.notes : []
    const cls = 'sc-in sc-notes' + (opts.plain ? ' plain' : '')
    const wholeRed = isChanged(s, 'notes') && !arr.some((_, i) => isChanged(s, 'note' + i))
    if (!arr.length) {
      return <span ref={fitRef} className={cls} style={{ pointerEvents: 'none', color: '#cbd2dc' }}>{opts.ph || '備考'}</span>
    }
    return (
      <span ref={fitRef} className={cls} key={'notes' + (isChanged(s, 'notes') ? '_c' : '')} style={{ pointerEvents: 'none' }}>
        {arr.map((n, i) => {
          const red = wholeRed || isChanged(s, 'note' + i) || (n && n.important)
          return (
            <Fragment key={i}>
              {i > 0 && <span> / </span>}
              <span style={{ color: red ? '#c81e1e' : undefined, fontWeight: (n && n.important) ? 700 : undefined }}>{n.text}</span>
            </Fragment>
          )
        })}
      </span>
    )
  }

  // 担当：1行=2人。各行を独立した入力にして、行ごとに別々の自動リサイズを行う
  // opts.oneEach=true のときは1人ずつ1行（縦並び）にする（スマホカード用）
  const cellDrivers = (s, opts = {}) => {
    const v = getVal(s, 'drivers')               // 2人ごとに改行された文字列
    let lines = v ? v.split('\n') : ['']
    if (opts.oneEach) {                           // 各行をさらに分解して1人=1行に
      const names = (Array.isArray(s.drivers) ? s.drivers.map(d => d.name) : (s.driverName ? [s.driverName] : []))
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
    const names = (Array.isArray(s.drivers) ? s.drivers.map(d => d.name) : (s.driverName ? [s.driverName] : []))
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
  const openPdfWin = (id) => window.open(`/api/shipments?id=${encodeURIComponent(id)}&pdf=1`, '_blank', 'width=900,height=1000,scrollbars=yes,resizable=yes')

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

  const resetReds = async () => {
    const targets = all.filter(s => Array.isArray(s.changedFields) && s.changedFields.length)
    if (targets.length === 0) { alert('赤（変更）表示はありません'); return }
    if (!window.confirm(`変更（赤）表示を${targets.length}件リセットしますか？（デバッグ用）`)) return
    for (const s of targets) {
      try {
        const res = await api.put(`/api/shipments/${s.id}`, { ...s, changedFields: [] })
        setAll(arr => arr.map(x => x.id === res.id ? res : x))
      } catch (e) { console.error(e) }
    }
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
        /* 別ウィンドウ: 日付/AM・PM(左)・タイトル(中央)・閉じる(右)。狭い画面では折り返して重ならないようにする */
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: '10px 12px', borderBottom: '1px solid #e5e9f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, flex: '0 1 auto' }}>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              style={{ fontSize: 13, padding: '4px 6px', border: '1.5px solid #bbb', borderRadius: 6 }} />
            <span style={{ fontSize: 13, color: '#111' }}>（{weekday}）</span>
            {ampmButtons}
          </div>
          <div style={{ flex: '1 1 120px', textAlign: 'center', fontSize: 16, fontWeight: 700, color: '#111', letterSpacing: '0.2em', whiteSpace: 'nowrap' }}>出荷予定表</div>
          <div className="no-print" style={{ flex: '0 0 auto', display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => window.close()}
              style={{ border: '1.5px solid #0f3060', background: '#0f3060', color: '#fff', borderRadius: 7, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>✕ 閉じる</button>
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
          {ampmButtons}
        </div>
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
                  <div className="sc-row sc-site"><span className="sc-val">{cell(s, 'siteName', '現場名', { big: true })}</span></div>
                  {/* ブロック形式：担当 / 車種 ・ 配合 / 量 */}
                  <div className="sc-grid2">
                    <div className="sc-box"><span className="sc-lbl">担当</span>{cellDriversCard(s)}</div>
                    <div className="sc-box sc-vehbox"><span className="sc-lbl">車種</span>
                      <div className="sc-veh">
                        {cell(s, 'vehicleType', '', { center: true, big: true })}
                      </div>
                    </div>
                    <div className="sc-box"><span className="sc-lbl">配合</span>{cellMix(s, { center: true, big: true })}</div>
                    <div className="sc-box sc-volbox"><span className="sc-lbl">数量</span>{cellVolume(s)}</div>
                  </div>
                  {/* PDF（添付があれば新規ウィンドウで開く） */}
                  {s.hasPdf && (
                    <div className="sc-row"><span className="sc-lbl">PDF</span><span className="sc-val">
                      <a href={`/api/shipments?id=${encodeURIComponent(s.id)}&pdf=1`} onClick={(e) => { e.preventDefault(); openPdfWin(s.id) }}
                        style={{ color: '#1a4d8f', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' }}>📄 PDFを開く</a>
                    </span></div>
                  )}
                  {/* 備考（横並び） */}
                  <div className="sc-row"><span className="sc-lbl">備考</span><span className="sc-val">{cellNotes(s, { plain: true })}</span></div>
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
            </>
          )}
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <button type="button" onClick={resetReds}
              style={{ border: '1px dashed #c0392b', background: '#fff', color: '#c0392b', borderRadius: 6, padding: '8px 12px', fontSize: 12, cursor: 'pointer' }}>
              🧹 変更(赤)をリセット（デバッグ）
            </button>
          </div>
        </div>
      ) : (() => {
        const inner = (<>
        <table>
          <colgroup>
            <col style={{ width: '11%' }} />
            <col style={{ width: '15%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '6%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '14%' }} />
            {!isPopup && <col style={{ width: '8%' }} />}
          </colgroup>
          <thead>
            <tr>
              <th><div>業者名</div><div>商社</div></th>
              <th>現場名</th><th>📄PDF</th><th>車種</th><th>配合</th><th>数量</th><th>担当</th><th>時間</th>
              <th><div>備考</div><div>現場連絡先</div></th>
              {!isPopup && <th>編集</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(s => (
              <tr key={s.id}>
                <td>{cell(s, 'companyName', '業者名')}{cell(s, 'tradingCompany', '商社')}</td>
                <td>{cell(s, 'siteName', '', { big: true })}</td>
                <td className="sc-nowrap" style={{ textAlign: 'center' }}>
                  {s.hasPdf ? <a href={`/api/shipments?id=${encodeURIComponent(s.id)}&pdf=1`} onClick={(e) => { e.preventDefault(); openPdfWin(s.id) }} style={{ color: '#1a4d8f', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer', whiteSpace: 'nowrap' }}>📄PDF</a> : null}
                </td>
                <td className="sc-nowrap">{cell(s, 'vehicleType', '', { center: true, big: true, xl: true })}</td>
                <td className="sc-nowrap">{cellMix(s, { center: true, big: true })}</td>
                <td className="sc-nowrap">{cellVolume(s)}</td>
                <td>{cellDrivers(s, { big: true })}</td>
                <td className="sc-nowrap">{cellMulti(s, 'times', '', { center: true, big: true })}</td>
                <td>{cellNotes(s, { plain: true })}{cell(s, 'siteContact', '現場連絡先')}</td>
                {!isPopup && (
                  <td style={{ textAlign: 'center' }}>
                    <button type="button" onClick={() => openEditWindow(s)}
                      style={{ display: 'block', margin: '0 auto', border: '1px solid #1a8f5a', background: '#f0f9f0', color: '#1a8f5a', borderRadius: 5, padding: '3px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>✏️ 編集</button>
                    <button type="button" onClick={() => openLine(s)}
                      style={{ display: 'block', margin: '4px auto 0', border: '1px solid #06c755', background: '#06c755', color: '#fff', borderRadius: 5, padding: '3px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>LINE送信</button>
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
        {!isPopup && (
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button type="button" onClick={resetReds}
              style={{ border: '1px dashed #c0392b', background: '#fff', color: '#c0392b', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }}>
              🧹 変更(赤)をリセット（デバッグ）
            </button>
          </div>
        )}
        </>)
        if (!isPopup) return <div className="schedule" style={{ overflowX: 'auto', padding: '0 16px 24px' }}>{inner}</div>
        // 別ウィンドウ: 画面が表の基準幅(860px)より広ければ幅100%で画面いっぱいに（PC）、
        // 狭ければ FitToWidth で縮小して横スクロールを出さない（スマホ縦）。
        return popupNarrow
          ? <FitToWidth width={860} max={1} style={{ padding: '4px 0 24px' }}>
              <div className="schedule popup-view" style={{ width: 860 }}>{inner}</div>
            </FitToWidth>
          : <div className="schedule popup-view" style={{ padding: '4px 12px 24px' }}>{inner}</div>
      })()}
      {editModal && (
        <ScheduleEditModal
          shipment={editModal}
          driverOptions={drivers}
          onClose={() => setEditModal(null)}
          onSave={async (patch, changedKeys) => { await saveStructured(editModal, patch, changedKeys); setEditModal(null) }}
        />
      )}
      {lineTarget && (
        <div onClick={() => setLineTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', width: '100%', maxWidth: 460, borderRadius: 14, padding: 18, maxHeight: '88dvh', overflowY: 'auto' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#111', marginBottom: 6 }}>💬 LINE送信</div>
            <div style={{ fontSize: 14, color: '#3a4a5c' }}><b style={{ color: '#c0392b' }}>{firstTimeOf(lineTarget) || '—'}</b>　<b>{lineTarget.companyName}</b></div>
            <div style={{ fontSize: 13, color: '#6b7a8d', marginBottom: 8 }}>{lineTarget.siteName || ''}</div>
            {Array.isArray(lineTarget.drivers) && lineTarget.drivers.length > 0 && (
              <div style={{ fontSize: 12, color: '#1a4d8f', marginBottom: 8 }}>現在の担当: {lineTarget.drivers.map(d => d.name).join('、')}</div>
            )}
            <div style={{ fontSize: 12, fontWeight: 700, color: '#3a4a5c', marginBottom: 6 }}>送り先を選択（従業員管理のドライバー・タップで選択）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {drivers.length === 0 ? <span style={{ fontSize: 13, color: '#9aa7b5' }}>ドライバーが登録されていません（従業員管理で登録してください）</span>
                : drivers.map(d => {
                  const on = lineSel.includes(d.id)
                  const noId = !cleanLineId(d.lineId)
                  return (
                    <button key={d.id} type="button" onClick={() => toggleLineSel(d.id)}
                      style={{ border: on ? '2px solid #06c755' : '1.5px solid #cdd5e0', background: on ? '#06c755' : '#fff', color: on ? '#fff' : (noId ? '#aab' : '#3a4a5c'), borderRadius: 8, padding: '9px 14px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                      {d.name}{noId && <span style={{ fontSize: 10, marginLeft: 2 }}>(LINE未設定)</span>}
                    </button>
                  )
                })}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button type="button" onClick={() => setLineTarget(null)} style={{ flex: 1, border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>キャンセル</button>
              <button type="button" onClick={doSendLine} style={{ flex: 1, border: '1.5px solid #06c755', background: '#06c755', color: '#fff', borderRadius: 10, padding: '12px', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>💬 一括送信</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// スマホ予定表の編集モーダル。更新で差分保存→閉じると予定表に戻り変更が赤文字反映される。
function ScheduleEditModal({ shipment, driverOptions = [], onClose, onSave }) {
  const s = shipment
  // --- 構造化した初期状態を伝票から組み立てる ---
  const initTimes = (Array.isArray(s.times) ? s.times.map(t => (t && t.text != null) ? t.text : t) : [])
    .map(x => String(x ?? '')).filter(x => x.trim() !== '')
  const initDrivers = (Array.isArray(s.drivers) ? s.drivers : (s.driverName ? [{ id: s.driverId || '', name: s.driverName }] : []))
    .map(d => ({ id: d.id || '', name: d.name }))
  const [times, setTimes] = useState(initTimes.length ? initTimes : [''])
  const [date, setDate] = useState(s.date || '')
  const [companyName, setCompanyName] = useState(s.companyName || '')
  const [tradingCompany, setTradingCompany] = useState(s.tradingCompany || '')
  const [siteName, setSiteName] = useState(s.siteName || '')
  const [pourLocation, setPourLocation] = useState(s.pourLocation || '')
  const [pourFree, setPourFree] = useState(() => !!(s.pourLocation && !POUR_LOCATIONS.includes(s.pourLocation)))
  const [siteAddress, setSiteAddress] = useState(s.siteAddress || '')
  const [mapView, setMapView] = useState(s.mapView || null)
  const [mapArrows, setMapArrows] = useState(Array.isArray(s.mapArrows) ? s.mapArrows : [])
  const [vehicleType, setVehicleType] = useState(s.vehicleType || '')   // "4t・7t" 連結（台数なし）
  const [mixRows, setMixRows] = useState(() => {
    if (Array.isArray(s.mixRows) && s.mixRows.length) {
      return s.mixRows.map(r => ({ parts: [r.parts?.[0] || '', r.parts?.[1] || '', r.parts?.[2] || ''], note: r.note || '' }))
    }
    const p = String(s.mixCode || '').split('-')
    const n = Array.isArray(s.mixNotes) ? s.mixNotes : []
    return [{ parts: [p[0] || '', p[1] || '', p[2] || ''], note: n[1] || '' }]
  })
  const [volume, setVolume] = useState(s.volume == null ? '' : String(s.volume))
  const [volumeUncertain, setVolumeUncertain] = useState(!!s.volumeUncertain)
  const [volumePlusA, setVolumePlusA] = useState(!!s.volumePlusA)
  const [volume2, setVolume2] = useState(s.volume2 == null ? '' : String(s.volume2))
  const [volumeUncertain2, setVolumeUncertain2] = useState(!!s.volumeUncertain2)
  const [volumePlusA2, setVolumePlusA2] = useState(!!s.volumePlusA2)
  const [hasVolume2, setHasVolume2] = useState(!!(s.volume2 || s.volumeUncertain2 || s.volumePlusA2))
  const [drivers, setDrivers] = useState(initDrivers)
  const [notes, setNotes] = useState(Array.isArray(s.notes) ? s.notes.map(n => n.text).join('\n') : '')
  const [noteTags, setNoteTags] = useState(Array.isArray(s.noteTags) ? s.noteTags : [])
  const [placements, setPlacements] = useState(Array.isArray(s.placements) ? s.placements : [])
  const [siteContact, setSiteContact] = useState(s.siteContact || '')
  const toggleNoteTag = (t) => setNoteTags(cur => cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t])
  const togglePlacement = (t) => setPlacements(cur => cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t])
  const [saving, setSaving] = useState(false)

  // 時間：行ごとに編集／追加／削除（最大2）
  const setTime = (i, v) => setTimes(ts => ts.map((t, idx) => idx === i ? v : t))
  const addTime = () => setTimes(ts => ts.length < 2 ? [...ts, ''] : ts)
  const delTime = (i) => setTimes(ts => ts.length > 1 ? ts.filter((_, idx) => idx !== i) : [''])
  // 配合：複数行。各行3セクション（各2桁）＋中央の特記
  const setMixPart = (ri, i, v) => setMixRows(rs => rs.map((r, idx) => idx === ri ? { ...r, parts: r.parts.map((x, j) => j === i ? v : x) } : r))
  const setMixNote = (ri, v) => setMixRows(rs => rs.map((r, idx) => idx === ri ? { ...r, note: v } : r))
  const addMixRow = () => setMixRows(rs => [...rs, { parts: ['', '', ''], note: '' }])
  const removeMixRow = (ri) => setMixRows(rs => rs.length > 1 ? rs.filter((_, idx) => idx !== ri) : rs)

  // 車種：3種から複数トグル（VEHICLE_TYPESの順を維持）
  const vehList = vehicleType.split('・').map(x => x.trim()).filter(Boolean)
  const toggleVeh = (o) => {
    const isOn = vehList.includes(o)
    const next = isOn ? vehList.filter(x => x !== o) : [...vehList, o]
    setVehicleType(VEHICLE_TYPES.filter(v => next.includes(v)).join('・'))
  }

  // 担当：最大4人。選択肢から追加／チップで削除
  const addDriver = (e) => {
    const d = driverOptions.find(x => x.id === e.target.value)
    if (d && drivers.length < 4 && !drivers.some(x => x.id === d.id)) setDrivers(ds => [...ds, { id: d.id, name: d.name }])
    e.target.value = ''
  }
  const removeDriver = (i) => setDrivers(ds => ds.filter((_, idx) => idx !== i))

  const submit = async () => {
    setSaving(true)
    // 構造化パッチを作り、元と異なるフィールドだけ changed に積む
    const cleanTimes = times.map(t => t.trim()).filter(Boolean)
    // 配合：複数行を整形（全行空の行は落とす）。1行目を mixCode/mixNotes に同期
    const cleanRows = mixRows
      .map(r => ({ parts: [r.parts[0].trim(), r.parts[1].trim(), r.parts[2].trim()], note: (r.note || '').trim() }))
      .filter(r => r.parts.some(Boolean) || r.note)
    const finalRows = cleanRows.length ? cleanRows : [{ parts: ['', '', ''], note: '' }]
    const mixCode = finalRows[0].parts.join('-').replace(/-+$/, '')
    const mixNotesClean = ['', finalRows[0].note || '', '']
    // 車種：選択中の車種名のみ（台数は持たない）
    const vehTypes = String(vehicleType || '').split('・').map(x => x.trim()).filter(Boolean)
    const vehicleItems = vehTypes.map(t => ({ type: t, qty: '' }))
    const patch = {
      times: cleanTimes,
      date: date || s.date,
      companyName, tradingCompany, siteName, siteAddress, pourLocation,
      mapView, mapArrows,
      vehicleType, vehicleItems, mixCode, mixNotes: mixNotesClean, mixRows: finalRows,
      volume, volumeUncertain, volumePlusA,
      volume2: hasVolume2 ? volume2 : '', volumeUncertain2: hasVolume2 ? volumeUncertain2 : false, volumePlusA2: hasVolume2 ? volumePlusA2 : false,
      drivers: drivers.map(d => ({ id: d.id, name: d.name })),
      notes: notes.split('\n').map(x => x.trim()).filter(Boolean).map(t => ({ text: t, important: false })),
      noteTags,
      placements,
      siteContact,
    }
    // 配合は桁ごと・備考は行ごとに変更を検出（共通ヘルパー）
    const changed = diffChangedFields(s, patch)
    try { await onSave(patch, changed) } catch { setSaving(false) }
  }

  const lblS = { fontSize: 12, fontWeight: 700, color: '#3a4a5c', marginBottom: 4, display: 'block' }
  const inS = { width: '100%', fontSize: 16, padding: '9px 10px', border: '1.5px solid #cdd5e0', borderRadius: 8, fontFamily: 'inherit', color: '#111', boxSizing: 'border-box' }
  const chip = (on) => ({ border: on ? '1.5px solid #1b4ea8' : '1.5px solid #cdd5e0', background: on ? '#1b4ea8' : '#fff', color: on ? '#fff' : '#3a4a5c', borderRadius: 8, padding: '9px 0', fontSize: 15, fontWeight: 700, cursor: 'pointer', textAlign: 'center' })

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', width: '100%', maxWidth: 520, maxHeight: '90dvh', overflowY: 'auto', borderRadius: '16px 16px 0 0', padding: 'calc(18px + env(safe-area-inset-top)) 18px calc(18px + env(safe-area-inset-bottom))', boxShadow: '0 -4px 24px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, position: 'sticky', top: 0, background: '#fff', paddingBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#111' }}>✏️ 予定を編集</div>
          <button type="button" onClick={onClose} disabled={saving}
            style={{ border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>✕ 閉じる</button>
        </div>

        {/* 日付（左・業者名と同じ幅）／時間（右・商社名と同じ開始位置）。下の業者名/商社名グリッドと列を揃える */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14, alignItems: 'start' }}>
          <div style={{ minWidth: 0 }}>
            <label style={lblS}>日付</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...inS, width: 'auto', maxWidth: '100%', display: 'block' }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <label style={lblS}>時間（最大2・上から順）</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {times.map((t, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input value={t} onChange={e => setTime(i, e.target.value)} placeholder="例: 08:00 / 午前" style={{ ...inS, flex: '1 1 0', minWidth: 0 }} />
                  {times.length > 1 && (
                    <button type="button" onClick={() => delTime(i)}
                      style={{ flex: '0 0 auto', border: '1.5px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 8, width: 38, height: 38, fontSize: 16, cursor: 'pointer' }}>×</button>
                  )}
                </div>
              ))}
            </div>
            {times.length < 2 && (
              <button type="button" onClick={addTime}
                style={{ marginTop: 6, border: '1px dashed #9aa7b5', background: '#fafbfc', color: '#3a4a5c', borderRadius: 8, padding: '7px 12px', fontSize: 13, cursor: 'pointer' }}>＋ 時間を追加</button>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div><label style={lblS}>業者名</label><input value={companyName} onChange={e => setCompanyName(e.target.value)} style={inS} /></div>
          <div><label style={lblS}>商社名</label><input value={tradingCompany} onChange={e => setTradingCompany(e.target.value)} style={inS} /></div>
        </div>
        <div style={{ marginBottom: 12 }}><label style={lblS}>現場名</label><input value={siteName} onChange={e => setSiteName(e.target.value)} style={inS} /></div>
        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>打設箇所</label>
          {!pourFree ? (
            <select value={pourLocation} style={{ ...inS, cursor: 'pointer' }}
              onChange={e => {
                if (e.target.value === '入力する') { setPourFree(true); setPourLocation('') }
                else setPourLocation(e.target.value)
              }}>
              <option value=""></option>
              {POUR_LOCATIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={pourLocation} onChange={e => setPourLocation(e.target.value)} placeholder="打設箇所を入力" style={{ ...inS, flex: 1 }} />
              <button type="button" onClick={() => { setPourFree(false); setPourLocation('') }}
                style={{ flex: '0 0 auto', border: '1.5px solid #cdd5e0', background: '#fff', color: '#3a4a5c', borderRadius: 8, padding: '0 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>一覧</button>
            </div>
          )}
        </div>

        {/* 現場住所＋地図（住所編集・ピン/矢印編集） */}
        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>現場住所</label>
          <input value={siteAddress} onChange={e => setSiteAddress(e.target.value)} placeholder={DEFAULT_SITE_ADDRESS} style={inS} />
          <div style={{ marginTop: 8 }}>
            <SiteMap
              address={siteAddress}
              onAddressChange={setSiteAddress}
              mapView={mapView}
              onMapViewChange={setMapView}
              arrows={mapArrows}
              onArrowsChange={setMapArrows}
            />
          </div>
        </div>

        {/* 車種（3種複数選択） */}
        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>車種（複数選択可）</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            {VEHICLE_TYPES.map(o => (
              <div key={o} onClick={() => toggleVeh(o)} style={chip(vehList.includes(o))}>{o}</div>
            ))}
          </div>
        </div>

        {/* 配合（複数行・3セクション・中央に特記）＋量（?トグル） */}
        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>配合（中央のみ特記可）</label>
          {mixRows.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', alignItems: 'flex-end', gap: 6, marginTop: ri > 0 ? 10 : 0 }}>
              {[0, 1, 2].map(i => (
                <Fragment key={i}>
                  {i > 0 && <span style={{ fontSize: 22, fontWeight: 700, color: '#111', paddingBottom: 8 }}>-</span>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {i === 1
                      ? <input value={row.note} onChange={e => setMixNote(ri, e.target.value)} placeholder="特記"
                          style={{ width: '100%', boxSizing: 'border-box', fontSize: 11, color: '#c0392b', textAlign: 'center', border: 'none', borderBottom: '1px dashed #e7a3a3', outline: 'none', padding: '0 0 2px', fontFamily: 'inherit' }} />
                      : <div style={{ height: 15 }} />}
                    <input value={row.parts[i]} onChange={e => setMixPart(ri, i, e.target.value)} inputMode="numeric" maxLength={2} placeholder="00"
                      style={{ width: '100%', boxSizing: 'border-box', fontSize: 20, fontWeight: 700, textAlign: 'center', border: '1.5px solid #cdd5e0', borderRadius: 8, padding: '8px 4px', fontFamily: 'inherit', color: '#111', marginTop: 3 }} />
                  </div>
                </Fragment>
              ))}
              {ri > 0 && (
                <button type="button" onClick={() => removeMixRow(ri)} title="この配合を削除"
                  style={{ flex: '0 0 auto', border: '1.5px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 8, width: 38, height: 40, fontSize: 16, cursor: 'pointer' }}>×</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addMixRow}
            style={{ marginTop: 8, border: '1px dashed #9aa7b5', background: '#fafbfc', color: '#3a4a5c', borderRadius: 8, padding: '7px 12px', fontSize: 13, cursor: 'pointer' }}>＋ 配合を追加</button>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>数量（m³）</label>
          {(() => {
            const sqBtn = (on, label, onClick, title) => (
              <button type="button" onClick={onClick} title={title}
                style={{ flex: '0 0 auto', border: on ? '1.5px solid #c0392b' : '1.5px solid #cdd5e0', background: on ? '#c0392b' : '#fff', color: on ? '#fff' : '#8a97a6', borderRadius: 8, minWidth: 42, height: 40, padding: '0 8px', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>{label}</button>
            )
            const row = (val, setV, unc, setUnc, plusA, setPlusA, onDel) => (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <input value={val} onChange={e => setV(e.target.value)} inputMode="decimal" style={{ ...inS, flex: 1 }} />
                {sqBtn(plusA, '+a', () => setPlusA(v => !v), '+a を付ける')}
                {sqBtn(unc, '?', () => setUnc(v => !v), '不確定マーク')}
                {onDel && sqBtn(false, '×', onDel, '2段目を削除')}
              </div>
            )
            return (<>
              {row(volume, setVolume, volumeUncertain, setVolumeUncertain, volumePlusA, setVolumePlusA, null)}
              {hasVolume2 && row(volume2, setVolume2, volumeUncertain2, setVolumeUncertain2, volumePlusA2, setVolumePlusA2,
                () => { setHasVolume2(false); setVolume2(''); setVolumeUncertain2(false); setVolumePlusA2(false) })}
              {!hasVolume2 && (
                <button type="button" onClick={() => setHasVolume2(true)}
                  style={{ border: '1px dashed #9aa7b5', background: '#fafbfc', color: '#3a4a5c', borderRadius: 8, padding: '7px 12px', fontSize: 13, cursor: 'pointer' }}>＋ 量を追加</button>
              )}
            </>)
          })()}
        </div>

        {/* 担当（最大4人・選択） */}
        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>担当ドライバー（最大4人）</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: drivers.length ? 6 : 0 }}>
            {drivers.map((d, i) => (
              <span key={d.id || i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1.5px solid #1b4ea8', background: '#e8f0ff', color: '#1b4ea8', borderRadius: 8, padding: '6px 10px', fontSize: 14, fontWeight: 600 }}>
                {d.name}
                <button type="button" onClick={() => removeDriver(i)} style={{ border: 'none', background: 'none', color: '#1b4ea8', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
              </span>
            ))}
          </div>
          {drivers.length < 4 && (
            <select onChange={addDriver} defaultValue="" style={{ ...inS, cursor: 'pointer' }}>
              <option value="">＋ ドライバーを追加</option>
              {driverOptions.filter(e => !drivers.some(d => d.id === e.id)).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </div>

        {/* 荷下ろし（クレーン / F1 / ポンプ） */}
        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>荷下ろし</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            {PLACEMENT_TYPES.map(t => (
              <div key={t} onClick={() => togglePlacement(t)} style={chip(placements.includes(t))}>{t}</div>
            ))}
          </div>
        </div>

        {/* 特記（工TP / 領 / 増コン / 追） */}
        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>特記</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 }}>
            {NOTE_TAGS.map(t => (
              <div key={t} onClick={() => toggleNoteTag(t)} style={chip(noteTags.includes(t))}>{t}</div>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}><label style={lblS}>備考（複数は改行）</label><textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...inS, resize: 'vertical' }} /></div>
        <div style={{ marginBottom: 6 }}><label style={lblS}>現場連絡先</label><input value={siteContact} onChange={e => setSiteContact(e.target.value)} inputMode="tel" style={inS} /></div>

        <button type="button" onClick={submit} disabled={saving}
          style={{ width: '100%', marginTop: 8, border: 'none', background: 'linear-gradient(135deg,#1a4d8f,#1a6a9f)', color: '#fff', borderRadius: 10, padding: '14px', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
          {saving ? '更新中…' : '更新'}
        </button>
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
const driversOf = (s) => Array.isArray(s.drivers) ? s.drivers.map(d => d.name) : (s.driverName ? [s.driverName] : [])

function useShipments() {
  const [all, setAll] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { api.get('/api/shipments').then(setAll).catch(e => console.error(e)).finally(() => setLoading(false)) }, [])
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
  const { all, loading } = useShipments()
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

          {/* 月別の合計m³（先月・今月・来月）と ?・+a の数 */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(auto-fill,minmax(150px,1fr))', gap: 12, marginBottom: 20 }}>
            {card('先月の合計', fmtVol(volBoth(lastMonthShips)), 'm³', monLabel(-1))}
            {card('今月の合計', fmtVol(volBoth(thisMonthShips)), 'm³', monLabel(0), '#1a6a9f')}
            {card('来月の合計', fmtVol(volBoth(nextMonthShips)), 'm³', monLabel(1))}
            {card('今月の「?」', marks.q, '件', '数量未確定の数')}
            {card('今月の「+a」', marks.a, '件', '+aの数')}
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
            {breakdown('今日の担当別', drvEntries, '本日の出荷はありません')}
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
                  <span style={{ flex: '0 0 auto', color: '#3a4a5c' }}>{s.vehicleType || ''}{s.volume ? ` ${s.volume}m³` : ''}</span>
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
  const { all, loading } = useShipments()
  const ms = new Date(date)   // 選択日（既定は本日）を左端に10日分表示
  const days = Array.from({ length: 10 }, (_, i) => { const d = new Date(ms); d.setDate(d.getDate() + i); return d })
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
            return (
              <div key={ds} style={{ border: '1px solid #dde3ed', borderRadius: 8, minHeight: 220, background: ds === todayStr ? '#eef5ff' : '#fff' }}>
                <div style={{ padding: '6px 8px', borderBottom: '1px solid #dde3ed', fontWeight: 700, fontSize: 13, textAlign: 'center', color: wd === '日' ? '#c0392b' : wd === '土' ? '#1b4ea8' : '#1a2332' }}>{d.getMonth() + 1}/{d.getDate()}（{wd}）</div>
                {/* 便別サマリー：第一便／第二便／午後の車種別台数と合計台数 */}
                {binList.map((bl, bi) => {
                  const st = vehStats(bl)
                  const lb = BIN_LABELS[bi]
                  // 内訳：4t/7t を1行目、大型を2行目。常に2行ぶんの高さを確保して下の一覧の開始位置を揃える
                  const small = ['4t', '7t'].filter(v => st.c[v] > 0).map(v => `${v}:${st.c[v]}台`).join('　')
                  const big = st.c['大型'] > 0 ? `大型:${st.c['大型']}台` : ''
                  return (
                    <div key={bi} style={{ padding: '6px 8px', borderBottom: '1px solid #eef0f4', background: '#f8fafc', fontSize: 13, color: '#3a4a5c', lineHeight: 1.4 }}>
                      <div style={{ fontWeight: 800, color: '#0f3060', fontSize: 15 }}>
                        <span style={{ whiteSpace: 'nowrap' }}>{lb.main}</span>
                        {lb.sub && <span style={{ display: 'block', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{lb.sub}</span>}
                      </div>
                      <div style={{ fontWeight: 700, color: '#0f3060', fontSize: 14 }}>計{st.total}台</div>
                      <div style={{ fontSize: 13, marginTop: 1, lineHeight: 1.3 }}>
                        <div style={{ whiteSpace: 'nowrap', minHeight: '1.3em' }}>{st.total === 0 ? '—' : small}</div>
                        <div style={{ whiteSpace: 'nowrap', minHeight: '1.3em' }}>{big}</div>
                      </div>
                    </div>
                  )
                })}
                <div style={{ padding: 6 }}>
                  {list.length === 0 ? <div style={{ fontSize: 11, color: '#c0c8d4' }}>—</div>
                    : list.map(s => <div key={s.id} style={{ fontSize: 11, borderBottom: '1px dashed #eee', padding: '3px 0' }}><b>{firstTimeOf(s)}</b> {s.companyName}<br /><span style={{ color: '#6b7a8d' }}>{s.siteName || ''}{s.volume ? ` /${s.volume}m³` : ''}</span></div>)}
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
  const { all, loading } = useShipments()
  const [customers, setCustomers] = useState([])
  useEffect(() => { api.get('/api/customers').then(setCustomers).catch(() => { /* noop */ }) }, [])
  const custCode = (s) => { const c = customers.find(c => c.id === s.companyId); return c ? (c.customerCode || '') : '' }
  const inAmPm = (s) => { if (ampm === 'both') return true; const m = timeToMin(firstTimeOf(s)); return ampm === 'AM' ? m < 720 : m >= 720 }
  const rows = all.filter(s => s.date === date && inAmPm(s))
    .sort((a, b) => timeToMin(firstTimeOf(a)) - timeToMin(firstTimeOf(b)) || String(firstTimeOf(a)).localeCompare(String(firstTimeOf(b))))

  // 試験集計（その日の全出荷から：現TP=現場 / 工TP=工場）
  const dayShips = all.filter(s => s.date === date)
  const testGen = dayShips.filter(s => (Array.isArray(s.testTags) ? s.testTags : []).includes('現TP')).length
  const testKo = dayShips.filter(s => (Array.isArray(s.testTags) ? s.testTags : []).includes('工TP')).length

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
  const tagsOf = (s) => (Array.isArray(s.noteTags) ? s.noteTags : []).filter(Boolean).join('・')
  const testOf = (s) => (Array.isArray(s.testTags) ? s.testTags : []).filter(Boolean).join('・')
  const volOne = (v, a, u) => { const b = (v == null ? '' : String(v)).trim(); return (!b && !a && !u) ? '' : `${b}${b ? 'm³' : ''}${a ? '+a' : ''}${u ? '?' : ''}` }

  const placementsOf = (s) => (Array.isArray(s.placements) ? s.placements : []).filter(Boolean).join('・')

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
    const mixes = mixRowsOfShip(s).map(r => r.code).filter(Boolean)
    const v1 = volOne(s.volume, s.volumePlusA, s.volumeUncertain)
    const v2 = volOne(s.volume2, s.volumePlusA2, s.volumeUncertain2)
    const vols = [v1, v2].filter(Boolean)
    const n = Math.max(1, mixes.length)
    for (let k = 0; k < n; k++) tableRows.push({ s, mix: mixes[k] || '', vols: k === 0 ? vols : [], primary: k === 0 })
  })

  // 1行を描画。配合の2行目以降（!primary）は配合のみ（その他は空）
  const renderRow = (r, key) => {
    const s = r.s
    if (!r.primary) {
      return (
        <tr key={key}>
          <td></td><td></td><td></td><td></td>
          <td className="seikon-mix">{r.mix}</td>
          <td></td><td></td><td></td><td></td><td></td>
        </tr>
      )
    }
    const ts = timesArr(s)
    const tekiyo2 = [placementsOf(s), tagsOf(s), testOf(s)].filter(Boolean).join(' / ')   // 荷下ろし / 特記 / 試験(現TP・工TP)
    return (
      <tr key={key}>
        <td>{s.companyName || ''}</td>
        <td>{s.siteName || ''}</td>
        <td className="seikon-datsu">{s.pourLocation || ''}</td>
        <td className="seikon-veh">{vehicleLabel(s) || ''}</td>
        <td className="seikon-mix">{r.mix}</td>
        <td style={{ textAlign: 'center' }}>{s.cementType || ''}</td>
        <td style={{ textAlign: 'center' }}>{r.vols.length ? r.vols.map((v, i) => <div key={i}>{v}</div>) : ''}</td>
        <td style={{ textAlign: 'center' }}>{ts.length ? ts.map((t, i) => <div key={i}>{t}</div>) : null}</td>
        <td className="seikon-phone">{s.siteContact || ''}</td>
        <td className="seikon-tekiyo">
          <div>{notesOf(s)}</div>
          <div>{tekiyo2}</div>
        </td>
      </tr>
    )
  }

  const ROWS = 23
  const blanks = Math.max(0, ROWS - tableRows.length)
  const cols = ['業者名', '現場名', '打設', '車輌', '配合', '種', '数量', '時間', '担当連絡先', '摘要']
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
          <span className="st-date">{titleDate}</span>
          <span className="st-ampm">
            <b style={{ opacity: ampm === 'PM' ? 0.3 : 1 }}>AM</b> ・ <b style={{ opacity: ampm === 'AM' ? 0.3 : 1 }}>PM</b>
          </span>
          <span className="st-test"><span className="st-test-label">試験</span>　現場：{testGen}件　工場：{testKo}件</span>
        </div>
        <table className="seikon-table">
          <colgroup>
            <col style={{ width: '11%' }} /><col style={{ width: '15%' }} /><col style={{ width: '5%' }} />
            <col style={{ width: '7%' }} /><col style={{ width: '13%' }} /><col style={{ width: '5%' }} />
            <col style={{ width: '8%' }} /><col style={{ width: '7%' }} /><col style={{ width: '11%' }} /><col style={{ width: '18%' }} />
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
  const [date, setDate] = useState(() => localToday())
  const { all, loading } = useShipments()
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
                <td style={RPT.td}>{shipVolStr(s)}</td>
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
  const [date, setDate] = useState(() => localToday())
  const { all, loading } = useShipments()
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
                    <td style={RPT.td}>{s.vehicleType || ''}</td><td style={RPT.td}>{s.mixCode || ''}</td><td style={RPT.td}>{shipVolStr(s)}</td>
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

// 担当者を選ぶUI（チップ・最大4人）
function DriverPicker({ value, options, onChange }) {
  const has = (id) => value.some(d => d.id === id)
  const toggle = (emp) => {
    if (has(emp.id)) onChange(value.filter(d => d.id !== emp.id))
    else if (value.length < 4) onChange([...value, { id: emp.id, name: emp.name }])
    else alert('担当者は最大4人までです')
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.length === 0 ? <span style={{ fontSize: 13, color: '#9aa7b5' }}>ドライバーが登録されていません（従業員管理で登録してください）</span>
        : options.map(emp => {
          const on = has(emp.id)
          return <button key={emp.id} type="button" onClick={() => toggle(emp)}
            style={{ border: on ? '2px solid #1b4ea8' : '1.5px solid #cdd5e0', background: on ? '#1b4ea8' : '#fff', color: on ? '#fff' : '#3a4a5c', borderRadius: 8, padding: '9px 14px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>{emp.name}</button>
        })}
    </div>
  )
}

// 担当者振替の本体（モーダル／別ウィンドウ共用）
// 担当者を選び、「保存してLINE送信」で割り当て＋選択ドライバーへLINE通知を行う
function DriverAssignBody({ shipment, drivers, onSaved, onClose }) {
  const [sel, setSel] = useState([])   // 開いた時点では誰も選択しない（PC/モバイル共通）
  const [busy, setBusy] = useState(false)
  const cleanId = (v) => String(v || '').replace(/[\s　​-‍﻿]/g, '').trim()
  // 保存（担当割り当て）。withLine=true のとき選択ドライバーへLINEも送信する
  const doSave = async (withLine) => {
    setBusy(true)
    try {
      const u = await saveShipmentDrivers(shipment, sel)
      notifyShipmentsChanged()
      if (withLine) {
        if (!sel.length) { alert('LINEを送る担当者が選択されていません。'); setBusy(false); return }
        const resolved = sel.map(d => { const emp = drivers.find(e => (d.id && e.id === d.id) || e.name === d.name); return { name: d.name, lineId: cleanId(emp?.lineId) } })
        const withId = resolved.filter(r => r.lineId)
        const without = resolved.filter(r => !r.lineId)
        if (!withId.length) {
          alert('割り当ては保存しました。\nただし選択した担当者にLINEユーザーIDが紐づいていないため送信できませんでした。\n（従業員管理でLINE IDを設定してください）')
        } else {
          try {
            const res = await api.post('/api/line', { action: 'pushShipment', shipmentId: shipment.id, lineUserIds: withId.map(r => r.lineId) })
            let m = `割り当てを保存し、${withId.map(r => r.name).join('、')} にLINEを送信しました（${res.sent ?? '?'}/${res.total ?? '?'} 件成功）`
            if (without.length) m += `\n（LINE未設定のためスキップ: ${without.map(r => r.name).join('、')}）`
            alert(m)
          } catch (e) { alert('割り当ては保存しましたが、LINE送信でエラー: ' + e.message) }
        }
      }
      onSaved && onSaved(u)
    } catch (e) { alert('エラー: ' + e.message); setBusy(false) }
  }
  return (
    <>
      <div style={{ fontSize: 17, fontWeight: 700, color: '#111', marginBottom: 6 }}>💬 LINE送信</div>
      <div style={{ fontSize: 14, color: '#3a4a5c' }}><b style={{ color: '#c0392b' }}>{firstTimeOf(shipment) || '—'}</b>　<b>{shipment.companyName}</b></div>
      <div style={{ fontSize: 13, color: '#6b7a8d', marginBottom: 12 }}>{shipment.siteName || ''}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#3a4a5c', marginBottom: 6 }}>担当者（最大4人・タップで選択／解除）</div>
      <DriverPicker value={sel} options={drivers} onChange={setSel} />
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button type="button" onClick={onClose} disabled={busy} style={{ flex: 1, border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>キャンセル</button>
        <button type="button" onClick={() => doSave(true)} disabled={busy}
          style={{ flex: 1, border: '1.5px solid #06c755', background: '#06c755', color: '#fff', borderRadius: 10, padding: '12px', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.7 : 1 }}>{busy ? '送信中…' : '💬 LINE送信'}</button>
      </div>
    </>
  )
}

// 現場住所のジオコード余り（緯度経度メモ）を除いた表示用住所
function cleanAddr(a) { return String(a || '').replace(/（緯度経度:[^）]*）/g, '').trim() }

// 住所設定（モーダル共用）：住所入力＋地図反映で登録
function AddressAssignBody({ shipment, onSaved, onClose }) {
  const [address, setAddress] = useState(shipment.siteAddress || '')
  const [mapView, setMapView] = useState(shipment.mapView || null)
  const [arrows, setArrows] = useState(Array.isArray(shipment.mapArrows) ? shipment.mapArrows : [])
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const u = await api.put(`/api/shipments/${shipment.id}?assign=1`, { siteAddress: address, mapView, mapArrows: arrows })
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
      <SiteMap address={address} onAddressChange={setAddress} mapView={mapView} onMapViewChange={setMapView} arrows={arrows} onArrowsChange={setArrows} />
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
    Promise.all([api.get('/api/shipments'), api.get('/api/employees?drivers=1')])
      .then(([ss, es]) => { setShipment(ss.find(x => x.id === id) || null); setDrivers(es.filter(e => e.type === 'driver')) })
      .catch(e => console.error(e)).finally(() => setLoading(false))
  }, [id])
  if (loading) return <div style={{ padding: 20, color: '#6b7a8d' }}>読み込み中...</div>
  if (!shipment) return <div style={{ padding: 20, color: '#6b7a8d' }}>対象の出荷が見つかりません。</div>
  return <div style={{ padding: 18, maxWidth: 480, margin: '0 auto' }}><DriverAssignBody shipment={shipment} drivers={drivers} onSaved={() => window.close()} onClose={() => window.close()} /></div>
}

// 伝票キャンセル：伝票を選んでキャンセルすると全リストから非表示になり、ここに保管される
// 出荷登録の伝票（denpyo）レイアウトを流用した読み取り専用ビュー
function DenpyoView({ s }) {
  const times = (Array.isArray(s.times) ? s.times.map(t => (t && t.text != null) ? t.text : t) : []).map(x => String(x ?? '').trim()).filter(Boolean)
  const notes = (Array.isArray(s.notes) ? s.notes.map(n => (n && n.text != null) ? n.text : n) : []).map(x => String(x ?? '').trim()).filter(Boolean)
  const orderDate = String(s.orderDate || (s.createdAt ? String(s.createdAt).slice(0, 10) : '') || '').replace(/-/g, '/')
  const mixes = mixRowsOfShip(s).filter(r => r.code || r.note)
  const cell = (label, flex, content) => (
    <div className="cell" style={{ flex }}>
      <div className="lbl">{label}</div>
      <div style={{ fontSize: 15, color: '#111', minHeight: 18, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</div>
    </div>
  )
  return (
    <div className="denpyo">
      <div className="sheet" style={{ margin: 0 }}>
        <div className="band">
          {cell('受 注 日', '0 0 18%', orderDate || '—')}
          {cell('日 付', '0 0 18%', s.date)}
          {cell('業 者 名', '1 1 0', s.companyName || '—')}
          {cell('商 社 名', '1 1 0', s.tradingCompany || '—')}
        </div>
        <div className="band">
          {cell('時 間', '0 0 24%', times.join(' / ') || '—')}
          {cell('現 場 名', '1 1 0', s.siteName || '—')}
        </div>
        <div className="band">
          {cell('現 場 住 所', '1 1 0', cleanAddr(s.siteAddress) || '未入力')}
        </div>
        <div className="band">
          {cell('車 種', '0 0 16%', vehicleLabel(s) || '—')}
          {cell('打設箇所', '0 0 16%', s.pourLocation || '—')}
          {cell('配 合', '1 1 0', mixes.length ? mixes.map((r, i) => <div key={i}>{r.code}{r.note ? `（${r.note}）` : ''}</div>) : '—')}
          {cell('セメント種', '0 0 12%', s.cementType || '—')}
          {cell('試 験', '0 0 14%', (s.testTags || []).join('・') || '—')}
        </div>
        <div className="band">
          {cell('数 量', '0 0 24%', shipVolStr(s) || '—')}
          {cell('荷下ろし', '1 1 0', (Array.isArray(s.placements) ? s.placements : []).join('・') || '—')}
          {cell('特 記', '0 0 24%', (Array.isArray(s.noteTags) ? s.noteTags : []).join('・') || '—')}
        </div>
        <div className="band">
          {cell('連 絡 先', '1 1 0', s.orderContact || '—')}
          {cell('現場連絡先', '1 1 0', s.siteContact || '—')}
        </div>
        <div className="band">
          {cell('備 考', '1 1 0', notes.length ? notes.map((n, i) => <div key={i}>・{n}</div>) : '—')}
        </div>
        <div className="band">
          {cell('担当ドライバー', '1 1 0', driversOf(s).join('・') || '—')}
          {cell('PDF', '0 0 22%', s.hasPdf
            ? <a href={`/api/shipments?id=${encodeURIComponent(s.id)}&pdf=1`} onClick={(e) => { e.preventDefault(); window.open(`/api/shipments?id=${encodeURIComponent(s.id)}&pdf=1`, '_blank', 'width=900,height=1000') }} style={{ color: '#1a4d8f', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' }}>📄 PDFを開く</a>
            : '—')}
        </div>
      </div>
    </div>
  )
}

// キャンセル伝票：削除（キャンセル）した伝票の保管庫。復元すると元に戻り一覧から消える
function CancelPage() {
  const [cancelled, setCancelled] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(null)        // 復元処理中の伝票id
  const [detail, setDetail] = useState(null)    // フォーム表示中の伝票
  const load = useCallback(async () => {
    try { const c = await api.get('/api/shipments?cancelled=1'); setCancelled(Array.isArray(c) ? c : []) }
    catch (e) { console.error(e) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useShipmentsChanged(load)

  const restore = async (s) => {
    setBusy(s.id)
    try { await api.put(`/api/shipments/${s.id}?cancel=1`, { cancelled: false }); notifyShipmentsChanged(); setDetail(null); await load() }
    catch (e) { alert('エラー: ' + e.message) } finally { setBusy(null) }
  }

  const q = search.trim().toLowerCase()
  const matchS = (s) => !q || [s.date, s.companyName, s.tradingCompany, s.siteName, firstTimeOf(s)].some(v => String(v || '').toLowerCase().includes(q))
  const rows = [...cancelled.filter(matchS)].sort((a, b) => String(b.cancelledAt || b.date || '').localeCompare(String(a.cancelledAt || a.date || '')))

  return (
    <div style={RPT.wrap}>
      <h2 style={{ margin: '0 0 6px', color: '#1a2332' }}>🗑️ キャンセル伝票</h2>
      <div style={{ fontSize: 13, color: '#6b7a8d', marginBottom: 12 }}>削除（キャンセル）した伝票がここに保管されます。右の「復元」を押すと元に戻り、この一覧から消えます。</div>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 日付・業者名・現場名で絞り込み"
        style={{ width: '100%', maxWidth: 420, padding: '9px 12px', border: '1.5px solid #dde3ed', borderRadius: 8, fontSize: 14, outline: 'none', marginBottom: 14 }} />
      {loading ? <div style={{ color: '#6b7a8d' }}>読み込み中...</div>
        : rows.length === 0 ? <div style={{ color: '#9aa7b5', fontSize: 13 }}>キャンセル伝票はありません</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: '10px 14px', opacity: 0.92 }}>
                  <span onClick={() => setDetail(s)} style={{ flex: '1 1 260px', minWidth: 0, cursor: 'pointer' }} title="クリックで伝票を表示">
                    <span style={{ fontSize: 13, color: '#3a4a5c' }}>{s.date}　<b style={{ color: '#c0392b' }}>{firstTimeOf(s) || ''}</b>　</span>
                    <b>{s.companyName}</b>{s.siteName ? <span style={{ color: '#6b7a8d' }}> ／ {s.siteName}</span> : ''}
                  </span>
                  <button type="button" onClick={() => setDetail(s)} style={{ flex: '0 0 auto', border: '1.5px solid #1a4d8f', background: '#fff', color: '#1a4d8f', borderRadius: 8, padding: '7px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>📄 表示</button>
                  <button type="button" disabled={busy === s.id} onClick={() => restore(s)} style={{ flex: '0 0 auto', border: '1.5px solid #1a8f5a', background: '#1a8f5a', color: '#fff', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', opacity: busy === s.id ? 0.7 : 1 }}>{busy === s.id ? '復元中…' : '↩ 復元'}</button>
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
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button type="button" onClick={() => setDetail(null)} disabled={busy} style={{ flex: 1, border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>閉じる</button>
              <button type="button" onClick={() => restore(detail)} disabled={busy} style={{ flex: 1, border: 'none', background: '#1a8f5a', color: '#fff', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.7 : 1 }}>{busy ? '復元中…' : '↩ 復元する'}</button>
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
  const useModal = isPopup || stacked   // 別ウィンドウ内 or スマホ/iPad は振替モーダル、PC(アプリ内)は別ウィンドウ
  const urlDate = (typeof window !== 'undefined') ? new URLSearchParams(window.location.search).get('date') : null
  const [date, setDate] = useState(() => (isPopup && urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate)) ? urlDate : localToday())
  const [all, setAll] = useState([])
  const [drivers, setDrivers] = useState([])
  const [loading, setLoading] = useState(true)
  const [assignTarget, setAssignTarget] = useState(null)
  const [addrTarget, setAddrTarget] = useState(null)
  const load = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([api.get('/api/shipments'), api.get('/api/employees?drivers=1')])
      setAll(s); setDrivers(e.filter(x => x.type === 'driver'))
    } catch (err) { console.error(err) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useShipmentsChanged(load)   // 別ウィンドウで保存されたら再取得して反映

  const rows = all.filter(s => s.date === date)
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
  const wd = (() => { const d = new Date(date); return isNaN(d.getTime()) ? '' : WD[d.getDay()] })()

  return (
    <div style={RPT.wrap}>
      <div style={RPT.head}>
        <h2 style={{ margin: 0, color: '#1a2332' }}>🔁 配送割り当て{isPopup ? '（共有）' : ''}</h2>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={RPT.date} />
        <span style={{ fontSize: 13, color: '#6b7a8d' }}>（{wd}）</span>
        {!isPopup && (
          <button type="button" onClick={openBoard}
            style={{ border: '1.5px solid #0f3060', background: '#fff', color: '#0f3060', borderRadius: 7, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>⛶ 別ウィンドウで開く（ログイン不要・共有可）</button>
        )}
        {isPopup && (
          <button type="button" onClick={() => window.close()}
            style={{ marginLeft: 'auto', border: '1.5px solid #0f3060', background: '#0f3060', color: '#fff', borderRadius: 7, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>✕ 閉じる</button>
        )}
      </div>
      {loading ? <div style={{ color: '#6b7a8d' }}>読み込み中...</div>
        : rows.length === 0 ? <div style={{ color: '#6b7a8d' }}>この日（{date}）の出荷登録はありません</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map(s => {
                const addr = cleanAddr(s.siteAddress)
                const addrCell = addr ? <span style={{ color: '#3a4a5c' }}>{addr}</span> : <span style={{ color: '#c0392b' }}>未入力</span>
                if (stacked) {
                  // スマホ/iPad：縦カード（1.時刻/業者名/現場名 2.LINE送信 3.住所+住所設定）。ボタンは同じ幅で右端を揃える
                  const cardBtnBase = { flex: '0 0 116px', borderRadius: 8, padding: '8px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer', textAlign: 'center', whiteSpace: 'nowrap' }
                  return (
                    <div key={s.id} style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, color: '#c0392b' }}>{firstTimeOf(s) || '—'}</span>
                        <span style={{ fontWeight: 700 }}>{s.companyName}</span>
                        <span style={{ color: '#6b7a8d' }}>{s.siteName || ''}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>住所: {addrCell}</span>
                        <button type="button" onClick={() => setAddrTarget(s)} style={{ ...cardBtnBase, border: '1.5px solid #1a6a9f', background: '#fff', color: '#1a6a9f' }}>📍 住所設定</button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ flex: 1, minWidth: 0 }} />
                        <button type="button" onClick={() => openAssign(s)} style={{ ...cardBtnBase, border: '1.5px solid #06c755', background: '#06c755', color: '#fff' }}>💬 LINE送信</button>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: '10px 14px' }}>
                    <span style={{ flex: '0 0 auto', fontWeight: 700, color: '#c0392b', minWidth: 56 }}>{firstTimeOf(s) || '—'}</span>
                    <span style={{ flex: '1 1 130px', minWidth: 0, fontWeight: 600 }}>{s.companyName}</span>
                    <span style={{ flex: '1 1 130px', minWidth: 0, color: '#3a4a5c' }}>{s.siteName || '—'}</span>
                    <span style={{ flex: '1 1 140px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>住所: {addrCell}</span>
                    <button type="button" onClick={() => setAddrTarget(s)} style={{ flex: '0 0 auto', border: '1.5px solid #1a6a9f', background: '#fff', color: '#1a6a9f', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>📍 住所設定</button>
                    <button type="button" onClick={() => openAssign(s)} style={{ flex: '0 0 auto', border: '1.5px solid #06c755', background: '#06c755', color: '#fff', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>💬 LINE送信</button>
                  </div>
                )
              })}
            </div>
          )}
      {assignTarget && (
        <div onClick={() => setAssignTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', width: '100%', maxWidth: 480, borderRadius: 14, padding: 18, maxHeight: '88dvh', overflowY: 'auto' }}>
            <DriverAssignBody shipment={assignTarget} drivers={drivers} onSaved={onModalSaved} onClose={() => setAssignTarget(null)} />
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
]

function Layout({ children, activeTab, onTabChange }) {
  const { user, logout } = useAuth()
  const [open, setOpen]   = useState(false)
  const isMobile = useIsMobile()
  const isPC = !isMobile
  // スマホでは生コン出荷予定表出力タブを表示しない
  const navTabs = TABS.filter(t => !(isMobile && t.id === 'seikon'))

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
    return <div className="popup-print-root" style={{ height: '100dvh', overflow: 'auto', background: '#fff' }}><DriverAssignPopupPage id={params.get('id') || ''} /></div>
  }

  let page = activeTab === 'dashboard' ? <DashboardPage />
    : activeTab === 'customers' ? <CustomersPage />
    : activeTab === 'employees' ? <EmployeesPage />
    : activeTab === 'shipments' ? <ShipmentsPage editTarget={editTarget} onEditConsumed={() => setEditTarget(null)} pendingEditId={pendingEditId} onPendingConsumed={() => setPendingEditId('')} isPopup={isPopup} />
    : activeTab === 'schedule' ? <SchedulePage isPopup={isPopup} onEditShipment={(s) => { setEditTarget(s); setActiveTab('shipments') }} />
    : activeTab === 'weekly' ? <WeeklySchedulePage />
    : activeTab === 'seikon' ? (isMobile && !isPopup
      ? <div style={{ padding: 24, color: '#6b7a8d' }}>生コン出荷予定表出力はパソコンからご利用ください。</div>
      : <SeikonOutputPage isPopup={isPopup} />)
    : activeTab === 'assign' ? <AssignPage isPopup={isPopup} />
    : activeTab === 'cancel' ? <CancelPage />
    : activeTab === 'shipreport' ? <ShipReportPage />
    : activeTab === 'driverreport' ? <DriverReportPage />
    : activeTab === 'settings' ? <SettingsPage />
    : null
  // 準備中タブは未アンロックならパスワード画面を表示
  if (LOCKED_TABS.includes(activeTab) && !unlocked[activeTab]) {
    page = <LockedPage onUnlock={() => setUnlocked(u => ({ ...u, [activeTab]: true }))} />
  }

  // 別ウィンドウ（ポップアップ）はサイドバー無しでその画面だけ表示
  if (isPopup) return <div className="popup-print-root" style={{ height: '100dvh', overflow: 'auto', background: '#fff' }}>{page}</div>

  return <Layout activeTab={activeTab} onTabChange={setActiveTab}>{page}</Layout>
}

export default function App() {
  return <AuthProvider><AppInner /></AuthProvider>
}
