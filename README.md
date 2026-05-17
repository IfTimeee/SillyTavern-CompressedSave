# SillyTavern Compressed Save

> 纯前端扩展：拦截大体积 POST 请求，自动 gzip 压缩请求体。
> 专治跨境云酒馆「保存 18MB 卡 50 秒」。
>
> by 莓可莉丝（meikorisu）for iftime ฅ^•ﻌ•^ฅ
>
> v1.1.0 | MIT

---

## 背景

SillyTavern 默认每次保存聊天时，都会把**整个聊天的完整 JSON** 通过 POST 发给后端。

聊天记录本质上是大量重复结构的纯文本（角色名、消息模板、HTML 标签、CSS 类名等），对 gzip 极为友好。但 SillyTavern 的前端并不会自动压缩请求体——于是当聊天累计到十几 MB 后，每次保存都要把十几 MB 原始 JSON 从国内上传到美国的 VPS。

典型场景：
- 跨境 VPS（香港/日本/美国）
- 国内家庭宽带上行普遍只有 2~5 Mbps
- 每发一条消息触发两次保存（发送前 + 生成后）
- 一次 18MB 的上传耗时约 50 秒，两次就是 100 秒

结果就是"发一句话卡两分钟"。

---

## 这个扩展做什么

1. **Hook `window.fetch`**：拦截 SillyTavern 发出的所有网络请求
2. **匹配目标请求**：只对 `/api/chats/save` 和 `/api/chats/group/save` 这类保存接口生效
3. **gzip 压缩请求体**：使用浏览器原生 `CompressionStream('gzip')` 即时压缩
4. **附加请求头**：设置 `Content-Encoding: gzip`，移除旧 `Content-Length`
5. **后端零改动**：Express 的 `body-parser` 默认 `inflate: true`，会自动解压，服务端完全无感知

整个流程对 SillyTavern 前端透明，上层代码不知道请求被压缩过。

---

## 效果

聊天 JSON 的 gzip 压缩比一般在 **8~12 倍**：

| 指标 | 启用前 | 启用后 |
|---|---|---|
| 上传体积 | 18 MB | ~2 MB |
| 上行 3 Mbps 上传耗时 | ~50 秒 | ~5 秒 |
| 每轮对话保存（两次） | ~100 秒 | ~10 秒 |
| 累计上行流量 | 36 MB / 消息 | ~4 MB / 消息 |

---

## 安装
### 方法一

酒馆直接安装:
 - 在SillyTavern中打开扩展管理器
 - 点击“安装扩展”
 - 输入地址：https://github.com/IfTimeee/SillyTavern-CompressedSave.git
 - 选择“仅为当前用户安装”或为“所有用户安装”

### 方法二
把整个文件夹放到 SillyTavern 的扩展目录中（二选一）：

**全局安装**（所有用户可见）：
```
SillyTavern/public/scripts/extensions/third-party/CompressedSave/
```

**用户级安装**（仅当前用户可见）：
```
SillyTavern/data/<your-user-handle>/extensions/CompressedSave/
```

安装后刷新 SillyTavern，打开「扩展面板」即可看到 **🐈 Compressed Save (猫猫加速喵~)**。


---

## 设置项

| 设置 | 默认值 | 说明 |
|---|---|---|
| 启用压缩 | ✅ 开 | 总开关 |
| 控制台日志 | ❌ 关 | 开启后在 F12 控制台打印每次压缩的详情 |
| 最小压缩阈值 | 4096 字节 | 小于此值的请求体不压缩（小请求压缩反而浪费 CPU） |
| 拦截路径 | `/api/chats/save`、`/api/chats/group/save` | 一行一个，支持路径子串匹配。可自行添加其他需要压缩的 API |

---

## 面板功能

扩展面板在 SillyTavern 扩展设置页内，展开后提供完整的可视化诊断，**无需开 F12**：

- **状态徽章**：绿色「已启用」/ 红色「已禁用」
- **统计卡片**：
  - 已压缩 / 跳过 / 失败次数
  - 最近一次压缩比
  - 累计上行流量节省（原始体积 → 压缩体积 → 节省百分比）
- **实时日志表格**：最近 30 条记录，包含时间、状态、路径、原始大小、压缩后大小、压缩比、gzip 耗时、总耗时
- **⚡ 测试压缩**：本地跑一次 1MB 假数据自检，验证 `CompressionStream` 可用性
- **📋 复制诊断**：将所有配置和统计打包为 JSON 复制到剪贴板，方便排查
- **🧹 清空统计**：重置所有计数器和日志

---

## 控制台 API

有调试需求时，可在 F12 控制台直接操作：

```js
CompressedSave.settings   // 查看当前配置
CompressedSave.stats      // 查看运行统计
CompressedSave.reset()    // 重置所有统计
```

---

## 兼容性

### 浏览器

需要原生支持 `CompressionStream` API：

| 浏览器 | 最低版本 |
|---|---|
| Chrome / Edge | 80+ |
| Firefox | 113+ |
| Safari | 16.4+ |

不支持时会自动跳过压缩（日志标记为 `skip`），不会报错。

### SillyTavern 后端

- Express `body-parser` 默认 `inflate: true`，开箱即用
- 如果后端配置了额外的反向代理（Nginx、Caddy 等），需确保代理不会对 `Content-Encoding: gzip` 的请求体的 Content-Length 做校验（通常不会）

### 出错绝不丢数据

即使压缩过程出现任何异常，扩展会**捕获错误并回退到原始未压缩请求**。设计哲学是：宁可多卡 50 秒，也绝不让保存失败。

---

## 技术原理

### 拦截时机

```
SillyTavern 调用 fetch()
        │
        ▼
patchedFetch() — 扩展的 hook
        │
        ├── 条件不满足 ──► 透传给原始 fetch()（无影响）
        │
        └── 条件满足 ──► gzip(body) ──► 原始 fetch(compressed_body)
                            │
                            ▼
                      Express body-parser 自动解压
                            │
                            ▼
                      SillyTavern 后端正常处理（无感知）
```

### gzip 为什么能压缩 8~12 倍

聊天 JSON 中存在大量重复字符串：
- 角色名（反复出现）
- `<div class="mes ...">` 等 HTML 结构
- CSS 类名 `mes_text`、`mes_block` 等
- JSON 键名 `name`、`mes`、`swipe_id` 等

gzip 的 LZ77 + Huffman 算法对这些重复模式极高效——字符越重复，比例越高。

### 小请求为什么跳过

低于 `minBytes`（默认 4KB）的请求不压缩。原因是：
- 极小的 payload 压缩后可能反而变大（gzip header 约 20 字节）
- 4KB 以下传输耗时已经很低，压缩节省的时间几乎为零

---

## 常见问题

**Q: 我从 Nginx 反代时开了 `gzip`，客户端还需要这个吗？**

Nginx 的 `gzip` 是压缩**响应体**（服务器→客户端），这个扩展压缩的是**请求体**（客户端→服务器）。两者方向不同，互不冲突。

**Q: 会影响非保存请求吗？**

不会。扩展只拦截 `targetPaths` 中列出的路径，且只处理 POST/PUT/PATCH，其他请求（聊天流、生成、配置读取等）全部透传。

**Q: 压缩会消耗多少 CPU？**

浏览器原生 `CompressionStream` 是底层 C++ 实现，不在 JS 主线程执行。1MB JSON 的 gzip 通常 <50ms，对前端无感知。

**Q: 我能压缩其他 API 吗？**

可以。在「拦截路径」中添加对应的路径关键字即可（如 `/api/settings/save`）。

---

## 许可证

MIT
