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

  // 配送割り当て：担当者・現場住所の更新（ログイン不要。指定された項目だけ更新）
  if (isAssign) {
    try {
      const existing = await redis.hgetall(`shipment:${id}`)
      if (!existing || Object.keys(existing).length === 0) return res.status(404).json({ error: '出荷登録が見つかりません' })
      const body: any = req.body || {}
      const patch: any = {}
      const changed: string[] = []
      if (Array.isArray(body.drivers)) { patch.drivers = body.drivers.map((d: any) => ({ id: d.id || '', name: d.name || '' })); changed.push('drivers') }
      if (body.siteAddress !== undefined) patch.siteAddress = String(body.siteAddress || '')
      if (body.mapView !== undefined) patch.mapView = body.mapView || null
      if (body.mapPin !== undefined) patch.mapPin = body.mapPin || null
      if (Array.isArray(body.mapArrows)) patch.mapArrows = body.mapArrows
      const prevCf = Array.isArray((existing as any).changedFields) ? (existing as any).changedFields : []
      const changedFields = changed.length ? Array.from(new Set([...prevCf, ...changed])) : prevCf
      const updated = { ...existing, ...patch, changedFields, updatedAt: new Date().toISOString() }
      ;(updated as any).history = appendHistory(existing, updated)
      await redis.hset(`shipment:${id}`, updated)
      await indexShipment(id as string, (updated as any).date)
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

  // 単一伝票の取得（担当振替の別ウィンドウ等）。?id=... のGET（pdf指定なし）→ その1件だけ読む
  if (req.method === 'GET' && hasId) {
    try {
      const s = await redis.hgetall(`shipment:${id}`)
      if (!s || Object.keys(s).length === 0) return res.status(404).json({ error: '出荷登録が見つかりません' })
      return res.status(200).json(s)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 一覧取得。
  //  ・?date=YYYY-MM-DD / ?from=&to= … 日付索引で当日・期間のみ取得（読み取り削減）
  //  ・指定なし / ?cancelled=1 … 従来どおり全件読み（検索・キャンセル一覧のフォールバック）
  if (req.method === 'GET' && !hasId) {
    try {
      const q = req.query
      const showCancelled = q.cancelled === '1' || q.cancelled === 'true'
      const dateParam = Array.isArray(q.date) ? q.date[0] : q.date
      const fromParam = Array.isArray(q.from) ? q.from[0] : q.from
      const toParam = Array.isArray(q.to) ? q.to[0] : q.to
      const ft = (s: any) => Array.isArray(s.times) ? (s.times[0] || '') : (s.time || '')
      let shipments: Record<string, any>[]
      if (!showCancelled && (dateParam || (fromParam && toParam))) {
        // 索引経由：当日 or 期間ぶんの id だけ取得して読む
        await ensureIndexed()
        const min = dateScore(dateParam || fromParam)
        const max = dateScore(dateParam || toParam)
        if (!min || !max) return res.status(200).json([])
        const ids = ((await redis.zrange(INDEX_KEY, min, max, { byScore: true })) || []) as string[]
        if (!ids.length) return res.status(200).json([])
        const p = redis.pipeline()
        ids.forEach(sid => p.hgetall(`shipment:${sid}`))
        const rows = (await p.exec<Record<string, any>[]>()) || []
        shipments = rows.filter(s => s && Object.keys(s).length > 0 && !isCancelled(s))
      } else {
        // 全件読み（フォールバック）
        const ids = await redis.smembers('shipments')
        if (!ids || ids.length === 0) return res.status(200).json([])
        const p = redis.pipeline()
        ids.forEach((sid: string) => p.hgetall(`shipment:${sid}`))
        const rows = await p.exec<Record<string, any>[]>()
        shipments = rows.filter(s => s && Object.keys(s).length > 0)
        shipments = shipments.filter(s => showCancelled ? isCancelled(s) : !isCancelled(s))
      }
      shipments.sort((a, b) => (String(a.date) + ft(a)).localeCompare(String(b.date) + ft(b)))
      return res.status(200).json(shipments)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 伝票キャンセル/復元（ログイン必須）。?cancel=1 / body {cancelled:bool}。キャンセル以外の項目は保持
  if (req.method === 'PUT' && hasId && (req.query.cancel === '1' || req.query.cancel === 'true')) {
    try {
      const existing = await redis.hgetall(`shipment:${id}`)
      if (!existing || Object.keys(existing).length === 0) return res.status(404).json({ error: '出荷登録が見つかりません' })
      const now = new Date().toISOString()
      const cancelled = !!((req.body as any)?.cancelled)
      const updated = { ...existing, cancelled, cancelledAt: cancelled ? now : '', updatedAt: now }
      await redis.hset(`shipment:${id}`, updated)
      await indexShipment(id as string, (updated as any).date)
      return res.status(200).json(updated)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 索引の再構築（管理用・ログイン必須）。?reindex=1 で既存データから shipments:bydate を作り直す
  if (req.method === 'POST' && !hasId && (req.query.reindex === '1' || req.query.reindex === 'true')) {
    try {
      _indexedMem = false
      await redis.del('shipments:indexed')
      await ensureIndexed()
      const n = await redis.zcard(INDEX_KEY)
      return res.status(200).json({ reindexed: n })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 新規作成
  if (req.method === 'POST' && !hasId) {
    const { date, orderDate, companyId, companyName, tradingCompany, times, siteName, siteAddress, vehicleType, truckCount, vehicleItems, mixCode, specialNote, mixNotes, mixRows, cementType, volume, volumeNote, volumeUncertain, volumePlusA, volume2, volumeNote2, volumeUncertain2, volumePlusA2, placements, pourLocation, noteTags, testTags, orderContact, siteContact, drivers, notes, driverMessages, mapView, mapPin, mapArrows, pdfData, pdfName } = req.body
    if (!date || !companyName) return res.status(400).json({ error: '日付と業者名は必須です' })
    try {
      const newId = uuidv4()
      const now = new Date().toISOString()
      // PDF（画像PDF）は容量が大きいので伝票本体とは別キーに保存し、本体には有無とファイル名だけ持たせる
      const pdf = await savePdf(newId, pdfData, pdfName)
      const shipment = {
        id: newId, date,
        orderDate: orderDate || date,   // 受注日（作成日。以後変更しない）
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
        volumeNote: volumeNote || '',
        volumeUncertain: !!volumeUncertain,
        volumePlusA: !!volumePlusA,
        volume2: volume2 || '',
        volumeNote2: volumeNote2 || '',
        volumeUncertain2: !!volumeUncertain2,
        volumePlusA2: !!volumePlusA2,
        placements: Array.isArray(placements) ? placements : [],
        pourLocation: pourLocation || '',
        noteTags: Array.isArray(noteTags) ? noteTags : [],
        testTags: Array.isArray(testTags) ? testTags : [],
        orderContact: orderContact || '',
        siteContact: siteContact || '',
        drivers: Array.isArray(drivers) ? drivers : [],
        notes: Array.isArray(notes) ? notes : [],
        driverMessages: Array.isArray(driverMessages) ? driverMessages : [],
        mapView: mapView || null,
        mapPin: mapPin || null,
        mapArrows: Array.isArray(mapArrows) ? mapArrows : [],
        hasPdf: pdf.hasPdf,
        pdfName: pdf.pdfName,
        cancelled: false,
        cancelledAt: '',
        changedFields: [],
        history: [],
        createdAt: now, updatedAt: now,
      }
      await redis.hset(`shipment:${newId}`, shipment)
      await redis.sadd('shipments', newId)
      await indexShipment(newId, date)
      return res.status(201).json(shipment)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 更新
  if (req.method === 'PUT' && hasId) {
    const { date, orderDate, companyId, companyName, tradingCompany, times, siteName, siteAddress, vehicleType, truckCount, vehicleItems, mixCode, specialNote, mixNotes, mixRows, cementType, volume, volumeNote, volumeUncertain, volumePlusA, volume2, volumeNote2, volumeUncertain2, volumePlusA2, placements, pourLocation, noteTags, testTags, orderContact, siteContact, drivers, notes, driverMessages, changedFields, mapView, mapPin, mapArrows, pdfData, pdfName } = req.body
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
        orderDate: orderDate || (existing as any).orderDate || date,   // 受注日（編集可。送られた値を優先）
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
        volumeNote: volumeNote !== undefined ? (volumeNote || '') : ((existing as any).volumeNote ?? ''),
        volumeUncertain: !!volumeUncertain,
        volumePlusA: !!volumePlusA,
        volume2: volume2 || '',
        volumeNote2: volumeNote2 !== undefined ? (volumeNote2 || '') : ((existing as any).volumeNote2 ?? ''),
        volumeUncertain2: !!volumeUncertain2,
        volumePlusA2: !!volumePlusA2,
        hasPdf: pdf.hasPdf,
        pdfName: pdf.pdfName,
        placements: Array.isArray(placements) ? placements : [],
        pourLocation: pourLocation !== undefined ? (pourLocation || '') : ((existing as any).pourLocation ?? ''),
        noteTags: Array.isArray(noteTags) ? noteTags : (Array.isArray((existing as any).noteTags) ? (existing as any).noteTags : []),
        testTags: Array.isArray(testTags) ? testTags : (Array.isArray((existing as any).testTags) ? (existing as any).testTags : []),
        orderContact: orderContact || '',
        siteContact: siteContact || '',
        drivers: Array.isArray(drivers) ? drivers : [],
        notes: Array.isArray(notes) ? notes : [],
        driverMessages: Array.isArray(driverMessages) ? driverMessages : [],
        mapView: mapView !== undefined ? (mapView || null) : ((existing as any).mapView ?? null),
        mapPin: mapPin !== undefined ? (mapPin || null) : ((existing as any).mapPin ?? null),
        mapArrows: Array.isArray(mapArrows) ? mapArrows : (Array.isArray((existing as any).mapArrows) ? (existing as any).mapArrows : []),
        changedFields: Array.isArray(changedFields) ? changedFields : (Array.isArray((existing as any).changedFields) ? (existing as any).changedFields : []),
        updatedAt: new Date().toISOString(),
      }
      ;(updated as any).history = appendHistory(existing, updated)
      await redis.hset(`shipment:${id}`, updated)
      await indexShipment(id as string, (updated as any).date)
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
      await redis.del(INDEX_KEY)
      await redis.del('shipments:indexed')
      _indexedMem = false
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
      await redis.zrem(INDEX_KEY, id as string)
      return res.status(200).json({ message: '削除しました' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

// キャンセル済み判定（Redisの真偽値表現ゆれに対応）
function isCancelled(s: any): boolean {
  return !!s && (s.cancelled === true || s.cancelled === 'true' || s.cancelled === 1 || s.cancelled === '1')
}

// ===== 変更履歴（出荷登録の地図下に表示）=====
// 編集のたびに「変更された項目・変更前→変更後の値」を記録し、新しい順に最大30件保持する。
const HISTORY_FIELDS: [string, string][] = [
  ['date', '日付'], ['companyName', '業者名'], ['tradingCompany', '商社名'], ['siteName', '現場名'],
  ['siteAddress', '現場住所'], ['times', '時間'], ['vehicleType', '車種'], ['mixCode', '配合'],
  ['cementType', 'セメント種'], ['volume', '数量'], ['pourLocation', '打設箇所'], ['placements', '荷下ろし'],
  ['noteTags', '特記'], ['testTags', '試験'], ['orderContact', '連絡先'], ['siteContact', '現場連絡先'],
  ['notes', '備考'], ['drivers', '担当'],
]
function histVal(f: string, s: any): string {
  switch (f) {
    case 'times': return (Array.isArray(s.times) ? s.times.map((t: any) => (t && t.text != null) ? t.text : t) : []).map((x: any) => String(x ?? '').trim()).filter(Boolean).join(' / ')
    case 'drivers': return (Array.isArray(s.drivers) ? s.drivers.map((d: any) => d && d.name) : []).map((x: any) => String(x ?? '').trim()).filter(Boolean).join('・')
    case 'notes': return (Array.isArray(s.notes) ? s.notes.map((n: any) => (n && n.text != null) ? n.text : n) : []).map((x: any) => String(x ?? '').trim()).filter(Boolean).join(' / ')
    case 'placements': return (Array.isArray(s.placements) ? s.placements : []).join('・')
    case 'noteTags': return (Array.isArray(s.noteTags) ? s.noteTags : []).join('・')
    case 'testTags': return (Array.isArray(s.testTags) ? s.testTags : []).join('・')
    case 'vehicleType': {
      if (Array.isArray(s.vehicleItems) && s.vehicleItems.length) return s.vehicleItems.map((v: any) => v && v.type).filter(Boolean).join('・')
      return String(s.vehicleType || '')
    }
    case 'mixCode': {
      if (Array.isArray(s.mixRows) && s.mixRows.length) {
        return s.mixRows.map((r: any) => (Array.isArray(r?.parts) ? r.parts.slice(0, 3).join('-') : '')).filter((c: string) => /[0-9]/.test(c)).join(' / ')
      }
      return /[0-9]/.test(String(s.mixCode || '')) ? String(s.mixCode) : ''
    }
    case 'volume': {
      const seg = (v: any, a: any, u: any) => { const b = (v == null ? '' : String(v)).trim(); return (!b && !a && !u) ? '' : `${b}${a ? '+a' : ''}${u ? '?' : ''}` }
      return [seg(s.volume, s.volumePlusA, s.volumeUncertain), seg(s.volume2, s.volumePlusA2, s.volumeUncertain2)].filter(Boolean).join(' / ')
    }
    default: return String(s[f] ?? '')
  }
}
// existing(変更前)とupdated(変更後)を比べ、変わった項目だけ履歴へ1エントリ追加して返す
function appendHistory(existing: any, updated: any): any[] {
  const prev = Array.isArray(existing?.history) ? existing.history : []
  const items: { f: string; from: string; to: string }[] = []
  for (const [key, label] of HISTORY_FIELDS) {
    const from = histVal(key, existing)
    const to = histVal(key, updated)
    if (from !== to) items.push({ f: label, from, to })
  }
  if (!items.length) return prev
  return [{ t: new Date().toISOString(), items }, ...prev].slice(0, 30)
}

// ===== 日付インデックス（出荷予定表・配送割り当て等の「特定日」取得を高速化）=====
// shipments:bydate は ZSET（score=YYYYMMDD, member=id）。全件読み(1+N)を当日/期間の件数ぶんに抑える。
const INDEX_KEY = 'shipments:bydate'
function dateScore(d: any): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''))
  return m ? parseInt(m[1] + m[2] + m[3], 10) : 0
}
// 伝票1件を索引に登録（作成・更新時に呼ぶ。date変更時も同member再登録でscoreが更新される）
async function indexShipment(id: string, date: any): Promise<void> {
  const sc = dateScore(date)
  if (sc) { try { await redis.zadd(INDEX_KEY, { score: sc, member: id }) } catch { /* 索引失敗は本処理を止めない */ } }
}
// 既存データの索引を一度だけ構築（インスタンス内メモ＋Redisフラグ）。初回の日付取得時に自動実行。
let _indexedMem = false
async function ensureIndexed(): Promise<void> {
  if (_indexedMem) return
  try {
    if (await redis.get('shipments:indexed')) { _indexedMem = true; return }
    const ids = (await redis.smembers('shipments')) || []
    if (ids.length) {
      const p = redis.pipeline()
      ids.forEach((sid: string) => p.hgetall(`shipment:${sid}`))
      const rows = (await p.exec<Record<string, any>[]>()) || []
      const zp = redis.pipeline(); let any = false
      rows.forEach((s, i) => { const sc = dateScore(s && (s as any).date); if (sc) { zp.zadd(INDEX_KEY, { score: sc, member: ids[i] }); any = true } })
      if (any) await zp.exec()
    }
    await redis.set('shipments:indexed', '1')
    _indexedMem = true
  } catch { /* 失敗時は呼び出し側が全件フォールバックする */ }
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
