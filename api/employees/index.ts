import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { requireAuth } from '../_auth'
import { v4 as uuidv4 } from 'uuid'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })

  if (req.method === 'GET') {
    try {
      const ids = await redis.smembers('employees')
      if (!ids || ids.length === 0) return res.status(200).json([])
      const employees = []
      for (const id of ids) {
        const e = await redis.hgetall(`employee:${id}`)
        if (e && Object.keys(e).length > 0) employees.push(e)
      }
      try {
        employees.sort((a, b) => String(a.employeeId || '').localeCompare(String(b.employeeId || '')))
      } catch (_) {}
      return res.status(200).json(employees)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  if (req.method === 'POST') {
    const { employeeId, name, lineId, type } = req.body
    if (!name) return res.status(400).json({ error: '氏名は必須です' })
    try {
      const id = uuidv4()
      const now = new Date().toISOString()
      const employee = {
        id, employeeId: employeeId || '', name,
        lineId: lineId || '', type: type || 'office',
        createdAt: now, updatedAt: now,
      }
      await redis.hset(`employee:${id}`, employee)
      await redis.sadd('employees', id)
      return res.status(201).json(employee)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
