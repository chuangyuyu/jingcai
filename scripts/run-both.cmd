@echo off
rem Task wrapper: fetch odds + backfill results (used by scheduled task)
cd /d "%~dp0.."
node scripts\daily.js both
