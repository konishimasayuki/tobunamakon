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
  a.download = `顧客一覧_${new Date().toISOString().slice(0, 10)}.csv`
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
  sideHead:   { display: 'flex', alignItems: 'center', gap: 10, padding: '18px 14px 16px', paddingTop: 'calc(18px + env(safe-area-inset-top))', borderBottom: '1px solid rgba(255,255,255,0.1)' },
  coName:     { color: '#fff', fontWeight: 700, fontSize: 13, lineHeight: 1.3 },
  syName:     { color: 'rgba(255,255,255,0.5)', fontSize: 10, marginTop: 2 },
  nav:        { flex: 1, padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 2 },
  navItem:    { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderRadius: 8, background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: 500, cursor: 'pointer', textAlign: 'left', width: '100%' },
  navActive:  { background: 'rgba(255,255,255,0.15)', color: '#fff', fontWeight: 600 },
  sideFoot:   { padding: '10px 14px 14px', paddingBottom: 'calc(14px + env(safe-area-inset-bottom))', borderTop: '1px solid rgba(255,255,255,0.1)' },
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

// 子要素を「自然な横幅(width)」で描画し、親の幅に収まるよう zoom で自動縮小する。
// iPhone/iPad で帳票が横に見切れないようにするためのラッパー。
function FitToWidth({ width = 700, max = 1, children, style }) {
  const ref = useRef(null)
  const [scale, setScale] = useState(max)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const calc = () => {
      const avail = el.clientWidth
      if (avail > 0) setScale(Math.min(max, avail / width))
    }
    calc()
    const ro = new ResizeObserver(calc)
    ro.observe(el)
    window.addEventListener('orientationchange', calc)
    return () => { ro.disconnect(); window.removeEventListener('orientationchange', calc) }
  }, [width, max])
  return (
    <div ref={ref} style={{ width: '100%', overflow: 'hidden', ...style }}>
      <div style={{ width, zoom: scale }}>{children}</div>
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
const emptyForm = { customerCode: '', companyName: '', companyNameKana: '', phone: '', address: '', contactPerson: '' }

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
    } : emptyForm)
  }, [customer])

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
          <div style={isMobile ? S.grid1 : S.grid2}>
            <Field label="電話番号" value={form.phone}         onChange={set('phone')}         type="tel" />
            <Field label="担当者名" value={form.contactPerson} onChange={set('contactPerson')} />
          </div>
          <Field label="住所" value={form.address} onChange={set('address')} fullWidth />
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
            <Field label="LINE ID" value={form.lineId} onChange={set('lineId')} />
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
      <div style={S.toolbar}>
        <input style={noZoom(S.search, isMobile)} placeholder="🔍  コード・会社名・電話番号などで検索" value={search} onChange={e => setSearch(e.target.value)} />
        <button style={S.exportBtn} onClick={() => exportCSV(customers)}>📥 エクスポート</button>
        <button style={S.importBtn} onClick={() => setImportOpen(true)}>📤 インポート</button>
        <button style={S.addBtn}    onClick={() => { setEditing(null); setModalOpen(true) }}>＋ 顧客追加</button>
      </div>
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
  date: new Date().toISOString().slice(0, 10),
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

// 選択チップ（単一 / 複数）
function Chips({ options, value, multi, onChange, big }) {
  const isOn = (o) => multi ? (value || []).includes(o) : value === o
  const toggle = (o) => {
    if (multi) {
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

// 地図のデフォルト縮尺（従来16から、マウスホイール4回分ズームインした縮尺）
const DEFAULT_MAP_ZOOM = 20

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
    if ((arrowsRef.current || []).length) return // 矢印がある＝位置確定済み。勝手に動かさない
    if (address === selfSetRef.current) return   // ピンドラッグ由来→再ジオコードしない
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

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <button type="button" onClick={toggleDraw} disabled={status !== ''}
          style={{ border: '1.5px solid #0f3060', background: drawMode ? '#0f3060' : '#fff', color: drawMode ? '#fff' : '#0f3060', borderRadius: 7, padding: '7px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
          {drawMode ? '✓ 描画を終える' : '✏️ 矢印を描く'}
        </button>
        <button type="button" onClick={undoArrow} disabled={!(arrows || []).length}
          style={{ border: '1.5px solid #bbb', background: '#fff', color: '#3a4a5c', borderRadius: 7, padding: '7px 12px', fontSize: 13, fontWeight: 600, cursor: (arrows || []).length ? 'pointer' : 'default', opacity: (arrows || []).length ? 1 : 0.5 }}>↩ やり直し</button>
        <button type="button" onClick={clearArrows} disabled={!(arrows || []).length}
          style={{ border: '1.5px solid #f0c0c0', background: '#fff0f0', color: '#c0392b', borderRadius: 7, padding: '7px 12px', fontSize: 13, fontWeight: 600, cursor: (arrows || []).length ? 'pointer' : 'default', opacity: (arrows || []).length ? 1 : 0.5 }}>🗑 全消去</button>
        {actions && <div style={{ display: 'flex', gap: 10, marginLeft: 'auto', alignItems: 'center' }}>{actions}</div>}
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

function ShipmentsPage({ editTarget, onEditConsumed, pendingEditId, onPendingConsumed }) {
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
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [editing, setEditing]       = useState(null)
  const [editChanged, setEditChanged] = useState([])
  const [page, setPage]             = useState(0)
  const topRef = useRef(null)
  const PAGE_SIZE = 10

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
    date: s.date || new Date().toISOString().slice(0, 10),
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
        const updated = await api.put(`/api/shipments/${editing}`, payload)
        setShipments(ss => sortShip(ss.map(s => s.id === updated.id ? updated : s)))
        setEditing(null)
        setEditChanged([])
        setForm({ ...emptyShipForm })
      } else {
        const created = await api.post('/api/shipments', payload)
        setShipments(ss => sortShip([...ss, created]))
        setForm({ ...emptyShipForm, date: form.date })
      }
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const handleReset = () => { setEditing(null); setEditChanged([]); setForm({ ...emptyShipForm }) }

  const handleDelete = async (id) => {
    try {
      await api.del(`/api/shipments/${id}`)
      setDeleteConfirm(null)
      setShipments(ss => ss.filter(s => s.id !== id))
    } catch (e) { alert('エラー: ' + e.message) }
  }

  const filtered = shipments.filter(s => {
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
  // 検索が変わったら1ページ目へ
  useEffect(() => { setPage(0) }, [search])

  // 予定表で変更された項目を赤く表示
  const redIf = (f) => editChanged.includes(f) ? { color: '#c81e1e' } : undefined

  return (
    <div ref={topRef} style={{ height: '100%', overflow: 'auto' }}>
      {/* 手配伝票フォーム */}
      <div className="denpyo" style={{ padding: isMobile ? '12px 8px' : '16px 12px', background: '#f3f1ec', borderBottom: '2px solid #dde3ed' }}>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', flexWrap: 'nowrap', gap: 12, alignItems: 'stretch', justifyContent: 'center' }}>
          <FitToWidth width={700} max={stacked ? 1 : 0.92} style={{ flex: stacked ? '0 0 auto' : '0 0 644px', minWidth: 0 }}>
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
                <input className="f" style={redIf('tradingCompany')} type="text" value={form.tradingCompany} onChange={set('tradingCompany')} />
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
                    <input className="f" style={redIf('siteName')} type="text" value={form.siteName} onChange={set('siteName')} />
                  </div>
                </div>
                <div className="subrow">
                  <div className="cell" style={{ flex: 1 }}>
                    <div className="lbl">現 場 住 所</div>
                    <textarea className="f" rows={1} value={form.siteAddress} onChange={set('siteAddress')} placeholder={DEFAULT_SITE_ADDRESS} />
                  </div>
                </div>
              </div>
            </div>

            {/* 4段: 車種 / 配合・m³ / セメント種・配置 */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 24%', minHeight: 140, justifyContent: 'space-between' }}>
                <div>
                  <div className="lbl" style={redIf('vehicleType')}>車 種</div>
                  <Chips options={VEHICLE_TYPES} value={form.vehicleType} onChange={v => setVal('vehicleType', v)} big />
                </div>
                <div className="inline" style={{ justifyContent: 'flex-end' }}>
                  <input className="num" type="number" min="0" inputMode="numeric" value={form.truckCount} onChange={set('truckCount')} />
                  <span className="unit">台</span>
                </div>
              </div>
              <div className="cell stack" style={{ flex: 1, padding: 0 }}>
                <div className="subrow">
                  <div className="cell" style={{ flex: '0 0 59%' }}>
                    <div className="lbl" style={redIf('mixCode')}>配 合</div>
                    <div className="haigou3" style={redIf('mixCode')}>
                      <div className="hgcol">
                        <input className="hgnote" placeholder="特記" value={mixNote(0)} onChange={e => setMixNote(0, e.target.value)} />
                        <input className="hg" inputMode="numeric" maxLength={2} value={mixPart(0)} onChange={e => setMix(0, e.target.value)} />
                      </div>
                      <span className="hgsep">-</span>
                      <div className="hgcol">
                        <input className="hgnote" placeholder="特記" value={mixNote(1)} onChange={e => setMixNote(1, e.target.value)} />
                        <input className="hg" inputMode="numeric" maxLength={2} value={mixPart(1)} onChange={e => setMix(1, e.target.value)} />
                      </div>
                      <span className="hgsep">-</span>
                      <div className="hgcol">
                        <input className="hgnote" placeholder="特記" value={mixNote(2)} onChange={e => setMixNote(2, e.target.value)} />
                        <input className="hg" inputMode="numeric" maxLength={2} value={mixPart(2)} onChange={e => setMix(2, e.target.value)} />
                      </div>
                    </div>
                  </div>
                  <div className="cell" style={{ flex: 1 }}>
                    <div className="lbl">セメント種</div>
                    <Chips options={CEMENT_TYPES} value={form.cementType} onChange={v => setVal('cementType', v)} />
                  </div>
                </div>
                <div className="subrow">
                  <div className="cell m3" style={{ flex: '0 0 59%', justifyContent: 'center' }}>
                    <div className="inline" style={{ justifyContent: 'center' }}>
                      <input type="number" min="0" step="0.01" inputMode="decimal" style={redIf('volume')} value={form.volume} onChange={set('volume')} />
                      <span className="unit" style={redIf('volume')}>m<sup>3</sup><span className={'qmark' + (form.volumeUncertain ? ' on' : '')}>?</span></span>
                    </div>
                    <label className="qtoggle"><input type="checkbox" checked={form.volumeUncertain} onChange={e => setVal('volumeUncertain', e.target.checked)} />？を付ける</label>
                  </div>
                  <div className="cell" style={{ flex: 1 }}>
                    <Chips options={PLACEMENT_TYPES} value={form.placements} multi onChange={v => setVal('placements', v)} />
                  </div>
                </div>
              </div>
            </div>

            {/* 5段: 連絡先 / 現場連絡先（ラベル左・入力右） */}
            <div className="band">
              <div className="cell" style={{ flex: '0 0 50%', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <div className="lbl" style={{ marginBottom: 0 }}>連 絡 先</div>
                <input className="f" type="text" value={form.orderContact} onChange={set('orderContact')} />
              </div>
              <div className="cell" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <div className="lbl" style={{ marginBottom: 0, ...redIf('siteContact') }}>現 場 連 絡 先</div>
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
              <div className="cell" style={{ flex: '0 0 32%' }}>
                <div className="lbl" style={redIf('drivers')}>担 当 ド ラ イ バ ー（最大4）</div>
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
                <div className="lbl">ド ラ イ バ ー へ の 連 絡</div>
                <DenpyoGrid items={form.driverMessages} onChange={v => setVal('driverMessages', v)} cols={2} height={80} addLabel="＋ 段落を追加" />
              </div>
            </div>
          </div>
          </FitToWidth>
          <div style={{ flex: stacked ? '0 0 auto' : '1 1 340px', width: stacked ? '100%' : undefined, minWidth: stacked ? 0 : 280 }}>
            <SiteMap
              address={form.siteAddress}
              onAddressChange={(a) => setVal('siteAddress', a)}
              mapView={form.mapView}
              onMapViewChange={(v) => setVal('mapView', v)}
              arrows={form.mapArrows}
              onArrowsChange={(a) => setVal('mapArrows', a)}
              actions={
                <>
                  <button type="button" style={{ ...S.cancelBtn, padding: '8px 20px', fontSize: 14 }} onClick={handleReset}>{editing ? '新規作成に戻す' : 'リセット'}</button>
                  <button type="submit" style={{ ...S.saveBtn, padding: '8px 24px', fontSize: 14, opacity: saving ? 0.7 : 1 }} disabled={saving}>
                    {saving ? (editing ? '更新中...' : '登録中...') : (editing ? '更新' : '登録')}
                  </button>
                </>
              }
            />
            {editing && <div style={{ marginTop: 10, padding: '6px 12px', background: '#fff8e1', border: '1px solid #f0d089', borderRadius: 6, fontSize: 13, color: '#8a6d1a' }}>編集中の伝票を更新します（「新規作成に戻す」で取消）</div>}
            {editing && editChanged.length > 0 && <div style={{ marginTop: 8, padding: '6px 12px', background: '#fdecec', border: '1px solid #f0b0b0', borderRadius: 6, fontSize: 13, color: '#c81e1e', fontWeight: 600 }}>予定表で変更された項目: {editChanged.map(f => SCHEDULE_FIELD_LABELS[f] || f).join('・')}</div>}
            {error && <div style={{ ...S.error, marginTop: 10 }}>{error}</div>}
          </div>
          </div>
        </form>
      </div>

      {/* 一覧 */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={S.toolbar}>
          <input style={noZoom(S.search, isMobile)} placeholder="🔍  日付・業者名・現場名などで検索" value={search} onChange={e => setSearch(e.target.value)} />
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
                  {['日付', '時間', '業者名', '商社名', '現場名', 'ドライバー', '車種', '台数', '配合', 'セメント', 'm³', '配置', ''].map((h, i) => (
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
                    <td style={S.td}>{s.truckCount ? `${s.truckCount}台` : '—'}</td>
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

function SchedulePage({ onEditShipment, isPopup }) {
  // 出荷予定表は縦持ち（スマホ・iPhone・iPad）前提。横スクロールのテーブルではなく
  // 1件=1カードの縦リストで表示する。PC・横向き（>=1025px）のみ従来テーブル。
  const isMobile = useIsMobile(1025)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [all, setAll] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try { setAll(await api.get('/api/shipments')) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

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
      case 'volume': return (s.volume == null ? '' : String(s.volume)) + (s.volumeUncertain ? '?' : '')
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
    } catch (e) { alert('保存エラー: ' + e.message) }
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
        onInput={e => fitOne(e.target)}
        onBlur={e => saveField(s, f, e.target.value)}
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
        onInput={e => fitOne(e.target)}
        onBlur={e => saveField(s, f, e.target.value)}
      />
    )
  }

  // 時刻（スマホカード用）：2つ以上あるときは横並びにして間に「〜」を入れる
  const cellTimes = (s) => {
    const times = (Array.isArray(s.times) ? s.times.map(t => (t && t.text != null) ? t.text : t) : [])
      .map(x => String(x ?? '').trim()).filter(Boolean)
    const cls = 'sc-in big center sc-timeitem' + (isChanged(s, 'times') ? ' changed' : '')
    const saveAll = (container) => {
      const inputs = Array.from(container.querySelectorAll('input.sc-timeitem'))
      saveField(s, 'times', inputs.map(i => i.value.trim()).filter(Boolean).join('\n'))
    }
    const items = times.length ? times : ['']
    return (
      <div className="sc-times" key={'times' + (isChanged(s, 'times') ? '_c' : '') + '_n' + items.length}>
        {items.map((t, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="sc-timesep">〜</span>}
            <input ref={fitRef} className={cls} defaultValue={t} placeholder={i === 0 ? '時間' : ''}
              onInput={e => fitOne(e.target)} onBlur={e => saveAll(e.target.closest('.sc-times'))} />
          </Fragment>
        ))}
      </div>
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
    const saveAll = (container) => {
      const inputs = Array.from(container.querySelectorAll('input.sc-driverline'))
      const joined = inputs.map(i => i.value.trim()).filter(Boolean).join('\n')
      saveField(s, 'drivers', joined)
    }
    return (
      <div className="sc-drivers" key={'drivers' + (isChanged(s, 'drivers') ? '_c' : '') + '_n' + display.length}>
        {display.map((line, i) => (
          <input
            key={i}
            ref={fitRef}
            className={cls}
            defaultValue={line}
            placeholder={i === 0 ? '担当' : ''}
            onInput={e => fitOne(e.target)}
            onBlur={e => saveAll(e.target.closest('.sc-drivers'))}
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
    const saveAll = (container) => {
      const inputs = Array.from(container.querySelectorAll('input.sc-driverline'))
      saveField(s, 'drivers', inputs.map(i => i.value.trim()).filter(Boolean).join('\n'))
    }
    let idx = 0
    return (
      <div className="sc-drivers-card" key={'drv' + (changed ? '_c' : '') + '_n' + n}
        onBlur={e => saveAll(e.currentTarget)}>
        {rows.map((row, ri) => (
          <div className="sc-drv-row" key={ri}>
            {row.map((nm) => {
              const i = idx++
              return (
                <input key={i} ref={fitRef} className={cls} defaultValue={nm}
                  placeholder={i === 0 ? '担当' : ''} onInput={e => fitOne(e.target)} />
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

  const sendLine = (s) => {
    const drivers = Array.isArray(s.drivers) ? s.drivers : []
    if (drivers.length === 0) { alert('担当が入っていません'); return }
    const names = drivers.map(d => d.name).join('、')
    if (window.confirm(`${names} に送信しますか？`)) {
      alert('送信を受け付けました。\n（※実際のLINE送信にはLINE Messaging APIの連携設定が必要です）')
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
    <div style={{ height: '100%', overflow: 'auto', background: '#fff' }}>
      <div style={{ position: 'relative', padding: '12px 16px', minHeight: 44, display: isMobile ? 'flex' : 'block', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <div style={{ textAlign: 'center', fontSize: isMobile ? 18 : 22, fontWeight: 700, color: '#111', letterSpacing: isMobile ? '0.15em' : '0.35em' }}>出荷予定表</div>
        <div style={isMobile
          ? { display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8, color: '#111' }
          : { position: 'absolute', right: 16, top: 10, display: 'flex', alignItems: 'center', gap: 8, color: '#111' }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ fontSize: isMobile ? 16 : 14, padding: '5px 8px', border: '1.5px solid #bbb', borderRadius: 6 }} />
          <span style={{ fontSize: 15 }}>（{weekday}）</span>
          {isPopup
            ? <button type="button" onClick={() => window.close()}
                style={{ border: '1.5px solid #0f3060', background: '#0f3060', color: '#fff', borderRadius: 7, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>✕ 閉じる</button>
            : !isMobile && <button type="button" onClick={openScheduleWindow}
                style={{ border: '1.5px solid #0f3060', background: '#fff', color: '#0f3060', borderRadius: 7, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>⛶ 別ウィンドウで開く</button>}
        </div>
      </div>
      {isMobile ? (
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
                        {s.truckCount ? <span className="sc-truck">{s.truckCount}台</span> : null}
                      </div>
                    </div>
                    <div className="sc-box"><span className="sc-lbl">配合</span>{cell(s, 'mixCode', '', { center: true, big: true })}{(Array.isArray(s.mixNotes) && s.mixNotes.some(Boolean)) ? <div style={{ fontSize: 11, color: '#c81e1e', fontWeight: 700, textAlign: 'center' }}>{s.mixNotes.filter(Boolean).join(' / ')}</div> : null}</div>
                    <div className="sc-box sc-volbox"><span className="sc-lbl">量</span>{cell(s, 'volume', '', { center: true, big: true })}</div>
                  </div>
                  {/* 備考（横並び） */}
                  <div className="sc-row"><span className="sc-lbl">備考</span><span className="sc-val">{cell(s, 'notes', '備考', { plain: true })}</span></div>
                  {/* 現場連絡先 */}
                  <div className="sc-row"><span className="sc-lbl">現場連絡先</span><span className="sc-val">{cell(s, 'siteContact', '現場連絡先')}</span></div>
                  <div className="sc-card-actions">
                    <button type="button" onClick={() => openEditWindow(s)}
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
      ) : (
      <div className={'schedule' + (isPopup ? ' popup-view' : '')} style={{ overflowX: isPopup ? 'visible' : 'auto', padding: isPopup ? '0 0 24px' : '0 16px 24px' }}>
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
                  {cell(s, 'mixCode', '', { center: true, big: true })}
                  {(Array.isArray(s.mixNotes) && s.mixNotes.some(Boolean)) ? (
                    <div className="sc-mixnotes">
                      <span>{s.mixNotes[0] || ''}</span><span>{s.mixNotes[1] || ''}</span><span>{s.mixNotes[2] || ''}</span>
                    </div>
                  ) : null}
                </td>
                <td className="sc-nowrap">{cell(s, 'volume', '', { center: true, big: true })}</td>
                <td>{cellDrivers(s, { big: true })}</td>
                <td className="sc-nowrap">{cellMulti(s, 'times', '', { center: true, big: true })}</td>
                <td>{cell(s, 'notes', '備考', { plain: true })}{cell(s, 'siteContact', '現場連絡先')}</td>
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
          <div style={{ marginTop: 8, fontSize: 12, color: '#6b7a8d', padding: isPopup ? '8px 8px 0' : 0 }}>
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
      </div>
      )}
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
  const today = new Date().toISOString().slice(0, 10)
  const ms = mondayOf(today)
  const weekDates = Array.from({ length: 7 }, (_, i) => { const d = new Date(ms); d.setDate(d.getDate() + i); return ymd(d) })
  const todays = all.filter(s => s.date === today)
  const weeks = all.filter(s => weekDates.includes(s.date))
  const vol = arr => arr.reduce((a, s) => a + (parseFloat(s.volume) || 0), 0).toFixed(2)
  const card = (label, value, sub) => (
    <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: '16px 18px', minWidth: 150 }}>
      <div style={{ fontSize: 12, color: '#6b7a8d' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: '#0f3060' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9aa7b5' }}>{sub}</div>}
    </div>
  )
  return (
    <div style={RPT.wrap}>
      <h2 style={{ margin: '0 0 16px', color: '#1a2332' }}>📊 ダッシュボード</h2>
      {loading ? <div style={{ color: '#6b7a8d' }}>読み込み中...</div> : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 22 }}>
            {card('今日の出荷', `${todays.length} 件`, today)}
            {card('今日の合計', `${vol(todays)} m³`)}
            {card('今週の出荷', `${weeks.length} 件`, `${weekDates[0]}〜${weekDates[6]}`)}
            {card('今週の合計', `${vol(weeks)} m³`)}
            {card('登録総数', `${all.length} 件`)}
          </div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ fontSize: 14, color: '#3a4a5c' }}>今日の車種別</h3>
              {todays.length === 0 ? <div style={{ fontSize: 12, color: '#9aa7b5' }}>なし</div>
                : Object.entries(todays.reduce((m, s) => { const k = s.vehicleType || '未設定'; m[k] = (m[k] || 0) + 1; return m }, {})).map(([k, v]) => <div key={k} style={{ fontSize: 13 }}>{k}: {v}件</div>)}
            </div>
            <div>
              <h3 style={{ fontSize: 14, color: '#3a4a5c' }}>今日の担当別</h3>
              {(() => {
                const m = {}; todays.forEach(s => { const ds = driversOf(s); (ds.length ? ds : ['未割当']).forEach(n => m[n] = (m[n] || 0) + 1) })
                const e = Object.entries(m)
                return e.length ? e.map(([k, v]) => <div key={k} style={{ fontSize: 13 }}>{k}: {v}件</div>) : <div style={{ fontSize: 12, color: '#9aa7b5' }}>なし</div>
              })()}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function WeeklySchedulePage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const { all, loading } = useShipments()
  const ms = new Date(date)   // 選択日（既定は本日）を左端に7日分表示
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(ms); d.setDate(d.getDate() + i); return d })
  const todayStr = new Date().toISOString().slice(0, 10)
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
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
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
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
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

function SettingsPage() {
  const isMobile = useIsMobile()
  const [token, setToken] = useState('')
  const [data, setData] = useState({ users: [], groups: [], activeGroupCount: 0, hasToken: false, hasSecret: false })
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [usersOpen, setUsersOpen] = useState(false)

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
                      <button onClick={() => delUser(u.userId)} style={S.delBtn}>削除</button>
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
function AppInner() {
  const { user, loading } = useAuth()
  const params = (typeof window !== 'undefined') ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const initialEditId = params.get('editShipment') || ''
  const view = params.get('view') || ''
  const isPopup = params.get('popup') === '1'
  const [activeTab, setActiveTab] = useState(initialEditId ? 'shipments' : (view === 'schedule' ? 'schedule' : 'dashboard'))
  const [editTarget, setEditTarget] = useState(null)
  const [pendingEditId, setPendingEditId] = useState(initialEditId)

  // 出荷予定表の別ウィンドウ（閲覧専用）のみ1分ごとに自動更新する。
  // 編集ポップアップ（出荷登録/伝票編集）は入力中にリロードされ入力内容が消えるため自動更新しない。
  useEffect(() => {
    if (!isPopup || view !== 'schedule') return
    const t = setInterval(() => window.location.reload(), 60000)
    return () => clearInterval(t)
  }, [isPopup, view])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', background: '#f4f6f9' }}>
      <div style={{ color: '#6b7a8d', fontSize: 15 }}>読み込み中...</div>
    </div>
  )

  if (!user) return <LoginPage />

  const page = activeTab === 'dashboard' ? <DashboardPage />
    : activeTab === 'customers' ? <CustomersPage />
    : activeTab === 'employees' ? <EmployeesPage />
    : activeTab === 'shipments' ? <ShipmentsPage editTarget={editTarget} onEditConsumed={() => setEditTarget(null)} pendingEditId={pendingEditId} onPendingConsumed={() => setPendingEditId('')} />
    : activeTab === 'schedule' ? <SchedulePage isPopup={isPopup} onEditShipment={(s) => { setEditTarget(s); setActiveTab('shipments') }} />
    : activeTab === 'weekly' ? <WeeklySchedulePage />
    : activeTab === 'assign' ? <AssignPage />
    : activeTab === 'shipreport' ? <ShipReportPage />
    : activeTab === 'driverreport' ? <DriverReportPage />
    : activeTab === 'settings' ? <SettingsPage />
    : null

  // 別ウィンドウ（ポップアップ）はサイドバー無しでその画面だけ表示
  if (isPopup) return <div style={{ height: '100dvh', overflow: 'auto', background: '#fff' }}>{page}</div>

  return <Layout activeTab={activeTab} onTabChange={setActiveTab}>{page}</Layout>
}

export default function App() {
  return <AuthProvider><AppInner /></AuthProvider>
}
