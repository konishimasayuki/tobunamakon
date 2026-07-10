# 東部生コン IME 自動切替（拡張機能 ＋ Windows 常駐ホスト）

業務システムの入力欄で、フィールドに応じて **IME を実際に自動切替**します。

- **業者名 / 現場名 / 備考など** にフォーカス → **全角かな**
- **日付 / 時間 / 配合 / 量 / 連絡先など** にフォーカス → **半角英数（IME OFF）**

## しくみ

ブラウザだけでは Windows の IME を確実に切り替えられません（Web の制約）。そこで
**ブラウザ拡張機能** と **Windows 常駐ホスト(`tobu-ime-host.exe`)** を Native Messaging で
連携させ、ホストが Windows の IMM32 API を使って IME を実際に切り替えます。

```
入力欄フォーカス → content.js → background.js → (Native Messaging)
                                          → tobu-ime-host.exe → IMM32 で IME 切替
```

- ホストは **Windows 同梱の .NET Framework** でその場ビルドします（Visual Studio 等の追加インストール不要）。
- ホスト未導入でも拡張機能は壊れず、`lang`/`inputmode` のヒントのみ（＝従来のベストエフォート）で動作します。

## 導入手順（Windows / Chrome・Edge）

対象環境: **Windows 10 / 11**（`.NET Framework 4.x` 同梱・標準構成でOK）

1. このフォルダ（`manifest.json` が入っているフォルダ）を任意の場所に展開する。
   - **展開後にフォルダを移動すると再インストールが必要**です（登録に絶対パスを使うため）。
2. **`install.bat` をダブルクリック**する。
   - `tobu-ime-host.exe` をその場でコンパイルし、Chrome/Edge にホストを登録します。
   - 「WindowsによってPCが保護されました」等が出たら「詳細情報」→「実行」。
3. ブラウザで拡張機能を読み込む:
   1. `chrome://extensions`（Edge は `edge://extensions`）を開く
   2. 右上「**デベロッパーモード**」を **ON**
   3. 「**パッケージ化されていない拡張機能を読み込む**」で **このフォルダ** を選択
4. 業務システムを開き、入力欄を移動して IME が自動で切り替われば完了。

> 拡張機能 ID は `key` 固定のため常に `boldmmjiahdcnocjlfpmillongehdogk` になります
> （ホスト側の許可リストと一致させるため）。

## アンインストール

`uninstall.bat` を実行 → 拡張機能は `chrome://extensions` から手動削除。

## モードの割当

- **全角かな**: 業者名 / 商社名 / 現場名 / 現場住所 / 車種補足 / 打設箇所 / 荷下ろし / 特記 / 備考
- **半角英数**: 受注日 / 日付 / 時間 / 配合 / 量 / 連絡先 / 現場連絡先

各欄フォーカス時に切り替えます。フィールド内で手動で IME を変えた分は、その欄にいる間は保持されます。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `manifest.json` | 拡張機能定義（ID固定 `key` / nativeMessaging 権限 / background） |
| `content.js` | 入力欄フォーカスを検知しモードを送る |
| `background.js` | Native Messaging でホストへ橋渡し |
| `TobuImeHost.cs` | 常駐ホストのソース（C#） |
| `com.tobu.ime.json` | Native Messaging ホストマニフェスト（許可拡張IDを記載） |
| `install.bat` / `uninstall.bat` | ホストのビルド＆登録 / 解除 |

## トラブルシューティング

- **切り替わらない**: `install.bat` を実行したか / 拡張機能を「更新」またはブラウザ再起動したか確認。
- **拡張の詳細で「Native host has exited」等**: フォルダを移動した場合は再度 `install.bat` を実行。
- **一部の IME（Google 日本語入力等）**: Microsoft IME で最も安定します。環境により効きが異なる場合があります。

## 注意（TSF/セキュリティ）

- IME 切替は **フォアグラウンドの入力欄** に対して行います（他アプリには作用しません）。
- ホストは拡張機能からのメッセージ以外では何もしません（stdin が閉じると終了）。
