@echo off
rem Run environment self-check: node scripts\daily.js check
chcp 65001 >nul
cd /d "%~dp0"
node scripts\daily.js check
echo.
pause
