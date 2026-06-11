# 引き継ぎ要約（東部生コン 業務管理システム）

最終更新: 2026-06-11

## リポジトリ / デプロイ
- **本番**: `main` → Vercel 自動デプロイ（**tobunamakon.vercel.app**）。現在の先端 `ff7dccd`。
- **作業ブランチ**: `claude/handoff-md-setup-0bhi97`（main と同内容）。
- **反映フロー**: 作業ブランチへ push → PR 作成 → main へマージ（＝本番デプロイ）。
- **DB**: Upstash Redis（従量課金）。`KV_REST_API_URL` / `KV_REST_API_TOKEN`。
- **外部サービス**: LINE Messaging API、Google Maps（フロント表示＋LINEの地図画像）。

## コード構成（要点）
- フロントは実質 **`src/App.jsx` 1ファイル（約4900行）**の単一SPA。`src/App.tsx` は空（`export {}`）。
- API（Vercel Functions・TypeScript）: `api/shipments.ts`（伝票＋日付索引＋変更履歴）, `api/customers.ts`, `api/employees.ts`, `api/line.ts`(LINE/Flexカード/Webhook), `api/backup.ts`(全データのexport/restore), `api/users.ts`, `api/auth/*`。`api/_redis.ts` `api/_auth.ts` は共通。
- 主な画面コンポーネント: `ShipmentsPage`(出荷登録/一覧), `SchedulePage`(出荷予定表), `AssignPage`(配送割り当て), `DashboardPage`, `SeikonOutputPage`(生コン出荷予定表/印刷・CSV), `ShipReportPage`/`DriverReportPage`(日報), `SettingsPage`, `CustomersPage`, `EmployeesPage`。
- 共有部品: `DenpyoFields`(伝票フォーム本体), `MobileEditForm`/`ScheduleEditModal`(スマホ予定編集), `DriverAssignBody`(担当割当/LINE送信モーダル・mode='assign'|'send'), `SiteMap`(Google地図), `VolNum`/`volNumColor`(量の桁色), `HistoryPanel`(変更履歴), `openPdfViewer`(×ボタン付きPDF表示)。
- ビルド: `npm run build`（`tsc && vite build`）。`tsc` は実質チェック軽め、検証は vite build が主。

## このセッションで本番反映した主な改修
- **担当者表示の整理**: ダッシュボードの「今日の担当別」・LINE送信カードの担当は非表示。出荷登録フォーム/一覧/配送割り当て/出荷予定表は表示。
- **量の桁色分け**: 整数2桁=黒太字 / 3桁(100㎥〜)=赤太字（全画面共通 `VolNum`、印刷でも赤=`sc-vol3`、範囲入力 `13〜14` も対応）。
- **配合表示**: 空セクションは「-」を残し全角空白（例 `24--` → `24-　-　`）。出荷予定表・一覧とも。
- **変更履歴**: 出荷登録の地図下→フォーム下に全幅・**スマホ2列/PC4列**、枠内に収め中央寄せ。サーバ(`api/shipments.ts`)が編集毎に「日時＋項目＋前→後」を記録（最大30件）。
- **PC版 出荷予定表のセル直接編集**（別ウィンドウ＝共有ボードは閲覧専用のまま）。現場名は編集可＋最大3行折り返し。
- **半角カナ検索**（`han2zenKana`/`kanaToHira`）: 業者名/商社名/出荷一覧/顧客管理。
- **時間 AM/PM ボタン**（出荷登録フォーム）。**配送割り当てにも AM/PM 絞り込み**（最新）。
- **時間欄フォント下限14px**（`10:30~11:00` でも小さくなりすぎない）。
- **全データ バックアップ機能**（設定画面）: 📥ダウンロード(JSON) / 📤復元(import・id単位upsert・既存は消さない)。`api/backup.ts`。PDF本体は対象外。
- **配送割り当てのボタン再構成**: 📄PDF確認(PDFなしは非表示)・📍住所設定・👤担当割当・💬LINE送信。
- **PDF表示に右上の大きめ半透明×ボタン**（閉じて戻れる。`openPdfViewer`、配送割当・一覧・予定表で共通）。
- **出荷予定表に「削除」ボタン**（編集列の右。削除＝キャンセル伝票へ・復元可）。
- **LINE送信を全ページ・全サイズで統一**: 「LINE送信」→ 送信先モーダル（割当済み担当者を初期選択）→ 選んだ人へpush送信。**担当(s.drivers)は変更しない**。担当の割り当ては「担当割当」ボタン（保存のみ）。

## 未対応 / 保留
- **時刻の並び順改良**: `1300` や `13-13:30` を 13:00 として扱う（現状はコロン必須・`13-13:30`は終わり側を拾う）。未実装。
- **IME 全角かな**: `ime-mode` は Firefox のみ有効。Chrome/iOS は不可（Web標準で強制不可）。代替案＝ローマ字→かな自動変換 等。
- 生コン出荷予定表(SeikonOutputPage)のCSVは販売大臣向けに「担当」を含む（表示は担当連絡先=現場連絡先で担当名は出さない）。

## ⚠️ 既知の注意・運用メモ
- **作業環境が時々 `285cf70` 等へ巻き戻る事象あり**（このセッションで頻発）。本番・GitHubは影響なし。**各セッション冒頭で `git fetch` → `git reset --hard origin/<branch>` で最新へ同期してから作業**するのが安全。push 前は `git rebase origin/<branch>`。
- モック確認は **`/tmp` にHTML作成 → Playwright(`npx playwright screenshot`)で画像化**し `SendUserFile` で提示（GitHubに上げない）。`npx playwright install chromium` 済み環境。
- スコープ制限: GitHub MCP は `konishimasayuki/tobunamakon` のみ。別リポジトリ(例 super-koni-chat)は別セッションで。
- Vercel無料枠超過の主因は別アプリ(super-koni-chat、ポーリング過多)。生コン単体は軽量。
- バックアップ/一覧/検索は「全件読み」のため、伝票が**数千件**たまるとVercelの約4.5MB制限・速度が課題に（将来ページング化）。

## 推奨フォローアップ
- 定期的に設定画面の「📥 バックアップをダウンロード」を実施しデータを手元保管。
- 反映後は本番（実Redis/実機）で動作確認（特にLINE送信・変更履歴・直接編集）。
