# ============================================================
# 生成 NAS 更新包（NAS更新包.zip）——跨网络（与 NAS 不在同一局域网）更新用
#   · 用法：打开飞牛「远程访问」→ NAS 桌面 →「文件」应用 → 进入项目文件夹
#           （如 /vol1/jingcai）→ 上传本包 → 解压到当前文件夹（覆盖）→ 按包内
#           UPDATE-README.txt 操作 → 到 Docker 里重启 jingcai 容器
#   · 包含：docs 网页代码（不含 NAS 本地数据）、scripts、nas、package.json、
#           docker-compose.yml、README.md、
#           docs/data 的 history.json 与 numbers.json（多因子模型历史库种子）、
#           config.nas.json（NAS 推荐配置：autoPush=false + 整点时间表）、
#           UPDATE-README.txt（操作说明）
#   · 不含：docs/data/days、docs/data/index.json、docs/excel（NAS 本地数据，绝不覆盖）
# ============================================================
param()
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP ("jingcai-nas-update-" + [guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $Root "NAS更新包.zip"

Write-Host "正在准备更新包…" -ForegroundColor Cyan
New-Item -ItemType Directory -Path $stage | Out-Null

# docs（排除 data 与 excel），随后只补种 data 下的 history/numbers
robocopy (Join-Path $Root "docs") (Join-Path $stage "docs") /E /XD (Join-Path $Root "docs\data") (Join-Path $Root "docs\excel") /NFL /NDL /NJH /NJS /NP | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "docs\data") -Force | Out-Null
foreach ($f in @("history.json", "numbers.json")) {
    $src = Join-Path $Root ("docs\data\" + $f)
    if (Test-Path $src) { Copy-Item $src (Join-Path $stage ("docs\data\" + $f)) -Force }
}
foreach ($d in @("scripts", "nas")) {
    robocopy (Join-Path $Root $d) (Join-Path $stage $d) /E /NFL /NDL /NJH /NJS /NP | Out-Null
}
foreach ($f in @("package.json", "docker-compose.yml", "README.md")) {
    $src = Join-Path $Root $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $stage $f) -Force }
}

# config.nas.json：NAS 推荐配置（autoPush=false + 本机时间表），可改名直接覆盖
$cfg = Get-Content (Join-Path $Root "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg.autoPush = $false
[System.IO.File]::WriteAllText((Join-Path $stage "config.nas.json"), ($cfg | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))

# UPDATE-README.txt（UTF-8 带 BOM，NAS 的文本编辑器可直接打开）
$readme = @"
竞彩进球数预测 · NAS 更新包（$(Get-Date -Format 'yyyy-MM-dd HH:mm') 生成）

适用场景：NAS 与当前电脑不在同一网络（无法用 同步到NAS.cmd 直接拷贝）时。

【更新步骤】
1) 打开飞牛「远程访问」，进入 NAS 桌面 →「文件」应用 → 进入项目文件夹（如 /vol1/jingcai）。
2) 把本压缩包（NAS更新包.zip）上传到该文件夹，再选「解压到当前文件夹」，覆盖同名文件。
   —— 包内不含 docs/data/days、index.json、excel，NAS 的本地数据不会被覆盖。
3) 更新配置（二选一）：
   a.【推荐】把解压出的 config.nas.json 改名为 config.json（覆盖原文件）。
      它已带好整点时间表（08:00~23:00）且 autoPush=false；
      若你之前设置过 nas.runKey 口令，请打开 config.json 把它填回 nas.runKey。
   b.【手动】打开原 config.json，把 "times" 一行改为整点数组：
      ["08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00",
       "16:00","17:00","18:00","19:00","20:00","21:00","22:00","23:00"]
4) 到飞牛「Docker」应用 → 容器（或项目）→ jingcai →「重启」。
5) 浏览器打开 http://NAS的IP:8788 验证：页面状态栏显示「NAS 本地数据」即正常。

本次更新内容：
· v4.0.1 多因子模型（权重规则修正：因子需证明自己才获得权重）
· 定时改为每天 8:00~23:00 每小时整点（夜间不执行）
"@
[System.IO.File]::WriteAllText((Join-Path $stage "UPDATE-README.txt"), $readme, (New-Object System.Text.UTF8Encoding($true)))

# 打包：手动逐条写入，条目名统一用 '/' 分隔——保证在 NAS(Linux) 的解压工具下目录结构正确
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    # 注意：$env:TEMP 可能是短路径（8.3 形式），而 Get-ChildItem 返回长路径；
    # 必须用 (Get-Item $stage).FullName 归一化后再截取相对路径，否则条目名会多出前缀
    $stageFull = (Get-Item $stage).FullName
    Get-ChildItem -Recurse -File $stage | ForEach-Object {
        $rel = $_.FullName.Substring($stageFull.Length + 1).Replace('\', '/')
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)
    }
} finally {
    $zip.Dispose()
}
Remove-Item $stage -Recurse -Force

$size = [math]::Round((Get-Item $zipPath).Length / 1KB)
Write-Host ("已生成：" + $zipPath + "（" + $size + " KB）") -ForegroundColor Green
Write-Host "下一步：飞牛远程访问 → 文件应用 → 上传到项目文件夹 → 解压（覆盖）→ 重启 jingcai 容器" -ForegroundColor Cyan
Write-Host "（详细步骤见包内 UPDATE-README.txt；同局域网时用 同步到NAS.cmd 即可）" -ForegroundColor DarkGray
