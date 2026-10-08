@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
py -3 threads_bridge.py --browser
pause
