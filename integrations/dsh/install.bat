@echo off
chcp 65001 >nul
title All-in-One Agent Hub - DSH Plugin Installer

echo ==========================================================
echo   正在为 DeepSeek Harness (DSH) 安装 Agent Hub 插件...
echo ==========================================================

set ROOT_DIR=%~dp0
python "%ROOT_DIR%install-dsh.py" %*

echo.
pause
