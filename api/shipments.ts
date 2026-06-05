import type { VercelRequest, VercelResponse } from '@vercel/node'
import { redis } from './_redis'
import { requireAuth } from './_auth'
import { v4 as uuidv4 } from 'uuid'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireAuth(req)
  const idParam = req.query.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  const hasId = !!id

  // 担当者の振替だけはログイン不要で許可（配送臨時割り当ての別ウィンドウ用）。担当者以外は変更しない。
  const isAssign = req.method === 'PUT' && hasId && (req.query.assign === '1' || req.query.assign === 'true')

  // 掲示板形式（出荷予定表）の別ウィンドウはログイン不要で閲覧できるよう、GET は認証なしで許可する。
  // 作成・更新・削除（POST/PUT/DELETE）は従来どおり認証必須（担当者振替の assign を除く）。
  if (!user && req.method !== 'GET' && !isAssign) return res.status(401).json({ error: '認証が必要です' })

  // 担当者の振替（ログイン不要・担当者のみ更新）
  if (isAssign) {
    try {
      const existing = await redis.hgetall(`shipment:${id}`)
      if (!existing || Object.keys(existing).length === 0) return res.status(404).json({ error: '出荷登録が見つかりません' })
      const drivers = Array.isArray((req.body as any)?.drivers) ? (req.body as any).drivers.map((d: any) => ({ id: d.id || '', name: d.name || '' })) : []
      const prevCf = Array.isArray((existing as any).changedFields) ? (existing as any).changedFields : []
      const changedFields = Array.from(new Set([...prevCf, 'drivers']))
      const updated = { ...existing, drivers, changedFields, updatedAt: new Date().toISOString() }
      await redis.hset(`shipment:${id}`, updated)
      return res.status(200).json(updated)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 添付PDFの取得（プレビュー用）: ?id=...&pdf=1 → application/pdf を返す
  if (req.method === 'GET' && hasId && (req.query.pdf === '1' || req.query.pdf === 'true')) {
    try {
      const b64 = await redis.get<string>(`shipmentpdf:${id}`)
      if (!b64) return res.status(404).json({ error: 'PDFが見つかりません' })
      const buf = Buffer.from(String(b64), 'base64')
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', 'inline; filename="shipment.pdf"')
      res.setHeader('Cache-Control', 'private, max-age=60')
      return res.status(200).send(buf)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 一覧取得
  if (req.method === 'GET' && !hasId) {
    try {
      const ids = await redis.smembers('shipments')
      if (!ids || ids.length === 0) return res.status(200).json([])
      const p = redis.pipeline()
      ids.forEach(sid => p.hgetall(`shipment:${sid}`))
      const rows = await p.exec<Record<string, any>[]>()
      const shipments = rows.filter(s => s && Object.keys(s).length > 0)
      const ft = (s: any) => Array.isArray(s.times) ? (s.times[0] || '') : (s.time || '')
      shipments.sort((a, b) => (String(a.date) + ft(a)).localeCompare(String(b.date) + ft(b)))
      return res.status(200).json(shipments)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 新規作成
  if (req.method === 'POST' && !hasId) {
    const { date, companyId, companyName, tradingCompany, times, siteName, siteAddress, vehicleType, truckCount, vehicleItems, mixCode, specialNote, mixNotes, mixRows, cementType, volume, volumeUncertain, volumePlusA, volume2, volumeUncertain2, volumePlusA2, placements, pourLocation, noteTags, orderContact, siteContact, drivers, notes, driverMessages, mapView, mapArrows, pdfData, pdfName } = req.body
    if (!date || !companyName) return res.status(400).json({ error: '日付と業者名は必須です' })
    try {
      const newId = uuidv4()
      const now = new Date().toISOString()
      // PDF（画像PDF）は容量が大きいので伝票本体とは別キーに保存し、本体には有無とファイル名だけ持たせる
      const pdf = await savePdf(newId, pdfData, pdfName)
      const shipment = {
        id: newId, date,
        companyId: companyId || '', companyName,
        tradingCompany: tradingCompany || '',
        times: Array.isArray(times) ? times : [],
        siteName: siteName || '',
        siteAddress: siteAddress || '',
        vehicleType: vehicleType || '',
        truckCount: truckCount || '',
        vehicleItems: Array.isArray(vehicleItems) ? vehicleItems : [],
        mixCode: mixCode || '',
        specialNote: specialNote || '',
        mixNotes: Array.isArray(mixNotes) ? mixNotes : ['', '', ''],
        mixRows: Array.isArray(mixRows) ? mixRows : [],
        cementType: cementType || '',
        volume: volume || '',
        volumeUncertain: !!volumeUncertain,
        volumePlusA: !!volumePlusA,
        volume2: volume2 || '',
        volumeUncertain2: !!volumeUncertain2,
        volumePlusA2: !!volumePlusA2,
        placements: Array.isArray(placements) ? placements : [],
        pourLocation: pourLocation || '',
        noteTags: Array.isArray(noteTags) ? noteTags : [],
        orderContact: orderContact || '',
        siteContact: siteContact || '',
        drivers: Array.isArray(drivers) ? drivers : [],
        notes: Array.isArray(notes) ? notes : [],
        driverMessages: Array.isArray(driverMessages) ? driverMessages : [],
        mapView: mapView || null,
        mapArrows: Array.isArray(mapArrows) ? mapArrows : [],
        hasPdf: pdf.hasPdf,
        pdfName: pdf.pdfName,
        changedFields: [],
        createdAt: now, updatedAt: now,
      }
      await redis.hset(`shipment:${newId}`, shipment)
      await redis.sadd('shipments', newId)
      return res.status(201).json(shipment)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 更新
  if (req.method === 'PUT' && hasId) {
    const { date, companyId, companyName, tradingCompany, times, siteName, siteAddress, vehicleType, truckCount, vehicleItems, mixCode, specialNote, mixNotes, mixRows, cementType, volume, volumeUncertain, volumePlusA, volume2, volumeUncertain2, volumePlusA2, placements, pourLocation, noteTags, orderContact, siteContact, drivers, notes, driverMessages, changedFields, mapView, mapArrows, pdfData, pdfName } = req.body
    if (!date || !companyName) return res.status(400).json({ error: '日付と業者名は必須です' })
    try {
      const existing = await redis.hgetall(`shipment:${id}`)
      if (!existing || Object.keys(existing).length === 0) return res.status(404).json({ error: '出荷登録が見つかりません' })
      // 新しいPDFが来た時だけ差し替え。来ていなければ既存の有無・名前を維持する
      const pdf = (pdfData !== undefined)
        ? await savePdf(id as string, pdfData, pdfName)
        : { hasPdf: (existing as any).hasPdf || '', pdfName: (existing as any).pdfName || '' }
      const updated = {
        ...existing,
        id,
        date,
        companyId: companyId || '', companyName,
        tradingCompany: tradingCompany || '',
        times: Array.isArray(times) ? times : [],
        siteName: siteName || '',
        siteAddress: siteAddress || '',
        vehicleType: vehicleType || '',
        truckCount: truckCount || '',
        vehicleItems: Array.isArray(vehicleItems) ? vehicleItems : (Array.isArray((existing as any).vehicleItems) ? (existing as any).vehicleItems : []),
        mixCode: mixCode || '',
        specialNote: specialNote || '',
        mixNotes: Array.isArray(mixNotes) ? mixNotes : ['', '', ''],
        mixRows: Array.isArray(mixRows) ? mixRows : (Array.isArray((existing as any).mixRows) ? (existing as any).mixRows : []),
        cementType: cementType || '',
        volume: volume || '',
        volumeUncertain: !!volumeUncertain,
        volumePlusA: !!volumePlusA,
        volume2: volume2 || '',
        volumeUncertain2: !!volumeUncertain2,
        volumePlusA2: !!volumePlusA2,
        hasPdf: pdf.hasPdf,
        pdfName: pdf.pdfName,
        placements: Array.isArray(placements) ? placements : [],
        pourLocation: pourLocation !== undefined ? (pourLocation || '') : ((existing as any).pourLocation ?? ''),
        noteTags: Array.isArray(noteTags) ? noteTags : (Array.isArray((existing as any).noteTags) ? (existing as any).noteTags : []),
        orderContact: orderContact || '',
        siteContact: siteContact || '',
        drivers: Array.isArray(drivers) ? drivers : [],
        notes: Array.isArray(notes) ? notes : [],
        driverMessages: Array.isArray(driverMessages) ? driverMessages : [],
        mapView: mapView !== undefined ? (mapView || null) : ((existing as any).mapView ?? null),
        mapArrows: Array.isArray(mapArrows) ? mapArrows : (Array.isArray((existing as any).mapArrows) ? (existing as any).mapArrows : []),
        changedFields: Array.isArray(changedFields) ? changedFields : (Array.isArray((existing as any).changedFields) ? (existing as any).changedFields : []),
        updatedAt: new Date().toISOString(),
      }
      await redis.hset(`shipment:${id}`, updated)
      return res.status(200).json(updated)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 全件削除（?all=1）。テストデータ等をまとめて消す。
  if (req.method === 'DELETE' && !hasId && (req.query.all === '1' || req.query.all === 'true')) {
    try {
      const ids = (await redis.smembers('shipments')) || []
      if (ids.length) {
        const p = redis.pipeline()
        ids.forEach(sid => p.del(`shipment:${sid}`))
        p.del('shipments')
        await p.exec()
      }
      return res.status(200).json({ deleted: ids.length })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 削除
  if (req.method === 'DELETE' && hasId) {
    try {
      await redis.del(`shipment:${id}`)
      await redis.del(`shipmentpdf:${id}`)
      await redis.srem('shipments', id)
      return res.status(200).json({ message: '削除しました' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

// PDF（dataURL もしくは素のbase64）を別キーに保存する。空文字なら削除。undefined は呼ばない想定。
// 戻り値は伝票本体に持たせる { hasPdf, pdfName }。
async function savePdf(id: string, pdfData: any, pdfName: any): Promise<{ hasPdf: string; pdfName: string }> {
  const key = `shipmentpdf:${id}`
  const raw = typeof pdfData === 'string' ? pdfData : ''
  if (!raw) {
    // 明示的に空が来たら添付を消す
    await redis.del(key)
    return { hasPdf: '', pdfName: '' }
  }
  const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
  await redis.set(key, b64)
  return { hasPdf: '1', pdfName: String(pdfName || 'shipment.pdf') }
}
