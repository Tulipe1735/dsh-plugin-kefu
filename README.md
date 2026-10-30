# dsh-plugin-kefu

**电商客服台 for DeepSeek Harness** —— 先把店里的商品学一遍，再按商品资料回答买家；答不准就交给人，绝不编造。

**AI 只负责措辞，事实来自你的商品资料。** 回复由 DSH 的模型生成，但模型只能复述插件给出的证据：出现证据里没有的数字、或碰到平台红线，整条回复直接丢弃并回退到模板。

```text
买家消息 ──▶ 检索商品（有依据吗？）──▶ 够：交给 DSH 模型写 ──▶ 敏感词/红线/数字校验 ──▶ 发出
                    │
                    └── 不够 / 命中转人工规则 ──▶ 待处理队列（附证据，人工一键采纳）
```

---

## 为什么是这个形态（而不是接管千牛/京麦客户端）

这是这个仓库最重要的一节。桌面客户端抓取、内存钩子、模拟点击这条路，**做不成一个可以公开分发的插件**：

| 平台 | 事实 | 来源 |
| --- | --- | --- |
| 千牛 / 淘宝天猫 | 官方聊天消息服务是**邀约制**，需「旺旺聊天记录」权限，仅聚石塔内网 MQ，按条计费；且人工消息的 `chatContent` 被**脱敏成关键词数组**，拿不到对话原文 | [旺旺聊天消息服务文档](https://open.taobao.com/doc.htm?docId=120374&docType=1) |
| 千牛应用审核 | 《千牛应用审核规范》明确：**使用非开放平台/千牛官方授权的 API 不予通过**，UI 抓取过不了审 | [审核规范](https://developer.alibaba.com/docs/doc.htm?treeId=775&articleId=118880&docType=1) |
| 京麦 / 京东咚咚 | 京麦 JSSDK 只有 `openDD` / `openDDChatByScene` 这类**唤起**能力，不能读也不能代发；JOS 的咚咚客服外接接口属特殊申请 | [JSSDK](https://jmw.jd.com/docs/jssdk/jssdk-pc2.0/api.html) · [咚咚客服接口](https://opendoc.jd.com/iopv2/iopv2/%E7%89%B9%E6%AE%8A%E7%94%B3%E8%AF%B7%E6%8E%A5%E5%8F%A3/%E5%92%9A%E5%92%9A%E5%AE%A2%E6%9C%8D.html) |
| 开源同类 | ChatGPT-On-CS（4.5k★，AGPL）、dify-on-qianniu（MIT）、automation9417/qianniu（无 license）**全部是桌面 UI 自动化**，非官方，且协议随客户端版本失效 | 见各仓库 |

所以本插件只做三件能长期活下去的事：

1. **官方开放平台通道**（淘宝 TOP / 京东 JOS）：真发真收，需要你自己开通接口权限；
2. **本地桥接（Local Bridge）**：你自己有采集端就把消息推进来，插件负责大脑和回复队列；
3. **人工一键采纳**：官方接口没配齐时，插件**不假装发送**，把草稿交给客服在客户端里发。

它不包含、也不会加入 DLL 注入、私聊协议逆向、模拟点击的代码。

---

## 为什么它不会瞎答

四道闸门，任何一道不过就不自动发：

1. **检索**：中文二元组分词（过滤「这个/多少钱/什么时候」这类问句词）+ 字段权重 + IDF，返回命中的具体字段（价格表 / 参数表 / 发货 / 售后）与 0–1 匹配度；
2. **字段完备**：问发货就必须有 `shipping` 字段，问尺码就必须有规格表，缺了就转人工（`no_evidence`）；一句话里问了两件事（「多少钱，什么时候发货」）会**两件一起答**，只要有一件没依据就整体转人工，不做半截回答；
3. **模型输出复检**：回复里的每个 ≥2 位数字都必须能在证据里找到，否则丢弃；命中商家敏感词或平台红线（诱导站外私聊、私下转账、泄露手机号）同样丢弃并回退模板；
4. **模型说不确定也不算答**：模型输出「这个我需要确认一下」这类话时，绝不当作最终回复发出去，而是连同这句话一起转人工——否则买家会以为有人在跟；
5. **去重与转人工规则**：同一句话不对同一买家重复发；买家发图、改地址、订单备注、触发词、非接待时段、匹配度不足，全部进待处理队列。

---

## 安装

在 DSH 里任选一种：

```text
# 插件市场（发布后）
插件市场 → 搜索 dsh-plugin-kefu → 安装

# 本地开发（link 方式，改代码即时生效）
插件管理 → 安装 → link:C:\path\to\dsh-plugin-kefu
```

装好后侧边栏出现 **客服** 面板，对话里也多出 5 个工具。

---

## 四个通道

| 通道 | 类型 | 说明 |
| --- | --- | --- |
| `qianniu` | 官方 | 淘宝开放平台网关。推送地址 `/plugins/dsh-plugin-kefu/channels/qianniu/push`，回复走你开通的 `sendMethod` |
| `jingmai` | 官方 | 京东 JOS `routerjson` 网关。推送地址 `.../channels/jingmai/push`，回复走 `sendMethod` |
| `bridge` | 桥接 | 你自建采集端：`POST .../channels/bridge/push` 推入，`GET .../channels/bridge/pull?after=<cursor>` 拉取回复，`POST .../channels/bridge/ack` 确认 |
| `webhook` | 通用 | 外部工具推入 + 插件把回复 `POST` 回 `outboundUrl`（带 `x-kefu-signature` HMAC-SHA256） |

所有推送都要 `x-kefu-token`（或 `?token=`），官方通道额外支持 `sign` 验签。

### Local Bridge 协议（最小实现，20 行）

```js
// 推一条买家消息
await fetch('http://127.0.0.1:54205/plugins/dsh-plugin-kefu/channels/bridge/push', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-kefu-token': TOKEN },
  body: JSON.stringify({ buyerId: 'u123', buyerName: '小王', text: '这个多少钱', images: [] }),
})

// 拉取要发出去的回复（cursor 从 0 开始）
const { items, cursor } = await (await fetch(
  `http://127.0.0.1:54205/plugins/dsh-plugin-kefu/channels/bridge/pull?after=${last}&token=${TOKEN}`,
)).json()
for (const item of items) await sendToBuyer(item.buyerId, item.text)

// 确认已送达，避免重复发
await fetch('http://127.0.0.1:54205/plugins/dsh-plugin-kefu/channels/bridge/ack', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-kefu-token': TOKEN },
  body: JSON.stringify({ ids: items.map((item) => item.id) }),
})
```

---

## 工具（对话里直接用）

| 工具 | 作用 |
| --- | --- |
| `kefu_import_products` | 从 CSV / TSV / JSON / Markdown 表格导入商品；重复导入按商品更新 |
| `kefu_search_products` | 检索商品，返回命中字段、证据、匹配度 |
| `kefu_draft_reply` | 跑一遍决策但**不发**：给出 action / 转人工原因 / 依据 / 草稿 |
| `kefu_send_reply` | 发送（先过敏感词与红线；官方通道没配齐则进入待采纳） |
| `kefu_queue` | 看待处理队列：谁在等、为什么等 |

对话示例：

> 把 `products.csv` 导进客服知识库，然后看看「纯棉短袖还有 M 码吗」会怎么回。

---

## 用 DSH 的模型写回复

设置 → **用 DSH 的模型写回复**：开启后调用 `ctx.llm`（`prepareCall` + 文本流），provider/model 选「自动」就用当前 profile 的第一个可用路由。

- **模型只拿得到证据**，系统提示明确禁止补充证据之外的任何承诺与数字；
- **输出要复检**（数字、敏感词、红线、长度），不合格自动回退模板；
- **没有 llm 服务**（headless profile）或模型报错时，插件仍然可用，只走模板；
- 时延与费用：每条需要模型回复的消息会多一次约 400 token 的调用，模型超时默认 20s，可在设置里改。

---

## 7×24 守护进程（bot 模式）

面板是人坐的工位；`daemon/` 是守在后台的 bot。它不依赖 DSH、不需要人点，直连 DeepSeek API，把同一套检索/决策/复检逻辑跑成一个常驻 HTTP 服务：

```powershell
$env:KEFU_TOKEN = "随机串"; $env:DEEPSEEK_API_KEY = "sk-..."; $env:KEFU_MODE = "auto"
node daemon/server.js
```

任何采集端只要会说三个接口（`/push`、`/pull`、`/ack`）就能把消息喂进来、把回复取走。详见 [daemon/README.md](daemon/README.md)。

> 同一份数据目录**不要**让面板和守护进程同时写：存储是整份 JSON 落盘，会互相覆盖。常驻时以守护进程为准。

---

## 商品表格式

支持 `.csv` / `.tsv` / `.json` / Markdown 表格。表头中英文都认：

```csv
标题,价格,规格,参数,发货,售后,关键词
重磅纯棉短袖 T 恤,¥129,S/129/12；M/129/8,材质:100% 纯棉;克重:230g,48 小时内发出,7 天无理由退换,夏季
```

- `规格`：一件商品多个规格用 `；` 分隔，每个规格的 `名称/价格/库存` 用 `/` 分隔
- `参数`：用 `:` 或 `=` 分隔，多组用 `；` 分隔
- 没有 `id` 时按标题生成，重复导入即更新

---

## 开发

```powershell
node --test tests/*.test.mjs   # 55 个测试：检索 / 决策 / 导入 / 模型复检 / 网关签名 / HTTP 桥 / 同源 / 面板注册
```

```text
index.js              Host：工具 + HTTP 桥 + 入站流水线 + 投递
lib/kb.js             商品卡、分词、检索、意图、字段提取
lib/ingest.js         CSV/TSV/JSON/Markdown 解析与合并
lib/reply.js          转人工预检、敏感词/红线、决策、模板、去重、分段
lib/composer.js       DSH 模型改写 + 输出复检
lib/channels/*        千牛 / 京麦 / bridge / webhook 适配器
client.js             侧边栏面板（无构建步骤）
```

---

## 发布（维护者）

```powershell
npm pack --dry-run        # 检查包内容
npm login                 # 需要一个已登录的 npm 账号
npm publish               # 包名 dsh-plugin-kefu（当前 npm 上未被占用）
git remote add origin git@github.com:<you>/dsh-plugin-kefu.git
git push -u origin main
```

社区插件市场（dshmarket）**不抓 npm**：它每次打开只读精选列表 `https://awesome-dsh-plugin.com/plugins.json`，条目来自 `awesome-dsh-plugin/awesome-dsh-plugin` 仓库的 `data/plugins/*.yml`。所以发布 npm 只让「按名字安装」可用，要出现在市场里，还得往那份精选列表提一个 PR（要求：`dsh.bundle` manifest、真实代码、仓库满 1 天、仓库带 `dsh-plugin` topic）。

## 数据与备份

全部数据在 `~/.dsh/kefu/`（`DSH_HOME` 存在时取它）：`config.json`（0600，含平台凭证）、`kb/products.json`、`conversations.json`、`outbox.json`。备份就是复制这个目录。

设置页底部的 **数据** 卡片可以清空：

- **清空会话队列**：清掉会话、消息与发件箱，商品目录保留（换班次常用）；
- **清空全部（含商品）**：连商品目录一起清（换店铺时用）。

也可以直接调接口 `POST /plugins/dsh-plugin-kefu/api/reset`，body `{"catalog": true}` 才会连商品一起清。

## 已知限制

- **千牛**：官方会话消息是邀约制且内容被脱敏，普通商家拿不到对话原文；本插件的千牛通道面向已获批的消息服务与自建推送。
- **京麦**：商家侧没有公开的咚咚会话消息 API，通常只能配合人工采纳或桥接。
- **桥接**：采集端由你自建。用第三方 UI 自动化项目采集时，请自行评估其许可（例如 AGPL）与平台条款。
- 知识库是纯本地的 JSON，没有向量检索；商品量级在几千条以内体验最好。

## 许可

MIT。与「闪回 / shanhui.org」无关联，未使用其任何代码或素材；本项目是按公开事实重新实现的电商客服台。

## 它解决什么

电商客服的真实矛盾不是「AI 不会说话」，而是**说错话的成本**：答错价格、承诺了没有的售后、答应改地址没改。所以这个插件把 AI 的手脚捆在商品资料上，把不确定的部分交还给人——这也是 DSH 里最该由人来兜底的那部分。
