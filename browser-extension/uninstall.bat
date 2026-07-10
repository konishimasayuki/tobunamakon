@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ============================================
echo   東部生コン IME 自動切替 ホスト アンインストール
echo ============================================
echo.

echo Chrome の登録を解除...
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tobu.ime" /f >nul 2>&1
echo Edge の登録を解除...
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tobu.ime" /f >nul 2>&1

if exist "%~dp0tobu-ime-host.exe" (
  del /q "%~dp0tobu-ime-host.exe" >nul 2>&1
  echo tobu-ime-host.exe を削除しました。
)

echo.
echo 解除しました。ブラウザの拡張機能は chrome://extensions から手動で削除してください。
echo.
pause
endlocal
