# Yggdrasil 材质处理

AsterYggdrasil 现在有两套材质入口。

面向启动器和 authlib-injector 兼容工具的是 Yggdrasil 上传接口：

```text
PUT    /api/yggdrasil/api/user/profile/{uuid}/{skin|cape}
DELETE /api/yggdrasil/api/user/profile/{uuid}/{skin|cape}
GET    /api/yggdrasil/textures/{hash}
```

面向站点用户的是 wardrobe 和 profile 绑定接口：

```text
GET    /api/v1/wardrobe/textures
POST   /api/v1/wardrobe/textures/{skin|cape}
PUT    /api/v1/profiles/minecraft/{uuid}/textures/{skin|cape}
DELETE /api/v1/profiles/minecraft/{uuid}/textures/{skin|cape}
```

Yggdrasil 协议接口返回协议格式，不使用项目 API envelope。`/api/v1/...` 站点和管理接口继续返回统一 envelope。

## Microsoft 绑定档案

用户绑定 Microsoft 正版账号后，站点会使用正版 UUID 和正版玩家名创建 Minecraft profile。
这类 profile 的名称和删除操作受保护：

- 不允许用户重命名。
- 不允许用户删除。
- 允许在系统配置开启 `yggdrasil_allow_microsoft_profile_texture_override` 时使用本站 wardrobe 材质。

该配置默认开启。开启后，Microsoft 绑定档案可以像普通皮肤站档案一样绑定、上传和解绑 skin/cape。
关闭后，Microsoft 绑定档案只能使用从 Mojang 同步来的官方材质。

绑定 Microsoft 正版账号时，系统会尝试把 Mojang 官方 skin/cape 下载到当前用户的 wardrobe，并绑定到该 profile。
这些材质会标记为 `mojang` 来源。用户后续手动选择或上传的材质会标记为 `local` 来源。

“更新正版皮肤”只同步 Mojang 官方材质到 wardrobe：

- 如果当前槽位为空，系统会绑定最新官方材质。
- 如果当前槽位仍是 `mojang` 来源，系统会用最新官方材质替换。
- 如果当前槽位已经是用户手动选择的 `local` 来源，系统只导入官方材质到 wardrobe，不覆盖用户当前选择。
- 如果 Mojang 不再返回某个官方槽位，系统只会清除当前绑定的 `mojang` 来源材质，不会删除或解绑用户本地材质。

## Wardrobe 和公共材质库

Wardrobe 是用户自己的材质库。上传到 wardrobe 的材质默认只属于当前用户，用户可以把其中一张绑定到自己的 Minecraft profile，也可以把材质设置为公开并提交到公共材质库。

公共材质库由运行时配置控制：

- `texture_library_enabled`: 是否启用公共材质库。
- `texture_library_review_required`: 用户发布材质到公共材质库时是否必须经过管理员审核。

用户侧常用流程：

1. 上传 skin/cape 到 wardrobe。
2. 把材质 visibility 改为 `public`。
3. 提交公共材质库。
4. 如果需要审核，等待管理员通过；如果不需要审核，提交后直接成为 `published`。
5. 其他登录用户可以从公共材质库复制该材质到自己的 wardrobe。

公共材质库只展示已经发布的公开材质。私有材质、待审核材质、被打回材质和已下架材质不会出现在公共列表或公共详情里。

公共材质库相关站点 API：

```text
GET    /api/v1/texture-library/tags
GET    /api/v1/texture-library/textures
GET    /api/v1/texture-library/textures/{texture_id}
POST   /api/v1/texture-library/textures/{texture_id}/copy
POST   /api/v1/texture-library/textures/{texture_id}/reports
POST   /api/v1/wardrobe/textures/{texture_id}/library-submission
DELETE /api/v1/wardrobe/textures/{texture_id}/library-submission
```

复制公共材质需要登录。复制后会在当前用户 wardrobe 中创建或复用一条材质记录，默认保持私有，不会自动再次发布。

## 审核、下架和举报

材质的公共库状态由 `library_status` 表示。当前主要状态包括：

- `private`: 不在公共材质库中。
- `pending_review`: 已提交，等待管理员审核。
- `published`: 已发布到公共材质库。
- `rejected`: 管理员打回。

管理员可以在材质库后台处理提交：

```text
GET  /api/v1/admin/texture-library/textures
GET  /api/v1/admin/texture-library/textures/{texture_id}
POST /api/v1/admin/texture-library/textures/{texture_id}/approve
POST /api/v1/admin/texture-library/textures/{texture_id}/reject
POST /api/v1/admin/texture-library/textures/{texture_id}/unpublish
```

用户可以举报已经发布的公共材质。举报必须登录，不能举报自己的材质，不能举报私有、待审核、打回或已下架材质。同一用户对同一材质只能保留一条 pending 举报。

举报有独立状态，不和材质的 `library_status` 混用：

- `pending`: 等待管理员处理。
- `accepted`: 举报成立。
- `rejected`: 举报被驳回。

管理员可以在举报队列中成立或驳回举报：

```text
GET  /api/v1/admin/texture-library/reports
GET  /api/v1/admin/texture-library/reports/{report_id}
POST /api/v1/admin/texture-library/reports/{report_id}/accept
POST /api/v1/admin/texture-library/reports/{report_id}/reject
```

举报成立会把对应材质从公共材质库下架，并把处理备注写入材质的审核意见。材质所有者在 wardrobe 里可以看到下架状态和处理说明。

如果管理员没有从举报队列处理，而是直接从材质管理页下架一个已发布材质，系统也会把该材质现有 pending 举报标记为 `accepted`，并复用下架备注作为举报处理备注。这样举报队列不会残留已经被直接处理的 pending 记录。

## 上传校验

上传文件必须是 `image/png`。服务端会先读取 PNG header 获取尺寸，再解码图像，避免在尺寸校验前把潜在 PNG bomb 完整读入内存。

允许的尺寸：

- skin: `64x32` 的整数倍，或 `64x64` 的整数倍。
- cape: `64x32` 的整数倍，或 `22x17` 的整数倍。

不符合尺寸的文件会返回 Yggdrasil 协议错误，错误类型为 `IllegalArgumentException`。

## Cape 22x17 兼容

authlib-injector 文档允许旧式 cape 使用 `22x17` 的整数倍，但它不是标准 cape 画布。AsterYggdrasil 在上传处理阶段会把这种 cape 补透明到对应的标准 `64x32` 画布：

- `22x17` 会保存为 `64x32`。
- `44x34` 会保存为 `128x64`。
- 原图像素从左上角开始保留。
- 新增区域填充完全透明像素。

这个归一化发生在存储前，所以后续 metadata、公开读取、hash、引用计数和孤儿清理都基于处理后的 PNG。客户端拿到的 URL 永远指向已经重编码后的安全 PNG。

## 重编码和 Hash

服务端会把上传 PNG 解码为 RGBA，再重新编码为 PNG。这样可以去掉与位图无关的 PNG 元数据，避免客户端分发用户上传文件中的额外数据。

材质 hash 使用处理后 PNG 文件内容计算，并作为公开 URL 的最后一段：

```text
/api/yggdrasil/textures/{sha256}
```

Minecraft/authlib-injector 客户端会把 URL 文件名当作材质标识缓存，所以同一张处理后图片会稳定命中同一个 hash。

## Public URL 和 skinDomains

`textures` property 中的 URL 必须是客户端可访问的绝对 URL。普通部署只需要配置 `public_site_url`，服务端会派生出 `{public_site_url}/api/yggdrasil/textures/{hash}`。如果配置了高级覆盖项 `yggdrasil_public_base_url`，服务端会优先使用第一个可用的 http/https URL。公开读对象存储/CDN 可以额外配置 `yggdrasil_texture_public_base_url`，让已上传材质使用 `{base}/{storage_key}`；默认皮肤仍走 Yggdrasil API。

配置 `yggdrasil_texture_public_base_url` 后，管理前端和用户前端的材质预览也会直接加载该对象存储/CDN URL。桶或 CDN 必须允许对外服务站点来源的匿名 `GET`/`HEAD` CORS 读取。上传不需要浏览器 CORS，AsterYggdrasil 始终由服务端 streaming 上传。

authlib-injector 会校验材质 URL 的域名是否在 metadata 的 `skinDomains` 中。metadata 会自动包含 Mojang 官方域名 `.minecraft.net`、`.mojang.com`，以及当前有效 texture URL 的 host。`yggdrasil_skin_domains` 只用于额外允许 CDN 或外部材质域名。

## 存储和维护

当前支持 local、S3 和 MinIO object storage，并通过 `object_storage` 静态配置选择 backend。上传成功后只保存处理后的 PNG，不保存原始上传文件。

运行时维护任务包括：

- `yggdrasil-texture-cleanup`: 删除没有数据库引用的材质对象。
- `yggdrasil-storage-consistency-check`: 检查数据库记录指向的对象是否缺失，以及 object storage key 是否和数据库 hash 一致。
- `yggdrasil-token-cleanup`: 清理过期或已吊销的 Yggdrasil token。

删除材质会先删除数据库引用，再按引用计数清理对象。多个 profile 引用同一 hash 时，不会误删仍被引用的对象。
