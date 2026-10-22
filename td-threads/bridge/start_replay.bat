@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
set SPEED=%1
if "%SPEED%"=="" set SPEED=60
py -3 threads_bridge.py --replay latest --speed %SPEED%
pause
