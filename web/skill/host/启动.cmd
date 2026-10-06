@echo off
cd /d %~dp0
echo ============================================================
echo  BQB Hub image host  (port 8123)
echo.
echo  This starts ONLY the image host layer.
echo  Start ComfyUI first (the drawing engine, port 8188).
echo  Both must be running, and this window must stay open.
echo.
echo  The phone needs the two lines printed below:
echo    - the address line with WLAN / Ethernet
echo    - the pairing token
echo ============================================================
echo.
chcp 65001 >nul
node serve.mjs --lan
chcp 936 >nul
echo.
echo The host has exited. Press any key to close this window.
pause
