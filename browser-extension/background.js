// ============================================================
//  背景(Service Worker): content.js からのモード要求を
//  Native Messaging で Windows 常駐ホスト(com.tobu.ime)へ橋渡しする。
//  ホスト未導入でもエラーにせず無視する（content.js のヒントのみ動作）。
//
//  診断: chrome://extensions → 本拡張の「service worker」→ Console で
//        [tobu-ime] のログを確認できる。
// ============================================================
const HOST = 'com.tobu.ime'
let port = null
let lastMode = null

function log(...a) { try { console.log('[tobu-ime]', ...a) } catch (_) {} }

function connect() {
  try {
    port = chrome.runtime.connectNative(HOST)
    log('connectNative called')
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError
      log('native host disconnected', err && err.message ? err.message : '(no error)')
      port = null
      lastMode = null
    })
    port.onMessage.addListener((m) => log('native reply', JSON.stringify(m)))
  } catch (e) {
    log('connectNative threw', e && e.message)
    port = null
  }
}

function send(mode) {
  if (mode !== 'kana' && mode !== 'ascii') return
  if (mode === lastMode) { log('skip (same mode)', mode); return }
  if (!port) connect()
  if (!port) { log('no port'); return }
  try {
    port.postMessage({ mode })
    lastMode = mode
    log('posted', mode)
  } catch (e) {
    log('postMessage threw', e && e.message)
    port = null
    lastMode = null
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'ime' && msg.mode) {
    log('onMessage', msg.mode)
    send(msg.mode)
  }
})
