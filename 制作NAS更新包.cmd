@echo off
rem ============================================================
rem  JingCai - Build NAS update package (cross-network update)
rem  Creates "NAS update package.zip" in this folder.
rem  Upload it via the fnOS remote-access "Files" app to the
rem  project folder, extract (overwrite), then restart the
rem  "jingcai" container in fnOS Docker.
rem  Details are in UPDATE-README.txt inside the zip.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "scripts\make-nas-update.ps1"
echo.
pause
