// 依存なしの ZIP（無圧縮=store方式）の生成/解析。ブラウザ・Nodeで同一動作する純JS。
// PDFバックアップ用途：PDFは既に圧縮済みなので store で十分（サイズもほぼ変わらない）。
// 文字コード：ファイル名はUTF-8（汎用フラグ bit11 を立てる）。

// ---- CRC-32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

const enc = new TextEncoder()
const dec = new TextDecoder()

// files: [{ name: string, bytes: Uint8Array }] → Uint8Array（ZIP全体）
export function zipStore(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const f of files) {
    const nameBytes = enc.encode(f.name)
    const data = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes)
    const crc = crc32(data)
    const size = data.length
    // ローカルファイルヘッダ（30 + name）
    const lh = new Uint8Array(30 + nameBytes.length)
    const dvl = new DataView(lh.buffer)
    dvl.setUint32(0, 0x04034b50, true)  // signature
    dvl.setUint16(4, 20, true)          // version needed
    dvl.setUint16(6, 0x0800, true)      // flags: UTF-8 filename
    dvl.setUint16(8, 0, true)           // method: store
    dvl.setUint16(10, 0, true)          // mod time
    dvl.setUint16(12, 0x21, true)       // mod date（1980-01-01。0は不正扱いのツールがあるため）
    dvl.setUint32(14, crc, true)
    dvl.setUint32(18, size, true)       // compressed size
    dvl.setUint32(22, size, true)       // uncompressed size
    dvl.setUint16(26, nameBytes.length, true)
    dvl.setUint16(28, 0, true)          // extra len
    lh.set(nameBytes, 30)
    chunks.push(lh, data)
    // 中央ディレクトリ（46 + name）
    const ch = new Uint8Array(46 + nameBytes.length)
    const dvc = new DataView(ch.buffer)
    dvc.setUint32(0, 0x02014b50, true)  // signature
    dvc.setUint16(4, 20, true)          // version made by
    dvc.setUint16(6, 20, true)          // version needed
    dvc.setUint16(8, 0x0800, true)      // flags
    dvc.setUint16(10, 0, true)          // method
    dvc.setUint16(12, 0, true)          // time
    dvc.setUint16(14, 0x21, true)       // date
    dvc.setUint32(16, crc, true)
    dvc.setUint32(20, size, true)
    dvc.setUint32(24, size, true)
    dvc.setUint16(28, nameBytes.length, true)
    dvc.setUint16(30, 0, true)          // extra len
    dvc.setUint16(32, 0, true)          // comment len
    dvc.setUint16(34, 0, true)          // disk number start
    dvc.setUint16(36, 0, true)          // internal attrs
    dvc.setUint32(38, 0, true)          // external attrs
    dvc.setUint32(42, offset, true)     // local header offset
    ch.set(nameBytes, 46)
    central.push(ch)
    offset += lh.length + data.length
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0)
  const centralOffset = offset
  // End Of Central Directory（22）
  const eocd = new Uint8Array(22)
  const dve = new DataView(eocd.buffer)
  dve.setUint32(0, 0x06054b50, true)
  dve.setUint16(4, 0, true)             // disk
  dve.setUint16(6, 0, true)             // disk with central dir
  dve.setUint16(8, files.length, true)  // entries this disk
  dve.setUint16(10, files.length, true) // entries total
  dve.setUint32(12, centralSize, true)
  dve.setUint32(16, centralOffset, true)
  dve.setUint16(20, 0, true)            // comment len
  // 連結
  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of chunks) { out.set(c, pos); pos += c.length }
  for (const c of central) { out.set(c, pos); pos += c.length }
  out.set(eocd, pos)
  return out
}

// Uint8Array（ZIP全体）→ [{ name, bytes }]。store方式のみ対応（本アプリが作ったZIP）。
export function unzipStore(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // EOCD を末尾から探す
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('ZIPが不正です（EOCDが見つかりません）')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)   // central dir offset
  const files = []
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIPが不正です（中央ディレクトリ）')
    const method = dv.getUint16(p + 10, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const lhOffset = dv.getUint32(p + 42, true)
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    if (method !== 0) throw new Error('未対応の圧縮方式です（storeのみ対応）: ' + name)
    // ローカルヘッダからデータ位置を求める
    const lhNameLen = dv.getUint16(lhOffset + 26, true)
    const lhExtraLen = dv.getUint16(lhOffset + 28, true)
    const dataStart = lhOffset + 30 + lhNameLen + lhExtraLen
    const data = bytes.slice(dataStart, dataStart + size)
    files.push({ name, bytes: data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}
