# 飞牛 NAS（fnOS）部署指南（详细版）

> 目标：在你的飞牛 NAS 上把「竞彩进球数预测」跑成一个常驻服务——网页 + 每天定时抓取都在 NAS 上，局域网设备直接访问，不需要 GitHub、不需要代理。
> **与电脑端是两套并行**：电脑端照常跑计划任务、推 GitHub 网页；NAS 端独立采集、数据存本地（出门在外的备用入口）。两边互不影响。
> 文件布局：项目文件放 `/vol1/jingcai`，容器项目文件放 `/vol1/docker/jingcai`。
> 全程只需要三步：**拷贝文件夹 → 部署容器 → 验证**。下面把每个界面的每个字段都写清楚，并有完整的"容器起不来"排查表。

---

## 第 0 步：前置检查

1. NAS 已开机，飞牛系统里已安装 **Docker** 应用（应用中心 → Docker，安装后打开）
2. 项目文件夹已拷贝到 NAS：**`/vol1/jingcai`**（存储空间根目录下的 jingcai 文件夹）
   - 拷贝方式：Windows 资源管理器地址栏输入 `\\NAS的IP` → 用飞牛账号登录 → 进入存储空间 → 新建文件夹 `jingcai` → 把电脑上整个项目文件夹**里面的内容**全部拷进去
   - 拷完的目录里应该能看到：`docker-compose.yml`、`config.json`、`docs`、`nas`、`scripts` 等（在飞牛的「文件」应用里确认一下）
   - ⚠️ 记住这个路径，后面要填。若文件夹建在个人空间里，实际可能是 `/vol1/1000/jingcai`；存储空间不叫 vol1 则相应替换——**以「文件」应用里看到的实际路径为准**
3. 电脑上先双击过 `手动执行.cmd`（数据最新；数据在 `docs/data` 里，随文件夹拷贝自动保留）
4. 让 NAS 这一套"独立化"（两处小改动，**不影响电脑端**）：
   - 编辑 NAS 上的 `jingcai/config.json`：把 `"autoPush": true` 改为 **`false`**（NAS 端不推送 GitHub）
   - 若拷贝时把 `.git` 文件夹也带过去了，**删除或改名**（如 `.git-bak`）——NAS 端从此不碰 GitHub
5. 在存储空间根目录建 `docker` 文件夹，里面再建 `jingcai`（→ `/vol1/docker/jingcai`），用于放容器项目文件

> 确认路径的小技巧：飞牛「文件」应用里进入该文件夹，顶部/属性里能看到完整路径。

---

## 第 1 步：部署容器（三种方式选一种）

### 方式 A：容器表单（最直观，推荐）

打开 **Docker 应用 → 左侧「容器」→ 右上角「添加容器」**，按下表填写：

| 字段 | 填什么 |
|---|---|
| 镜像 | `node:20-alpine`（若拉取失败见下方排查表第 1 条） |
| 容器名称 | `jingcai` |
| 重启策略 | `除非手动停止`（或"总是"/unless-stopped） |
| 端口映射 | 本地 `8788` → 容器 `8788`，协议 TCP |
| 存储/挂载 | 添加一条：主机路径 `/vol1/jingcai`（你的实际项目路径）→ 容器路径 `/app` |
| 环境变量 | 添加两条：`TZ` = `Asia/Shanghai`；`PORT` = `8788` |
| 命令（若有该字段） | `node /app/nas/server.js`（就是这一串，**不要加引号、不要加 sh -c、不要加 cd**；脚本不依赖工作目录，绝对路径即可） |

保存/启动即可。

### 方式 B：SSH 一条命令（最快）

用任意 SSH 工具登录 NAS（飞牛「系统设置 → 终端/SSH」里可开启），执行：

```bash
docker run -d --name jingcai --restart unless-stopped \
  -e TZ=Asia/Shanghai -e PORT=8788 \
  -p 8788:8788 \
  -v /vol1/jingcai:/app \
  node:20-alpine \
  node /app/nas/server.js
```

（把 `/vol1/jingcai` 换成你的实际路径；第一条命令已包含自动重启设置。）

### 方式 C：Compose 项目（本仓库自带 docker-compose.yml）

**Docker 应用 → 左侧「项目」→ 新建项目**：

- **项目名称**：`jingcai`
- 先把项目目录里的 `docker-compose.yml` **复制一份**到 `/vol1/docker/jingcai/`（也可不放，见下条）
- 新建项目时：界面若有「项目存放位置/路径」就选 `/vol1/docker/jingcai`；Compose 来源选「选择文件」指到那里的 `docker-compose.yml`，**或者直接把文件内容粘贴进去**——两种方式都直接可用
- ⚠️ 唯一要核对的：compose 里 `volumes` 一行的 `/vol1/jingcai` 与你项目文件夹的实际路径一致（不一致就把这一行改掉）。因为用的是绝对路径，**粘贴方式也不会挂错目录**（旧教程里"必须把 `.` 改成绝对路径"的坑已内置解决）
- 点「部署/启动」。首次会拉取 `node:20-alpine` 镜像。

> 三种方式的本质完全一样：都是拿 node 镜像、挂载项目文件夹到 `/app`、运行 `nas/server.js`、放通 8788 端口。

---

## 第 2 步：验证（1 分钟）

1. **看日志**：Docker →「容器」（或「项目」）→ `jingcai` → 「日志」，应看到：
   ```
   竞彩进球数预测 · NAS 服务已启动
     网页地址：http://<NAS的IP>:8788/
     定时执行：11:00(both)、17:00(odds)（容器时区 Asia/Shanghai）
     数据概况：{"days":13,...,"matches":137,...}
   ```
2. **开网页**：手机或电脑浏览器打开 `http://NAS的IP:8788` —— 就是完整网页（数据表、模拟投注、统计、详情页、Excel 下载）
3. **确认"NAS 本地模式"**：页面状态栏显示 **「NAS 本地数据」**、且「同步到云端」按钮消失——此时网页上的「抓取今日赔率 / 回填赛果」按钮**直接指挥 NAS 执行**（写入 NAS 数据文件，所有设备刷新即可见）
4. **状态接口**：`http://NAS的IP:8788/api/status`
5. **手动执行一次**：点网页上的「抓取今日赔率」按钮，或访问 `http://NAS的IP:8788/api/run?mode=both`（几秒到几十秒后刷新网页即可看到新抓取）

---

## 第 3 步：收尾（两套并行，不用动电脑端）

- **电脑端保持原样**：计划任务照跑、照常推 GitHub 网页——两套并行正是预期用法，两边数据各自累计、互不覆盖
- 手机/平板同一局域网直接访问 `http://NAS的IP:8788`，**无需任何代理**；出门在外可开启飞牛「远程访问」（绑定飞牛账号）作为备用入口
- 可选：`config.json` 的 `nas.runKey` 填一个口令，防止他人触发手动执行接口（网页浏览不受影响；网页按钮首次使用会提示输入一次，浏览器记住）

---

## 容器起不来？按这个表对号入座

### 先学会看日志（关键一步）

三种方式任选：
1. Docker 应用 →「容器」→ 找到 `jingcai` → 点开 →「日志」标签（最常用）
2. Docker 应用 →「项目」→ `jingcai` →「日志」
3. SSH：`docker logs jingcai --tail 50`（容器没建起来时用 `docker ps -a` 看状态和退出码）

### 常见错误对照表

| 日志里的关键词 | 原因 | 解决 |
|---|---|---|
| `pull access denied`、`i/o timeout`、`TLS handshake timeout`、`dial tcp ... timeout` | **镜像拉取失败**（连不上 Docker Hub，国内常见，与代码无关） | ① Docker 应用 →「设置」→ 配置**镜像加速源**（填飞牛推荐的加速地址）后重试；② 或把镜像名换成加速前缀，如 `docker.m.daocloud.io/library/node:20-alpine`（加速地址有时效，可上网搜"docker 镜像加速"取最新可用的） |
| `Starting` → `Started` → `Exited:0`（**干干净净退出、日志没有任何报错**） | **容器的「命令」字段没生效/没填**：容器实际跑的是 node 的交互模式（等待输入），无输入立即正常退出（退出码 0 就是它"正常结束"的意思） | 编辑容器 → 找到「命令 / 执行命令 / Command」框（不是名称、不是环境变量框），填：`node /app/nas/server.js`（无引号）→ 保存并启动；或按"方式 B"用 SSH 一条命令删旧建新。验证：日志出现 `NAS 服务已启动` 即成功 |
| `syntax error: unterminated quoted string`（或命令里的引号被拆得乱七八糟） | **命令框不支持引号**：图形界面把双引号拆坏了，`sh -c "..."` 这类带引号的命令会失败 | 改用**不带引号**的命令：`node /app/nas/server.js`；或按"方式 B"用 SSH 一条命令重建 |
| `Cannot find module '/app/nas/server.js'`、`MODULE_NOT_FOUND` | **挂载路径不对**——容器里 `/app` 不是项目文件夹 | 方式 C：核对 compose 里 `- /vol1/jingcai:/app` 是否是你项目文件夹的实际路径（大小写、个人空间 `/vol1/1000/...` 等）；方式 A/B：检查挂载的"主机路径"是不是真的项目文件夹（里面要有 nas、docs 这些子文件夹） |
| `EACCES: permission denied`、`permission denied, open ...` | **文件权限**——容器用户读不了/写不了项目文件 | SSH 执行一行：`sudo chown -R 1000:1000 /vol1/jingcai`；或方式 C 删除 `user: "1000:1000"` 那一行、方式 A 不设置用户，重新部署（以 root 运行） |
| `port is already allocated`、`address already in use` | **8788 端口被占用** | 换端口：方式 A 把两处 8788 都改成一个空闲端口（如 8890）；方式 B/C 同理（ports 与 PORT 两处一致）；改完 `http://NAS的IP:新端口` 访问 |
| `no such file or directory`（挂载时报错）、容器秒退 | **主机路径不存在** | 先在飞牛「文件」应用里把 `jingcai` 文件夹建好、项目拷进去，再重新部署 |
| 容器状态一直是「已停止」但日志为空 | 命令字段没有生效 | 编辑容器：找到「命令 / Command」字段填 `node /app/nas/server.js`（**无引号、不要 sh -c**）并保存、启动；或按"方式 B"用 SSH 一条命令删旧建新 |
| 日志显示 `EADDRINUSE`（Node 报的） | 容器内端口占用 | 极少见；把 PORT 与 ports 一起换端口重新部署 |
| 日志一切正常但网页打不开 | 防火墙/网络 | 确认访问地址是 `http://NAS的IP:8788`（不是 https）；确认手机与 NAS 在同一局域网；飞牛「安全」里如开了防火墙需放行该端口 |

**找不到原因时**：把「日志」页的内容截图或复制发我（尤其最后 20 行），以及你用的是方式 A/B/C，我来定位。

---

## 日常使用与维护

| 事项 | 操作 |
|---|---|
| 自动采集 | 每天 11:00 / 17:00 自动执行（抓赔率 + 回填赛果 + 封盘冻结预测），日志可在 Docker 里看，或项目目录 `logs/daily.log` |
| 手动执行 | 直接点网页上的「抓取今日赔率 / 回填赛果」按钮（NAS 本地执行）；或浏览器访问 `http://NAS的IP:8788/api/run?mode=both`；或 SSH：`docker exec jingcai node scripts/daily.js both --no-push` |
| 改采集时间 | 编辑项目目录 `config.json` 的 `times` → Docker 里重启 `jingcai` 容器 |
| 改网页端口 | 换端口（见上表）→ 重新部署 |
| 更新代码 | 把新版本代码文件覆盖到 NAS 项目目录（**不要覆盖 `docs/data`、`docs/excel`、`logs`**）；`docs/` 下的网页文件即时生效（无需重启），改了 `scripts/`、`nas/`、`config.json` 才需要重启容器 |
| 数据备份 | 拷走项目目录的 `docs/data` + `docs/excel`；整个项目文件夹拷回电脑也是一份完整备份 |
| 环境自检 | SSH：`docker exec jingcai node scripts/daily.js check`（NAS 环境下 GitHub 相关项会自动按"可忽略"处理） |

> 进阶：若希望容器写出的文件直接归你的飞牛账号（便于以后经 SMB 修改），先 `sudo chown -R 1000:1000 /vol1/jingcai`，再采用带 `user: "1000:1000"` 的 compose（本仓库自带）。反之若更新文件时遇到"权限不足"，同样是执行这条 chown。
