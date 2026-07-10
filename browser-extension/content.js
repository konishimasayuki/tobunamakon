// ============================================================
// 東部生コン IME 自動切替 (Content Script)
// ------------------------------------------------------------
// 目的:
//   ・data-ime="kana"  … 業者名/現場名など日本語入力欄  → 全角かな
//   ・data-ime="ascii" … 日付/時間/連絡先など半角英数欄 → 半角英数
//  にフォーカスするたび、その欄に合わせて IME を切り替える。
//
// 実現手段:
//   (A) Windows 常駐ホスト(tobu-ime-host.exe)へ background.js 経由で
//       モードを送る → IMM32 で「実際に」切り替わる（本命）。
//   (B) 併せて lang / inputmode のヒントも付与（スマホのソフトキーボード
//       種別など、ホスト未導入時のベストエフォート）。
//
//  連続して同じモードになる場合、実際の送信は background.js 側で抑制する。
//  1フィールド内で手動 IME 切替した内容は、そのフィールドにいる間は保持される
//  （切替はフォーカス時のみ・入力中は送らないため）。
// ============================================================

(function () {
  'use strict'

  function sendNative(mode) {
    try { chrome.runtime.sendMessage({ type: 'ime', mode }) } catch (_) { /* noop */ }
  }

  function applyKana(el) {
    try {
      el.lang = 'ja'
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.setAttribute('inputmode', 'text')
    } catch (_) { /* noop */ }
    sendNative('kana')
  }

  function applyAscii(el) {
    try {
      el.lang = 'en'
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        // 数値専用ならスマホで英数キーボードになりやすい
        const im = el.getAttribute('data-ime-inputmode') || 'text'
        el.setAttribute('inputmode', im)
      }
    } catch (_) { /* noop */ }
    sendNative('ascii')
  }

  function onFocusIn(e) {
    const el = e.target
    if (!el) return
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return

    // 属性: 直接付いていなくても、上位に data-ime があれば継承
    const mode = el.getAttribute('data-ime')
      || (el.closest && el.closest('[data-ime]') && el.closest('[data-ime]').getAttribute('data-ime'))
    if (!mode) return

    if (mode === 'kana') applyKana(el)
    else if (mode === 'ascii') applyAscii(el)
  }

  document.addEventListener('focusin', onFocusIn, true)

  try { console.info('[東部生コン IME 拡張] content script 起動 ✓') } catch (_) {}
})()
