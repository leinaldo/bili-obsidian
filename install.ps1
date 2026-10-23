# Windows 安装：生成配置，放一个开机自启的快捷方式（启动文件夹），并启动后台服务。
# 用法: 双击 install.cmd；或 powershell -ExecutionPolicy Bypass -File install.ps1 [--vault 库路径] [--folder 文件夹名] [--model sonnet] [--port 17321]
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 让 Python 的输出也用 UTF-8，不然中文用户名路径之类的会在 PowerShell 里变成乱码
$env:PYTHONIOENCODING = 'utf-8'
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

# 停掉已在运行的旧服务：本目录的，以及占着端口的（可能是装在别的目录里的老版本，
# 不停掉的话新服务绑不上端口，浏览器拿到的还是老目录里的旧油猴脚本）
Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -like "*$Server*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$holders = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $holders) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId"
    if (-not $proc) { continue }
    if ($proc.Name -like 'python*' -and $proc.CommandLine -like '*server.py*') {
        Write-Host "停掉旧的后台服务：$($proc.CommandLine)"
        Stop-Process -Id $procId -Force
    } else {
        Write-Host "✗ 端口 $Port 被别的程序占用：$($proc.Name)（PID $procId）。关掉它，或用 --port 换一个端口后重新安装"
        exit 1
    }
}
for ($i = 0; $i -lt 10 -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue); $i++) {
    Start-Sleep -Milliseconds 500
}

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
    # 选你看 B 站用的那个浏览器（装了 Tampermonkey 的；有多个会问你，选过会记住），之后的页面都在它里面打开
    $hit = $null
    $pick = (& $Py -I (Join-Path $Dir 'pick_browser.py')) | ConvertFrom-Json
    if ($pick.key) {
        $hit = @{ Exe = $pick.exe; Scheme = $pick.scheme; Id = $pick.id; Profile = $pick.profile }
        Write-Host ''
        Write-Host "在 $($pick.name) 里打开页面（要换浏览器：先设环境变量 BILI_OBSIDIAN_BROWSER=chrome/edge/brave，再运行一次安装）"
        if ($pick.extra -gt 0) {
            Write-Host "⚠️  $($pick.name) 里装了不止一个 Tampermonkey（比如 Edge 商店版和 Chrome 商店版各一个）。"
            Write-Host '   这样油猴脚本会被装两份：另一份停在旧版本，Tampermonkey 会不停弹出更新页。'
            Write-Host "   打开 $($pick.scheme)://extensions ，只留一个 Tampermonkey，把另一个移除。"
        }
    }
    # 油猴脚本运行时会向本地服务报到版本；已经是最新版就不用再打开安装页（以后的更新它会自己拉）。
    # 能报到也说明「允许用户脚本」是开着的，所以后面的检查也一起跳过
    $seen = & $Py -I (Join-Path $Dir 'userscript_seen.py')
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ 油猴脚本已装好并在运行（$seen），不用再打开安装页"
        return
    }
    if (-not $hit) {
        Write-Host ''
        Write-Host '没检测到 Tampermonkey，正在打开扩展商店，装好后回到这里按回车继续'
        Start-Process 'https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo'
        Read-Host | Out-Null
    }
    # 「允许用户脚本」只能用户自己开；这里只读检查：0 已开，1 没开，2 查不到
    $us = 2
    if ($hit) {
        & $Py -I (Join-Path $Dir 'userscripts_status.py') $hit.Profile $hit.Id
        $us = $LASTEXITCODE
    }

    Write-Host ''
    if ($us -eq 0) {
        Write-Host '✓ Tampermonkey 的「允许用户脚本」已开启'
        Write-Host "接下来在 Tampermonkey 安装页上点「安装」，然后刷新 B 站视频页（没弹出的话手动打开 $url）"
        try { Start-Process $hit.Exe -ArgumentList $url } catch { Start-Process $url }
        return
    }
    Write-Host '接下来在浏览器里做两件事，然后刷新 B 站视频页：'
    Write-Host "  1. Tampermonkey 安装页：点「安装」（没弹出的话手动打开 $url）"
    if (-not $hit) {
        Write-Host '  2. 打开浏览器的扩展管理页（Chrome 是 chrome://extensions），进 Tampermonkey 的「详细信息」，打开「允许用户脚本」'
        Start-Process $url
        return
    }
    # Windows 上浏览器会忽略命令行传进来的 chrome:// / edge:// 地址（只放行网页地址），
    # 没法替你打开扩展详情页，所以把地址复制到剪贴板，让你粘贴到地址栏
    $extUrl = "$($hit.Scheme)://extensions/?id=$($hit.Id)"
    $copied = $false
    try { Set-Clipboard -Value $extUrl; $copied = $true } catch {}
    Write-Host '  2. Tampermonkey 扩展详情页：打开「允许用户脚本」开关'
    if ($copied) {
        Write-Host "     浏览器不允许外部程序直接打开这个页面，地址已复制到剪贴板："
    } else {
        Write-Host "     浏览器不允许外部程序直接打开这个页面，请手动复制下面的地址："
    }
    Write-Host "     $extUrl"
    Write-Host '     在浏览器地址栏里粘贴（Ctrl+V）并回车，就能看到这个开关'
    try {
        Start-Process $hit.Exe -ArgumentList $url
    } catch {
        Start-Process $url
    }
    if ($us -ne 1) { return }  # 查不到状态就不等了

    Write-Host ''
    Write-Host '等你打开「允许用户脚本」…（最多等 3 分钟，按 Ctrl+C 可跳过）'
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Seconds 2
        # 浏览器改完设置要过几秒才写进配置文件
        & $Py -I (Join-Path $Dir 'userscripts_status.py') $hit.Profile $hit.Id
        if ($LASTEXITCODE -eq 0) {
            Write-Host '✓ 「允许用户脚本」已开启'
            return
        }
    }
    Write-Host '还没检测到开启。装好后如果 B 站页面上没有按钮，回到扩展详情页把「允许用户脚本」打开再刷新'
}

for ($i = 0; $i -lt 5; $i++) {
    Start-Sleep -Seconds 1
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Headers @{ 'X-Bili-Summary' = '1' }
        if ($h.dir -and ($h.dir.TrimEnd('\') -ine $Dir.TrimEnd('\'))) {
            Write-Host "✗ 端口 $Port 上应答的是另一个目录的服务：$($h.dir)"
            Write-Host '  在任务管理器里结束那个 pythonw.exe，再重新运行安装命令'
            exit 1
        }
        Write-Host "✓ 后台服务已启动（端口 $Port），登录 Windows 时会自动运行"
        Install-Userscript
        exit 0
    } catch {}
}
Write-Host "✗ 服务没起来，看看 $(Join-Path $Dir 'server.log')"
exit 1
