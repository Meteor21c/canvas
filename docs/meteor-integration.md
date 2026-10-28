# 流星 API 完整创作台适配

本分支基于 tigerowo/infinite-canvas 正式标签 v0.8.2（801e0561），并参考 leezeqi/canvas 的 Sub2API 协议适配，保留原版首页、无限画布、提示词、素材、图像、视频与 Agent 界面；账号、模型权限及钱包由现有 Sub2API 管理。原作者与贡献者包括 basketikun、HuFakai、tigerowo 和 leezeqi，遵循完整保留的 GNU AGPL-3.0。页面 `/studio/source` 提供与当前部署提交对应的完整源码与本安装说明。

## 运行与构建

- `Meteor canvas v0.8.2` GitHub Actions 执行 Go 测试、完整前端类型检查、API 边界测试，构建 linux/amd64 镜像 `ghcr.io/meteor21c/canvas:meteor-<commit7>`，并运行无付费任务的模拟主站验收。
- 镜像由真实 Node.js 22 编译和运行 Next，Bun 仅安装依赖与运行测试；Go 以纯 Go SQLite 构建。未使用的 Comfy Bridge 不参与本次构建。
- 部署使用 `deploy/meteor.compose.yml`，固定已经拉取并核验的镜像摘要。生产服务器不执行编译。数据目录默认 `/opt/meteor-canvas/data-v082`，首次只创建此明确目录并授予 uid/gid 1000，不递归修改其他目录。
- SQLite 固定 `/app/data/infinite-canvas.db`。启动前备份此数据库和数据卷以及 Compose，保留旧镜像，先完成拉取再切换目标服务。
- 容器以 uid 1000、只读根、无额外 capabilities 运行。默认总内存 768 MiB、Node 堆 320 MiB、Go 内存软上限 224 MiB、CPU 0.75；是起始预算，需实际观察。`/tmp` 和 Next 缓存是有限 tmpfs。
- 只有 Next 的端口绑定在宿主回环 `127.0.0.1:3010`，Go 的 8080 不发布。创作台加入现有私有网络 `meteor-cutover-live-sub2api`，通过固定 `METEOR_API_BASE=http://sub2api:8080` 访问主站。主站宿主的 3000 仍只绑定回环；无需开放新公网端口。CI 用 `host.docker.internal:3000` 连接无付费能力的模拟主站。

## Nginx 与路径

Next 的 `basePath=/studio`、`trailingSlash=false`。`/studio` 精确匹配和 `/studio/` 前缀均原样代理 `127.0.0.1:3010`，不能去掉 `/studio`，也不能将 `/studio` 强制跳转至 `/canvas`。保留 `Authorization` 头；`/studio/api/*` 由 Next 固定转发容器内 `127.0.0.1:8080/api/*`。主站 `/api/v1/*`、`/v1/*` 不变。

Next 禁止独立登录、注册、管理员页面及对应 API、匿名存储、外部桥接和自定义外发入口；Go 继续在实际数据接口验证主站站主 JWT。主站 API Key 只能在 Go 内存使用，不能出现在公开渠道配置、前端项目、源码、日志和导出中。

`/studio/studio-health` 同时验证 Next 与 Go 存活；业务验收还需登录、项目保存与媒体结果。首次切换验证首页、各原版页面、静态资源、站主鉴权、非站主拒绝、文件归属、缓存配额与清理、容器健康、重启次数、主站健康、系统负载/内存/Swap。付费模型实际调用由明确选定的小额任务单独验收，不因进程健康自动发起。

## 数据与清理

画布项目默认从最近一次服务器保存起保留 7 天；图片、音频和临时上传从服务器创建起保留 7 天，已完成任务的响应记录从完成起保留 7 天。项目和媒体响应提供 expiresAt，画布还提供 retentionDays 与 expiryWarning（到期前 24 小时）。旧工程缺少服务器留存标记时先完整保留内容，并以首次采用新规则的服务器时间开始 7 天，避免把旧客户端时间误判为已过期。客户端不能通过未来 updatedAt 延长期限。每分钟维护按明确对象逐一处理，启动不立即执行清理。最小任务幂等回执、工程删除墓碑长期保留，避免过期后旧客户端再次触发付费生成。

旧试用版的 `canvas_pilot_projects` 在切换前备份，使用事务仅插入新 SQLite 尚不存在的工程；保留原始 JSON 节点和 revision，不修改源 PostgreSQL。浏览器旧工程按站主身份导入新库；工程的 7 天期限从服务器首次导入起算，已有媒体期限独立计算，保存工程不会刷新媒体期限。首次空库会顺序初始化固定的公开提示词源，单次响应上限 4 MiB、分类最多 500 条，后续按日同步；该过程不调用模型。


## 后端业务边界

- Go仅连接固定主站内部地址，生产是`http://sub2api:8080`；模型目录使用当前站主本人未过期且有额度的密钥，不向浏览器下发密钥或内部主站地址。Gemini原生渠道只保留文本能力；图片生成统一使用 images/generations 或 images/edits，拒绝借 chat/responses 工具绕过。视频渠道统一适配本站视频接口。
- 当前主站只向站主开放创作台；每次通过主站`auth/me`和`canvas/access`核验，缓存最长10秒。主站JWT、API Key只保留在进程内存，进程重启后重新登录或刷新页面即可恢复目录；不会写入SQLite、项目或导出。
- 视频创建先保存本地任务与永久最小幂等回执，再调用主站`/v1/videos/generations`。保留主站素材库审核、预扣与最终结算流程；图片和音频也按客户端任务编号去重。主站是唯一钱包，不创建Canvas二次扣款或虚构退款。未知提交、中断和缺失登录状态都不会自动重新生成。
- 图像、音频及视频提交并发最多2个；视频状态轮询并发最多2个。视频结果从本站受保护内容接口按Range转发，浏览器仅得到30分钟签名的本站路径，不得到上游直链或API Key。
- 单文件最大64 MiB；临时素材每站主最多256个、512 MiB，全局2 GiB。生成图片先保存为独立文件，SQLite不保存base64图像。每分钟清理超过7天的素材，超过后保留任务编号并标注素材已清理。已完成任务的响应缓存7天后清理，最小幂等回执继续保留，避免历史客户端编号再次付费。
- 画布最多20个、单个1 MiB、总10 MiB，保留原版节点、Agent及对话状态。保存采用JSON`revision`乐观锁；旧revision返回HTTP409。sync只插入缺失ID并返回账户完整列表，删除墓碑长期保留，阻止旧页面恢复已删除工程。工程7天到期后清空正文并留下墓碑，素材期限独立计算；过期内容不会自动重发付费请求。旧工程采用规则时获得完整首个7天窗口。
- Go请求日志只记method、path、status，不记Authorization或完整query；媒体上传按文件签名核验格式，拒绝HTML/SVG；远程图片读取通过DNS绑定的公网安全dialer并限制体积和并发。

本地纯mock验收覆盖任务并发幂等、重启未知状态、任务缓存清理后不重放、图片/视频安全边界、主站允许的时长/清晰度及参考图片视频音频字段、签名内容读取、项目revision冲突/删除恢复保护、素材归属/Range/256文件配额/7天清理与旧工程留存保护。测试不发起实际上游付费任务。

## 售价与参数边界

- `GET /studio/api/v1/meteor/capabilities?kind=image|video&channelId=...&model=...` 返回当前本人渠道能力；`POST /studio/api/v1/meteor/quote` 接收 kind、channelId、model、count，以及图片 size/resolution/quality 或视频 duration/resolution/audio/inputVideo。
- 图片单次最多4张、参考图片最多4张；JSON、multipart和嵌套自定义字段均检查数量。图片任务只能选择 images 协议，原生 Gemini 图片能力暂不在此入口开放。普通文本/Agent 请求可继续带入图片作识别，但不能要求 image_generation 输出绕过限制。
- 视频单次1条、参考素材最多4个，服务端强制 watermark=false。Seedance/Kling 的清晰度和音频/参考视频组合来自本人密钥对应的实时目录；时长使用主站同款规则（1.5 Pro 4–12秒、2.5 4–30秒、2.0系列4–15秒、Kling 3–15秒）。已存在的 Grok 视频保留经主站代码确认的1–15秒与480p/720p保守能力。其他无法确认的模型明确暂不可提交。
- FZY视频售价、官方参考倍率和预扣读取主站选定密钥的 `/v1/videos/pricing`；只转发本站单价、官方单价、对比倍率、预扣及必要计费单位，绝不转发原始定价响应、内部成本、加价字段或渠道身份。Grok视频读取本人实际分组配置与专属/视频独立倍率，未提供的官方价和预扣为 null。
- 图片价格从主站模型广场本人分组解析，应用专属倍率或图片独立倍率；像素尺寸优先确定1K/2K/4K档。Token模型展示真实输入/缓存/图像输出Token单价；没有Token用量时不估造每张总价或预扣。官方图像输出价缺失时不拿文本输出价替代。未确认或未配置值为null，不当作0；分档/分时尚不能确定完整费用时明确提示查看主站。
- `saleRateToOfficial` 是本站价÷官方价：0.345 表示官方的34.5%，即3.45折。报价是只读预览；最终扣费仍由主站按创建时冻结价格和实际用量完成。

上述新增接口、数量边界与留存测试使用本地模拟主站和隔离临时SQLite/文件目录，不调用真实付费生成；本轮没有执行生产数据清理。
