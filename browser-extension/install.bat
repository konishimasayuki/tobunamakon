@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ============================================
echo   東部生コン IME 自動切替 ホスト インストール
echo ============================================
echo.

rem --- .NET Framework の csc.exe を探す（Windows 同梱・追加インストール不要） ---
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [エラー] .NET Framework の csc.exe が見つかりません。
  echo         Windows の .NET Framework 4.x が必要です。
  goto :fail
)

echo [1/3] ホストをコンパイルしています...
"%CSC%" /nologo /target:winexe /out:"%~dp0tobu-ime-host.exe" "%~dp0TobuImeHost.cs"
if errorlevel 1 goto :fail
if not exist "%~dp0tobu-ime-host.exe" goto :fail
echo       -^> tobu-ime-host.exe を作成しました。

echo [2/3] Chrome にネイティブホストを登録しています...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tobu.ime" /ve /t REG_SZ /d "%~dp0com.tobu.ime.json" /f >nul 2>&1

echo [3/3] Edge にネイティブホストを登録しています...
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tobu.ime" /ve /t REG_SZ /d "%~dp0com.tobu.ime.json" /f >nul 2>&1

echo.
echo ============================================
echo   インストール完了！
echo ============================================
echo.
echo 次にブラウザ側の拡張機能を読み込んでください:
echo   1) chrome://extensions （Edge は edge://extensions）を開く
echo   2) 右上「デベロッパーモード」を ON
echo   3)「パッケージ化されていない拡張機能を読み込む」で
echo      このフォルダ（%~dp0）を選択
echo.
echo   ※ 既に読み込み済みの場合は、拡張機能の「更新」ボタンを押すか
echo      ブラウザを再起動してください。
echo.
goto :end

:fail
echo.
echo [失敗] インストールを中止しました。
:end
pause
endlocal
