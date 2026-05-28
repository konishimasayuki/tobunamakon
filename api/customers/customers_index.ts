import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { requireAuth } from '../_auth'
import { v4 as uuidv4 } from 'uuid'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })

  if (req.method === 'GET') {
    try {
      const ids = await redis.smembers('customers')
      if (!ids || ids.length === 0) return res.status(200).json([])
      const customers = []
      for (const id of ids) {
        const c = await redis.hgetall(`customer:${id}`)
        if (c && Object.keys(c).length > 0) customers.push(c)
      }
      customers.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      return res.status(200).json(customers)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  if (req.method === 'POST') {
    const { customerCode, companyName, companyNameKana, phone, address, contactPerson, memo } = req.body
    if (!companyName) return res.status(400).json({ error: '会社名は必須です' })
    try {
      const id = uuidv4()
      const now = new Date().toISOString()
      const customer = {
        id,
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
      await redis.hset(`customer:${id}`, customer)
      await redis.sadd('customers', id)
      return res.status(201).json(customer)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
