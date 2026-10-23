# 一行安装 / 更新（Windows，在 PowerShell 里运行）：
#   irm https://raw.githubusercontent.com/leinaldo/bili-obsidian/main/get.ps1 | iex
# 下载最新代码到 %USERPROFILE%\tools\bili-obsidian（可用环境变量 BILI_OBSIDIAN_DIR 改位置），再运行 install.ps1。
# 重复运行就是更新：config.json、缓存和日志不在代码包里，会原样保留。
# 注意：这个文件不带 BOM，是给 irm | iex 用的；本地运行请用 install.cmd。
& {
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    # Windows PowerShell 5.1 默认的 TLS 版本连不上 GitHub
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $Repo = 'leinaldo/bili-obsidian'
    $Dest = if ($env:BILI_OBSIDIAN_DIR) { $env:BILI_OBSIDIAN_DIR } else { Join-Path $HOME 'tools\bili-obsidian' }

    if ((Test-Path (Join-Path $Dest '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Host "更新 $Dest（git 仓库）"
        git -C $Dest pull --ff-only
    } else {
        Write-Host "下载最新代码到 $Dest"
        $Tmp = Join-Path $env:TEMP ('bili-obsidian-' + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $Tmp | Out-Null
        try {
            $Zip = Join-Path $Tmp 'src.zip'
            Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $Zip
            Expand-Archive -Path $Zip -DestinationPath $Tmp
            $Src = Get-ChildItem $Tmp -Directory | Select-Object -First 1
            New-Item -ItemType Directory -Force -Path $Dest | Out-Null
            Copy-Item -Path (Join-Path $Src.FullName '*') -Destination $Dest -Recurse -Force
        } finally {
            Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
        }
    }

    # 用 & 而不是 exit 结束：脚本跑在 iex 里，exit 会把你的 PowerShell 窗口一起关掉
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dest 'install.ps1')
}
