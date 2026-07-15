// スーパーコニチャットの「デバック依頼」チャンネルへ、新規依頼／返信を転送する。
//   ・画像は送らない（テキスト＋元スレッドへのリンクのみ）。
//   ・送信先URL/シークレットが未設定なら何もしない（＝環境変数を入れるまで無効。既存挙動は不変）。
//   ・失敗しても呼び出し側の投稿は止めない（この関数内でエラーを握りつぶす）。
//
// Vercel 環境変数:
//   KONICHAT_INGEST_URL    … 例) https://xxxx.supabase.co/functions/v1/debug-inbox
//   KONICHAT_INGEST_SECRET … Edge Function の DEBUG_INBOX_SECRET と同じ値
import type { VercelRequest } from '@vercel/node'

const INGEST_URL = process.env.KONICHAT_INGEST_URL
const INGEST_SECRET = process.env.KONICHAT_INGEST_SECRET || ''
const SOURCE = '東部生コン'

// リクエストから自分（このアプリ）の公開URLを組み立てる（デバッグ依頼へ戻るリンク用）。
export function baseUrlFrom(req: VercelRequest): string {
  if (process.env.PUBLIC_APP_URL) return process.env.PUBLIC_APP_URL.replace(/\/$/, '')
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https'
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || ''
  return `${proto}://${host}`
}

// payload: { kind:'thread'|'reply', title?, threadTitle?, body, authorName, url }
export async function notifyKonichat(payload: Record<string, any>): Promise<void> {
  if (!INGEST_URL) return   // 未設定なら無効（デプロイしても env を入れるまでは何もしない）
  try {
    await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-inbox-secret': INGEST_SECRET },
      body: JSON.stringify({ ...payload, source: SOURCE }),
    })
  } catch (e) {
    console.error('konichat notify failed', e)
  }
}
