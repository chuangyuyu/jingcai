# ============================================================
# 注册 Windows 计划任务（每天两次定时抓取）
#   —— 上午任务：抓赔率 + 回填赛果（时间取 config.json 的 times[0]，默认 11:00）
#   —— 下午任务：抓赔率（时间取 config.json 的 times[1]，默认 17:00）
#   两次抓取会分别记录比赛赔率快照（表格中 ①② 两列），差值变化以箭头标注。
#
# 运行方式：
#   必须用「管理员 PowerShell」运行（本机策略限制，普通权限会被拒绝）。
#   默认注册为 SYSTEM 身份：开机即运行、无需登录；自动推送 GitHub 需要令牌
#     （用 setup.ps1 -Token 把令牌写进远端地址，见 README）。
#   加 -InteractiveUser 则注册为「当前用户」身份：仅在你登录状态下运行；
#     只要用浏览器登录过一次 GitHub（手动推送一次即可），之后可免令牌自动推送。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -InteractiveUser
# 可选参数：
#   -InteractiveUser  以当前用户身份注册（配合浏览器登录，免令牌推送）
#   -RunNow    注册后立即运行一次上午任务以验证
#   -Remove    删除全部相关计划任务
# ============================================================
param(
    [switch]$RunNow,
    [switch]$Remove,
    [switch]$InteractiveUser
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$TaskNameFirst = "竞彩1球-上午抓取"
$TaskNameSecond = "竞彩1球-下午抓取"
# 旧版任务名（v1 时期为 09:10/21:10），注册新版时自动清理
$LegacyNames = @("竞彩1球-早间抓取回填", "竞彩1球-晚间抓取")

if ($Remove) {
    @($TaskNameFirst, $TaskNameSecond) + $LegacyNames | ForEach-Object {
        Unregister-ScheduledTask -TaskName $_ -Confirm:$false -ErrorAction SilentlyContinue
    }
    Write-Host "已删除计划任务。" -ForegroundColor Yellow
    exit 0
}

# 读取时间配置（times 数组；兼容旧配置的 morningTime/eveningTime）
$timeFirst = "11:00"
$timeSecond = "17:00"
$cfgPath = Join-Path $Root "config.json"
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.times -and $cfg.times.Count -ge 2) {
            $timeFirst = [string]$cfg.times[0]
            $timeSecond = [string]$cfg.times[1]
        } elseif ($cfg.morningTime -and $cfg.eveningTime) {
            $timeFirst = [string]$cfg.morningTime
            $timeSecond = [string]$cfg.eveningTime
        }
    } catch { Write-Warning "config.json 解析失败，使用默认时间 11:00 / 17:00。" }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "未找到 node，请先安装 Node.js 并确保在 PATH 中。" }

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

# 运行身份：默认 SYSTEM（免登录）；指定 -InteractiveUser 则用当前用户（可用浏览器登录推送）
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin -and -not $InteractiveUser) {
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $modeText = "SYSTEM（免登录、开机即运行；自动推送需配置令牌）"
} else {
    $me = "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    $modeText = "$me（仅登录状态下运行；浏览器登录过一次 GitHub 后可免令牌推送）"
    if (-not $isAdmin) {
        Write-Warning "当前不是管理员权限，本机策略可能拒绝注册；若失败请改用管理员 PowerShell。"
    }
}

$actionFirst = New-ScheduledTaskAction -Execute $node `
    -Argument "`"$Root\scripts\daily.js`" both" -WorkingDirectory $Root
$actionSecond = New-ScheduledTaskAction -Execute $node `
    -Argument "`"$Root\scripts\daily.js`" odds" -WorkingDirectory $Root

# 清理旧版任务
foreach ($n in $LegacyNames) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "已移除旧版任务：$n" -ForegroundColor DarkYellow
    }
}

Register-ScheduledTask -TaskName $TaskNameFirst -Action $actionFirst `
    -Trigger (New-ScheduledTaskTrigger -Daily -At $timeFirst) `
    -Settings $settings -Principal $principal -Force `
    -Description "竞彩1球差值：每天 $timeFirst 抓取赔率（第一次快照）并回填赛果（仓库目录 $Root）" | Out-Null
Write-Host "已注册：$TaskNameFirst（每天 $timeFirst，both）" -ForegroundColor Green

Register-ScheduledTask -TaskName $TaskNameSecond -Action $actionSecond `
    -Trigger (New-ScheduledTaskTrigger -Daily -At $timeSecond) `
    -Settings $settings -Principal $principal -Force `
    -Description "竞彩1球差值：每天 $timeSecond 抓取赔率（第二次快照，记录差值变化）（仓库目录 $Root）" | Out-Null
Write-Host "已注册：$TaskNameSecond（每天 $timeSecond，odds）" -ForegroundColor Green

Write-Host "运行身份：$modeText" -ForegroundColor Cyan
Write-Host "提示：默认 SYSTEM（免登录）；要改用浏览器登录推送（免令牌），加 -InteractiveUser 重新运行。" -ForegroundColor DarkGray

if ($RunNow) {
    Write-Host "`n立即运行上午任务验证…" -ForegroundColor Cyan
    Start-ScheduledTask -TaskName $TaskNameFirst
    Start-Sleep -Seconds 20
    $info = Get-ScheduledTaskInfo -TaskName $TaskNameFirst
    Write-Host ("上午任务上次运行：{0}，结果代码：{1}（0x0 表示成功）" -f $info.LastRunTime, $info.LastTaskResult)
    Write-Host "（详细输出见仓库 logs\daily.log）"
}
