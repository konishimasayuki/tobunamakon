// ============================================================
//  背景(Service Worker): content.js からのモード要求を
//  Native Messaging で Windows 常駐ホスト(com.tobu.ime)へ橋渡しする。
//  ホスト未導入(install.bat 未実行)でもエラーにせず黙って無視する
//  → content.js 側の lang/inputmode ヒントだけが効く(従来動作)。
// ============================================================
const HOST = 'com.tobu.ime'
let port = null
let lastMode = null

function connect() {
  try {
    port = chrome.runtime.connectNative(HOST)
    port.onDisconnect.addListener(() => {
      // ホスト未導入 / 切断。chrome.runtime.lastError は参照して握りつぶす。
      void chrome.runtime.lastError
      port = null
      lastMode = null
    })
    port.onMessage.addListener(() => { /* ack は特に使わない */ })
  } catch (_) {
    port = null
  }
}

function send(mode) {
  if (mode !== 'kana' && mode !== 'ascii') return
  if (mode === lastMode) return       // 同じモードの連投は抑制
  if (!port) connect()
  if (!port) return
  try {
    port.postMessage({ mode })
    lastMode = mode
  } catch (_) {
    port = null
    lastMode = null
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'ime' && msg.mode) send(msg.mode)
})
