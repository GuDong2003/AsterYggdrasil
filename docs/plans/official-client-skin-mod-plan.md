# 正版客户端皮肤站材质 Mod 开发方案

## 结论

这个 Mod 的目标是让安装了 Mod 的正版客户端也读取 `mc.guji.uno` 皮肤站材质。
服务端不需要再参与客户端显示逻辑；Mod 只在客户端覆盖 skin/cape 渲染结果，不参与登录鉴权。

最终效果：

- 正版玩家没有在皮肤站换肤时，显示 Mojang 官方皮肤。
- 正版玩家在皮肤站选择了自定义材质时，显示皮肤站当前绑定材质。
- 皮肤站登录玩家显示皮肤站当前绑定材质。
- 查询失败、验签失败、下载失败时回退 Mojang 官方皮肤，不影响进入服务器。

## 推荐首版范围

第一版只做 Fabric 单版本，建议先定一个明确目标版本，例如：

- Minecraft `1.20.1` + Fabric + Yarn mappings。
- 或 Minecraft `1.21.1` + Fabric + Yarn mappings。

不要第一版同时做 Fabric、Forge、NeoForge 多平台。平台适配层后续再抽。

第一版功能边界：

- 客户端启动时加载配置。
- 进入多人游戏后按玩家 UUID 查询皮肤站。
- 验签 Yggdrasil `textures` property。
- 覆盖 skin/cape 显示。
- 本地缓存 profile 和 PNG 材质。
- 失败回退 Mojang 官方皮肤。

## 服务端接口

### Metadata

Mod 启动后先请求 metadata：

```text
GET https://mc.guji.uno/api/yggdrasil
```

需要读取：

- `skinDomains`: 允许下载材质的域名。
- `signaturePublickey`: 验签 `textures` property 的 RSA 公钥。
- `meta.serverName`: 可用于日志或配置界面显示。

示例字段：

```json
{
  "meta": {
    "serverName": "LDMC"
  },
  "skinDomains": [".minecraft.net", ".mojang.com", "mc.guji.uno"],
  "signaturePublickey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
}
```

### Profile

按玩家 UUID 查询本站 profile：

```text
GET https://mc.guji.uno/api/yggdrasil/sessionserver/session/minecraft/profile/{uuid}?unsigned=false
```

要求：

- `{uuid}` 使用无横杠 UUID，和 Minecraft session profile 一致。
- 必须传 `unsigned=false`，否则可能没有 `signature`。
- HTTP `404` 表示该 UUID 没有绑定皮肤站，直接回退 Mojang 官方皮肤。

响应示例：

```json
{
  "id": "069a79f444e94726a5befca90e38aaf5",
  "name": "Notch",
  "properties": [
    {
      "name": "textures",
      "value": "base64-json",
      "signature": "base64-rsa-signature"
    }
  ]
}
```

`value` 解码后格式：

```json
{
  "timestamp": 1780000000000,
  "profileId": "069a79f444e94726a5befca90e38aaf5",
  "profileName": "Notch",
  "textures": {
    "SKIN": {
      "url": "https://mc.guji.uno/api/yggdrasil/textures/<hash>",
      "metadata": {
        "model": "slim"
      }
    },
    "CAPE": {
      "url": "https://mc.guji.uno/api/yggdrasil/textures/<hash>"
    }
  }
}
```

## 验签要求

必须对 `textures` property 做签名校验。

服务端签名算法：

```text
SHA1withRSA
```

也就是：

- RSA PKCS#1 v1.5。
- SHA-1 digest。
- 签名内容是原始 `value` 字符串的 UTF-8 bytes。
- `signature` 是 base64。
- 公钥来自 metadata 的 `signaturePublickey`。

Java 验签伪代码：

```java
Signature verifier = Signature.getInstance("SHA1withRSA");
verifier.initVerify(publicKey);
verifier.update(value.getBytes(StandardCharsets.UTF_8));
boolean ok = verifier.verify(Base64.getDecoder().decode(signature));
```

验签失败时不要使用该材质，直接回退 Mojang 官方皮肤。

## 材质 URL 校验

Mod 不能下载任意 URL。

下载前必须校验：

- URL scheme 必须是 `https`。
- host 必须匹配 metadata `skinDomains`。
- 精确域名规则：`mc.guji.uno` 只匹配 `mc.guji.uno`。
- 点前缀规则：`.minecraft.net` 匹配 `textures.minecraft.net` 等子域。
- 拒绝 IP、空 host、非 http/https、重定向到非白名单域名。

下载参数：

- 连接超时：`3s`。
- 响应读取超时：`5s`。
- 单个 PNG 最大体积：建议 `4 MiB`。
- 只接受 `image/png`，如果服务端没有返回 content type，可在读取 PNG header 后兜底判断。

## 匹配策略

Mod 以 UUID 为主键。

处理顺序：

1. 客户端原版/Mojang skin provider 先正常工作。
2. Mod 异步请求本站 profile。
3. 如果本站返回有效并验签通过的 textures，就覆盖客户端 skin/cape。
4. 如果本站返回 404、无 textures、签名失败、URL 不合法或下载失败，保留原版/Mojang 结果。

这样可以同时覆盖：

- 正版直登玩家。
- 使用皮肤站 Yggdrasil 登录的玩家。
- 服务器在线模式下的其他正版玩家。

未绑定皮肤站的正版玩家不会被接管，仍显示 Mojang 官方皮肤。

## 客户端缓存

缓存目录：

```text
.minecraft/asteryggdrasil-skins/
  config.json
  metadata.json
  profiles/
    <uuid>.json
  textures/
    <sha256-or-urlhash>.png
```

缓存策略：

- metadata 缓存 `1h`。
- profile 响应缓存 `5min`。
- PNG 材质按 URL hash 长缓存，建议 `30d` 或直到 URL 变化。
- 查询和下载必须异步执行，禁止阻塞渲染线程和主客户端线程。
- 同一个 UUID 的并发查询需要合并，避免玩家列表刷新时重复请求。
- 服务器断线或切换世界不需要立即清空缓存。

建议缓存 key：

```text
profile: <baseUrl>|<uuid>
texture: sha256(<textureUrl>)
skin render key: <uuid>|<textureUrl>|<model>
```

## 配置项

配置文件建议：

```json
{
  "enabled": true,
  "baseUrl": "https://mc.guji.uno/api/yggdrasil",
  "verifySignature": true,
  "fallbackToMojang": true,
  "profileCacheSeconds": 300,
  "metadataCacheSeconds": 3600,
  "requestTimeoutMillis": 3000,
  "downloadTimeoutMillis": 5000,
  "maxTextureBytes": 4194304,
  "debugLogging": false
}
```

整合包可以预置该配置，普通玩家只需要安装 Mod。

正式版不建议允许玩家关闭 `verifySignature`。如果为了调试保留开关，默认必须是 `true`。

## Fabric 实现结构

建议拆成平台无关 core 和 Fabric adapter：

```text
mod/
  common/
    AsterSkinConfig.java
    AsterSkinClient.java
    AsterYggdrasilClient.java
    MetadataCache.java
    ProfileCache.java
    TextureCache.java
    TexturesPropertyVerifier.java
    SkinOverrideResult.java
    SkinDomainMatcher.java
  fabric/
    AsterSkinMod.java
    FabricSkinOverrideBridge.java
    mixin/
      PlayerSkinProviderMixin.java
      PlayerListEntryMixin.java
```

核心职责：

- `AsterYggdrasilClient`: HTTP 请求 metadata/profile/texture。
- `TexturesPropertyVerifier`: RSA 验签和 base64 解析。
- `SkinDomainMatcher`: `skinDomains` 域名匹配。
- `TextureCache`: PNG 下载、保存、读取、过期清理。
- `SkinOverrideResult`: 返回 skin URL、本地 texture identifier、model、cape。
- `FabricSkinOverrideBridge`: 把 core 结果接到 Minecraft 客户端皮肤系统。

## Fabric 接入点

具体 Mixin 目标随 Minecraft/Yarn 版本变化，开发者必须按目标版本确认 mappings。

首选思路：

- 包装或拦截客户端玩家皮肤提供器。
- 在原版 Mojang skin provider 返回后，异步查询本站材质。
- 查询成功后注册本地 PNG 为客户端 texture。
- 刷新对应玩家的 skin/cape 渲染结果。

常见候选点：

- `net.minecraft.client.texture.PlayerSkinProvider`
- `net.minecraft.client.network.PlayerListEntry`
- `net.minecraft.client.render.entity.PlayerEntityRenderer`

不建议直接改网络登录流程，也不要改服务端验证包。
Mod 只处理本地显示。

## 皮肤模型

`textures.SKIN.metadata.model == "slim"` 时使用 slim 模型。

否则使用 default 模型。

如果只有 cape，没有 skin：

- skin 保持 Mojang 官方结果。
- cape 使用本站 cape。

如果只有 skin，没有 cape：

- skin 使用本站 skin。
- cape 保持 Mojang 官方结果或为空。

## 失败处理

这些情况必须回退 Mojang 官方皮肤：

- 配置关闭。
- baseUrl 不合法。
- metadata 请求失败。
- metadata 没有公钥。
- profile 返回 404。
- profile 无 `textures` property。
- property 签名无效。
- value 不是合法 base64 JSON。
- profileId 与请求 UUID 不一致。
- 材质 URL 不在 `skinDomains`。
- 材质下载失败或 PNG 无效。

失败日志：

- 默认只打印 debug 级别。
- 不要在聊天框刷屏。
- 可以提供 `/asterskin reload` 或配置界面后续再做。

## 与服务端现有逻辑的关系

站点侧已经提供这些能力：

- Microsoft 绑定档案使用正版 UUID 和正版玩家名。
- Microsoft 绑定档案不能重命名、不能删除。
- Microsoft 绑定档案可以使用本站 wardrobe 材质。
- 绑定时同步 Mojang 官方材质到 wardrobe。
- 角色档案可在 `正版同步` 和 `皮肤站自定义` 间切换。
- Yggdrasil profile endpoint 返回当前档案正在使用的材质。

Mod 不需要知道材质是 `mojang` 还是 `local` 来源。
它只读取 profile 当前的 `textures` property。

## 开发任务拆分

第一阶段：协议和缓存

1. 读取配置。
2. 请求 metadata。
3. 实现 `skinDomains` 匹配。
4. 实现 `SHA1withRSA` 验签。
5. 请求 profile 并解析 textures。
6. 下载 PNG 并写入缓存。

第二阶段：Fabric 接入

1. 找到目标版本皮肤加载链路。
2. 接入异步查询。
3. 注册本地 PNG texture。
4. 覆盖 skin/cape/model。
5. 保留 Mojang fallback。

第三阶段：体验和稳定性

1. 合并并发请求。
2. 增加缓存过期清理。
3. 增加 debug 日志。
4. 增加配置 reload。
5. 做多人测试和弱网测试。

## 验收标准

至少覆盖这些场景：

1. 正版玩家未绑定皮肤站：显示 Mojang 官方皮肤。
2. 正版玩家已绑定皮肤站，当前选择 `正版同步`：显示同步到皮肤站的正版材质。
3. 正版玩家已绑定皮肤站，当前选择 `皮肤站自定义`：正版直登也显示皮肤站自定义材质。
4. 皮肤站登录玩家：显示皮肤站当前材质。
5. 其他安装 Mod 的玩家能看到上述材质。
6. 未安装 Mod 的正版客户端仍只看到 Mojang 官方皮肤。
7. 断网或 mc.guji.uno 不可达时，不影响进服，回退 Mojang 官方皮肤。
8. 篡改 `textures.value` 或 `signature` 后，Mod 拒绝使用材质。
9. 材质 URL 改成非白名单域名后，Mod 拒绝下载。
10. 同一服务器在线 30 分钟没有明显内存增长或重复下载风暴。

## 后续版本

第二版可以考虑：

- NeoForge/Forge 适配。
- 游戏内配置界面。
- 手动刷新按钮。
- 管理员预置多服务器 baseUrl。
- 皮肤下载统计或诊断页面。
- 服务端专用轻量查询接口，但首版不需要。
