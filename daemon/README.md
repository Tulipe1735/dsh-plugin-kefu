# kefu-daemon — 独立守护进程（真 7×24）

DSH 面板是**人坐的工位**；这个守护进程是**守在后台的 bot**。它不依赖 DSH：`lib/` 整套（检索、决策、复检、存储）原样复用，只把「模型」换成直连 DeepSeek API，「界面」换成 HTTP。

```
采集端（你自建：千牛/京麦消息源）
   │  POST /push            ↑  GET /pull  ·  POST /ack
   ▼                        │
kefu-daemon  ── 知识库 / 决策 / 模型改话术 / 复检 / 去重 / 转人工
```

## 启动

```powershell
$env:KEFU_TOKEN         = "换成你自己的随机串"      # 必填，所有接口都要它
$env:DEEPSEEK_API_KEY   = "sk-..."                  # 不填则只走确定性模板
$env:KEFU_MODE          = "auto"                    # auto = 真自动回复；copilot = 进待处理队列
$env:KEFU_PORT          = "17802"
node daemon/server.js
```

`KEFU_HOME` 不填时用 `~/.dsh`，也就是**和 DSH 面板同一份数据**。

> ⚠️ **不要同时跑**守护进程和 DSH 面板并让两边都写。存储是整份 JSON 落盘，两个进程会互相覆盖。
> 常驻时以守护进程为准（用它的 HTTP 接口管理），面板只在守护进程停掉时用；或者给守护进程单独的 `KEFU_HOME`，两边各管各的。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 存活检查（**不需要** token） |
| GET | `/status` | 商品数、队列统计、脱敏后的配置 |
| GET/POST | `/config` | 读 / 改配置（`mode`、转人工规则、敏感词、话术） |
| POST | `/push` | 推入一条买家消息：`{ buyerId, text, images?, buyerName?, messageId? }` |
| GET | `/pull?after=<cursor>` | 拉取待发送的回复 |
| POST | `/ack` | `{ ids: [...] }` 确认已送达，避免重复发 |
| GET | `/queue?status=pending` | 待人工队列 |
| POST | `/queue/<id>/reply` | `{ text }` 人工回复，同样进发件箱 |
| POST | `/queue/<id>/status` | `{ status }` 标记 bot/pending/human/closed |
| GET | `/products` · POST `/products/import` · POST `/products/delete` | 商品目录 |
| POST | `/reset` | `{ catalog: false }` 清队列；`true` 连商品一起清 |

除 `/health` 外都要 `x-kefu-token` 头（或 `?token=`），token 不对一律 401。

## 常驻

**Windows（任务计划程序，开机自启）**

```powershell
schtasks /Create /TN "kefu-daemon" /SC ONSTART /RU $env:USERNAME /RL HIGHEST `
  /TR "powershell -NoProfile -WindowStyle Hidden -Command \"`$env:KEFU_TOKEN='...';`$env:DEEPSEEK_API_KEY='...';`$env:KEFU_MODE='auto'; cd 'C:\path\to\dsh-plugin-kefu'; node daemon/server.js\""
```

也可以用 [nssm](https://nssm.cc/) 装成服务，崩溃自动拉起。

**Linux / systemd**

```ini
[Unit]
Description=kefu-daemon
After=network-online.target

[Service]
WorkingDirectory=/opt/dsh-plugin-kefu
Environment=KEFU_TOKEN=... DEEPSEEK_API_KEY=... KEFU_MODE=auto
ExecStart=/usr/bin/node daemon/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## 一个最小采集端

```python
import requests, time
B = "http://127.0.0.1:17802"
H = {"x-kefu-token": "换成你自己的随机串"}
cursor = 0

while True:
    # 1) 把新买家消息推给大脑
    requests.post(f"{B}/push", headers=H, json={
        "buyerId": "buyer-123", "buyerName": "小王", "text": 读到的消息,
    })

    # 2) 把大脑写好的回复发出去
    r = requests.get(f"{B}/pull", headers=H, params={"after": cursor}).json()
    for item in r["items"]:
        send_to_client(item["buyerId"], item["text"])
    if r["items"]:
        cursor = r["cursor"]
        requests.post(f"{B}/ack", headers=H, json={"ids": [i["id"] for i in r["items"]]})

    time.sleep(1)
```

`读到的消息` / `send_to_client` 这一段就是采集端，取决于你用哪种方式接千牛/京麦——那部分不在本仓库里（原因见根目录 README）。

## 它保证什么

- **只按证据回答**：字段缺失就 `escalate`，不进发件箱；
- **模型说的数必须来自证据**，否则丢弃回退模板；
- **同一条消息只答一次**（`messageId` 去重，webhook 重试安全）；
- **回复先进发件箱**，采集端 `ack` 之后才算送达，进程崩了回复不丢。
