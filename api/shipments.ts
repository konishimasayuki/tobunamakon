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
      if (body.mapReceived !== undefined) patch.mapReceived = !!body.mapReceived
      if (body.faxReceived !== undefined) patch.faxReceived = !!body.faxReceived
      // ドライバーへの伝達事項＝備考(notes)。配送割り当てから編集した内容を出荷登録の備考へ反映。changed には積まない（赤ハイライト対象外）
      if (Array.isArray(body.notes)) patch.notes = body.notes.map((n: any) => ({ text: String((n && n.text != null) ? n.text : n ?? '').slice(0, 500), important: !!(n && n.important) }))
      const prevCf = Array.isArray((existing as any).changedFields) ? (existing as any).changedFields : []
      const changedFields = changed.length ? Array.from(new Set([...prevCf, ...changed])) : prevCf
      const updated = { ...existing, ...patch, changedFields, updatedAt: new Date().toISOString() }
      ;(updated as any).history = appendHistory(existing, updated)
      await saveShipmentHash(id as string, updated, (updated as any).date)
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

  // 版番号（グローバルINCR）の取得。掲示板のポーリングが「変化があったか」を1コマンドで確認するための軽量GET。
  // 認証不要（閲覧専用の別ウィンドウから叩けるように）。値が前回と変わっていなければ本体取得をスキップできる。
  if (req.method === 'GET' && !hasId && (req.query.rev === '1' || req.query.rev === 'true')) {
    return res.status(200).json({ rev: await readRev() })
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
  //  ・?recent=N&offset=M … 登録順(createdAt)索引で「登録が新しい順にN件」→ { items, next }
  //  ・?cancelled=1&limit=N&offset=M … キャンセル順索引で「キャンセルが新しい順にN件」→ { items, next }
  //  ・指定なし / 索引が使えないとき … 全件読み（検索・フォールバック）
  if (req.method === 'GET' && !hasId) {
    try {
      const q = req.query
      const one = (v: any) => Array.isArray(v) ? v[0] : v
      const num = (v: any) => { const n = parseInt(String(one(v) ?? ''), 10); return Number.isFinite(n) ? n : 0 }
      const showCancelled = q.cancelled === '1' || q.cancelled === 'true'
      const dateParam = one(q.date)
      const fromParam = one(q.from)
      const toParam = one(q.to)
      const offset = Math.max(0, num(q.offset))
      const recentN = Math.min(2000, Math.max(0, num(q.recent)))
      const limitN = Math.min(500, Math.max(0, num(q.limit)))
      const ft = (s: any) => { const t = Array.isArray(s.times) ? s.times[0] : s.time; return (t && t.text != null) ? t.text : (t || '') }

      // id配列 → 伝票ハッシュ（存在しないものは捨てる）
      const readIds = async (ids: string[]): Promise<Record<string, any>[]> => {
        if (!ids.length) return []
        const p = redis.pipeline()
        ids.forEach(sid => p.hgetall(`shipment:${sid}`))
        const rows = (await p.exec<Record<string, any>[]>()) || []
        return rows.filter(s => s && Object.keys(s).length > 0)
      }
      // ZSET索引から「新しい順に count 件」だけ読む。next は続きのoffset（もう無ければ null）
      const readZ = async (key: string, count: number, wantCancelled: boolean) => {
        const ids = ((await redis.zrange(key, offset, offset + count - 1, { rev: true })) || []) as string[]
        const rows = await readIds(ids)
        const items = rows.filter(s => wantCancelled ? isCancelled(s) : !isCancelled(s))
        return { items, next: ids.length < count ? null : offset + count }
      }
      // 索引が使えないときのフォールバック：全件読んでから同じ形に整える
      const readAllRows = async (): Promise<Record<string, any>[]> => readIds(((await redis.smembers('shipments')) || []) as string[])
      const sliceAll = (rows: Record<string, any>[], count: number, cmp: (a: any, b: any) => number) => {
        const sorted = [...rows].sort(cmp)
        return { items: sorted.slice(offset, offset + count), next: offset + count < sorted.length ? offset + count : null }
      }
      const byCancelledAt = (a: any, b: any) => String(b.cancelledAt || b.date || '').localeCompare(String(a.cancelledAt || a.date || ''))
      const byCreatedAt = (a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))

      // キャンセル伝票：直近N件だけ（「さらに読み込む」は offset を進めて再取得）
      if (showCancelled && limitN > 0) {
        if (await ensureZIndexed()) return res.status(200).json(await readZ(CANCELZ_KEY, limitN, true))
        const rows = (await readAllRows()).filter(isCancelled)
        return res.status(200).json(sliceAll(rows, limitN, byCancelledAt))
      }
      // 出荷登録の一覧：登録が新しい順にN件（伝票日付では絞らない＝遠い先の日付でも一覧の先頭に出る）
      if (!showCancelled && recentN > 0) {
        if (await ensureZIndexed()) return res.status(200).json(await readZ(CREATED_KEY, recentN, false))
        const rows = (await readAllRows()).filter(s => !isCancelled(s))
        return res.status(200).json(sliceAll(rows, recentN, byCreatedAt))
      }

      let shipments: Record<string, any>[]
      if (showCancelled && await ensureZIndexed()) {
        // キャンセル一覧（件数指定なし＝全件）：索引ぶんだけ読む（全件走査を避ける）
        const ids = ((await redis.zrange(CANCELZ_KEY, 0, -1, { rev: true })) || []) as string[]
        if (!ids.length) return res.status(200).json([])
        shipments = (await readIds(ids)).filter(isCancelled)
      } else if (!showCancelled && (dateParam || (fromParam && toParam))) {
        // 索引経由：当日 or 期間ぶんの id だけ取得して読む
        await ensureIndexed()
        const min = dateScore(dateParam || fromParam)
        const max = dateScore(dateParam || toParam)
        if (!min || !max) return res.status(200).json([])
        const ids = ((await redis.zrange(INDEX_KEY, min, max, { byScore: true })) || []) as string[]
        if (!ids.length) return res.status(200).json([])
        shipments = (await readIds(ids)).filter(s => !isCancelled(s))
      } else {
        // 全件読み（フォールバック）
        const rows = await readAllRows()
        if (!rows.length) return res.status(200).json([])
        shipments = rows.filter(s => showCancelled ? isCancelled(s) : !isCancelled(s))
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
      // 変更履歴に「キャンセル／復元」を日時付きで記録（あとから誰が何をしたか追えるように）
      const prevHist = Array.isArray((existing as any).history) ? (existing as any).history : []
      const histItem = { t: now, items: [{ f: '状態', from: cancelled ? '有効' : 'キャンセル', to: cancelled ? 'キャンセル' : '復元' }] }
      const updated = { ...existing, cancelled, cancelledAt: cancelled ? now : '', updatedAt: now, history: [histItem, ...prevHist].slice(0, 30) }
      await saveShipmentHash(id as string, updated, (updated as any).date)
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
      _zIndexedMem = false
      await redis.del('shipments:indexed')
      await redis.del(CREATED_FLAG)
      await redis.del(CANCELZ_FLAG)
      await redis.del(CREATED_KEY)
      await redis.del(CANCELZ_KEY)
      await ensureIndexed()
      await ensureZIndexed()
      const n = await redis.zcard(INDEX_KEY)
      return res.status(200).json({ reindexed: n })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 新規作成
  if (req.method === 'POST' && !hasId) {
    const { date, orderDate, companyId, companyName, tradingCompany, times, siteName, siteAddress, vehicleType, vehicleFree, truckCount, vehicleItems, mixCode, mixMode, specialNote, mixNotes, mixRows, cementType, cementType2, volume, volumeNote, volumeUncertain, volumePlusA, volume2, volumeNote2, volumeUncertain2, volumePlusA2, placements, pourLocation, noteTags, testTags, mapReceived, faxReceived, orderContact, siteContact, drivers, notes, driverMessages, mapView, mapPin, mapArrows, pdfData, pdfName } = req.body
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
        vehicleFree: vehicleFree || '',
        truckCount: truckCount || '',
        vehicleItems: Array.isArray(vehicleItems) ? vehicleItems : [],
        mixCode: mixCode || '',
        mixMode: (mixMode === 'mortar' || mixMode === 'dry') ? mixMode : 'num',
        specialNote: specialNote || '',
        mixNotes: Array.isArray(mixNotes) ? mixNotes : ['', '', ''],
        mixRows: Array.isArray(mixRows) ? mixRows : [],
        cementType: cementType || '',
        cementType2: cementType2 || '',
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
        mapReceived: !!mapReceived,
        faxReceived: !!faxReceived,
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
      await saveShipmentHash(newId, shipment, date)
      return res.status(201).json(shipment)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 更新
  if (req.method === 'PUT' && hasId) {
    const { date, orderDate, companyId, companyName, tradingCompany, times, siteName, siteAddress, vehicleType, vehicleFree, truckCount, vehicleItems, mixCode, mixMode, specialNote, mixNotes, mixRows, cementType, cementType2, volume, volumeNote, volumeUncertain, volumePlusA, volume2, volumeNote2, volumeUncertain2, volumePlusA2, placements, pourLocation, noteTags, testTags, mapReceived, faxReceived, orderContact, siteContact, drivers, notes, driverMessages, changedFields, mapView, mapPin, mapArrows, pdfData, pdfName } = req.body
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
        vehicleFree: vehicleFree !== undefined ? (vehicleFree || '') : ((existing as any).vehicleFree ?? ''),
        truckCount: truckCount || '',
        vehicleItems: Array.isArray(vehicleItems) ? vehicleItems : (Array.isArray((existing as any).vehicleItems) ? (existing as any).vehicleItems : []),
        mixCode: mixCode || '',
        mixMode: (mixMode === 'mortar' || mixMode === 'dry') ? mixMode : ((mixMode === 'num') ? 'num' : ((existing as any).mixMode || 'num')),
        specialNote: specialNote || '',
        mixNotes: Array.isArray(mixNotes) ? mixNotes : ['', '', ''],
        mixRows: Array.isArray(mixRows) ? mixRows : (Array.isArray((existing as any).mixRows) ? (existing as any).mixRows : []),
        cementType: cementType || '',
        cementType2: cementType2 !== undefined ? (cementType2 || '') : ((existing as any).cementType2 ?? ''),
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
        mapReceived: mapReceived !== undefined ? !!mapReceived : !!(existing as any).mapReceived,
        faxReceived: faxReceived !== undefined ? !!faxReceived : !!(existing as any).faxReceived,
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
      await saveShipmentHash(id as string, updated, (updated as any).date)
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
      await redis.del(CREATED_KEY)
      await redis.del(CREATED_FLAG)
      await redis.del(CANCELZ_KEY)
      await redis.del(CANCELZ_FLAG)
      await redis.del(OLD_CANCEL_SET)
      _indexedMem = false
      _zIndexedMem = false
      await bumpRev()   // 全削除も版番号を更新して掲示板に反映させる
      return res.status(200).json({ deleted: ids.length })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return res.status(500).json({ error: msg })
    }
  }

  // 削除
  if (req.method === 'DELETE' && hasId) {
    try {
      await removeShipment(id as string)
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
// 登録順(createdAt)の索引。一覧は「登録が新しい順」に並べるため、取得もこの軸で行う
//（伝票日付で絞ると、遠い未来日・過去日を登録した伝票が一覧から消えるため）。
const CREATED_KEY = 'shipments:bycreated'
const CREATED_FLAG = 'shipments:bycreatedindexed'
// キャンセル伝票の索引（新しい順に必要件数だけ取得するため ZSET）。
// ※旧 'shipments:cancelled' は SET のため同名にZSETは書けない。別名にして作り直す。
const CANCELZ_KEY = 'shipments:cancelledz'
const CANCELZ_FLAG = 'shipments:cancelledzindexed'
const OLD_CANCEL_SET = 'shipments:cancelled'
function tsOf(v: any): number { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : 0 }
function dateScore(d: any): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''))
  return m ? parseInt(m[1] + m[2] + m[3], 10) : 0
}
// ===== 変更版番号（グローバルINCR）＝掲示板ポーリングの「変化検知」用 =====
// 伝票が1件でも変わるたびに +1 する単一カウンター。掲示板は ?rev=1 でこの値だけ読み、
// 前回と同じなら本体（当日ぶん）を取得しない＝平常時の読み取りを大幅に削減する。
const REV_KEY = 'shipments:rev'
// ★伝票ハッシュへの書き込みは必ずこの1関数を通す（saveShipmentHash / removeShipment）。
//   hset＋索引更新＋版番号INCRを MULTI で原子化し、「片方だけ成功して版番号がズレる」部分失敗を防ぐ。
//   直接 redis.hset(`shipment:...`) を書く新規経路を足すと版番号更新が漏れるため、CIで検出する（scripts/check-shipment-writes.mjs）。
async function saveShipmentHash(id: string, obj: any, date: any): Promise<void> {
  const sc = dateScore(date)
  const tx = redis.multi()
  tx.hset(`shipment:${id}`, obj)
  tx.sadd('shipments', id)              // 冪等（既存でも無害）＝作成・更新のどちらでも集合を保つ
  if (sc) tx.zadd(INDEX_KEY, { score: sc, member: id })
  // 登録順の索引（作成日時）。同じMULTI内で維持する
  tx.zadd(CREATED_KEY, { score: tsOf(obj && obj.createdAt) || Date.now(), member: id })
  // キャンセル索引も同じMULTI内で維持（キャンセル→追加／復元→削除）
  if (isCancelled(obj)) tx.zadd(CANCELZ_KEY, { score: tsOf(obj && obj.cancelledAt) || tsOf(obj && obj.updatedAt) || Date.now(), member: id })
  else tx.zrem(CANCELZ_KEY, id)
  tx.incr(REV_KEY)
  await tx.exec()
}
// 伝票の削除も必ずこの1関数を通す（版番号INCRを含める）
async function removeShipment(id: string): Promise<void> {
  const tx = redis.multi()
  tx.del(`shipment:${id}`)
  tx.del(`shipmentpdf:${id}`)
  tx.srem('shipments', id)
  tx.zrem(INDEX_KEY, id)
  tx.zrem(CREATED_KEY, id)
  tx.zrem(CANCELZ_KEY, id)
  tx.incr(REV_KEY)
  await tx.exec()
}
async function bumpRev(): Promise<void> { try { await redis.incr(REV_KEY) } catch { /* noop */ } }
async function readRev(): Promise<number> {
  try { const v = await redis.get(REV_KEY); const n = Number(v); return Number.isFinite(n) ? n : 0 } catch { return 0 }
}
// 既存データから「登録順」「キャンセル」の索引を一度だけ作る（1回の全件走査で両方まとめて作る）。
// 成功なら true。false のときは呼び出し側が従来どおり全件走査する（安全側）。
let _zIndexedMem = false
async function ensureZIndexed(): Promise<boolean> {
  if (_zIndexedMem) return true
  try {
    const flags = (await redis.mget<(string | null)[]>(CREATED_FLAG, CANCELZ_FLAG)) || []
    if (flags[0] && flags[1]) { _zIndexedMem = true; return true }
    const ids = (await redis.smembers('shipments')) || []
    if (ids.length) {
      const p = redis.pipeline()
      ids.forEach((sid: string) => p.hgetall(`shipment:${sid}`))
      const rows = (await p.exec<Record<string, any>[]>()) || []
      const zp = redis.pipeline(); let any = false
      rows.forEach((s: any, i) => {
        if (!s || !Object.keys(s).length) return
        zp.zadd(CREATED_KEY, { score: tsOf(s.createdAt) || 1, member: ids[i] })
        if (isCancelled(s)) zp.zadd(CANCELZ_KEY, { score: tsOf(s.cancelledAt) || tsOf(s.updatedAt) || 1, member: ids[i] })
        any = true
      })
      if (any) await zp.exec()
    }
    await redis.set(CREATED_FLAG, '1')
    await redis.set(CANCELZ_FLAG, '1')
    try { await redis.del(OLD_CANCEL_SET) } catch { /* 旧SET索引は不要なので掃除（派生データ） */ }
    _zIndexedMem = true
    return true
  } catch { return false }
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
