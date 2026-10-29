/**
 * 启动器生成器（只生成 启动.bat）
 *
 * 为什么用脚本生成：
 *   .bat 必须保存为 **UTF-8 无 BOM** 才能在 chcp 65001 下正确显示中文，
 *   用 PowerShell here-string 写会破坏全角字符，导致 cmd 报
 *   "'??：客户管理系统' is not recognized"。这里用 Buffer 精确写入（CRLF + UTF-8 无 BOM）。
 *
 * 1.25.5 起：启动后不再保留命令行窗口
 *   · 双击时先用 PowerShell 把自己以 --hidden 重新拉起，然后原窗口立即退出；
 *   · 隐藏模式里用 `start /b node server.js` 起服务，日志写到 data\server.log，
 *     启动器自己留在后台做健康巡检（每 30 秒），服务停了就退出；
 *   · 停止服务：设置页「关于 → 停止服务」按钮（POST /api/shutdown，仅本机）。
 *
 * 用法：node tools/make-bats.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const START_BAT = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal enabledelayedexpansion',
  'title 客户管理系统（后台运行）',
  '',
  'cd /d "%~dp0"',
  'set "ROOT=%~dp0"',
  'if "%ROOT:~-1%"=="\\" set "ROOT=%ROOT:~0,-1%"',
  '',
  'set "PORT=8899"',
  'set "MAXPORT=8910"',
  '',
  'rem ---------- 0. 隐藏命令行 ----------',
  'rem 可见窗口双击时：把自己以 --hidden 重新拉起（无窗口），然后原窗口立即退出。',
  'if /i not "%~1"=="--hidden" (',
  '  where powershell >nul 2>nul',
  '  if not errorlevel 1 (',
  '    powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath \'%~f0\' -ArgumentList \'--hidden\' -WindowStyle Hidden"',
  '    exit /b 0',
  '  )',
  '  rem 极端情况下没有 PowerShell：继续以可见窗口运行（功能不受影响）',
  ')',
  '',
  'rem 后台模式：所有提示写日志，不显示窗口。',
  'if not exist "%ROOT%\\data" mkdir "%ROOT%\\data"',
  'set "LOG=%ROOT%\\data\\server.log"',
  'rem 日志超过 5MB 就轮转一次，避免无限增长',
  'for %%A in ("%LOG%") do if %%~zA GTR 5242880 (',
  '  if exist "%LOG%.1" del "%LOG%.1" >nul 2>nul',
  '  move /y "%LOG%" "%LOG%.1" >nul 2>nul',
  ')',
  '',
  'rem ---------- 1. 找浏览器（打开无地址栏窗口用） ----------',
  'set "BROWSER="',
  'for %%P in (',
  '  "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
  '  "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
  '  "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
  '  "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
  ') do (',
  '  if not defined BROWSER if exist %%P set "BROWSER=%%~P"',
  ')',
  '',
  'rem ---------- 2. Check Node.js ----------',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo [%date% %time%] [错误] 未检测到 Node.js，需要 22.5 或更高版本。 >> "%LOG%"',
  '  exit /b 1',
  ')',
  'for /f "tokens=*" %%v in (\'node -v\') do set "NODEV=%%v"',
  'node -e "const v=process.versions.node.split(\'.\').map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)" >nul 2>nul',
  'if errorlevel 1 (',
  '  echo [%date% %time%] [错误] Node.js 版本过低（%NODEV%），需要 22.5 或更高。 >> "%LOG%"',
  '  exit /b 1',
  ')',
  '',
  'rem ---------- 3. 已在运行则只打开应用窗口 ----------',
  'call :probe',
  'if "!RUNNING!"=="1" (',
  '  call :openbrowser',
  '  exit /b 0',
  ')',
  '',
  'rem ---------- 4. Start the service (background, log to file) ----------',
  'set "CRM_ROOT=%ROOT%"',
  'set "CRM_PORT=%PORT%"',
  'echo. >> "%LOG%"',
  'echo [%date% %time%] 启动服务 >> "%LOG%"',
  'start "" /b node "%ROOT%\\server\\server.js" >> "%LOG%" 2>&1',
  '',
  'rem 等它起来（端口可能被占用后顺延，用 :probe 读 .run.json/扫描）',
  'set "UP="',
  'for /l %%i in (1,1,40) do (',
  '  if not defined UP (',
  '    ping -n 2 127.0.0.1 >nul',
  '    call :probe',
  '    if "!RUNNING!"=="1" set "UP=1"',
  '  )',
  ')',
  'if not defined UP (',
  '  echo [%date% %time%] [错误] 服务 40 秒内未就绪，详见本日志。 >> "%LOG%"',
  '  exit /b 1',
  ')',
  'call :openbrowser',
  '',
  'rem ---------- 5. 后台存活：每 30 秒巡检一次，服务停了就退出 ----------',
  ':watch',
  'ping -n 31 127.0.0.1 >nul',
  'call :probe',
  'if "!RUNNING!"=="1" goto watch',
  'echo [%date% %time%] 服务已停止，启动器退出 >> "%LOG%"',
  'exit /b 0',
  '',
  'rem ================= subroutines =================',
  '',
  'rem Probe candidate ports and confirm the running service is ours.',
  'rem Note: all rem lines are kept ASCII-only on purpose. A rem line that',
  'rem contains multi-byte characters can, under a codepage mismatch, be',
  'rem mangled by the parser and executed as a command, which surfaces as',
  'rem "xxx is not recognized as an internal or external command".',
  ':probe',
  'set "RUNNING=0"',
  'set "FOUNDPORT="',
  'set "RECPORT="',
  '',
  'rem 1) Authoritative source: the port recorded in data\\.run.json.',
  'if exist "%~dp0data\\.run.json" (',
  '  for /f "usebackq tokens=2 delims=:," %%a in (`findstr /i "\\"port\\"" "%~dp0data\\.run.json"`) do set "RECPORT=%%a"',
  '  set "RECPORT=!RECPORT: =!"',
  '  if not "!RECPORT!"=="" (',
  '    call :httpcheck !RECPORT!',
  '    if "!ALIVE!"=="1" (',
  '      set "RUNNING=1"',
  '      set "FOUNDPORT=!RECPORT!"',
  '    )',
  '  )',
  ')',
  '',
  'rem 2) Fallback: scan the configured range in case the record is stale.',
  'for /l %%p in (%PORT%,1,%MAXPORT%) do (',
  '  if "!RUNNING!"=="0" (',
  '    call :httpcheck %%p',
  '    if "!ALIVE!"=="1" (',
  '      set "RUNNING=1"',
  '      set "FOUNDPORT=%%p"',
  '    )',
  '  )',
  ')',
  'exit /b 0',
  '',
  'rem GET http://127.0.0.1:%1/api/health and look for our signature.',
  'rem curl.exe ships with Windows 10 1803+ (present on Windows 11).',
  'rem --connect-timeout 0.1 is the important part: on this machine a dead',
  'rem port does not refuse instantly, so a probe without it waits out the',
  'rem whole --max-time. Measured: dead port 2022ms -> 125ms, while a live',
  'rem port still answers in 19ms. That keeps the range scan fast.',
  ':httpcheck',
  'set "ALIVE=0"',
  'curl -s --connect-timeout 0.1 --max-time 1 "http://127.0.0.1:%1/api/health" >"%TEMP%\\crm_probe_%1.txt" 2>nul',
  'if exist "%TEMP%\\crm_probe_%1.txt" (',
  '  findstr /c:"crm-bjxt" "%TEMP%\\crm_probe_%1.txt" >nul 2>nul',
  '  if not errorlevel 1 set "ALIVE=1"',
  '  del "%TEMP%\\crm_probe_%1.txt" >nul 2>nul',
  ')',
  'exit /b 0',
  '',
  'rem Open the app window (chrome-less). Falls back to default browser.',
  ':openbrowser',
  'if defined BROWSER (',
  '  start "" "!BROWSER!" --app="http://127.0.0.1:!FOUNDPORT!/"',
  ') else (',
  '  start "" "http://127.0.0.1:!FOUNDPORT!/"',
  ')',
  'exit /b 0',
  ''
].join('\r\n');

function writeBat(name, content) {
  const file = path.join(ROOT, name);
  fs.writeFileSync(file, Buffer.from(content, 'utf8'));
  const buf = fs.readFileSync(file);
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  console.log(`已生成 ${name}  (${buf.length} 字节, BOM: ${hasBom ? '有(异常!)' : '无 ✓'})`);
  return file;
}

writeBat('启动.bat', START_BAT);
console.log('\n完成。双击 启动.bat（或桌面快捷方式）→ 后台起服务 + 打开应用窗口，不留命令行。');
