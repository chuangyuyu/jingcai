# ============================================================
# 竞彩1球差值 一键部署脚本
#   1) 安装 Node 依赖
#   2) 初始化 git 仓库并提交
#   3) 配置 GitHub 远端并推送（需先在 GitHub 上建好空仓库）
#   4) 注册 Windows 计划任务（每天两次自动抓取）
#
# 用法（管理员 PowerShell，建议）：
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# 也可带参数：
#   ... -RepoUrl https://github.com/你的用户名/jingcai.git -Token github_pat_xxx
#   ... -SkipTasks -SkipPush        # 只装依赖、提交本地
# ============================================================
param(
    [string]$RepoUrl = "",
    [string]$Token = "",
    [switch]$SkipTasks,
    [switch]$SkipPush
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "=== 竞彩1球差值 部署脚本 ===" -ForegroundColor Cyan
Write-Host "仓库目录：$Root"

# ---------- 1. 依赖 ----------
Write-Host "`n[1/5] 安装 Node 依赖…" -ForegroundColor Cyan
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "未找到 npm，请先安装 Node.js：https://nodejs.org"
}
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
Write-Host "依赖安装完成。" -ForegroundColor Green

# ---------- 2. git 初始化 ----------
Write-Host "`n[2/5] 初始化 git 仓库…" -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $Root ".git"))) {
    git init -b main | Out-Null
    Write-Host "已 git init（分支 main）"
}
if (-not (git config user.name)) {
    git config user.name "jingcai-bot"
    git config user.email "jingcai-bot@users.noreply.github.com"
    Write-Host "已设置本仓库 git 身份（jingcai-bot，可自行修改）"
}

# ---------- 3. 远端 ----------
Write-Host "`n[3/5] 配置 GitHub 远端…" -ForegroundColor Cyan
if ($RepoUrl -eq "") {
    $RepoUrl = Read-Host "GitHub 仓库地址（如 https://github.com/你的用户名/jingcai.git；直接回车跳过这一步）"
}
if ($RepoUrl -ne "") {
    $pushUrl = $RepoUrl
    if ($Token -ne "") {
        # 把令牌写进本仓库的远端地址（只存于本地 .git/config，不会提交到仓库），
        # 这样 SYSTEM 账户运行的计划任务也能免交互推送。
        $pushUrl = $RepoUrl -replace '^https://', "https://x-access-token:$Token@"
        Write-Host "已使用令牌配置推送地址（令牌仅保存在本地 .git/config）"
    }
    git remote remove origin 2>$null | Out-Null
    git remote add origin $pushUrl
    Write-Host "远端 origin 已设置：$RepoUrl"
}

# ---------- 4. 提交并推送 ----------
Write-Host "`n[4/5] 提交本地文件…" -ForegroundColor Cyan
git add -A
git commit -m "init: 竞彩1球差值记录工具" 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host "已提交。" -ForegroundColor Green }
else { Write-Host "没有需要提交的改动。" }

if (-not $SkipPush -and $RepoUrl -ne "") {
    Write-Host "推送到 GitHub…"
    git push -u origin main
    if ($LASTEXITCODE -eq 0) { Write-Host "推送成功。" -ForegroundColor Green }
    else { Write-Warning "推送失败：请检查仓库地址、令牌权限（Contents 读写）或网络。" }
} else {
    Write-Host "（跳过推送）"
}

# ---------- 5. 计划任务 ----------
Write-Host "`n[5/5] 注册计划任务…" -ForegroundColor Cyan
if ($SkipTasks) {
    Write-Host "（按参数要求跳过）"
} else {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Warning "当前不是管理员权限，跳过计划任务。请用『管理员 PowerShell』重新运行本脚本，或单独运行 scripts\register-tasks.ps1"
    } else {
        & (Join-Path $PSScriptRoot "register-tasks.ps1")
    }
}

# ---------- 完成 ----------
Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
Write-Host @"
后续步骤：
  1. 打开 GitHub 仓库 → Settings → Pages → Source 选 “Deploy from a branch”，
     分支选 main，目录选 /docs，保存。稍等 1~2 分钟即可用
     https://你的用户名.github.io/仓库名/ 访问（手机、其他电脑均可）。
  2. （可选）在该网页「更多 → 设置」里填入同样的仓库和令牌，手机也能一键同步。
  3. 安装油猴脚本：浏览器装 Tampermonkey 后，打开
     https://raw.githubusercontent.com/你的用户名/仓库名/main/userscript/jingcai.user.js 安装。
  4. 验证定时任务：任务计划程序中查看「竞彩1球-早间抓取回填 / 晚间抓取」。
"@
