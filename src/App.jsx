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

  const filtered = customers.filter(c => {
    if (!search) return true
    const q = String(search).toLowerCase()
    return [c.customerCode, c.companyName, c.companyNameKana, c.phone, c.address, c.contactPerson]
      .some(v => String(v || '').toLowerCase().includes(q))
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
const PLACEMENT_TYPES = ['クレーン', 'F1', 'ポンプ']
const DEFAULT_SITE_ADDRESS = '〒842-0121 佐賀県神埼市神埼町志波屋２０２０'

const emptyShipForm = {
  date: localToday(),
  companyId: '', companyName: '',
  tradingCompany: '',
  times: [{ text: '', important: false }],
  siteName: '',
  siteAddress: '',
  vehicleType: '',
  truckCount: '',
  mixCode: '',
  specialNote: '',
  mixNotes: ['', '', ''],
  cementType: '',
  volume: '',
  volumeUncertain: false,
  placements: [],
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
  const refit = () => requestAnimationFrame(() => {
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
  const PAGE_SIZE = 10
  // 直近7日（本日起点）の日付配列
  const weekDates = (() => {
    const base = new Date()
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base); d.setDate(base.getDate() + i)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
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

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))
  const setVal = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handleCompany = (e) => {
    const c = customers.find(c => c.id === e.target.value)
    setForm(f => ({ ...f, companyId: c?.id || '', companyName: c?.companyName || '' }))
  }

  const handleCompanyInput = (e) => {
    const v = e.target.value
    const c = customers.find(c => c.companyName === v)
    setForm(f => ({ ...f, companyId: c?.id || '', companyName: v }))
  }

  const setMix = (i, v) => setForm(f => {
    const parts = String(f.mixCode || '').split('-')
    while (parts.length < 3) parts.push('')
    parts[i] = v.replace(/\D/g, '').slice(0, 2)
    return { ...f, mixCode: parts.slice(0, 3).join('-') }
  })
  const mixPart = (i) => (String(form.mixCode || '').split('-')[i] || '')
  const setMixNote = (i, v) => setForm(f => {
    const n = Array.isArray(f.mixNotes) ? [...f.mixNotes] : ['', '', '']
    while (n.length < 3) n.push('')
    n[i] = v
    return { ...f, mixNotes: n }
  })
  const mixNote = (i) => (Array.isArray(form.mixNotes) ? (form.mixNotes[i] || '') : '')

  const addDriver = (e) => {
    const emp = employees.find(emp => emp.id === e.target.value)
    if (!emp) return
    setForm(f => (f.drivers.length >= 4 || f.drivers.some(d => d.id === emp.id))
      ? f : ({ ...f, drivers: [...f.drivers, { id: emp.id, name: emp.name }] }))
  }
  const removeDriver = (i) => setForm(f => ({ ...f, drivers: f.drivers.filter((_, idx) => idx !== i) }))

  const firstTime = (s) => Array.isArray(s.times) ? (s.times[0] || '') : ''
  const sortShip = (arr) => [...arr].sort((a, b) => (String(a.date) + firstTime(a)).localeCompare(String(b.date) + firstTime(b)))

  const toForm = (s) => ({
    date: s.date || localToday(),
    companyId: s.companyId || '',
    companyName: s.companyName || '',
    tradingCompany: s.tradingCompany || '',
    times: (Array.isArray(s.times) && s.times.length ? s.times : ['']).map(t => ({ text: String(t ?? ''), important: false })),
    siteName: s.siteName || '',
    siteAddress: (s.siteAddress || '').replace(/（緯度経度:[^）]*）/g, '').trim(),
    vehicleType: s.vehicleType || '',
    truckCount: (s.truckCount ?? '') === '' ? '' : String(s.truckCount),
    mixCode: s.mixCode || '',
    specialNote: s.specialNote || '',
    mixNotes: (Array.isArray(s.mixNotes) && s.mixNotes.length) ? [s.mixNotes[0] || '', s.mixNotes[1] || '', s.mixNotes[2] || ''] : [s.specialNote || '', '', ''],
    cementType: s.cementType || '',
    volume: (s.volume ?? '') === '' ? '' : String(s.volume),
    volumeUncertain: !!s.volumeUncertain,
    placements: Array.isArray(s.placements) ? s.placements : [],
    orderContact: s.orderContact || '',
    siteContact: s.siteContact || '',
    drivers: Array.isArray(s.drivers) ? s.drivers : (s.driverName ? [{ id: s.driverId || '', name: s.driverName }] : []),
    notes: (Array.isArray(s.notes) && s.notes.length ? s.notes : [{ text: '', important: false }]).map(n => ({ text: String(n.text ?? ''), important: !!n.important })),
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

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const payload = {
        ...form,
        times: form.times.map(t => t.text).filter(t => t.trim() !== ''),
        notes: form.notes.filter(n => n.text.trim() !== ''),
        driverMessages: form.driverMessages.filter(n => n.text.trim() !== ''),
      }
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

  const handleDelete = async (id) => {
    try {
      await api.del(`/api/shipments/${id}`)
      setDeleteConfirm(null)
      setShipments(ss => ss.filter(s => s.id !== id))
    } catch (e) { alert('エラー: ' + e.message) }
  }

  // 商社名プルダウン候補：既存出荷で入力された商社名を重複なしで集める
  const tradingOptions = Array.from(new Set(
    shipments.map(s => (s.tradingCompany || '').trim()).filter(Boolean)
  )).sort()

  const filtered = shipments.filter(s => {
    if (dateFilter && s.date !== dateFilter) return false
    if (!search) return true
    const q = search.toLowerCase()
    return [s.date, s.companyName, s.tradingCompany, s.siteName, s.mixCode, s.vehicleType]
      .some(v => String(v || '').toLowerCase().includes(q))
  })
  // 直近に登録したものを一番上に（登録日時の新しい順）
  const sortedList = [...filtered].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  // 10件ずつページング
  const pageCount = Math.max(1, Math.ceil(sortedList.length / PAGE_SIZE))
  const curPage = Math.min(page, pageCount - 1)
  const pageRows = sortedList.slice(curPage * PAGE_SIZE, curPage * PAGE_SIZE + PAGE_SIZE)
  // 検索・日付絞り込みが変わったら1ページ目へ
  useEffect(() => { setPage(0) }, [search, dateFilter])

  // 予定表で変更された項目を赤く表示
  const redIf = (f) => editChanged.includes(f) ? { color: '#c81e1e' } : undefined

  return (
    <div ref={topRef} style={{ height: '100%', overflow: 'auto' }}>
      {/* 手配伝票フォーム */}
      <div className="denpyo" style={{ padding: isMobile ? '12px 8px' : '16px 12px', background: '#f3f1ec', borderBottom: '2px solid #dde3ed' }}>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', flexWrap: 'nowrap', gap: stacked ? 12 : 28, alignItems: 'stretch', justifyContent: 'center' }}>
          <FitToWidth width={700} max={stacked ? 1 : 1} style={{ flex: stacked ? '0 0 auto' : '0 0 700px', minWidth: 0 }}>
          <div className="sheet" style={{ margin: 0 }}>
            {/* 1段: 日付 / 業者名 / 商社名 */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 24%' }}>
                <div className="lbl">日 付</div>
                <input className="f" type="date" value={form.date} onChange={set('date')} required />
              </div>
              <div className="cell" style={{ flex: '0 0 45%' }}>
                <div className="lbl" style={redIf('companyName')}>業 者 名</div>
                <input className="f" style={redIf('companyName')} list="customerList" value={form.companyName} onChange={handleCompanyInput} placeholder="入力して検索" required />
                <datalist id="customerList">
                  {customers.map(c => <option key={c.id} value={c.companyName} />)}
                </datalist>
              </div>
              <div className="cell" style={{ flex: 1 }}>
                <div className="lbl" style={redIf('tradingCompany')}>商 社 名</div>
                <input className="f" style={redIf('tradingCompany')} list="tradingList" value={form.tradingCompany} onChange={set('tradingCompany')} placeholder="入力して選択" />
                <datalist id="tradingList">
                  {tradingOptions.map(t => <option key={t} value={t} />)}
                </datalist>
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

            {/* 4段: 車種 / 配合・m³ / セメント種・配置 */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 24%', minHeight: 140, justifyContent: 'space-between' }}>
                <div>
                  <div className="lbl" style={redIf('vehicleType')}>車 種</div>
                  <Chips options={VEHICLE_TYPES} value={form.vehicleType} onChange={v => setVal('vehicleType', v)} multiStr big />
                </div>
              </div>
              <div className="cell stack" style={{ flex: 1, padding: 0 }}>
                <div className="subrow">
                  <div className="cell" style={{ flex: '0 0 56%', minWidth: 0 }}>
                    <div className="lbl" style={redIf('mixCode')}>配 合</div>
                    <div className="haigou3" style={redIf('mixCode')}>
                      <div className="hgcol">
                        <div className="hgnote-spacer" />
                        <input className="hg" inputMode="numeric" maxLength={2} value={mixPart(0)} onChange={e => setMix(0, e.target.value)} />
                      </div>
                      <span className="hgsep">-</span>
                      <div className="hgcol">
                        <input className="hgnote" placeholder="特記" value={mixNote(1)} onChange={e => setMixNote(1, e.target.value)} />
                        <input className="hg" inputMode="numeric" maxLength={2} value={mixPart(1)} onChange={e => setMix(1, e.target.value)} />
                      </div>
                      <span className="hgsep">-</span>
                      <div className="hgcol">
                        <div className="hgnote-spacer" />
                        <input className="hg" inputMode="numeric" maxLength={2} value={mixPart(2)} onChange={e => setMix(2, e.target.value)} />
                      </div>
                    </div>
                  </div>
                  <div className="cell" style={{ flex: '0 0 44%', minWidth: 0 }}>
                    <div className="lbl">セメント種</div>
                    <Chips options={CEMENT_TYPES} value={form.cementType} onChange={v => setVal('cementType', v)} big />
                  </div>
                </div>
                <div className="subrow">
                  <div className="cell m3" style={{ flex: '0 0 56%', minWidth: 0, justifyContent: 'center' }}>
                    <div className="inline" style={{ justifyContent: 'center' }}>
                      <input type="number" min="0" step="0.01" inputMode="decimal" style={redIf('volume')} value={form.volume} onChange={set('volume')} />
                      <span className="unit" style={redIf('volume')}>m<sup>3</sup><span className={'qmark' + (form.volumeUncertain ? ' on' : '')}>?</span></span>
                    </div>
                    <label className="qtoggle"><input type="checkbox" checked={form.volumeUncertain} onChange={e => setVal('volumeUncertain', e.target.checked)} />？を付ける</label>
                  </div>
                  <div className="cell" style={{ flex: '0 0 44%', minWidth: 0 }}>
                    <Chips options={PLACEMENT_TYPES} value={form.placements} multi onChange={v => setVal('placements', v)} big />
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

            {/* 6段: 備考 */}
            <div className="band">
              <div className="cell" style={{ flex: 1 }}>
                <div className="lbl" style={redIf('notes')}>備 考</div>
                <DenpyoGrid items={form.notes} onChange={v => setVal('notes', v)} cols={2} max={2} height={90} addLabel="＋ 段落を追加" />
              </div>
            </div>

            {/* 7段: 担当ドライバー / ドライバーへの連絡 */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 30%' }}>
                <div className="lbl" style={{ ...redIf('drivers'), fontSize: 11, letterSpacing: '.06em' }}>担当ドライバー（最大4）</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
                  {form.drivers.map((d, i) => (
                    <span key={d.id || i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid #1b4ea8', background: '#e8f0ff', color: '#1b4ea8', borderRadius: 5, padding: '2px 6px', fontSize: 13 }}>
                      {d.name}
                      <button type="button" onClick={() => removeDriver(i)} style={{ border: 'none', background: 'none', color: '#1b4ea8', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
                {form.drivers.length < 4 && (
                  <select className="f" value="" onChange={addDriver} style={{ marginTop: 5 }}>
                    <option value="">＋ ドライバーを追加</option>
                    {employees.filter(e => !form.drivers.some(d => d.id === e.id)).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                )}
              </div>
              <div className="cell" style={{ flex: 1 }}>
                <div className="lbl" style={{ fontSize: 11, letterSpacing: '.06em' }}>ドライバーへの連絡</div>
                <DenpyoGrid items={form.driverMessages} onChange={v => setVal('driverMessages', v)} cols={2} height={80} addLabel="＋ 段落を追加" />
              </div>
            </div>
          </div>
          </FitToWidth>
          <div style={{ flex: stacked ? '0 0 auto' : '0 0 640px', width: stacked ? '100%' : undefined, minWidth: stacked ? 0 : 280 }}>
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
          {/* 直近7日の日付ボタン（横スクロール可）。押したボタンは解除ボタンに変化 */}
          <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', gap: 6, overflowX: 'auto', padding: '2px 0', WebkitOverflowScrolling: 'touch' }}>
            {weekDates.map((d, i) => {
              const active = dateFilter === d
              const label = i === 0 ? '本日' : `${parseInt(d.slice(5, 7), 10)}/${parseInt(d.slice(8, 10), 10)}`
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
        <div style={S.countBar}>{loading ? '読み込み中...' : `${filtered.length} 件中 ${filtered.length === 0 ? 0 : curPage * PAGE_SIZE + 1}〜${Math.min((curPage + 1) * PAGE_SIZE, filtered.length)} 件を表示`}</div>

        {loading ? (
          <div style={S.empty}>読み込み中...</div>
        ) : filtered.length === 0 ? (
          <div style={S.empty}>{search ? '検索結果がありません' : '出荷登録がありません'}</div>
        ) : (
          <div className="tw-scroll" style={{ ...S.tableWrap, overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {['日付', '時間', '業者名', '商社名', '現場名', 'ドライバー', '車種', '配合', 'セメント', 'm³', '荷下ろし', ''].map((h, i) => (
                    <th key={i} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map(s => (
                  <tr key={s.id} style={{ ...S.tr, cursor: 'pointer', background: editing === s.id ? '#eef5ff' : undefined }} onClick={() => startEdit(s)}>
                    <td style={S.td}>{s.date}</td>
                    <td style={S.td}>{Array.isArray(s.times) && s.times.length ? s.times.join(' / ') : '—'}</td>
                    <td style={{ ...S.td, fontWeight: 600 }}>{s.companyName}</td>
                    <td style={S.td}>{s.tradingCompany || '—'}</td>
                    <td style={S.td}>{s.siteName || '—'}</td>
                    <td style={S.td}>{Array.isArray(s.drivers) && s.drivers.length ? s.drivers.map(d => d.name).join('・') : (s.driverName || '—')}</td>
                    <td style={S.td}>{s.vehicleType || '—'}</td>
                    <td style={S.td}>{s.mixCode || '—'}</td>
                    <td style={S.td}>{s.cementType || '—'}</td>
                    <td style={S.td}>{s.volume ? `${s.volume}m³${s.volumeUncertain ? '?' : ''}` : (s.volumeUncertain ? '?' : '—')}</td>
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

        {!loading && filtered.length > PAGE_SIZE && (
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
            <p style={{ marginBottom: 16, color: '#1a2332', fontSize: 14 }}>この出荷登録を削除しますか？</p>
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
// 出荷予定表ページ
// ============================================================
const SCHEDULE_FIELD_LABELS = {
  companyName: '業者名', tradingCompany: '商社名', siteName: '現場名',
  vehicleType: '車種', mixCode: '配合', volume: '量', drivers: '担当',
  times: '時間', notes: '備考', siteContact: '現場連絡先',
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
  if (norm(orig.volume) !== norm(next.volume) || !!orig.volumeUncertain !== !!next.volumeUncertain) changed.push('volume')
  const origPlace = Array.isArray(orig.placements) ? orig.placements : []
  const nextPlace = Array.isArray(next.placements) ? next.placements : []
  if (!eq(origPlace, nextPlace)) changed.push('placements')
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
  const [date, setDate] = useState(() => localToday())
  useAutoToday(setDate)   // 0:00を跨いだら本日表示中は自動で当日へ繰り上げ
  const [all, setAll] = useState([])
  const [loading, setLoading] = useState(true)
  const [editModal, setEditModal] = useState(null)   // スマホ：編集モーダルで開いている伝票
  const [drivers, setDrivers] = useState([])         // 担当ドライバー選択用（従業員=driver）

  const load = useCallback(async () => {
    try { setAll(await api.get('/api/shipments')) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.get('/api/employees').then(e => setDrivers((e || []).filter(emp => emp.type === 'driver'))).catch(() => {})
  }, [])

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
  // 時間を分に変換してソート。午前=11:59(719分)・午後=23:59(1439分)扱い、空欄は最後
  const timeToMin = (t) => {
    const str = String(t || '').trim()
    if (!str) return 100000
    const m = str.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/)
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
    if (str.includes('午前')) return 11 * 60 + 59   // 11:59
    if (str.includes('午後')) return 23 * 60 + 59   // 23:59
    const h = str.match(/(\d{1,2})\s*時/)
    if (h) return parseInt(h[1], 10) * 60
    return 99999   // 解析できない文字 → 空欄の手前
  }
  const rows = all.filter(s => s.date === date)
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
      case 'notes': return (Array.isArray(s.notes) ? s.notes.map(n => n.text) : []).join(' / ')
      case 'volume': return (s.volume == null ? '' : String(s.volume)) + (s.volumeUncertain ? '  ?' : '')
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

  // 配合：18-13-20 を桁グループごとに分割描画。変更された桁(mix0/mix1/mix2)だけ赤くする
  const cellMix = (s, opts = {}) => {
    const parts = String(s.mixCode || '').split('-')
    const cls = 'sc-mixcode' + (opts.big ? ' big' : '') + (opts.center ? ' center' : '')
    // 全体変更(旧データ＝mixCodeのみ)の場合は全桁を赤に（後方互換）
    const wholeRed = isChanged(s, 'mixCode') && !['mix0', 'mix1', 'mix2'].some(k => isChanged(s, k))
    if (!parts.length || !String(s.mixCode || '').trim()) {
      return <span ref={fitRef} className={cls} style={{ pointerEvents: 'none' }} />
    }
    return (
      <span ref={fitRef} className={cls} key={'mix' + (isChanged(s, 'mixCode') ? '_c' : '')} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>
        {parts.map((p, i) => (
          <Fragment key={i}>
            {i > 0 && <span>-</span>}
            <span style={{ color: (wholeRed || isChanged(s, 'mix' + i)) ? '#c81e1e' : undefined }}>{p}</span>
          </Fragment>
        ))}
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

  const sendLine = async (s) => {
    const shipDrivers = Array.isArray(s.drivers) ? s.drivers : []
    if (shipDrivers.length === 0) { alert('担当が入っていません'); return }
    // 担当ドライバー → 従業員管理のLINEユーザーIDを解決（id一致、なければ氏名一致）
    // lineId はコピペ混入の空白・改行・不可視文字を除去してから使う
    const cleanId = (v) => String(v || '').replace(/[\s　​-‍﻿]/g, '').trim()
    const resolved = shipDrivers.map(d => {
      const emp = drivers.find(e => (d.id && e.id === d.id) || e.name === d.name)
      return { name: d.name, lineId: cleanId(emp?.lineId) }
    })
    const withId = resolved.filter(r => r.lineId)
    const without = resolved.filter(r => !r.lineId)
    if (withId.length === 0) {
      alert('担当ドライバーにLINEユーザーIDが紐づいていません。\n従業員管理でLINE IDを設定してください。')
      return
    }
    let msg = `${withId.map(r => r.name).join('、')} にLINEを送信しますか？`
    if (without.length) msg += `\n（LINE未設定のためスキップ: ${without.map(r => r.name).join('、')}）`
    if (!window.confirm(msg)) return
    try {
      const res = await api.post('/api/line', { action: 'pushShipment', shipmentId: s.id, lineUserIds: withId.map(r => r.lineId) })
      const fails = (res.results || []).filter(r => !r.ok)
      let msg = `送信しました（${res.sent}/${res.total} 件成功）`
      if (fails.length) {
        // 失敗したIDと担当名・理由を表示
        const lines = fails.map(f => {
          const who = withId.find(w => w.lineId === f.to)
          return `・${who ? who.name : ''}（${f.to}）\n  ${f.error || '不明なエラー'}`
        })
        msg += `\n\n■ 送信失敗:\n${lines.join('\n')}`
      }
      alert(msg)
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

  return (
    <div className={isPopup ? 'schedule-popup-root' : ''} style={{ height: '100%', overflow: 'auto', background: '#fff' }}>
      {isPopup ? (
        /* 別ウィンドウ: タイトルを画面中央に絶対配置し、日付(左)/閉じる(右)を両端に重ねる */
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 12px', borderBottom: '1px solid #e5e9f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto', position: 'relative', zIndex: 1 }}>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              style={{ fontSize: 13, padding: '4px 6px', border: '1.5px solid #bbb', borderRadius: 6 }} />
            <span style={{ fontSize: 13, color: '#111' }}>（{weekday}）</span>
          </div>
          <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', fontSize: 16, fontWeight: 700, color: '#111', letterSpacing: '0.2em', whiteSpace: 'nowrap', pointerEvents: 'none' }}>出荷予定表</div>
          <button type="button" onClick={() => window.close()}
            style={{ flex: '0 0 auto', position: 'relative', zIndex: 1, border: '1.5px solid #0f3060', background: '#0f3060', color: '#fff', borderRadius: 7, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>✕ 閉じる</button>
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
                    <div className="sc-box"><span className="sc-lbl">配合</span>{cellMix(s, { center: true, big: true })}{(Array.isArray(s.mixNotes) && (s.mixNotes[1] || '').trim()) ? <div style={{ fontSize: 11, color: '#c81e1e', fontWeight: 700, textAlign: 'center' }}>{s.mixNotes[1]}</div> : null}</div>
                    <div className="sc-box sc-volbox"><span className="sc-lbl">量</span>{cell(s, 'volume', '', { center: true, big: true })}</div>
                  </div>
                  {/* 備考（横並び） */}
                  <div className="sc-row"><span className="sc-lbl">備考</span><span className="sc-val">{cellNotes(s, { plain: true })}</span></div>
                  {/* 現場連絡先 */}
                  <div className="sc-row"><span className="sc-lbl">現場連絡先</span><span className="sc-val">{cell(s, 'siteContact', '現場連絡先')}</span></div>
                  <div className="sc-card-actions">
                    <button type="button" onClick={() => setEditModal(s)}
                      style={{ flex: 1, border: '1px solid #1a8f5a', background: '#f0f9f0', color: '#1a8f5a', borderRadius: 8, padding: '11px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>✏️ 編集</button>
                    <button type="button" onClick={() => sendLine(s)}
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
            <col style={{ width: '10%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '16%' }} />
            {!isPopup && <col style={{ width: '8%' }} />}
          </colgroup>
          <thead>
            <tr>
              <th><div>業者名</div><div>商社</div></th>
              <th>現場名</th><th>車種</th><th>配合</th><th>量</th><th>担当</th><th>時間</th>
              <th><div>備考</div><div>現場連絡先</div></th>
              {!isPopup && <th>編集</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(s => (
              <tr key={s.id}>
                <td>{cell(s, 'companyName', '業者名')}{cell(s, 'tradingCompany', '商社')}</td>
                <td>{cell(s, 'siteName', '', { big: true })}</td>
                <td className="sc-nowrap">{cell(s, 'vehicleType', '', { center: true, big: true, xl: true })}</td>
                <td className="sc-nowrap">
                  {cellMix(s, { center: true, big: true })}
                  {(Array.isArray(s.mixNotes) && (s.mixNotes[1] || '').trim()) ? (
                    <div className="sc-mixnotes">
                      <span /><span style={{ color: (isChanged(s, 'mixnote') || isChanged(s, 'mixCode')) ? '#c81e1e' : undefined }}>{s.mixNotes[1]}</span><span />
                    </div>
                  ) : null}
                </td>
                <td className="sc-nowrap">{cell(s, 'volume', '', { center: true, big: true })}</td>
                <td>{cellDrivers(s, { big: true })}</td>
                <td className="sc-nowrap">{cellMulti(s, 'times', '', { center: true, big: true })}</td>
                <td>{cellNotes(s, { plain: true })}{cell(s, 'siteContact', '現場連絡先')}</td>
                {!isPopup && (
                  <td style={{ textAlign: 'center' }}>
                    <button type="button" onClick={() => openEditWindow(s)}
                      style={{ display: 'block', margin: '0 auto', border: '1px solid #1a8f5a', background: '#f0f9f0', color: '#1a8f5a', borderRadius: 5, padding: '3px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>✏️ 編集</button>
                    <button type="button" onClick={() => sendLine(s)}
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
  const [siteAddress, setSiteAddress] = useState(s.siteAddress || '')
  const [mapView, setMapView] = useState(s.mapView || null)
  const [mapArrows, setMapArrows] = useState(Array.isArray(s.mapArrows) ? s.mapArrows : [])
  const [vehicleType, setVehicleType] = useState(s.vehicleType || '')   // "4t・7t" 連結
  const [mixParts, setMixParts] = useState(() => {
    const p = String(s.mixCode || '').split('-')
    return [p[0] || '', p[1] || '', p[2] || '']
  })
  const [mixNotes, setMixNotes] = useState(() => {
    const n = Array.isArray(s.mixNotes) ? s.mixNotes : []
    return [n[0] || '', n[1] || '', n[2] || '']
  })
  const [volume, setVolume] = useState(s.volume == null ? '' : String(s.volume))
  const [volumeUncertain, setVolumeUncertain] = useState(!!s.volumeUncertain)
  const [drivers, setDrivers] = useState(initDrivers)
  const [notes, setNotes] = useState(Array.isArray(s.notes) ? s.notes.map(n => n.text).join('\n') : '')
  const [siteContact, setSiteContact] = useState(s.siteContact || '')
  const [saving, setSaving] = useState(false)

  // 時間：行ごとに編集／追加／削除（最大2）
  const setTime = (i, v) => setTimes(ts => ts.map((t, idx) => idx === i ? v : t))
  const addTime = () => setTimes(ts => ts.length < 2 ? [...ts, ''] : ts)
  const delTime = (i) => setTimes(ts => ts.length > 1 ? ts.filter((_, idx) => idx !== i) : [''])
  // 配合：3セクション（各2桁）＋各セクションの特記
  const setMixPart = (i, v) => setMixParts(p => p.map((x, idx) => idx === i ? v : x))
  const setMixNote = (i, v) => setMixNotes(n => n.map((x, idx) => idx === i ? v : x))

  // 車種：3種から複数トグル（VEHICLE_TYPESの順を維持）
  const vehList = vehicleType.split('・').map(x => x.trim()).filter(Boolean)
  const toggleVeh = (o) => {
    const next = vehList.includes(o) ? vehList.filter(x => x !== o) : [...vehList, o]
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
    // 配合：3セクションを - 連結（末尾の空欄は落とす）。特記は3要素配列で保持
    const mixCode = mixParts.map(p => p.trim()).join('-').replace(/-+$/, '')
    const mixNotesClean = mixNotes.map(n => n.trim())
    const patch = {
      times: cleanTimes,
      date: date || s.date,
      companyName, tradingCompany, siteName, siteAddress,
      mapView, mapArrows,
      vehicleType, mixCode, mixNotes: mixNotesClean, volume, volumeUncertain,
      drivers: drivers.map(d => ({ id: d.id, name: d.name })),
      notes: notes.split('\n').map(x => x.trim()).filter(Boolean).map(t => ({ text: t, important: false })),
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

        {/* 配合（3セクション・各セクションに特記）＋量（?トグル） */}
        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>配合（中央のみ特記可）</label>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            {[0, 1, 2].map(i => (
              <Fragment key={i}>
                {i > 0 && <span style={{ fontSize: 22, fontWeight: 700, color: '#111', paddingBottom: 8 }}>-</span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {i === 1
                    ? <input value={mixNotes[1]} onChange={e => setMixNote(1, e.target.value)} placeholder="特記"
                        style={{ width: '100%', boxSizing: 'border-box', fontSize: 11, color: '#c0392b', textAlign: 'center', border: 'none', borderBottom: '1px dashed #e7a3a3', outline: 'none', padding: '0 0 2px', fontFamily: 'inherit' }} />
                    : <div style={{ height: 15 }} />}
                  <input value={mixParts[i]} onChange={e => setMixPart(i, e.target.value)} inputMode="numeric" maxLength={2} placeholder="00"
                    style={{ width: '100%', boxSizing: 'border-box', fontSize: 20, fontWeight: 700, textAlign: 'center', border: '1.5px solid #cdd5e0', borderRadius: 8, padding: '8px 4px', fontFamily: 'inherit', color: '#111', marginTop: 3 }} />
                </div>
              </Fragment>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>量（m³）</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input value={volume} onChange={e => setVolume(e.target.value)} inputMode="decimal" style={{ ...inS, flex: 1 }} />
            <button type="button" onClick={() => setVolumeUncertain(v => !v)}
              style={{ flex: '0 0 auto', border: volumeUncertain ? '1.5px solid #c0392b' : '1.5px solid #cdd5e0', background: volumeUncertain ? '#c0392b' : '#fff', color: volumeUncertain ? '#fff' : '#8a97a6', borderRadius: 8, width: 42, height: 40, fontSize: 18, fontWeight: 700, cursor: 'pointer' }} title="不確定マーク">?</button>
          </div>
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

  const vehEntries = Object.entries(todays.reduce((m, s) => { const k = s.vehicleType || '未設定'; m[k] = (m[k] || 0) + 1; return m }, {})).sort((a, b) => b[1] - a[1])
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

          {/* 内訳（車種別・担当別） */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
            {breakdown('今日の車種別', vehEntries, '本日の出荷はありません')}
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
  const ms = new Date(date)   // 選択日（既定は本日）を左端に7日分表示
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(ms); d.setDate(d.getDate() + i); return d })
  const todayStr = localToday()
  return (
    <div style={RPT.wrap}>
      <div style={RPT.head}>
        <h2 style={{ margin: 0, color: '#1a2332' }}>🗓️ 週間出荷予定表</h2>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={RPT.date} />
        <span style={{ fontSize: 13, color: '#6b7a8d' }}>{ymd(days[0])} 〜 {ymd(days[6])}</span>
      </div>
      {loading ? <div>読み込み中...</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6, minWidth: 900 }}>
          {days.map(d => {
            const ds = ymd(d), wd = WD[d.getDay()]
            const list = all.filter(s => s.date === ds).sort((a, b) => String(firstTimeOf(a)).localeCompare(String(firstTimeOf(b))))
            return (
              <div key={ds} style={{ border: '1px solid #dde3ed', borderRadius: 8, minHeight: 220, background: ds === todayStr ? '#eef5ff' : '#fff' }}>
                <div style={{ padding: '6px 8px', borderBottom: '1px solid #dde3ed', fontWeight: 700, fontSize: 13, textAlign: 'center', color: wd === '日' ? '#c0392b' : wd === '土' ? '#1b4ea8' : '#1a2332' }}>{d.getMonth() + 1}/{d.getDate()}（{wd}）</div>
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

function ShipReportPage() {
  const [date, setDate] = useState(() => localToday())
  const { all, loading } = useShipments()
  const rows = all.filter(s => s.date === date).sort((a, b) => String(firstTimeOf(a)).localeCompare(String(firstTimeOf(b))))
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
                <td style={RPT.td}>{s.volume ? `${s.volume}m³` : ''}{s.volumeUncertain ? '?' : ''}</td>
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
          const list = groups[n].sort((a, b) => String(firstTimeOf(a)).localeCompare(String(firstTimeOf(b))))
          const vol = list.reduce((a, s) => a + (parseFloat(s.volume) || 0), 0)
          return (
            <div key={n} style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 700, color: '#0f3060', marginBottom: 6 }}>👤 {n}（{list.length}件 / {vol.toFixed(2)}m³）</div>
              <table style={RPT.table}>
                <thead><tr>{['時間', '業者名', '現場名', '車種', '配合', '量'].map(h => <th key={h} style={RPT.th}>{h}</th>)}</tr></thead>
                <tbody>{list.map(s => (
                  <tr key={s.id}>
                    <td style={RPT.td}>{firstTimeOf(s)}</td><td style={RPT.td}>{s.companyName}</td><td style={RPT.td}>{s.siteName || ''}</td>
                    <td style={RPT.td}>{s.vehicleType || ''}</td><td style={RPT.td}>{s.mixCode || ''}</td><td style={RPT.td}>{s.volume ? `${s.volume}m³` : ''}{s.volumeUncertain ? '?' : ''}</td>
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

function AssignPage() {
  return (
    <div style={RPT.wrap}>
      <h2 style={{ margin: '0 0 12px', color: '#1a2332' }}>🔁 配送臨時割り当て</h2>
      <div style={{ color: '#6b7a8d', maxWidth: 580, lineHeight: 1.9, fontSize: 14 }}>
        この画面の仕様を確認させてください。想定している操作・項目（例：当日の出荷一覧に対して担当ドライバーを素早く割り当て／変更する、急な代替ドライバーを割り当てる、車両の臨時手配など）を教えていただければ、それに合わせて実装します。
      </div>
    </div>
  )
}

// テスト用の出荷登録データ。設定画面からワンタップで投入し、出荷予定表などの動作確認に使う。
// 本日を起点に「1日10件 × 10日分（計100件）」を、各項目ランダムで組み立てる。
function buildTestShipments() {
  const dayStr = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const rint = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min   // min〜max の整数
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
  const dgts = (n) => Array.from({ length: n }, () => rint(0, 9)).join('')        // n桁のランダム数字

  const companies = ['高柳左官', '（有）徳島景画', '山田建設', '九州土木', '佐賀建設', '東肥組', '鳥栖工務店', '大和コンクリート', '神埼建設', '有明工業']
  const tradings  = ['', '東部商事', '生コン商事', '', '九州資材', '', '佐賀生コン商会', '', '西日本建材', '']
  const sites     = ['中学校8', '市民体育館 改修', '県道拡幅工事', '橋梁下部工', '配水池工事', '農道舗装', '小学校体育館', '護岸工事', 'マンション基礎', '排水路改良']
  const addresses = [
    '佐賀県小城市三日月町織島６１３', '佐賀県神埼市神埼町志波屋２０２０', '佐賀県佐賀市本庄町１丁目', '佐賀県鳥栖市本鳥栖町',
    '佐賀県神埼市千代田町餘江', '佐賀県佐賀市大和町尼寺', '佐賀県小城市小城町', '佐賀県三養基郡みやき町', '佐賀県佐賀市諸富町', '佐賀県神埼郡吉野ヶ里町',
  ]
  const driverPool = ['小西公幸', '田中一郎', '佐藤健', '鈴木大輔', '高橋誠', '渡辺隆', '伊藤豊', '山本浩']
  const timeChoices = ['08:00', '08:30', '09:00', '10:00', '10:30', '11:00', '13:00', '14:00', '15:30', '午前', '午後']
  const noteChoices = ['AM', 'FAX', 'バケット→舟下ろし', '(！)23打てばなし', '工TP']

  const rows = []
  for (let day = 0; day < 10; day++) {
    for (let i = 0; i < 10; i++) {
      const idx = rint(0, 9)
      // 時間：1つ または 2つ（重複しないよう選ぶ）
      const nTimes = rint(1, 2)
      const times = []
      while (times.length < nTimes) { const t = pick(timeChoices); if (!times.includes(t)) times.push(t) }
      // 車種：いずれか1つ
      const vehicleType = pick(VEHICLE_TYPES)
      // 配合：左18〜30 / 中12〜18 / 右20
      const mixCode = `${rint(18, 30)}-${rint(12, 18)}-20`
      // 担当ドライバー：1〜4人（重複なし）
      const nDrivers = rint(1, 4)
      const pool = [...driverPool]
      const drivers = Array.from({ length: nDrivers }, () => {
        const k = Math.floor(Math.random() * pool.length)
        return { id: '', name: pool.splice(k, 1)[0] }
      })
      // 備考：ランダムで1つ（候補から）
      const notes = [{ text: pick(noteChoices), important: false }]
      rows.push({
        date: dayStr(day),
        companyName: pick(companies),
        tradingCompany: pick(tradings),
        times,
        siteName: `${pick(sites)}（${day + 1}日目-${i + 1}）`,
        siteAddress: pick(addresses),
        vehicleType,
        mixCode,
        mixNotes: ['', '', ''],
        cementType: pick(CEMENT_TYPES),           // N か B
        volume: String(rint(3, 30)),
        volumeUncertain: false,
        placements: [pick(PLACEMENT_TYPES)],      // クレーン / F1 / ポンプ のいずれか1つ
        orderContact: `${dgts(4)}-${dgts(2)}-${dgts(4)}`,   // 0000-00-0000 形式（ランダム数字）
        drivers,
        notes,
        siteContact: `${dgts(3)}-${dgts(4)}-${dgts(4)}`,    // 000-0000-0000 形式（ランダム数字）
      })
    }
  }
  return rows
}

function SettingsPage() {
  const isMobile = useIsMobile()
  const [token, setToken] = useState('')
  const [data, setData] = useState({ users: [], groups: [], activeGroupCount: 0, hasToken: false, hasSecret: false })
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [usersOpen, setUsersOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try { setData(await api.get('/api/line')) } catch (e) { console.error(e) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

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
  const delGroup = async (groupId) => {
    if (!window.confirm('このグループを一覧から削除しますか？')) return
    try { await api.del(`/api/line?groupId=${encodeURIComponent(groupId)}`); load() } catch (e) { alert(e.message) }
  }
  const importTestShipments = async () => {
    const rows = buildTestShipments()
    if (!window.confirm(`テスト用の出荷登録データを${rows.length}件（1日10件×10日分）インポートします。\nよろしいですか？`)) return
    setImporting(true)
    let ok = 0
    const fails = []
    // 100件を1件ずつ直列だと時間がかかるため、10件ずつ並列で投入する
    const CHUNK = 10
    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK)
      const results = await Promise.allSettled(batch.map(r => api.post('/api/shipments', r)))
      results.forEach((res, k) => {
        if (res.status === 'fulfilled') ok++
        else fails.push(`${batch[k].companyName}: ${res.reason?.message || 'エラー'}`)
      })
    }
    setImporting(false)
    notifyShipmentsChanged()   // 開いている出荷予定表タブに反映
    let msg = `インポート完了：${ok}/${rows.length}件 登録しました。\n「出荷予定表」で確認できます。`
    if (fails.length) msg += `\n\n失敗（先頭5件）:\n${fails.slice(0, 5).join('\n')}`
    alert(msg)
  }
  const deleteAllShipments = async () => {
    if (!window.confirm('現在登録されている出荷登録データを「すべて」削除します。\nこの操作は元に戻せません。よろしいですか？')) return
    if (!window.confirm('本当に全件削除してよろしいですか？（最終確認）')) return
    setDeleting(true)
    try {
      const res = await api.del('/api/shipments?all=1')
      notifyShipmentsChanged()
      alert(`削除しました（${res.deleted ?? 0}件）`)
    } catch (e) { alert('削除に失敗しました: ' + e.message) } finally { setDeleting(false) }
  }
  const copy = () => { navigator.clipboard?.writeText(webhookUrl); alert('Webhook URLをコピーしました') }
  const copyText = (t) => { navigator.clipboard?.writeText(t); alert('コピーしました\n' + t) }
  const fmtDT = (s) => { const d = new Date(s); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const VIA_LABELS = { join: '招待', message: 'メッセージ' }

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
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>🧪 テスト用データ</h3>
        <div style={{ fontSize: 13, color: '#3a4a5c', marginBottom: 12, lineHeight: 1.7 }}>
          動作確認用の出荷登録データ（本日から10日分・1日10件＝計100件）をまとめて登録します。<br />
          登録後は「出荷予定表」や「出荷登録」で内容を確認・編集・削除できます。
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={importTestShipments} disabled={importing || deleting}
            style={{ ...S.addBtn, padding: '10px 16px', fontSize: 13, opacity: (importing || deleting) ? 0.6 : 1 }}>
            {importing ? 'インポート中…' : '＋ テスト用の出荷登録をインポート'}
          </button>
          <button onClick={deleteAllShipments} disabled={importing || deleting}
            style={{ ...S.dangerBtn, padding: '10px 16px', fontSize: 13, opacity: (importing || deleting) ? 0.6 : 1 }}>
            {deleting ? '削除中…' : '🗑 出荷登録データを全件削除'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: '#c0392b', marginTop: 8 }}>
          ※「全件削除」は現在登録されている出荷登録をすべて消します（元に戻せません）。
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

      <div style={{ ...box, maxWidth: 980 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: usersOpen ? 12 : 0, gap: 8 }}>
          <button
            onClick={() => setUsersOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 15, fontWeight: 700, color: '#1a2332', textAlign: 'left' }}
          >
            <span style={{ fontSize: 12, color: '#6b7a8d', width: 12, display: 'inline-block' }}>{usersOpen ? '▼' : '▶'}</span>
            登録済みLINEユーザー・グループ（友だち追加・グループ招待時に自動登録）
            <span style={{ fontSize: 12, fontWeight: 400, color: '#6b7a8d' }}>ユーザー{(data.users || []).length}・グループ{data.activeGroupCount || 0}</span>
          </button>
          {usersOpen && <button onClick={load} style={S.editBtn}>🔄 更新</button>}
        </div>
        {usersOpen && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 18 }}>
            {/* 左：登録済みユーザー */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#3a4a5c', marginBottom: 8 }}>👤 ユーザー <span style={{ fontWeight: 400, color: '#9aa7b5' }}>{(data.users || []).length}件</span></div>
              {loading ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>読み込み中...</div>
                : (data.users || []).length === 0 ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>まだ登録がありません（公式アカウントを友だち追加すると自動で登録されます）</div>
                  : data.users.map((u) => (
                    <div key={u.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid #eef0f4' }}>
                      <span style={{ fontSize: 13, minWidth: 0 }}><b>{u.name}</b> <span style={{ color: '#6b7a8d', fontSize: 11, wordBreak: 'break-all' }}>{u.userId}</span></span>
                      <span style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                        <button onClick={() => { navigator.clipboard?.writeText(u.userId); alert('LINEユーザーIDをコピーしました。\n顧客管理の「LINEユーザーID」欄に貼り付けてください。') }}
                          style={{ border: '1.5px solid #1a4d8f', background: '#fff', color: '#1a4d8f', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>📋 IDコピー</button>
                        <button onClick={() => delUser(u.userId)} style={S.delBtn}>削除</button>
                      </span>
                    </div>
                  ))}
            </div>
            {/* 右：登録済みグループ（グループID） */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#3a4a5c', marginBottom: 8 }}>👥 グループID <span style={{ fontWeight: 400, color: '#9aa7b5' }}>参加中{data.activeGroupCount || 0}件</span></div>
              {loading ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>読み込み中...</div>
                : (data.groups || []).length === 0 ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>まだ取得がありません（公式アカウントをグループに招待すると自動で登録されます）</div>
                  : data.groups.map((g) => {
                    const left = g.status === 'left'
                    return (
                      <div key={g.groupId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid #eef0f4', opacity: left ? 0.5 : 1 }}>
                        <span style={{ fontSize: 13, minWidth: 0 }}>
                          <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, color: left ? '#9aa7b5' : '#1a8f5a', border: `1px solid ${left ? '#d8dee8' : '#a0dca0'}`, background: left ? '#f4f6f9' : '#f0f9f0', borderRadius: 4, padding: '1px 6px', marginRight: 6 }}>{left ? '退出済み' : '参加中'}</span>
                          <span style={{ color: '#6b7a8d', fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>{g.groupId}</span>
                          <span style={{ display: 'block', color: '#9aa7b5', fontSize: 10, marginTop: 2 }}>
                            {g.sourceType === 'room' ? '複数人' : 'グループ'}・{VIA_LABELS[g.acquiredVia] || g.acquiredVia}取得・初回 {fmtDT(g.firstSeenAt)}・最終 {fmtDT(g.lastSeenAt)}
                          </span>
                        </span>
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <button onClick={() => copyText(g.groupId)} style={S.editBtn}>コピー</button>
                          <button onClick={() => delGroup(g.groupId)} style={S.delBtn}>削除</button>
                        </span>
                      </div>
                    )
                  })}
            </div>
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
  { id: 'assign', label: '配送臨時割り当て', icon: '🔁' },
  { id: 'shipreport', label: '出荷日報', icon: '📑' },
  { id: 'driverreport', label: '運行日報', icon: '🚚' },
  { id: 'settings', label: '設定', icon: '⚙️' },
  { id: 'customers', label: '顧客管理', icon: '👥' },
  { id: 'employees', label: '従業員管理', icon: '👷' },
]

function Layout({ children, activeTab, onTabChange }) {
  const { user, logout } = useAuth()
  const [open, setOpen]   = useState(false)
  const isMobile = useIsMobile()
  const isPC = !isMobile

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
          {TABS.map(tab => (
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
            {TABS.map(tab => (
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
  const params = (typeof window !== 'undefined') ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const initialEditId = params.get('editShipment') || ''
  const view = params.get('view') || ''
  const isPopup = params.get('popup') === '1'
  // 掲示板形式の出荷予定表（別ウィンドウ・閲覧専用）はログイン不要で開けるようにする
  const isBoard = isPopup && view === 'schedule' && !initialEditId
  const [activeTab, setActiveTab] = useState(initialEditId ? 'shipments' : (view === 'schedule' ? 'schedule' : 'dashboard'))
  const [editTarget, setEditTarget] = useState(null)
  const [pendingEditId, setPendingEditId] = useState(initialEditId)
  // 準備中（パスワード保護）タブ。セッション中はアンロック状態を保持
  const LOCKED_TABS = ['assign', 'shipreport', 'driverreport']
  const [unlocked, setUnlocked] = useState({})

  // 別ウィンドウの自動更新は SchedulePage 内で差分更新（再取得して変更分のみ反映）する。
  // 全画面 reload は入力内容やスクロール位置が失われるため行わない。

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', background: '#f4f6f9' }}>
      <div style={{ color: '#6b7a8d', fontSize: 15 }}>読み込み中...</div>
    </div>
  )

  if (!user && !isBoard) return <LoginPage />

  let page = activeTab === 'dashboard' ? <DashboardPage />
    : activeTab === 'customers' ? <CustomersPage />
    : activeTab === 'employees' ? <EmployeesPage />
    : activeTab === 'shipments' ? <ShipmentsPage editTarget={editTarget} onEditConsumed={() => setEditTarget(null)} pendingEditId={pendingEditId} onPendingConsumed={() => setPendingEditId('')} isPopup={isPopup} />
    : activeTab === 'schedule' ? <SchedulePage isPopup={isPopup} onEditShipment={(s) => { setEditTarget(s); setActiveTab('shipments') }} />
    : activeTab === 'weekly' ? <WeeklySchedulePage />
    : activeTab === 'assign' ? <AssignPage />
    : activeTab === 'shipreport' ? <ShipReportPage />
    : activeTab === 'driverreport' ? <DriverReportPage />
    : activeTab === 'settings' ? <SettingsPage />
    : null
  // 準備中タブは未アンロックならパスワード画面を表示
  if (LOCKED_TABS.includes(activeTab) && !unlocked[activeTab]) {
    page = <LockedPage onUnlock={() => setUnlocked(u => ({ ...u, [activeTab]: true }))} />
  }

  // 別ウィンドウ（ポップアップ）はサイドバー無しでその画面だけ表示
  if (isPopup) return <div style={{ height: '100dvh', overflow: 'auto', background: '#fff' }}>{page}</div>

  return <Layout activeTab={activeTab} onTabChange={setActiveTab}>{page}</Layout>
}

export default function App() {
  return <AuthProvider><AppInner /></AuthProvider>
}
