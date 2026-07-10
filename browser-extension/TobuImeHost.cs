// ============================================================
//  東部生コン IME 自動切替 — Windows ネイティブホスト（診断ログ付き・多重方式）
// ------------------------------------------------------------
//  Chrome / Edge の拡張機能から Native Messaging で
//    {"mode":"kana"}  … 全角ひらがな(ローマ字入力) に切替
//    {"mode":"ascii"} … 半角英数(IME OFF) に切替
//  を受け取り、フォアグラウンドの入力欄の IME を切り替える。
//
//  Chrome/Edge は TSF ベースのため、確実性を上げるべく複数方式を併用:
//    (1) VK_IME_ON / VK_IME_OFF キー送出 (SendInput)  … TSF に最も効きやすい
//    (2) AttachThreadInput + IMM32 (ImmSetOpenStatus / ImmSetConversionStatus)
//    (3) WM_IME_CONTROL メッセージ (旧IMM互換)
//
//  診断ログ: %TEMP%\tobu-ime-host.log に各処理結果を追記する。
//  （原因切り分け後、ログ出力は削ってよい）
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
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] static extern IntPtr GetFocus();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder buf, int max);

    [DllImport("imm32.dll")] static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);
    [DllImport("imm32.dll")] static extern IntPtr ImmGetContext(IntPtr hWnd);
    [DllImport("imm32.dll")] static extern bool ImmReleaseContext(IntPtr hWnd, IntPtr hIMC);
    [DllImport("imm32.dll")] static extern bool ImmSetOpenStatus(IntPtr hIMC, bool fOpen);
    [DllImport("imm32.dll")] static extern bool ImmGetConversionStatus(IntPtr hIMC, out int conv, out int sentence);
    [DllImport("imm32.dll")] static extern bool ImmSetConversionStatus(IntPtr hIMC, int conv, int sentence);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam,
                                            uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    // ---- SendInput 構造体 ----
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }

    const uint INPUT_KEYBOARD    = 1;
    const uint KEYEVENTF_KEYUP   = 0x0002;
    const ushort VK_IME_ON       = 0x16;
    const ushort VK_IME_OFF      = 0x1A;

    const uint WM_IME_CONTROL       = 0x0283;
    const int  IMC_SETCONVERSIONMODE = 0x0002;
    const int  IMC_SETOPENSTATUS     = 0x0006;
    const int  IME_CMODE_NATIVE      = 0x0001;
    const int  IME_CMODE_FULLSHAPE   = 0x0008;
    const int  IME_CMODE_ROMAN       = 0x0010;
    const uint SMTO_ABORTIFHUNG      = 0x0002;

    // ---- 診断ログ ----
    static readonly string LOG = Path.Combine(Path.GetTempPath(), "tobu-ime-host.log");
    static void Log(string s)
    {
        try { File.AppendAllText(LOG, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + s + "\r\n", Encoding.UTF8); }
        catch { }
    }
    static string ClassOf(IntPtr h)
    {
        if (h == IntPtr.Zero) return "(null)";
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static void SendKey(ushort vk)
    {
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki = new KEYBDINPUT { wVk = vk };
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].U.ki = new KEYBDINPUT { wVk = vk, dwFlags = KEYEVENTF_KEYUP };
        uint sent = SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
        Log("    SendInput vk=0x" + vk.ToString("X") + " -> sent=" + sent +
            (sent == 0 ? " err=" + Marshal.GetLastWin32Error() : ""));
    }

    static bool ApplyIme(string mode)
    {
        IntPtr hFg = GetForegroundWindow();
        if (hFg == IntPtr.Zero) { Log("    foreground=null -> abort"); return false; }
        uint pid;
        uint tid = GetWindowThreadProcessId(hFg, out pid);
        Log("    foreground hwnd=" + hFg + " class=" + ClassOf(hFg) + " tid=" + tid);

        bool any = false;

        // (1) VK_IME_ON / VK_IME_OFF （TSF に最も効きやすい）
        SendKey(mode == "kana" ? VK_IME_ON : VK_IME_OFF);
        any = true;

        // (2)(3) 対象スレッドへアタッチして focus/IMM32 を直接操作
        uint self = GetCurrentThreadId();
        bool attached = AttachThreadInput(self, tid, true);
        try
        {
            IntPtr hFocus = GetFocus();
            if (hFocus == IntPtr.Zero) hFocus = hFg;
            Log("    attach=" + attached + " focus hwnd=" + hFocus + " class=" + ClassOf(hFocus));

            // (2) IMM32 直接
            IntPtr himc = ImmGetContext(hFocus);
            Log("    ImmGetContext=" + himc);
            if (himc != IntPtr.Zero)
            {
                if (mode == "kana")
                {
                    bool o = ImmSetOpenStatus(himc, true);
                    int cur, sen;
                    if (!ImmGetConversionStatus(himc, out cur, out sen)) sen = 0;
                    int conv = IME_CMODE_NATIVE | IME_CMODE_FULLSHAPE | IME_CMODE_ROMAN;
                    bool c = ImmSetConversionStatus(himc, conv, sen);
                    Log("    Imm kana: open=" + o + " conv=" + c);
                }
                else
                {
                    bool o = ImmSetOpenStatus(himc, false);
                    Log("    Imm ascii: open=" + o);
                }
                ImmReleaseContext(hFocus, himc);
            }

            // (3) WM_IME_CONTROL （旧IMM互換のバックアップ）
            IntPtr hIme = ImmGetDefaultIMEWnd(hFocus);
            if (hIme == IntPtr.Zero) hIme = ImmGetDefaultIMEWnd(hFg);
            Log("    defaultIMEWnd=" + hIme);
            if (hIme != IntPtr.Zero)
            {
                IntPtr res;
                if (mode == "kana")
                {
                    SendMessageTimeout(hIme, WM_IME_CONTROL, (IntPtr)IMC_SETOPENSTATUS, (IntPtr)1, SMTO_ABORTIFHUNG, 400, out res);
                    int conv = IME_CMODE_NATIVE | IME_CMODE_FULLSHAPE | IME_CMODE_ROMAN;
                    SendMessageTimeout(hIme, WM_IME_CONTROL, (IntPtr)IMC_SETCONVERSIONMODE, (IntPtr)conv, SMTO_ABORTIFHUNG, 400, out res);
                }
                else
                {
                    SendMessageTimeout(hIme, WM_IME_CONTROL, (IntPtr)IMC_SETOPENSTATUS, (IntPtr)0, SMTO_ABORTIFHUNG, 400, out res);
                }
            }
        }
        finally
        {
            if (attached) AttachThreadInput(self, tid, false);
        }
        return any;
    }

    // ---- Native Messaging（4byte 長さ + UTF-8 JSON）----
    static byte[] ReadExact(Stream s, int n)
    {
        var buf = new byte[n];
        int off = 0;
        while (off < n)
        {
            int r = s.Read(buf, off, n - off);
            if (r <= 0) return null;
            off += r;
        }
        return buf;
    }

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
        byte[] len = BitConverter.GetBytes(payload.Length);
        stdout.Write(len, 0, 4);
        stdout.Write(payload, 0, payload.Length);
        stdout.Flush();
    }

    static int Main()
    {
        Log("=== host started ===");
        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();
        while (true)
        {
            byte[] lenBytes = ReadExact(stdin, 4);
            if (lenBytes == null) { Log("stdin EOF -> exit"); break; }
            int len = BitConverter.ToInt32(lenBytes, 0);
            if (len <= 0 || len > 1024 * 1024) { Log("bad len " + len + " -> exit"); break; }

            byte[] msg = ReadExact(stdin, len);
            if (msg == null) break;

            string mode = null;
            bool ok = false;
            try
            {
                string raw = Encoding.UTF8.GetString(msg);
                mode = ParseMode(raw);
                Log("recv: " + raw + "  (mode=" + (mode ?? "?") + ")");
                if (mode == "kana" || mode == "ascii") ok = ApplyIme(mode);
            }
            catch (Exception ex) { Log("EXCEPTION: " + ex.Message); ok = false; }

            WriteMessage(stdout, "{\"ok\":" + (ok ? "true" : "false") +
                                 ",\"mode\":\"" + (mode ?? "") + "\"}");
        }
        return 0;
    }
}
