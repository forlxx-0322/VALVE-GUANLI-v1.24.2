@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 客户管理系统 - 安装为桌面应用
cd /d "%~dp0"

echo.
echo   ==================================================
echo      客户管理系统  ·  安装为桌面应用（0 安装包）
echo   ==================================================
echo.

set "URL=http://127.0.0.1:8899/"

rem ---------- 1. 找浏览器（Edge 优先，其次 Chrome） ----------
set "BROWSER="
for %%P in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
) do (
  if not defined BROWSER if exist %%P set "BROWSER=%%~P"
)
if not defined BROWSER (
  echo   [错误] 没找到 Edge 或 Chrome。Windows 10/11 自带 Edge，请确认没被卸载。
  echo.
  pause
  exit /b 1
)
echo   浏览器：!BROWSER!

rem ---------- 2. 服务没跑就先拉起来 ----------
echo   检查本机服务 ...
curl -s --fail -o nul --max-time 2 "%URL%api/health" >nul 2>nul
if errorlevel 1 (
  echo   服务未运行，正在启动（最小化窗口）...
  start "" /min "%~dp0启动.bat"
  set "READY="
  for /l %%I in (1,1,25) do (
    if not defined READY (
      timeout /t 1 >nul
      curl -s --fail -o nul --max-time 2 "%URL%api/health" >nul 2>nul
      if not errorlevel 1 set "READY=1"
    )
  )
  if not defined READY (
    echo   [提示] 服务 25 秒内没起来，请先双击「启动.bat」看下报错。
    echo.
    pause
    exit /b 1
  )
)
echo   服务已就绪：%URL%
echo.

rem ---------- 3. 用"应用窗口"打开（无地址栏、独立任务栏图标） ----------
echo   正在打开应用窗口 ...
start "" "!BROWSER!" --app="%URL%"
echo.

echo   --------------------------------------------------
echo   想固定到开始菜单 / 桌面（推荐）：
echo     1. 在弹出的应用窗口右上角点  ...  （Chrome 是 ⋮）
echo     2. 选「应用」-^>「安装此站点为应用」
echo     3. 名称填「客户管理」，确定；之后开始菜单和桌面就有独立图标
echo.
echo   说明：这只是浏览器的一个"应用壳"，数据仍在本机，不联网也不上传。
echo   以后每天点图标打开即可；服务没跑时先把「启动.bat」双击一下。
echo   --------------------------------------------------
echo.
timeout /t 8 >nul
exit /b 0
