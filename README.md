# 竞彩 1球 · 比分双选差值记录

记录并分析中国体育彩票「竞彩足球」中一个有趣的赔率结构差异：

- **1球赔率**：总进球玩法中「恰好进 1 球」的赔率（`ttg.s1`）
- **优化赔率**：把 1 元按赔率倒数比例拆成两注、分别押 1:0 和 0:1，使两注无论哪个比分命中回报相同的"保底回报"：
  `优化赔率 = 1:0赔率 × 0:1赔率 ÷ (1:0赔率 + 0:1赔率)`
- **差值 = 1球赔率 − 优化赔率**
  - 正数：押「总进球 1球」回报更高
  - 负数：押「1:0 + 0:1 比分双选（等回报拆注）」回报更高

两者对应的是同一个事件（全场恰好 1 球），赔率差来自官方不同的抽水结构。工具每天自动记录每场比赛的三个赔率与差值，次日回填赛果，长期积累后可以观察：**赛果为 1 球的比赛，其差值分布有什么规律**，为决策提供参考。

> 仅供个人数据分析，不构成投注建议。数据版权归中国体育彩票（sporttery.cn）所有，请勿高频抓取。

---

## 三种使用方式

| 入口 | 作用 | 谁来执行 |
|---|---|---|
| **网页**（GitHub Pages） | 查看/分析：明细表、差值分布图、1球命中率、导出 Excel；也可手动抓取、回填赛果 | 任何设备打开浏览器 |
| **计划任务**（本机 Windows） | 每天 11:00 抓赔率+回填赛果、21:00 抓赔率，自动提交到 GitHub | 这台电脑（需开机） |
| **油猴脚本**（Edge 等浏览器） | 访问体彩官网时自动抓取；网页右下角浮窗直接看当天差值；可一键同步 | 你日常用的浏览器 |

网页端直接调用体彩官方接口（接口已开放跨域），所以**手机上打开网页也能抓取最新数据**；数据保存在你的 GitHub 仓库里，多设备共享。

> 为什么不用 GitHub Actions 定时？体彩接口会拦截境外 IP 访问，而 GitHub 的服务器在境外，定时任务必须落在国内网络（本机计划任务 / 浏览器）。

---

## 快速部署

### 第 1 步：在 GitHub 建一个空仓库

打开 <https://github.com/new>：
- Repository name：例如 `jingcai`
- 可见性：**Public**（免费账户的 Pages 功能要求公开仓库）
- **不要**勾选 "Add a README file"（要空仓库）

### 第 2 步：本机初始化并推送（管理员 PowerShell）

在本项目目录（本 README 所在目录）打开**管理员 PowerShell**，运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

脚本会依次：安装依赖 → git init 提交 → 提示输入仓库地址（如 `https://github.com/你的用户名/jingcai.git`）→ 推送 → 注册两个计划任务。

> 想省去推送时的登录弹窗，可先生成一个**细粒度令牌**（<https://github.com/settings/personal-access-tokens/new>：Repository access 只选该仓库，Permissions → Contents 选 Read and write），然后：
> ```powershell
> powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -RepoUrl https://github.com/你的用户名/jingcai.git -Token github_pat_xxx
> ```
> 令牌会写进本仓库的 `.git/config` 远端地址（仅存本机、不会提交），这样 SYSTEM 账户的定时任务也能免交互推送。

也可以不用脚本，手动执行（等价）：

```bash
npm install
git init -b main && git add -A && git commit -m "init"
git remote add origin https://github.com/你的用户名/jingcai.git
git push -u origin main
```

计划任务单独注册（同样需要管理员）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1
```

任务名：「竞彩1球-早间抓取回填」（11:00）、「竞彩1球-晚间抓取」（21:00），时间可在 `config.json` 里改（改完重新运行注册脚本）。**注册任务需要管理员 PowerShell**（本机策略限制）。运行身份二选一：

- 默认 **SYSTEM**：电脑开机即执行、无需登录；自动推送 GitHub 需要先把令牌写进远端地址（即上面带 `-Token` 的方式）
- 加 `-InteractiveUser`：以你的账户身份运行（**需保持登录状态**）；先手动执行一次 `git push` 让 Windows 记住 GitHub 登录，之后就能**免令牌自动推送**（会弹一次浏览器/登录窗口，登录即可）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -InteractiveUser
```

两种方式错过的时间点都会在开机后自动补跑。

### 第 3 步：开启 GitHub Pages

仓库 → **Settings → Pages**：
- Source 选 **Deploy from a branch**
- Branch 选 **main**，目录选 **/docs**，保存

等 1~2 分钟，访问 `https://你的用户名.github.io/仓库名/`。把这个网址收藏到手机主屏，随时可用。

### 第 4 步（可选）：手机上也能"写"

网页默认只读云端数据；要让手机上的抓取/回填也能保存到云端，在网页「更多 → 设置」填入仓库名和同一个令牌（令牌只存在该设备的浏览器里）。不配也可以：手机会把改动暂存本机并显示"待同步"，回到电脑后照样能看本机数据。

### 第 5 步（可选）：安装油猴脚本

1. Edge 安装 [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) 扩展（必须先装它，否则脚本无法运行）
2. 安装脚本，二选一：
   - 仓库已推送：打开 `https://raw.githubusercontent.com/你的用户名/仓库名/main/userscript/jingcai.user.js`，点"安装"
   - 仓库还没推送：打开 Tampermonkey 管理面板 → 把本项目里的 `userscript/jingcai.user.js` 文件直接拖进浏览器窗口 → 点"安装"
3. 之后你每次访问体彩官网（如竞彩赛程页），脚本每天首次访问会自动抓一次数据；页面右下角浮窗可看当天场次差值，点「设置」填入仓库和令牌即可同步到云端

---

## 本机手动执行（不用打开浏览器）

**双击项目目录里的 `手动执行.cmd`** 即可，等价于命令行运行 `node scripts\daily.js both`：
抓取/刷新赔率 → 回填赛果 → 更新 Excel → （已配置仓库时）推送到 GitHub。窗口里会打印每一步结果，看完按任意键关闭。

其他手动方式：
- 网页上点「抓取今日赔率 / 回填赛果」按钮（任意设备可用；配置令牌后能同步云端）
- 装了油猴脚本后，用 Edge 打开体彩官网页面会自动抓取，右下角浮窗直接看当天差值
- 只用 Edge 打开体彩官网、不装油猴脚本的话，不会有任何动作

## 网页功能说明

- **抓取今日赔率**：从官方接口拉取当前在售场次（通常含今天+明天的比赛），写入本地并计算差值；配置了令牌会自动同步到 GitHub
- **回填赛果**：抓取最近 14 天内未出结果场次的比分，标记"是否 1 球"
- **同步到云端**：把本机暂存的改动提交到仓库（含 Excel 的更新由电脑端任务完成）
- **统计分布**：差值分布堆叠柱状图（按赛果是否 1 球分组）、各差值区间的 1 球命中率（带总体参考线）、分箱明细表
- **数据表**：每场一行的明细，可按列排序、按日期范围/联赛筛选
- **更多**：下载云端 Excel / 浏览器即时导出 Excel / 导出 CSV / 重新加载 / 设置

数据更新后，其他设备/网页可能有 **1~2 分钟** 的 GitHub Pages 缓存延迟，可点「重新加载云端数据」或稍等刷新。

---

## 目录结构

```
docs/                    GitHub Pages 站点（也是数据存放处）
  index.html  app.js  style.css  core.js   ← core.js 是全部业务逻辑的唯一来源
  data/index.json        已记录日期的索引
  data/days/YYYY-MM-DD.json   每天一个数据文件（每场一行）
  excel/竞彩1球-差值记录.xlsx  全量 Excel（按月分 sheet + 统计 + 说明）
  excel/records.csv      全量 CSV
  vendor/xlsx.full.min.js SheetJS（浏览器端导出用）
scripts/
  daily.js               计划任务入口：抓赔率/回填赛果/生成 Excel/提交推送
  export-excel.js        由 JSON 生成 Excel（daily.js 会自动调用）
  build-userscript.js    把 core.js 内联进油猴脚本
  register-tasks.ps1     注册/删除 Windows 计划任务
  setup.ps1              一键部署
  test-core.js           核心逻辑自检（node scripts/test-core.js）
userscript/
  src.user.js            油猴脚本源文件（改交互改这里）
  jingcai.user.js        构建产物（安装用，勿手改）
config.json              autoPush / 回填窗口 / 定时时间
logs/daily.log           计划任务运行日志
```

## 数据口径（重要）

- **抓取时点**：每场比赛记录的是"最后一次抓取时"的在售赔率（见每行「赔率更新时间」）。计划任务在比赛日 11:00 与 21:00 各抓一次，所以白天开赛的场次最后一次刷新在当天上午，晚间/凌晨场在当晚 21 点
- 只有 **1球、1:0、0:1 三个赔率齐全**的场次才计算差值；缺赔率的场次保留行但不计算
- 凌晨开赛的比赛（如欧洲联赛）属于前一天的"销售日"，网页与 Excel 的「日期」按销售日分组，「开赛时间」显示真实日期的月-日
- 赛果按全场（90 分钟）比分判定；回填窗口为最近 10~14 天，晚出结果的比赛会自动补齐
- 官网只提供"当前在售"比赛的赔率，**无法回溯历史**，数据从部署当天开始积累

## 常见问题

- **电脑关机了？** 开机后计划任务会补跑一次（StartWhenAvailable）。几天不开机也不影响已有数据；之后可在网页手动「回填赛果」补齐
- **接口变了怎么办？** 所有接口地址与解析逻辑都在 `docs/core.js` 一个文件里，改完重新 `npm run build:userscript` 即可，三端同时生效
- **多设备同时写入会冲突吗？** 写入前会先拉取云端并合并（同一场取更新的赔率、已有的赛果不丢），冲突自动重试，无需手工处理
- **令牌安全吗？** 令牌只保存在浏览器 localStorage 或本机 `.git/config`，不会提交到仓库；建议用细粒度令牌并只授权这一个仓库的 Contents 读写
- **换电脑？** 新电脑装 Node + git，克隆仓库后运行 `npm install` 和 `register-tasks.ps1` 即可；网页端无需安装

## 免责声明

本项目仅为个人对公开赔率数据的记录与分析工具；数据版权归中国体育彩票所有；不构成任何投注建议。请理性购彩，量力而行。
