# dsh-channel-credits

输入框下方统计栏常驻显示渠道积分余额；每轮对话结束后在回合尾部回填本轮积分消耗。

数据全部来自 `dsh-our-free-model` 已注册的 `channel-pack` RPC 服务（`usage.badge` /
`provider.status`），不请求任何外部接口，不读凭据文件。

## 两个挂载点

| 槽位 | 位置 | 内容 |
| --- | --- | --- |
| `conversation.composer.dock` | 输入框卡片下方统计栏（`⊙ 上下文环` 右侧） | `剩余 9,034 积分`，点击强刷 |
| `conversation.chat.turnTail` | 每轮回答末尾的动作行之前 | `本轮 −0.31 积分` |

统计栏条目靠 CSS `order:1` 排到 `activity` / `usage` / `ContextMeter` 之后 —— 那三个
原生条目都没有 `order`（默认 0），所以本插件是这行的最后一个 flex item。

## 数据口径

- **剩余积分**：宿主 `usage.badge` 返回的 `balance.total` 按 provider 求和。只对
  `provider.status` 里 `accounts.total > 0` 的 provider 取数（宿主是逐账号顺序打上游的，
  盲目全量轮询会触发风控）。
- **本轮消耗**：宿主和上游都没有任何单次消耗字段，因此用**余额差量**实测：回合刚结束时
  强刷一次作为基线，再在 70s / 120s / 180s 采样，取到回落就结算。上游扣账延迟实测
  60~100 秒，所以回合结束时读到的必然还是旧值 —— 这也是必须异步回填的原因。
- 结算结果写 `localStorage`（键 `dcc:v1:turn:<sessionId>:<turn>`），刷新页面不重算。
- 同一会话只允许最新一轮认领差量；0 值也记账，避免重复结算。

## 依赖的真实接口

```js
connection.rpc.call('/api', 'channel-pack', { method, payload }, signal)
```

- `usage.badge { provider, force }` → `{ accounts: [{ accountId, nickname, balance: { total, packages } }], windowDays }`
- `provider.status { providers }` → `{ statuses: { <p>: { accounts: { total, enabled }, closed } } }`

宿主的徽标缓存 TTL 是 120 秒，插件轮询周期也是 120 秒，`force:true` 只在点击和结算采样时用。

## 依赖风险（重要）

本插件读的是 **`dsh-our-free-model` 注册的私有 RPC 服务 `channel-pack`**，不是 DSH
官方稳定 API。`dsh-our-free-model` 默认开启热更新（`autoReloadWatch`），上游一旦调整
`usage.badge` / `provider.status` 的方法名、参数或返回结构，插件会静默失效（界面不报错，
只是不显示）。

同理，`dsh-channel-credits` 只适用于**装了 `dsh-our-free-model` 并配置了至少一个渠道账号**
的 DSH 桌面端；没有该插件时 `connection.rpc` 找不到 `channel-pack` 服务，本插件不渲染任何内容。

与 [`dsh-ofm-balance`](https://github.com/Shen-18/dsh-ofm-balance) 的区别：那个在**侧边栏**
列各渠道额度、只做余额展示；本插件在**输入框统计栏**常驻余额，并且对**每一轮对话**回填
积分消耗与具体扣款账号（`本轮 −3.91 积分 · ACAI`）。

## 已知限制

- 单位混用：`cline` 是美元、`zcode` 是 token、`gemini` 是额度，其余按「积分」显示。
  多 provider 合计时只累加同单位条目。
- 凭据缺失的账号（如 `qodercn`）返回 `balance: null` + `error: '凭据未配置'`，界面上
  显示为「不可用」，不计入合计。
- 一个回合里如果切换过 provider，差量会算到当前 provider 的合计上。

## 装配

profile 的 `package.json`（`$DSH_HOME/profiles/<name>/package.json`）：

- `dependencies` 加 `"dsh-channel-credits": "file:/absolute/path/to/dsh-channel-credits"`
  （或直接 `dsh plugin add`）
- `dsh.profile.bundles` 末尾追加 `"dsh-channel-credits"`

包内 `cordis.patch.yml` 插入一行 `channel-credits`，客户端半边由 `dsh.client.platform: web` 声明。
**改动需要重启 DSH 桌面端才生效**（cordis 树只在启动时构建）。
