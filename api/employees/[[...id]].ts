import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { requireAuth } from '../_auth'
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
      const ids = await redis.smembers('employees')
      if (!ids || ids.length === 0) return res.status(200).json([])
      const employees = []
      for (const eid of ids) {
        const e = await redis.hgetall(`employee:${eid}`)
        if (e && Object.keys(e).length > 0) employees.push(e)
      }
      employees.sort((a, b) => (a.employeeId || '').localeCompare(b.employeeId || ''))
      return res.status(200).json(employees)
    } catch (e) {
      return res.status(500).json({ error: 'サーバーエラーが発生しました' })
    }
  }

  // 新規作成
  if (req.method === 'POST' && !hasId) {
    const { employeeId, name, lineId, type } = req.body
    if (!name) return res.status(400).json({ error: '氏名は必須です' })
    try {
      const newId = uuidv4()
      const now = new Date().toISOString()
      const employee = {
        id: newId, employeeId: employeeId || '', name,
        lineId: lineId || '', type: type || 'office',
        createdAt: now, updatedAt: now,
      }
      await redis.hset(`employee:${newId}`, employee)
      await redis.sadd('employees', newId)
      return res.status(201).json(employee)
    } catch (e) {
      return res.status(500).json({ error: 'サーバーエラーが発生しました' })
    }
  }

  // 更新
  if (req.method === 'PUT' && hasId) {
    const { employeeId, name, lineId, type } = req.body
    if (!name) return res.status(400).json({ error: '氏名は必須です' })
    try {
      const existing = await redis.hgetall(`employee:${id}`)
      if (!existing || Object.keys(existing).length === 0) return res.status(404).json({ error: '従業員が見つかりません' })
      const updated = {
        ...existing,
        employeeId: employeeId || '',
        name,
        lineId: lineId || '',
        type: type || 'office',
        updatedAt: new Date().toISOString(),
      }
      await redis.hset(`employee:${id}`, updated)
      return res.status(200).json(updated)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 削除
  if (req.method === 'DELETE' && hasId) {
    try {
      await redis.del(`employee:${id}`)
      await redis.srem('employees', id)
      return res.status(200).json({ message: '削除しました' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
