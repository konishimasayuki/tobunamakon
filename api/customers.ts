import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from './_redis'
import { requireAuth } from './_auth'
import { v4 as uuidv4 } from 'uuid'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })

  const idParam = req.query.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  const hasId = !!id

  // 一覧取得
  if (req.method === 'GET' && !hasId) {
    try {
      const ids = await redis.smembers('customers')
      if (!ids || ids.length === 0) return res.status(200).json([])
      const customers = []
      for (const cid of ids) {
        const c = await redis.hgetall(`customer:${cid}`)
        if (c && Object.keys(c).length > 0) customers.push(c)
      }
      customers.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      return res.status(200).json(customers)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 新規作成
  if (req.method === 'POST' && !hasId) {
    const { customerCode, companyName, companyNameKana, phone, address, contactPerson, memo } = req.body
    if (!companyName) return res.status(400).json({ error: '会社名は必須です' })
    try {
      const newId = uuidv4()
      const now = new Date().toISOString()
      const customer = {
        id: newId,
        customerCode:    customerCode    || '',
        companyName,
        companyNameKana: companyNameKana || '',
        phone:           phone           || '',
        address:         address         || '',
        contactPerson:   contactPerson   || '',
        memo:            memo            || '',
        createdAt: now,
        updatedAt: now,
      }
      await redis.hset(`customer:${newId}`, customer)
      await redis.sadd('customers', newId)
      return res.status(201).json(customer)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 更新
  if (req.method === 'PUT' && hasId) {
    const { customerCode, companyName, companyNameKana, phone, address, contactPerson, memo } = req.body
    if (!companyName) return res.status(400).json({ error: '会社名は必須です' })
    try {
      const existing = await redis.hgetall(`customer:${id}`)
      if (!existing || Object.keys(existing).length === 0) return res.status(404).json({ error: '顧客が見つかりません' })
      const updated = {
        ...existing,
        customerCode:    customerCode    || '',
        companyName,
        companyNameKana: companyNameKana || '',
        phone:           phone           || '',
        address:         address         || '',
        contactPerson:   contactPerson   || '',
        memo:            memo            || '',
        updatedAt: new Date().toISOString(),
      }
      await redis.hset(`customer:${id}`, updated)
      return res.status(200).json(updated)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 削除
  if (req.method === 'DELETE' && hasId) {
    try {
      await redis.del(`customer:${id}`)
      await redis.srem('customers', id)
      return res.status(200).json({ message: '削除しました' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
