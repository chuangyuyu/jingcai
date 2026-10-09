# ============================================================
# 同步代码到 NAS 项目文件夹（不覆盖 NAS 的数据与运行配置）
#   —— 拷贝：docs 网页代码（不含 data/excel）、scripts、nas、userscript、
#      根目录文档与清单等；docs/data/history.json 与 numbers.json 仅在
#      NAS 上不存在时补种（首次部署用），绝不覆盖 NAS 自己积累的数据。
#   —— config.json 不整文件覆盖：只把本机的 times（执行时间表）合并进
#      NAS 配置，保留 NAS 上的 autoPush=false、runKey 等本地设置。
#   —— 完成后请到 NAS 的 Docker 应用里重启 jingcai 容器（nas/server.js 与
#      config.json 需重启才生效；docs 下的网页文件即时生效、无需重启）。
#
# 用法：双击根目录「同步到NAS.cmd」，或手动：
#   powershell -ExecutionPolicy Bypass -File scripts\sync-to-nas.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\sync-to-nas.ps1 -NasPath "\\192.168.1.5\存储空间\jingcai"
# 首次运行会询问 NAS 项目文件夹路径并记住（存入 .nas-path.txt，仅本机保存）。
# ============================================================
param(
    [string]$NasPath
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$pathFile = Join-Path $Root ".nas-path.txt"

if (-not $NasPath -and (Test-Path $pathFile)) {
    $NasPath = (Get-Content $pathFile -Raw -Encoding UTF8).Trim()
}
if (-not $NasPath) {
    Write-Host "请输入 NAS 上项目文件夹的访问路径（Windows 资源管理器能打开的地址）：" -ForegroundColor Cyan
    Write-Host "例如：\\192.168.1.5\存储空间\jingcai　或映射的盘符 Z:\jingcai" -ForegroundColor DarkGray
    $NasPath = (Read-Host "NAS 项目路径").Trim().TrimEnd('\')
    if (-not $NasPath) { throw "未提供路径，已取消。" }
    Set-Content -Path $pathFile -Value $NasPath -Encoding UTF8
}
$NasPath = $NasPath.TrimEnd('\')

if (-not (Test-Path (Join-Path $NasPath "config.json"))) {
    throw "该路径下没有 config.json，可能不是 NAS 上的项目文件夹：$NasPath （如填错了可删除本机 .nas-path.txt 后重新运行）"
}
Write-Host ("NAS 项目路径：" + $NasPath) -ForegroundColor Cyan

# ---- 1) 拷贝代码文件（不碰数据、配置、logs、.git、node_modules）----
robocopy (Join-Path $Root "docs") (Join-Path $NasPath "docs") /E /XD (Join-Path $Root "docs\data") (Join-Path $Root "docs\excel") /NFL /NDL /NJH /NJS /NP | Out-Null
foreach ($d in @("scripts", "nas", "userscript")) {
    robocopy (Join-Path $Root $d) (Join-Path $NasPath $d) /E /NFL /NDL /NJH /NJS /NP | Out-Null
}
foreach ($f in @("package.json", "package-lock.json", "docker-compose.yml", "README.md", "NAS部署指南.md", "手动执行.cmd", "一键安装.cmd", "环境自检.cmd")) {
    $src = Join-Path $Root $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $NasPath $f) -Force }
}
Write-Host "代码文件已同步（docs / scripts / nas / userscript + 根目录文件）" -ForegroundColor Green

# ---- 2) 数据文件：仅当 NAS 上缺失时补种（首次部署）；已有则保留 NAS 自己的 ----
foreach ($f in @("history.json", "numbers.json")) {
    $dst = Join-Path $NasPath ("docs\data\" + $f)
    if (-not (Test-Path $dst)) {
        $src = Join-Path $Root ("docs\data\" + $f)
        if (Test-Path $src) {
            Copy-Item $src $dst
            Write-Host ("已补种 docs/data/" + $f + "（NAS 上原本没有此文件）") -ForegroundColor Yellow
        }
    }
}

# ---- 3) config.json：只合并 times（执行时间表），保留 NAS 本地设置（autoPush=false 等）----
$localCfg = Get-Content (Join-Path $Root "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$nasCfgPath = Join-Path $NasPath "config.json"
$nasCfg = Get-Content $nasCfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$nasCfg.times = $localCfg.times
$json = $nasCfg | ConvertTo-Json -Depth 10
# NAS 上由 Node 读取该文件（JSON.parse 不认 BOM），必须以“无 BOM 的 UTF-8”写回
[System.IO.File]::WriteAllText($nasCfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("config.json 已合并时间表：times = " + ($localCfg.times -join '、') + "（NAS 上的 autoPush 等其他设置保持不变）") -ForegroundColor Green

Write-Host ""
Write-Host "同步完成。请到 NAS 的 Docker 应用里【重启 jingcai 容器】，让 nas/server.js 与新时间表生效。" -ForegroundColor Cyan
Write-Host "（docs 下的网页文件是即时生效的、无需重启；NAS 本地数据与 Excel 完全没有被覆盖。）" -ForegroundColor DarkGray
