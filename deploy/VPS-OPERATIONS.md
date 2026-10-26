# 运维

服务器上的部署、回退与日常运维。隐私与推送见 [shipping](../docs/shipping.md)。

部署是可撤回的：旧 release 目录原样保留，回退只是把服务指回去再重启。所以事前检查从简，靠快速回退兜底；唯一要人确认的是"服务空闲"，因为重启会打断正在进行的生成。

## 停机前

1. 主窗口接管的卡位先"放回多卡，返回原主窗口"。
2. 打开"多卡并行"，等各卡位的生成、后台整理、待受理输入结束，**逐个暂停全部卡位**，包括空闲的（应用内更新在仍有运行卡位时会拒绝）。
3. 确认主窗口没有生成、后台整理、助手、消化队列或插件任务。

在界面上看过即可。重启后普通卡位不自动续跑，由用户手动"恢复"；接管归属保留。

## 部署

推荐方式：源码工作树（含私人数据）保持原位作为服务 cwd，产品代码从独立的 release 目录运行。systemd drop-in 指定入口和 `LIYUAN_WEB_DIST_DIR`，并用 `BindReadOnlyPaths` 把 release 的 `server/`、`src/`、`web/public/`、`skills/`、`node_modules/@liyuan`、`.liyuan/extensions/roleplay.ts` 只读挂到 cwd 对应路径。私有目录不在 release 里，切换碰不到它们。

```bash
# SOURCE=源码仓库  REV=要部署的 commit  OLD=当前 release  NEW=新 release 目录
# DROPIN=/etc/systemd/system/liyuan.service.d/50-current-release.conf
cd "$SOURCE" && npm run verify                     # 对 REV 跑一次（加本次相关的浏览器测试）
mkdir "$NEW" && git -C "$SOURCE" archive "$REV" | tar -x -C "$NEW"
# 依赖：$NEW/node_modules 与 $NEW/web/node_modules 逐项链接到源码已安装的依赖；
#       但 $NEW/node_modules/@liyuan/* 要指向 $NEW/packages/ 下本版本的 SDK，不能指回源码
npm --prefix "$NEW/web" run build -- --outDir "$NEW/web/dist"
sudo -u liyuan test -r "$NEW/server/main.ts" && sudo -u liyuan test -r "$NEW/web/dist/index.html"
# —— 确认空闲（见上一节）——
cp -p "$DROPIN" "$DROPIN.prev"
sed -i "s#$OLD#$NEW#g" "$DROPIN"
systemctl daemon-reload && systemctl restart liyuan
```

- `git archive` 只取已提交的那个 commit，不在 dirty 工作树上直接部署。推送 GitHub 不是部署的前提。
- `web/public/` 由服务运行时读取，HTML 来自 dist，SDK 读 `packages/*/dist`；三者在同一个 release 里天然配套，不手改 bundle。
- release 内源码、Skill、静态资源对服务账户可读；私有目录/文件保持 0700/0600。

不需要：手工整库备份、私有配置哈希快照、候选文件逐个清单、工具链指纹、写死 PID 的前置断言。`scripts/update-local.sh` 是原地合并上游并重启的旧式更新器，用 release 目录部署时不需要它。

## 部署后核对

几分钟内做完：

1. `systemctl is-active liyuan`，进程命令行指向新 release。
2. `curl -fsS http://127.0.0.1:<端口>/healthz` 返回 200；首页引用的 bundle 来自新 dist。
3. 浏览器打开一次：WS 连上，设置页能打开。

任一失败立即回退，再查原因。启动时服务会合法地重写部分设置格式或模型元数据（如 Agent 目录的 `settings.json`、`models.json`），这不是异常。线上核对保持只读，不在生产卡上试写。

## 回退

```bash
cp -p "$DROPIN.prev" "$DROPIN" && systemctl daemon-reload && systemctl restart liyuan
```

只回代码/dist。用户新数据保留，不回滚故事、数据库或记忆，私有配置不从 GitHub 恢复。新版稳定一段时间后可删更早的 release，至少保留上一个。

## 访问保护

- 敏感 HTTP/WS 拒绝异源 Origin 和不合规的 Fetch Metadata（同站点不等于同源）；路径先规范化再鉴权；无 Origin 的 CLI 请求仍要过访问密码。
- **未设访问密码时**只接受 localhost、回环或本机网卡 IP 作为 `Host`（防 DNS 重绑定）。用自定义域名：先从本机/IP 入口设好密码，或设置 `LIYUAN_TRUSTED_HOSTS=a.example,b.example`（不带 URL、凭据、通配符）。
- 反向代理保留原始 `Host`（含非默认端口）：Nginx 用 `proxy_set_header Host $http_host;`，不要用 `$host`。服务不信任 `X-Forwarded-Host`。非默认 HTTPS 端口上线后实际试一次带 Origin 的 POST 和 WebSocket。
- 密码凭据文件损坏、不是普通文件或是符号链接时服务拒绝开放，不会退化成无密码。排障时保留文件，查权限和磁盘。
- 接管后的 API/WS 需要工作区与租约：浏览器自动附加；外部工具从 `/api/play-slots/main` 取值后带 `x-liyuan-workspace` 与 `x-liyuan-workspace-lease`，过期返回 `409 workspace_changed`。
- 遇到来源或 Host 拒绝，先查浏览器地址、代理转发和信任配置，不要关掉校验或鉴权。

## 网络与代理

- Compose 里的网络设置只是模板。研究网络用 `LIYUAN_WEB_RESEARCH_PROXY`（空值 = 不用代理）；数据库与助手/模板按各自来源下载，Veridis 的 Git 路由见 `server/plugin-git-network.ts`。外部 CLI 代理镜像固定版本，不用 `latest`。
- Fish 连接问题先做无 Key 的只读网络检查。`LIYUAN_FISH_AUDIO_NETWORK_MODE=compatible` 只为 Fish 切换固定 DNS 与兼容握手，仍严格校验证书；不要用 `NODE_TLS_REJECT_UNAUTHORIZED=0`。上线后确认 `GET /api/fish-tts/status` 不返回 Key。

### 模型代理超时

部分供应商在隐藏推理期间不发流式字节，部分前置代理会因首包/空闲超时断开（如 524），见 [models 预算与超时](../docs/models.md#预算与超时)。若实测同一端点同一模型支持 `openai-responses` 且事件能及时穿过代理，可以只为受影响的岗位改用这个协议：在 `liyuan.agent.json` 添加渠道（启动时同步到 Agent 目录 `models.json`），只改对应 `stepModels` 键；先备份私有配置、保持 0600 与属主，空闲时重启生效，回退就恢复备份后重启。Responses 目前没有传输时间线（见 [diagnostics 请求查看器](../docs/diagnostics.md#请求查看器)）。

## 磁盘与原子保存

- `ENOSPC`：分别看容量与 inode，以服务账户的可用空间为准。只清确认可重建的缓存或已结束的测试副本；会话、素材、记忆、备份不是垃圾。
- 配置写入走 `src/atomic-json.ts`：同目录临时文件 → 同步 → 替换，保留一个 `.bak`。中断留下的临时文件可能含私人配置，不要公开或随手删。空间不足返回 507。

## 私有持久数据与锁

- `.liyuan/play-slots/`（含 `main-window.json`）、`.liyuan-fish-tts/`、插件私有目录都是持久数据，更新不覆盖，损坏时不删文件来"修复"。Docker/Compose 用独立持久卷。
- 插件请求次数持久记在私有 `model-request-budget.json`，重启不清零。
- 进程锁按 PID/starttime/boot/nonce 核对身份，只在确认持有者已死亡时回收；活进程、身份未知、损坏或 symlink 的锁不要手动删。
