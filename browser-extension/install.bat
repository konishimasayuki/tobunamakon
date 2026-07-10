@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   Tobu IME switch  -  Host installer
echo ============================================
echo.

rem --- Find the .NET Framework csc.exe (built into Windows 10/11) ---
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [ERROR] .NET Framework csc.exe was not found.
  echo         .NET Framework 4.x is required.
  goto :fail
)

echo [1/3] Compiling host ...
"%CSC%" /nologo /target:winexe /out:"%~dp0tobu-ime-host.exe" "%~dp0TobuImeHost.cs"
if errorlevel 1 goto :fail
if not exist "%~dp0tobu-ime-host.exe" goto :fail
echo       ok: tobu-ime-host.exe created.

echo [2/3] Registering native host for Chrome ...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tobu.ime" /ve /t REG_SZ /d "%~dp0com.tobu.ime.json" /f >nul 2>&1

echo [3/3] Registering native host for Edge ...
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tobu.ime" /ve /t REG_SZ /d "%~dp0com.tobu.ime.json" /f >nul 2>&1

echo.
echo ============================================
echo   Installation complete.
echo ============================================
echo.
echo Next: load the browser extension.
echo   1) Open  chrome://extensions   (Edge: edge://extensions)
echo   2) Turn ON "Developer mode" (top-right)
echo   3) Click "Load unpacked" and select THIS folder:
echo      %~dp0
echo.
echo   If it is already loaded, click the extension's Reload
echo   button or restart the browser.
echo.
goto :end

:fail
echo.
echo [FAILED] Installation was aborted.
:end
echo Press any key to close...
pause >nul
endlocal
