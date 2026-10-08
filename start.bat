@echo off
chcp 65001 >nul
title Multi-Agent Hub Launcher

echo ==========================================================
echo           🚀 Starting Multi-Agent Hub (Windows)...   
echo ==========================================================

set ROOT_DIR=%~dp0
cd /d "%ROOT_DIR%"

if not exist logs mkdir logs
if not exist .run mkdir .run

if not exist hub\agents.json (
    if exist hub\agents.example.json (
        echo [Info] 自动从 agents.example.json 创建 agents.json...
        copy hub\agents.example.json hub\agents.json >nul
    )
)

set AGENTHUB_HOST=127.0.0.1
set AGENTHUB_PORT=8765
set HUBCONSOLE_HOST=0.0.0.0
set HUBCONSOLE_PORT=8890

echo [1/2] 正在启动 Task Bus (Python MCP Server :8765)...
start "Multi-Agent Hub - Task Bus" /min python hub\agent_hub.py --http %AGENTHUB_PORT% --host %AGENTHUB_HOST%

echo [2/2] 正在启动 Web Console (Node.js :8890)...
cd /d "%ROOT_DIR%console"
start "Multi-Agent Hub - Web Console" /min node server.mjs
cd /d "%ROOT_DIR%"

timeout /t 2 >nul

echo.
echo ==========================================================
echo   ✅ Multi-Agent Hub 已在后台启动！
echo ==========================================================
echo   🌐 Web 控制台地址 : http://localhost:%HUBCONSOLE_PORT%/dashboard
echo   📡 MCP 任务总线地址 : http://%AGENTHUB_HOST%:%AGENTHUB_PORT%/mcp
echo   ⏹  停止服务       : 双击运行 stop.bat
echo ==========================================================
pause
