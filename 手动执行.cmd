@echo off
rem ============================================================
rem  JingCai 1Qiu Diff - Manual Run (double-click this file)
rem  Fetch odds + backfill results + rebuild Excel + push to GitHub (if configured)
rem  Equivalent: node scripts\daily.js both
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
node scripts\daily.js both
echo.
pause
