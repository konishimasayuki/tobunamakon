# 東部生コン 業務管理システム — 開発メモ

## 構成
- フロント: Vite + React/TS（`src/App.jsx` に集約・約3000行）
- サーバー: Vercel サーバーレス関数（`api/`）。データストアは Upstash Redis（`api/_redis.ts`）
- 認証: JWT（`api/_auth.ts`）。出荷データの GET のみ未認証可（掲示板形式の閲覧用）
- 外部連携: LINE Messaging API（`api/line.ts`）、Google Maps（Static/JS API）

## リマインド・留意点
- **全件削除のサーバーAPIが残置中**: `DELETE /api/shipments?all=1`（`api/shipments.ts`）。
  出荷登録を全件まとめて削除するエンドポイント。設定画面の UI（テスト用データのインポート／全件削除ボタン）は
  削除済みだが、**サーバー側のエンドポイントは温存**している。
  「既存テストデータを削除して」と指示が来たら、このAPIにボタンを再配線するか直接叩いて対応する。
