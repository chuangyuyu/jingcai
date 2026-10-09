# ============================================================
# 注册 Windows 计划任务（每天 8:00~23:00 每小时整点抓取）
#   时间列表取 config.json 的 times（默认 16 个整点，夜间不执行）。
#   每个整点运行一次完整流程：抓赔率 + 回填赛果 + 编号/联赛球队历史维护
#   + 封盘冻结预测 + 更新 Excel（是否推送 GitHub 由 config.json 的 autoPush 决定）。
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
#   -RunNow    注册后立即运行一次以验证
#   -Remove    删除全部相关计划任务
# ============================================================
param(
    [switch]$RunNow,
    [switch]$Remove,
    [switch]$InteractiveUser
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$TaskName = "竞彩进球数-整点抓取"
# 旧版任务名（创建新版时自动清理）：v1 早晚任务、v2 上午/下午两次任务
$LegacyNames = @("竞彩1球-上午抓取", "竞彩1球-下午抓取", "竞彩1球-早间抓取回填", "竞彩1球-晚间抓取")

if ($Remove) {
    @($TaskName) + $LegacyNames | ForEach-Object {
        Unregister-ScheduledTask -TaskName $_ -Confirm:$false -ErrorAction SilentlyContinue
    }
    Write-Host "已删除计划任务。" -ForegroundColor Yellow
    exit 0
}

# 读取时间配置（times 数组；默认 8:00~23:00 每小时整点）
$times = @('08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00')
$cfgPath = Join-Path $Root "config.json"
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.times -and $cfg.times.Count -ge 1) {
            $times = @($cfg.times | ForEach-Object { [string]$_ })
        }
    } catch { Write-Warning "config.json 解析失败，使用默认整点时间 8:00~23:00。" }
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

$action = New-ScheduledTaskAction -Execute $node `
    -Argument "`"$Root\scripts\daily.js`" both" -WorkingDirectory $Root

# 清理旧版任务
foreach ($n in $LegacyNames) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "已移除旧版任务：$n" -ForegroundColor DarkYellow
    }
}

# 每个整点一个每日触发器（同一任务挂多个触发器）
$triggers = @($times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })

Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Trigger $triggers `
    -Settings $settings -Principal $principal -Force `
    -Description "竞彩进球数预测：每天 $($times[0])~$($times[-1]) 每小时整点抓取/回填/冻结（共 $($times.Count) 次；仓库目录 $Root）" | Out-Null
Write-Host "已注册：$TaskName（每天 $($times.Count) 次：$($times -join '、')）" -ForegroundColor Green
Write-Host "运行身份：$modeText" -ForegroundColor Cyan
Write-Host "提示：默认 SYSTEM（免登录）；要改用浏览器登录推送（免令牌），加 -InteractiveUser 重新运行。" -ForegroundColor DarkGray

if ($RunNow) {
    Write-Host "`n立即运行一次验证…" -ForegroundColor Cyan
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 20
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host ("任务上次运行：{0}，结果代码：{1}（0x0 表示成功）" -f $info.LastRunTime, $info.LastTaskResult)
    Write-Host "（详细输出见仓库 logs\daily.log）"
}
