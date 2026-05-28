# 東部生コン 業務管理システム

React + Vite + Vercel Serverless Functions + Upstash Redis

## 構成

```
tobu-konkuri/
├── api/                   # Vercel Serverless Functions (バックエンドAPI)
│   ├── auth/login.ts      # POST /api/auth/login
│   ├── auth/setup.ts      # POST /api/auth/setup (初回管理者作成)
│   ├── customers/index.ts # GET/POST /api/customers
│   ├── customers/[id].ts  # PUT/DELETE /api/customers/:id
│   └── users/index.ts     # GET/POST /api/users
├── src/                   # Reactフロントエンド
│   ├── components/Layout.tsx
│   ├── components/CustomerModal.tsx
│   ├── hooks/useAuth.tsx
│   ├── pages/LoginPage.tsx
│   └── pages/CustomersPage.tsx
└── vercel.json
```

## セットアップ手順

### 1. Vercel環境変数に追加

既存の `KV_REST_API_URL` / `KV_REST_API_TOKEN` に加えて:
- `JWT_SECRET` = 長いランダム文字列

### 2. GitHubにプッシュ → Vercelが自動デプロイ

### 3. 初回管理者ユーザーを作成

```bash
curl -X POST https://your-app.vercel.app/api/auth/setup \
  -H "Content-Type: application/json" \
  -d '{"setupKey":"tobu-setup-2024","username":"admin","password":"パスワード","displayName":"管理者"}'
```

### 4. ブラウザでログインして使用開始

## ローカル開発

```bash
npm install
npx vercel dev   # APIも含めてローカル起動
```

## 権限

| 役職 | 顧客閲覧 | 顧客追加・編集 | 顧客削除 | ユーザー管理 |
|------|---------|--------------|---------|------------|
| admin | ✅ | ✅ | ✅ | ✅ |
| manager | ✅ | ✅ | ✅ | ❌ |
| staff | ✅ | ✅ | ❌ | ❌ |
