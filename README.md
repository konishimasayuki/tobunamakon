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

## LINE グループID取得

公式アカウント（Bot）が参加したグループの groupId を Webhook 経由で自動取得し、
設定画面の「登録済みLINEユーザー・グループ」に表示する。

### 事前設定（必須）

LINE Developers コンソール → 対象チャネル → [Messaging API設定] で
**「グループトーク・複数人トークへの参加を許可する」を ON** にする。
OFF のままだと Bot を招待しても即退出し、groupId を取得できない。

### 取得の仕組み

| イベント | 動作 |
|---------|------|
| `join`（招待された） | groupId を `active` で登録（主軸・ほぼ全自動） |
| グループ内 `message` | 未登録なら補完登録、登録済みなら最終確認日時を更新 |
| グループ内で「ID」と送信 | Bot が groupId を返信（確認用・無料の reply） |
| `leave`（退出・削除） | 該当 groupId を `left`（退出済み）に更新 |

- groupId 取得は **Webhook での都度記録が唯一の手段**（一覧取得APIは存在しない）。
- upsert 設計のため同一イベントの再送・重複でも 1 レコードに集約（冪等）。
- **未認証アカウントでも groupId は取得可能**。
- データは Redis ハッシュ `line:groups`（groupId → レコードJSON）に保存。
