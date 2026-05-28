import { useState, useEffect, useCallback, createContext, useContext } from 'react'

// ============================================================
// 型・定数
// ============================================================
const ROLE_LABELS = { admin: '管理者', manager: 'マネージャー', staff: 'スタッフ' }

// ============================================================
// APIクライアント
// ============================================================
const getToken = () => localStorage.getItem('token') || ''

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...options.headers,
    },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'エラーが発生しました')
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
  const [user, setUser]     = useState(null)
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
// スタイル定数
// ============================================================
const S = {
  // ログイン
  loginRoot: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #0f3060 0%, #1a4d8f 50%, #1a6a9f 100%)' },
  loginCard: { background: '#fff', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  loginLogo: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 32, paddingBottom: 24, borderBottom: '2px solid #f0f2f5' },
  company:   { fontSize: 18, fontWeight: 700, color: '#1a2332', lineHeight: 1.3 },
  systemTxt: { fontSize: 12, color: '#6b7a8d', marginTop: 2 },
  form:      { display: 'flex', flexDirection: 'column', gap: 16 },
  field:     { display: 'flex', flexDirection: 'column', gap: 6 },
  label:     { fontSize: 13, fontWeight: 600, color: '#3a4a5c' },
  input:     { padding: '10px 14px', border: '1.5px solid #dde3ed', borderRadius: 8, fontSize: 15, outline: 'none', color: '#1a2332' },
  error:     { background: '#fef2f2', color: '#c0392b', padding: '10px 14px', borderRadius: 8, fontSize: 13, border: '1px solid #fecaca' },
  loginBtn:  { background: 'linear-gradient(135deg, #1a4d8f, #1a6a9f)', color: '#fff', border: 'none', borderRadius: 8, padding: '12px', fontSize: 15, fontWeight: 600, cursor: 'pointer', marginTop: 4 },
  // レイアウト
  appRoot:   { display: 'flex', height: '100vh', overflow: 'hidden' },
  sidebar:   { width: 220, background: '#0f3060', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  sideHead:  { display: 'flex', alignItems: 'center', gap: 10, padding: '20px 16px 18px', borderBottom: '1px solid rgba(255,255,255,0.1)' },
  coName:    { color: '#fff', fontWeight: 700, fontSize: 14, lineHeight: 1.3 },
  syName:    { color: 'rgba(255,255,255,0.5)', fontSize: 10, marginTop: 2 },
  nav:       { flex: 1, padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 2 },
  navItem:   { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: 500, cursor: 'pointer', textAlign: 'left', width: '100%' },
  navActive: { background: 'rgba(255,255,255,0.15)', color: '#fff', fontWeight: 600 },
  sideFoot:  { padding: '12px 16px 16px', borderTop: '1px solid rgba(255,255,255,0.1)' },
  userName:  { color: '#fff', fontWeight: 600, fontSize: 13 },
  userRole:  { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 2 },
  logoutBtn: { width: '100%', background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 7, padding: '7px 0', fontSize: 12, fontWeight: 500, cursor: 'pointer', marginTop: 10 },
  main:      { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f4f6f9' },
  pageHead:  { padding: '16px 24px', background: '#fff', borderBottom: '1px solid #eef0f4', boxShadow: '0 1px 4px rgba(0,0,0,0.05)' },
  pageTitle: { fontSize: 18, fontWeight: 700, color: '#1a2332' },
  content:   { flex: 1, overflow: 'auto' },
  // 顧客一覧
  toolbar:   { display: 'flex', gap: 12, alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #eef0f4', background: '#fff' },
  search:    { flex: 1, padding: '9px 14px', border: '1.5px solid #dde3ed', borderRadius: 8, fontSize: 14, outline: 'none' },
  addBtn:    { background: 'linear-gradient(135deg, #1a4d8f, #1a6a9f)', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  countBar:  { padding: '8px 20px', background: '#f8fafc', fontSize: 12, color: '#6b7a8d', borderBottom: '1px solid #eef0f4' },
  tableWrap: { flex: 1, overflow: 'auto' },
  table:     { width: '100%', borderCollapse: 'collapse' },
  th:        { padding: '10px 16px', background: '#f4f6f9', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#3a4a5c', borderBottom: '1px solid #dde3ed', whiteSpace: 'nowrap', position: 'sticky', top: 0 },
  tr:        { borderBottom: '1px solid #eef0f4' },
  td:        { padding: '12px 16px', fontSize: 14, color: '#1a2332', verticalAlign: 'middle' },
  tel:       { color: '#1a4d8f', fontWeight: 500 },
  editBtn:   { background: '#f0f4ff', color: '#1a4d8f', border: '1px solid #c0d0f0', borderRadius: 5, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginRight: 6 },
  delBtn:    { background: '#fff0f0', color: '#c0392b', border: '1px solid #f0c0c0', borderRadius: 5, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  empty:     { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: '#6b7a8d', fontSize: 15, padding: 60 },
  // モーダル共通
  overlay:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal:     { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 560, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', maxHeight: '90vh', overflow: 'auto' },
  modalHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: '1px solid #eef0f4' },
  modalTitle:{ fontSize: 17, fontWeight: 700, color: '#1a2332' },
  closeBtn:  { background: 'none', border: 'none', fontSize: 18, color: '#6b7a8d', cursor: 'pointer', padding: '4px 8px', borderRadius: 4 },
  modalForm: { padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 14 },
  grid2:     { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
  smLabel:   { fontSize: 12, fontWeight: 600, color: '#3a4a5c' },
  smInput:   { padding: '9px 12px', border: '1.5px solid #dde3ed', borderRadius: 7, fontSize: 14, color: '#1a2332', outline: 'none' },
  actions:   { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 },
  cancelBtn: { background: '#f4f6f9', color: '#3a4a5c', border: '1.5px solid #dde3ed', borderRadius: 7, padding: '9px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  saveBtn:   { background: 'linear-gradient(135deg, #1a4d8f, #1a6a9f)', color: '#fff', border: 'none', borderRadius: 7, padding: '9px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  confirmBox:{ background: '#fff', borderRadius: 12, padding: '28px 32px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', textAlign: 'center' },
  dangerBtn: { background: '#c0392b', color: '#fff', border: 'none', borderRadius: 7, padding: '9px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
}

// ============================================================
// ログイン画面
// ============================================================
function LoginPage() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={S.loginRoot}>
      <div style={S.loginCard}>
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
            <input style={S.input} type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="username" autoComplete="username" required />
          </div>
          <div style={S.field}>
            <label style={S.label}>パスワード</label>
            <input style={S.input} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" required />
          </div>
          {error && <div style={S.error}>{error}</div>}
          <button style={{ ...S.loginBtn, opacity: loading ? 0.7 : 1 }} type="submit" disabled={loading}>
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ============================================================
// 顧客フォームのフィールド（共通部品）
// ============================================================
function Field({ label, value, onChange, required, type = 'text', fullWidth = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, gridColumn: fullWidth ? '1 / -1' : undefined }}>
      <label style={S.smLabel}>{label}</label>
      <input style={S.smInput} type={type} value={value} onChange={onChange} required={required} />
    </div>
  )
}

// ============================================================
// 顧客追加・編集モーダル
// ============================================================
const emptyForm = { companyName: '', customerName: '', phone: '', address: '', contactPerson: '', memo: '' }

function CustomerModal({ customer, onSave, onClose }) {
  const [form, setForm]     = useState(emptyForm)
  const [error, setError]   = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setForm(customer ? {
      companyName:   customer.companyName,
      customerName:  customer.customerName,
      phone:         customer.phone,
      address:       customer.address,
      contactPerson: customer.contactPerson,
      memo:          customer.memo,
    } : emptyForm)
  }, [customer])

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await onSave(form)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        <div style={S.modalHead}>
          <h2 style={S.modalTitle}>{customer ? '顧客編集' : '顧客追加'}</h2>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={S.modalForm}>
          <div style={S.grid2}>
            <Field label="会社名 *"  value={form.companyName}   onChange={set('companyName')}   required />
            <Field label="顧客名"    value={form.customerName}  onChange={set('customerName')} />
            <Field label="電話番号"  value={form.phone}         onChange={set('phone')}         type="tel" />
            <Field label="担当者名"  value={form.contactPerson} onChange={set('contactPerson')} />
          </div>
          <Field label="住所" value={form.address} onChange={set('address')} fullWidth />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={S.smLabel}>メモ・備考</label>
            <textarea style={{ ...S.smInput, height: 80, resize: 'vertical' }} value={form.memo} onChange={set('memo')} placeholder="自由記入" />
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
// 顧客管理ページ
// ============================================================
function CustomersPage() {
  const { user } = useAuth()
  const [customers, setCustomers]       = useState([])
  const [loading, setLoading]           = useState(true)
  const [search, setSearch]             = useState('')
  const [modalOpen, setModalOpen]       = useState(false)
  const [editing, setEditing]           = useState(null)
  const [deleteConfirm, setDeleteConfirm] = useState(null)

  const canDelete = user?.role === 'admin' || user?.role === 'manager'

  const load = useCallback(async () => {
    try {
      const data = await api.get('/api/customers')
      setCustomers(data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = customers.filter(c =>
    [c.companyName, c.customerName, c.phone, c.address, c.contactPerson]
      .some(v => v.toLowerCase().includes(search.toLowerCase()))
  )

  const handleSave = async (data) => {
    if (editing) {
      await api.put(`/api/customers/${editing.id}`, data)
    } else {
      await api.post('/api/customers', data)
    }
    await load()
  }

  const handleDelete = async (id) => {
    await api.del(`/api/customers/${id}`)
    setDeleteConfirm(null)
    await load()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={S.toolbar}>
        <input style={S.search} placeholder="🔍  会社名・電話番号などで検索" value={search} onChange={e => setSearch(e.target.value)} />
        <button style={S.addBtn} onClick={() => { setEditing(null); setModalOpen(true) }}>＋ 顧客追加</button>
      </div>
      <div style={S.countBar}>{loading ? '読み込み中...' : `${filtered.length} 件`}</div>

      {loading ? (
        <div style={S.empty}>読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div style={S.empty}>{search ? '検索結果がありません' : '顧客が登録されていません'}</div>
      ) : (
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                {['会社名', '顧客名', '電話番号', '担当者', '住所', ''].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} style={S.tr}>
                  <td style={{ ...S.td, fontWeight: 600 }}>{c.companyName}</td>
                  <td style={S.td}>{c.customerName || '—'}</td>
                  <td style={S.td}>
                    {c.phone ? <a href={`tel:${c.phone}`} style={S.tel}>{c.phone}</a> : '—'}
                  </td>
                  <td style={S.td}>{c.contactPerson || '—'}</td>
                  <td style={{ ...S.td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.address || '—'}
                  </td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    <button style={S.editBtn} onClick={() => { setEditing(c); setModalOpen(true) }}>編集</button>
                    {canDelete && (
                      <button style={S.delBtn} onClick={() => setDeleteConfirm(c.id)}>削除</button>
                    )}
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
            <p style={{ marginBottom: 16, color: '#1a2332' }}>この顧客を削除しますか？</p>
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
// レイアウト（サイドバー）
// ============================================================
const TABS = [
  { id: 'customers', label: '顧客管理', icon: '👥' },
  // 案件管理・日次集計など今後ここに追加
]

function Layout({ children, activeTab, onTabChange }) {
  const { user, logout } = useAuth()
  return (
    <div style={S.appRoot}>
      <aside style={S.sidebar}>
        <div style={S.sideHead}>
          <div style={{ fontSize: 28 }}>🏗</div>
          <div>
            <div style={S.coName}>東部生コン</div>
            <div style={S.syName}>業務管理システム</div>
          </div>
        </div>
        <nav style={S.nav}>
          {TABS.map(tab => (
            <button
              key={tab.id}
              style={{ ...S.navItem, ...(activeTab === tab.id ? S.navActive : {}) }}
              onClick={() => onTabChange(tab.id)}
            >
              <span style={{ fontSize: 16 }}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>
        <div style={S.sideFoot}>
          <div style={S.userName}>{user?.displayName}</div>
          <div style={S.userRole}>{user?.role ? ROLE_LABELS[user.role] : ''}</div>
          <button style={S.logoutBtn} onClick={logout}>ログアウト</button>
        </div>
      </aside>
      <main style={S.main}>
        <div style={S.pageHead}>
          <h1 style={S.pageTitle}>
            {TABS.find(t => t.id === activeTab)?.icon}{' '}
            {TABS.find(t => t.id === activeTab)?.label}
          </h1>
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
  const [activeTab, setActiveTab] = useState('customers')

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f4f6f9' }}>
        <div style={{ color: '#6b7a8d', fontSize: 15 }}>読み込み中...</div>
      </div>
    )
  }

  if (!user) return <LoginPage />

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'customers' && <CustomersPage />}
    </Layout>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  )
}
