@echo off
chcp 65001 >nul
echo 正在停止 Multi-Agent Hub 服务...

taskkill /f /fi "WINDOWTITLE eq Multi-Agent Hub - Task Bus*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq Multi-Agent Hub - Web Console*" >nul 2>&1

echo ✅ 服务已停止。
timeout /t 2 >nul
