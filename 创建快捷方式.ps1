# ============================================================
# 创建「CRM管理系统」桌面 + 开始菜单快捷方式（图标：Q 版女仆 crm.ico）
# 用法：右键「使用 PowerShell 运行」，或在 PowerShell 里执行本文件
# ============================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $root 'server\server.js'))) {
  $root = 'D:\BJXT'
}

$vbs = Join-Path $root '启动CRM.vbs'
$icon = Join-Path $root 'web\assets\crm2.ico'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

if (-not (Test-Path $vbs)) { throw "找不到 启动CRM.vbs：$vbs" }
if (-not (Test-Path $icon)) { throw "找不到图标 crm.ico：$icon" }

$shell = New-Object -ComObject WScript.Shell

function New-Shortcut([string]$path) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $wscript
  $lnk.Arguments = '"' + $vbs + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = $icon + ',0'
  $lnk.Description = 'CRM管理系统'
  $lnk.WindowStyle = 1
  $lnk.Save()
  Write-Host "✓ 已创建：$path"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'

New-Shortcut (Join-Path $desktop 'CRM管理系统.lnk')
New-Shortcut (Join-Path $startMenu 'CRM管理系统.lnk')

Write-Host ''
Write-Host '完成：桌面和开始菜单都有「CRM管理系统」了。'
Write-Host '双击后会先确保服务在跑，再用独立窗口打开（无地址栏）。'
