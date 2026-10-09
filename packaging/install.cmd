@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\bootstrap.ps1" -Action install %*
exit /b %ERRORLEVEL%
