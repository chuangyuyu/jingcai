@echo off
rem ============================================================
rem  JingCai - Sync code to NAS (double-click this file)
rem  Copies web/scripts code to the NAS project folder.
rem  Does NOT touch NAS data (docs\data / docs\excel), logs or
rem  NAS-local config (only merges the "times" schedule).
rem  After sync: restart the "jingcai" container in fnOS Docker.
rem  Equivalent: powershell -ExecutionPolicy Bypass -File scripts\sync-to-nas.ps1
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "scripts\sync-to-nas.ps1"
echo.
pause
