@echo off
if not "%~1"=="" goto run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\bootstrap.ps1" -Action install -KeepOpen
exit /b %ERRORLEVEL%
:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\bootstrap.ps1" -Action install %*
exit /b %ERRORLEVEL%
