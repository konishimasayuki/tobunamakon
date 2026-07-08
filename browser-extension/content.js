// ============================================================
// 東部生コン IME 自動切替 (Content Script)
// ------------------------------------------------------------
// 目的:
//   ・data-ime="kana"  … 業者名/現場名など日本語入力欄
//   ・data-ime="ascii" … 日付/時間/連絡先など半角英数欄
//  にフォーカスした時、初回のみ IME モードのヒントを送る。
//  ユーザーが手動で切り替えた後は上書きしない(既に触った欄はマークして無視)。
//
// 実現手段(いずれもベストエフォート・環境依存):
//   1) lang 属性の切替 ("ja" / "en")
//   2) 空 CompositionEvent の dispatch (一部 IME はこれで反応)
//   3) inputMode の設定
//
// 注意: Web ページ / 拡張機能から Windows IME を「必ず」切替させる標準 API は無い。
//       完全な強制切替が必要な場合は Native Messaging 経由の Windows companion(exe) が必要。
// ============================================================

(function () {
  'use strict'
  const TOUCHED = new WeakSet()

  function hintKana(el) {
    try {
      el.lang = 'ja'
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.setAttribute('inputmode', 'text')
      }
      // 一部の IME はこれで日本語モードに切り替わる
      const start = new CompositionEvent('compositionstart', { data: '' })
      el.dispatchEvent(start)
      // すぐに終了イベントも送って表示上の副作用を消す
      const end = new CompositionEvent('compositionend', { data: '' })
      el.dispatchEvent(end)
    } catch (_) { /* noop */ }
  }

  function hintAscii(el) {
    try {
      el.lang = 'en'
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        // 数値専用ならブラウザ側で英数キーボードになる可能性が高い
        const im = el.getAttribute('data-ime-inputmode') || 'text'
        el.setAttribute('inputmode', im)
      }
    } catch (_) { /* noop */ }
  }

  function onFocusIn(e) {
    const el = e.target
    if (!el) return
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return
    if (TOUCHED.has(el)) return   // 既に一度触れた欄は「ユーザーの手動選択」を尊重

    // 属性: 直接付いていなくても、上位に data-ime があれば継承
    const mode = el.getAttribute('data-ime')
      || (el.closest && el.closest('[data-ime]') && el.closest('[data-ime]').getAttribute('data-ime'))
    if (!mode) return

    TOUCHED.add(el)
    if (mode === 'kana') hintKana(el)
    else if (mode === 'ascii') hintAscii(el)
  }

  // input イベント: 一度でも入力が発生した欄はユーザーが IME を自分で切替済とみなす
  function onInput(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      TOUCHED.add(e.target)
    }
  }

  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('input', onInput, true)

  // インジケータ: 拡張が動いている印を1回だけコンソールに出す
  try { console.info('[東部生コン IME 拡張] content script 起動 ✓') } catch (_) {}
})()
