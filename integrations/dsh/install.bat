@echo off
setlocal
chcp 65001 >nul
if "%~1"=="" (
  echo Usage: install.bat --profile EXISTING_PROFILE [--url URL] [--check]
  echo This helper prepares configuration; the official dsh CLI links the package.
  exit /b 2
)
if not defined HUB_PYTHON set "HUB_PYTHON=python"
"%HUB_PYTHON%" -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
if errorlevel 1 (
  echo Python 3.8+ is required. Set HUB_PYTHON to a working python.exe path.
  exit /b 1
)
"%HUB_PYTHON%" "%~dp0install-dsh.py" %*
exit /b %errorlevel%
