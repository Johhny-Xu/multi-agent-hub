@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-services.ps1" -Action start
set "LAUNCH_RESULT=%ERRORLEVEL%"
if not "%~1"=="--no-pause" pause
exit /b %LAUNCH_RESULT%
