@echo off
rem ============================================================
rem  JingCai 1Qiu Diff - One-click setup (for a new computer)
rem  Steps: 1) install Node deps  2) register daily tasks
rem         3) run environment self-check
rem  Just double-click this file. A UAC prompt will appear - click Yes.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo Requesting administrator privileges, please click "Yes" in the UAC dialog...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo [1/3] Installing Node dependencies ...
where npm >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: Node.js not found. Please install it first: https://nodejs.org
  pause
  exit /b 1
)
call npm install --no-fund --no-audit
if %errorlevel% neq 0 (echo npm install FAILED & pause & exit /b 1)

echo.
echo [2/3] Registering daily scheduled tasks (11:00 / 21:00, current user) ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register-tasks.ps1" -InteractiveUser

echo.
echo [3/3] Environment self-check ...
node "%~dp0scripts\daily.js" check

echo.
echo ============================================================
echo  Setup finished.
echo  First push: double-click the manual-run cmd (Chinese file
echo  name: shou-dong-zhi-xing.cmd) once, and sign in when the
echo  GitHub login window pops up. After that it is fully automatic.
echo  See README.md - section about migrating to another computer.
echo ============================================================
pause
