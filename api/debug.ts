import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from './_redis'
import { requireAuth } from './_auth'
import { v4 as uuidv4 } from 'uuid'

// デバッグ依頼用の掲示板:
//   ・スレッド = 親投稿(title + body + image + author + createdAt) + replies[]
//   ・誰でも(認証済みユーザーなら)スレ立て・返信できる
//   ・自動更新なし(クライアント側でも常に手動取得)
//   ・画像は dataURL を投稿に直接持たせる(小サイズ想定。3MB上限で弾く)

const INDEX_KEY = 'debug:threads'   // sorted set: score=updatedAt(ms)
const KEY = (id: string) => `debug:thread:${id}`
const MAX_IMG = 3 * 1024 * 1024  // 3MB

function sizeOfDataUrl(s: string): number {
  if (!s) return 0
  const i = s.indexOf(',')
  const b64 = i >= 0 ? s.slice(i + 1) : s
  return Math.floor(b64.length * 3 / 4)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })

  const idParam = req.query.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam

  // 一覧取得（スレッド全体・新しい順）
  if (req.method === 'GET' && !id) {
    try {
      const ids = ((await redis.zrange(INDEX_KEY, 0, -1, { rev: true })) || []) as string[]
      if (!ids.length) return res.status(200).json([])
      const p = redis.pipeline()
      ids.forEach(tid => p.get(KEY(tid)))
      const raws = (await p.exec()) || []
      const threads = raws
        .map((raw: any) => { try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null } })
        .filter((t: any) => t && t.id)
      return res.status(200).json(threads)
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 単一スレッド取得
  if (req.method === 'GET' && id) {
    try {
      const raw = await redis.get<any>(KEY(id as string))
      if (!raw) return res.status(404).json({ error: 'スレッドが見つかりません' })
      const t = typeof raw === 'string' ? JSON.parse(raw) : raw
      return res.status(200).json(t)
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 新規スレッド作成 (POST /api/debug)
  if (req.method === 'POST' && !id) {
    try {
      const { title, body, image } = req.body || {}
      if (!String(title || '').trim() && !String(body || '').trim() && !image) {
        return res.status(400).json({ error: 'タイトル・本文・画像のいずれかは必須です' })
      }
      if (image && sizeOfDataUrl(image) > MAX_IMG) {
        return res.status(400).json({ error: `画像が大きすぎます（最大 ${MAX_IMG / 1024 / 1024}MB）` })
      }
      const now = new Date().toISOString()
      const thread = {
        id: uuidv4(),
        title: String(title || '').slice(0, 200),
        body: String(body || '').slice(0, 5000),
        image: image || '',
        author: { id: user.id, name: user.username },
        createdAt: now,
        updatedAt: now,
        replies: [] as any[],
      }
      await redis.set(KEY(thread.id), JSON.stringify(thread))
      await redis.zadd(INDEX_KEY, { score: Date.now(), member: thread.id })
      return res.status(201).json(thread)
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 返信追加 (POST /api/debug?id=...)
  if (req.method === 'POST' && id) {
    try {
      const { body, image } = req.body || {}
      if (!String(body || '').trim() && !image) {
        return res.status(400).json({ error: '本文または画像が必要です' })
      }
      if (image && sizeOfDataUrl(image) > MAX_IMG) {
        return res.status(400).json({ error: `画像が大きすぎます（最大 ${MAX_IMG / 1024 / 1024}MB）` })
      }
      const raw = await redis.get<any>(KEY(id as string))
      if (!raw) return res.status(404).json({ error: 'スレッドが見つかりません' })
      const t = typeof raw === 'string' ? JSON.parse(raw) : raw
      const reply = {
        id: uuidv4(),
        body: String(body || '').slice(0, 5000),
        image: image || '',
        author: { id: user.id, name: user.username },
        createdAt: new Date().toISOString(),
      }
      t.replies = Array.isArray(t.replies) ? t.replies : []
      t.replies.push(reply)
      t.updatedAt = reply.createdAt
      await redis.set(KEY(id as string), JSON.stringify(t))
      await redis.zadd(INDEX_KEY, { score: Date.now(), member: id as string })
      return res.status(201).json(t)
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  // スレッド削除 (DELETE /api/debug?id=...) — 投稿者か admin のみ
  if (req.method === 'DELETE' && id) {
    try {
      const raw = await redis.get<any>(KEY(id as string))
      if (!raw) return res.status(404).json({ error: 'スレッドが見つかりません' })
      const t = typeof raw === 'string' ? JSON.parse(raw) : raw
      const isOwner = t.author && t.author.id === user.id
      if (!isOwner && user.role !== 'admin') return res.status(403).json({ error: '削除権限がありません' })
      await redis.del(KEY(id as string))
      await redis.zrem(INDEX_KEY, id as string)
      return res.status(200).json({ ok: true })
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
