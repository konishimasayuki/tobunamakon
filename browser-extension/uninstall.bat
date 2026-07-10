@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   Tobu IME switch  -  Host uninstaller
echo ============================================
echo.

echo Removing Chrome registration ...
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tobu.ime" /f >nul 2>&1
echo Removing Edge registration ...
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tobu.ime" /f >nul 2>&1

if exist "%~dp0tobu-ime-host.exe" (
  del /q "%~dp0tobu-ime-host.exe" >nul 2>&1
  echo Deleted tobu-ime-host.exe
)

echo.
echo Done. Remove the extension manually from chrome://extensions if needed.
echo.
echo Press any key to close...
pause >nul
endlocal
