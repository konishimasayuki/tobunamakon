import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from '../_redis'
import { requireAuth } from '../_auth'

interface Employee {
  id: string
  employeeId: string
  name: string
  lineId: string
  type: string
  createdAt: string
  updatedAt: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  if (!user) return res.status(401).json({ error: '認証が必要です' })

  const { id } = req.query as { id: string }

  if (req.method === 'PUT') {
    const { employeeId, name, lineId, type } = req.body
    if (!name) return res.status(400).json({ error: '氏名は必須です' })
    try {
      const existing = await redis.hgetall<Employee>(`employee:${id}`)
      if (!existing) return res.status(404).json({ error: '従業員が見つかりません' })
      const updated: Employee = {
        ...existing,
        employeeId:
