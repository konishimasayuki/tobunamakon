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
      const ids = await redis.smembers('shipments')
      if (!ids || ids.length === 0) return res.status(200).json([])
      const p = redis.pipeline()
      ids.forEach(sid => p.hgetall(`shipment:${sid}`))
      const rows = await p.exec<Record<string, any>[]>()
      const shipments = rows.filter(s => s && Object.keys(s).length > 0)
      shipments.sort((a, b) => (String(a.date) + (a.time || '')).localeCompare(String(b.date) + (b.time || '')))
      return res.status(200).json(shipments)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 新規作成
  if (req.method === 'POST' && !hasId) {
    const { date, time, companyId, companyName, siteName, vehicleType, driverId, driverName, mixCode, nbType, volume, equipment, note, orderContact, siteContact } = req.body
    if (!date || !companyName) return res.status(400).json({ error: '日付と業者名は必須です' })
    try {
      const newId = uuidv4()
      const now = new Date().toISOString()
      const shipment = {
        id: newId, date, time: time || '', companyId: companyId || '', companyName,
        siteName: siteName || '', vehicleType: vehicleType || '4t',
        driverId: driverId || '', driverName: driverName || '',
        mixCode: mixCode || '', nbType: nbType || 'N',
        volume: volume || '', equipment: equipment || '',
        note: note || '', orderContact: orderContact || '',
        siteContact: siteContact || '', createdAt: now, updatedAt: now,
      }
      await redis.hset(`shipment:${newId}`, shipment)
      await redis.sadd('shipments', newId)
      return res.status(201).json(shipment)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 削除
  if (req.method === 'DELETE' && hasId) {
    try {
      await redis.del(`shipment:${id}`)
      await redis.srem('shipments', id)
      return res.status(200).json({ message: '削除しました' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
