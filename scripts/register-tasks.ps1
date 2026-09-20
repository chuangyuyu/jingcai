# ============================================================
# 注册 Windows 计划任务（每天定时抓取）
#   —— 早间任务：抓赔率 + 回填赛果（时间取 config.json 的 morningTime，默认 09:10）
#   —— 晚间任务：抓赔率（时间取 config.json 的 eveningTime，默认 21:10）
# 需要以管理员身份运行 PowerShell：
#   powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1
# 可选参数：
#   -RunNow    注册后立即各运行一次以验证
#   -Remove    删除这两个计划任务
# ============================================================
param(
    [switch]$RunNow,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$TaskNameMorning = "竞彩1球-早间抓取回填"
$TaskNameEvening = "竞彩1球-晚间抓取"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskNameMorning -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskNameEvening -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已删除计划任务。" -ForegroundColor Yellow
    exit 0
}

# 读取时间配置
$morningTime = "09:10"
$eveningTime = "21:10"
$cfgPath = Join-Path $Root "config.json"
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.morningTime) { $morningTime = $cfg.morningTime }
        if ($cfg.eveningTime) { $eveningTime = $cfg.eveningTime }
    } catch { Write-Warning "config.json 解析失败，使用默认时间。" }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "未找到 node，请先安装 Node.js 并确保在 PATH 中。" }

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew
# 以 SYSTEM 运行：无需登录、无需密码（数据抓取与 git 推送均以本机身份执行）
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

$actionMorning = New-ScheduledTaskAction -Execute $node `
    -Argument "`"$Root\scripts\daily.js`" both" -WorkingDirectory $Root
$actionEvening = New-ScheduledTaskAction -Execute $node `
    -Argument "`"$Root\scripts\daily.js`" odds" -WorkingDirectory $Root

Register-ScheduledTask -TaskName $TaskNameMorning -Action $actionMorning `
    -Trigger (New-ScheduledTaskTrigger -Daily -At $morningTime) `
    -Settings $settings -Principal $principal -Force `
    -Description "竞彩1球差值：每天 $morningTime 抓取赔率并回填赛果（仓库目录 $Root）" | Out-Null
Write-Host "已注册：$TaskNameMorning（每天 $morningTime，both）" -ForegroundColor Green

Register-ScheduledTask -TaskName $TaskNameEvening -Action $actionEvening `
    -Trigger (New-ScheduledTaskTrigger -Daily -At $eveningTime) `
    -Settings $settings -Principal $principal -Force `
    -Description "竞彩1球差值：每天 $eveningTime 抓取/刷新赔率（仓库目录 $Root）" | Out-Null
Write-Host "已注册：$TaskNameEvening（每天 $eveningTime，odds）" -ForegroundColor Green

if ($RunNow) {
    Write-Host "`n立即运行早间任务验证…" -ForegroundColor Cyan
    Start-ScheduledTask -TaskName $TaskNameMorning
    Start-Sleep -Seconds 20
    $info = Get-ScheduledTaskInfo -TaskName $TaskNameMorning
    Write-Host ("早间任务状态：{0}，上次结果：{1}" -f $info.LastTaskResult, $info.LastRunTime)
    Write-Host "（详细输出见仓库 logs\daily.log）"
}
