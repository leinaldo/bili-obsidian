# Windows 安装：生成配置，放一个开机自启的快捷方式（启动文件夹），并启动后台服务。
# 用法: 双击 install.cmd；或 powershell -ExecutionPolicy Bypass -File install.ps1 [--vault 库路径] [--folder 文件夹名] [--model sonnet] [--port 17321]
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Dir 'server.py'

# 找 Python 3.8+。跳过 WindowsApps 里那个只会打开应用商店的假 python
$Py = $null
foreach ($c in @('py', 'python', 'python3')) {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { continue }
    $exe = & $c -c "import sys; assert sys.version_info >= (3, 8); print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe -and ($exe -notlike '*WindowsApps*')) { $Py = $exe.Trim(); break }
}
if (-not $Py) { Write-Host '需要 Python 3.8+，请到 https://www.python.org/downloads/ 安装（勾选 Add to PATH）'; exit 1 }
$Pyw = Join-Path (Split-Path $Py) 'pythonw.exe'
if (-not (Test-Path $Pyw)) { $Pyw = $Py }
Write-Host "Python：$Py"

& $Py (Join-Path $Dir 'setup_config.py') @args
if ($LASTEXITCODE -ne 0) { exit 1 }
$Port = (Get-Content (Join-Path $Dir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).port

# 停掉已在运行的旧服务
Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -like "*$Server*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 启动文件夹里放快捷方式：登录时自动运行，不需要管理员权限
$Lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'bili-obsidian.lnk'
$Shell = New-Object -ComObject WScript.Shell
$S = $Shell.CreateShortcut($Lnk)
$S.TargetPath = $Pyw
$S.Arguments = "`"$Server`""
$S.WorkingDirectory = $Dir
$S.WindowStyle = 7
$S.Save()

Start-Process -FilePath $Pyw -ArgumentList "`"$Server`"" -WorkingDirectory $Dir -WindowStyle Hidden

# 打开油猴脚本的地址，Tampermonkey 会弹出安装页，点「安装」即可；以后脚本更新也会自动拉取。
# 浏览器不允许程序替你点安装，这一下只能你自己点。
function Install-Userscript {
    $url = "http://127.0.0.1:$Port/bili-summary.user.js"
    # 已经装过油猴脚本时（比如只是更新），设 BILI_OBSIDIAN_NO_BROWSER=1 跳过打开浏览器；脚本会自己从本地服务更新
    if ($env:BILI_OBSIDIAN_NO_BROWSER) {
        Write-Host "跳过打开浏览器。油猴脚本没装的话，手动打开：$url"
        return
    }
    # Tampermonkey 在 Chrome / Edge 商店里的扩展 ID（含测试版）
    $ids = 'dhdgffkkebhmkfjojejmpbldmpobfkfo', 'iikmkjmpaadaobahmlepeloendndfphd', 'gcalenpjmijncebpfijmoaglllgpjagf'
    $roots = 'Google\Chrome\User Data', 'Microsoft\Edge\User Data', 'BraveSoftware\Brave-Browser\User Data' |
        ForEach-Object { Join-Path $env:LOCALAPPDATA $_ }
    $found = $roots | Where-Object { Test-Path $_ } |
        ForEach-Object { Get-ChildItem $_ -Directory -ErrorAction SilentlyContinue } |
        Where-Object { $p = $_.FullName; $ids | Where-Object { Test-Path (Join-Path $p "Extensions\$_") } }
    if (-not $found) {
        Write-Host ''
        Write-Host '没检测到 Tampermonkey，正在打开扩展商店，装好后回到这里按回车继续'
        Start-Process 'https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo'
        Read-Host | Out-Null
    }
    Write-Host ''
    Write-Host '正在打开油猴脚本安装页，在 Tampermonkey 页面上点「安装」即可'
    Write-Host "（没弹出的话手动打开：$url）"
    Write-Host 'Chrome 里按钮不出现：到扩展管理页打开 Tampermonkey 的「允许用户脚本」，再刷新 B 站'
    Start-Process $url
}

for ($i = 0; $i -lt 5; $i++) {
    Start-Sleep -Seconds 1
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Headers @{ 'X-Bili-Summary' = '1' } | Out-Null
        Write-Host "✓ 后台服务已启动（端口 $Port），登录 Windows 时会自动运行"
        Install-Userscript
        exit 0
    } catch {}
}
Write-Host "✗ 服务没起来，看看 $(Join-Path $Dir 'server.log')"
exit 1
