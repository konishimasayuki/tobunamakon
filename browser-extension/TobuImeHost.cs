// ============================================================
//  東部生コン IME 自動切替 — Windows ネイティブホスト
// ------------------------------------------------------------
//  Chrome / Edge の拡張機能から Native Messaging で
//    {"mode":"kana"}  … 全角ひらがな(ローマ字入力) に切替
//    {"mode":"ascii"} … 半角英数(IME OFF) に切替
//  を受け取り、フォアグラウンドウィンドウの入力欄に対して
//  IMM32 の WM_IME_CONTROL を送って IME を実際に切り替える。
//
//  ・追加ランタイム不要（Windows 同梱の .NET Framework で動作）
//  ・install.bat が同梱の csc.exe でこの1ファイルをコンパイルする
//
//  ビルド:  csc /target:winexe /out:tobu-ime-host.exe TobuImeHost.cs
// ============================================================
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class TobuImeHost
{
    // ---- Win32 ----
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO gui);
    [DllImport("imm32.dll")]  static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam,
                                            uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct GUITHREADINFO
    {
        public int cbSize; public uint flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }

    const uint WM_IME_CONTROL       = 0x0283;
    const int  IMC_SETCONVERSIONMODE = 0x0002;
    const int  IMC_SETOPENSTATUS     = 0x0006;
    const int  IME_CMODE_NATIVE      = 0x0001;
    const int  IME_CMODE_FULLSHAPE   = 0x0008;
    const int  IME_CMODE_ROMAN       = 0x0010;
    const uint SMTO_ABORTIFHUNG      = 0x0002;

    static bool ApplyIme(string mode)
    {
        IntPtr hFg = GetForegroundWindow();
        if (hFg == IntPtr.Zero) return false;

        uint pid;
        uint tid = GetWindowThreadProcessId(hFg, out pid);

        // フォアグラウンドスレッドで実際にフォーカスされている子ウィンドウを取得
        IntPtr hFocus = hFg;
        var gti = new GUITHREADINFO();
        gti.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(tid, ref gti) && gti.hwndFocus != IntPtr.Zero)
            hFocus = gti.hwndFocus;

        IntPtr hIme = ImmGetDefaultIMEWnd(hFocus);
        if (hIme == IntPtr.Zero) hIme = ImmGetDefaultIMEWnd(hFg);
        if (hIme == IntPtr.Zero) return false;

        IntPtr res;
        if (mode == "kana")
        {
            // IME ON → 全角ひらがな・ローマ字入力
            SendMessageTimeout(hIme, WM_IME_CONTROL, (IntPtr)IMC_SETOPENSTATUS, (IntPtr)1,
                               SMTO_ABORTIFHUNG, 400, out res);
            int conv = IME_CMODE_NATIVE | IME_CMODE_FULLSHAPE | IME_CMODE_ROMAN;
            SendMessageTimeout(hIme, WM_IME_CONTROL, (IntPtr)IMC_SETCONVERSIONMODE, (IntPtr)conv,
                               SMTO_ABORTIFHUNG, 400, out res);
        }
        else // "ascii"
        {
            // IME OFF（直接入力＝半角英数）
            SendMessageTimeout(hIme, WM_IME_CONTROL, (IntPtr)IMC_SETOPENSTATUS, (IntPtr)0,
                               SMTO_ABORTIFHUNG, 400, out res);
        }
        return true;
    }

    // ---- Native Messaging（4byte 長さ + UTF-8 JSON）----
    static byte[] ReadExact(Stream s, int n)
    {
        var buf = new byte[n];
        int off = 0;
        while (off < n)
        {
            int r = s.Read(buf, off, n - off);
            if (r <= 0) return null; // EOF（ブラウザ終了）
            off += r;
        }
        return buf;
    }

    // 我々の拡張が送る最小 JSON からモード値だけを取り出す簡易パーサ
    static string ParseMode(string json)
    {
        int i = json.IndexOf("\"mode\"", StringComparison.Ordinal);
        if (i < 0) return null;
        i = json.IndexOf(':', i);
        if (i < 0) return null;
        int q1 = json.IndexOf('"', i + 1);
        if (q1 < 0) return null;
        int q2 = json.IndexOf('"', q1 + 1);
        if (q2 < 0) return null;
        return json.Substring(q1 + 1, q2 - q1 - 1);
    }

    static void WriteMessage(Stream stdout, string json)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        byte[] len = BitConverter.GetBytes(payload.Length); // little-endian
        stdout.Write(len, 0, 4);
        stdout.Write(payload, 0, payload.Length);
        stdout.Flush();
    }

    static int Main()
    {
        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();
        while (true)
        {
            byte[] lenBytes = ReadExact(stdin, 4);
            if (lenBytes == null) break;
            int len = BitConverter.ToInt32(lenBytes, 0);
            if (len <= 0 || len > 1024 * 1024) break;

            byte[] msg = ReadExact(stdin, len);
            if (msg == null) break;

            string mode = null;
            bool ok = false;
            try
            {
                mode = ParseMode(Encoding.UTF8.GetString(msg));
                if (mode == "kana" || mode == "ascii") ok = ApplyIme(mode);
            }
            catch { ok = false; }

            WriteMessage(stdout, "{\"ok\":" + (ok ? "true" : "false") +
                                 ",\"mode\":\"" + (mode ?? "") + "\"}");
        }
        return 0;
    }
}
