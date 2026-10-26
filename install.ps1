﻿# Windows 安装：装音频转写组件，记下本机 agent 命令行的路径，给 Chrome / Edge / Brave 注册本地服务，
# 然后引导你加载浏览器扩展。重复运行就是更新。
# 用法: 双击 install.cmd；或 powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 让 Python 的输出也用 UTF-8，不然中文用户名路径之类的会在 PowerShell 里变成乱码
$env:PYTHONIOENCODING = 'utf-8'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Name = 'com.leinaldo.bili_obsidian'
$ExtId = 'kcoaeghgmnflfeonjdpodfeakekcofga'  # 由 extension\manifest.json 里的 key 决定

# 找 Python 3.8+。跳过 WindowsApps 里那个只会打开应用商店的假 python
$Py = $null
foreach ($c in @('py', 'python', 'python3')) {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { continue }
    $exe = & $c -c "import sys; assert sys.version_info >= (3, 8); print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe -and ($exe -notlike '*WindowsApps*')) { $Py = $exe.Trim(); break }
}
if (-not $Py) { Write-Host '需要 Python 3.8+，请到 https://www.python.org/downloads/ 安装（勾选 Add to PATH）'; exit 1 }
Write-Host "Python：$Py"

# 旧版本（油猴脚本 + 后台 HTTP 服务）留下的开机自启和进程，新版本不再需要
$OldLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'bili-obsidian.lnk'
if (Test-Path $OldLnk) {
    Remove-Item -Force $OldLnk
    Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
        Where-Object { $_.CommandLine -like '*server.py*' -and $_.CommandLine -like '*bili-obsidian*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Host '已移除旧版本的后台服务。记得在 Tampermonkey 里删掉旧的「B站总结到 Obsidian」脚本'
}

# 视频没有 AI 字幕时要下载音频转写。转写组件 faster-whisper 有几百 MB，装在单独的虚拟环境里
Write-Host '安装音频转写组件（首次要下载几百 MB）…'
$AsrPy = Join-Path $Dir 'asr-venv\Scripts\python.exe'
if (-not (Test-Path $AsrPy)) { & $Py -m venv (Join-Path $Dir 'asr-venv') }
if (Test-Path $AsrPy) { & $AsrPy -m pip install -q --upgrade faster-whisper }
if (-not (Test-Path $AsrPy) -or $LASTEXITCODE -ne 0) {
    Write-Host '⚠️  转写组件安装失败：有 AI 字幕的视频不受影响，没有字幕的视频会总结失败。可以稍后重新运行安装'
}

# 记下 agent 命令行的完整路径：浏览器启动本地服务时的 PATH 可能和终端里不一样
Write-Host '查找本机的 agent 命令行…'
$Clis = [ordered]@{}
foreach ($c in @('claude', 'codex', 'opencode', 'gemini', 'qwen')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $Clis[$c] = $cmd.Source; Write-Host "  ${c}：$($cmd.Source)" } else { Write-Host "  ${c}：未安装" }
}
[IO.File]::WriteAllText((Join-Path $Dir 'clis.json'), ($Clis | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

# 本地服务的启动脚本：要用 python.exe（不是 pythonw.exe），浏览器靠标准输入输出和它通信
$Bat = Join-Path $Dir 'host\run_host.bat'
[IO.File]::WriteAllText($Bat, "@echo off`r`n`"$Py`" `"%~dp0bili_host.py`" %*`r`n", (New-Object Text.UTF8Encoding $false))
$Manifest = Join-Path $Dir 'host\native-host.json'
$m = [ordered]@{
    name = $Name; description = 'B站视频总结的本地服务'; path = $Bat; type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtId/")
}
[IO.File]::WriteAllText($Manifest, ($m | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
# Windows 上浏览器从注册表找本地服务；三家都写上，没装的浏览器不会读
foreach ($k in @('Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser', 'Chromium')) {
    $key = "HKCU:\Software\$k\NativeMessagingHosts\$Name"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $Manifest
}
Write-Host '✓ 已给 Chrome、Edge、Brave 注册本地服务'

# 按浏览器的方式启动一次本地服务，确认它能正常应答
$test = @'
import json, struct, subprocess, sys
p = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
msg = json.dumps({"id": 1, "cmd": "hello"}).encode()
out, _ = p.communicate(struct.pack("=I", len(msg)) + msg, timeout=60)
r = json.loads(out[4:4 + struct.unpack("=I", out[:4])[0]])
assert r["type"] == "result", r
print("✓ 本地服务自检通过：命令行 " + ("、".join(c["name"] for c in r["clis"]) or "无") +
      "；音频转写 " + ("可用" if r["asr"] else "不可用"))
'@
$test | & $Py - $Bat
if ($LASTEXITCODE -ne 0) { Write-Host "✗ 本地服务自检失败，看 $Dir\host.log"; exit 1 }

$Ext = Join-Path $Dir 'extension'
Set-Clipboard -Value $Ext
Write-Host ''
Write-Host '最后一步：在浏览器里加载扩展（只需一次，以后更新代码后在扩展页点「重新加载」即可）'
Write-Host '  1. 地址栏打开 chrome://extensions（Edge 是 edge://extensions），打开「开发者模式」'
Write-Host '  2. 点「加载已解压的扩展程序」，选择这个文件夹（路径已复制到剪贴板）：'
Write-Host "     $Ext"
Write-Host '  3. 如果浏览器之前开着，完全退出再打开一次，让它读到本地服务'
