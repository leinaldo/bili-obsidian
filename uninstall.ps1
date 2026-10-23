# Windows 卸载：停掉后台服务并删掉开机自启的快捷方式。已生成的笔记和配置不会删除。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Dir 'server.py'
Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -like "*$Server*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Startup')) 'bili-obsidian.lnk')
Write-Host '✓ 后台服务已移除。记得在 Tampermonkey 里删掉「B站总结到 Obsidian」脚本'
