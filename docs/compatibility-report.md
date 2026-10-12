# 兼容性与发布验证报告

本报告回答一个问题：**在某个具体的 DSH 构建上，本仓的替换件到底改变了什么、没改变什么，以及这些结论是被什么证据支撑的。**
它的一半由人写（范围、边界、未完成项），另一半由证据生成（§5 的清单与能力矩阵，由 `node tools/settings-report.mjs --write` 从 `evidence/*-evidence.json` 渲染，标记块以外的内容不会被覆盖）。

安装、切换、重启、升级复核与终端兜底见 [release-guide.md](release-guide.md)。

## 1. 被验收的对象

| 项 | 值 |
| --- | --- |
| 上游包 | `@deepseek-ai/dsh@0.2.1-alpha.2` |
| 上游提交 | `d743267388641bc76f17c45ce8b4c231aed1d32c`（`github.com/deepseek-ai/deepseek-harness`） |
| 构建身份 | 16 个记录包、308 个文件、7649159 字节的 `sha256` 摘要 `bced54ff05f16443449162f00be33c2a0aea802d7f5046648262c0185942e321` |
| 许可与归属 | MIT，`Copyright (c) 2026 DeepSeek`；两个自有包各自带 `LICENSE`、`NOTICE`、`provenance.json` |
| 替换件 | `@dsh-local-overlay/dsh-client-ui-settings@0.1.0`（组件）+ `@dsh-local-overlay/web-composition@0.1.0`（组合层） |

版本号相同**不足以**证明构建相同：判定用的是构建身份摘要，加 `provenance.json` 里 18 个记录文件的逐文件 `sha256`
（其中 3 个是故意改动的，改动以完整 diff 记在 `expectedDiff` 里），再加两个被钉住的包清单。改动只有三处：
组件里那一行持久化选择（`isLoopback ? "host" : "memory"` → `"host"`）、组件模块自身的 id、组合层 `cordis.patch.yml` 里
`ui-settings` 那一行指向的包名。复现核验：`node tools/overlay.mjs preflight`（不改任何东西）。

## 2. 完整回归：每个区域被什么断言、证据在哪

下表里的"证据"都指 `evidence/overlay-evidence.json` 与 `evidence/control-evidence.json` 里同名的 `checks` 条目与截图。
两条跑用同一套断言：overlay 组装替换件，control 组装上游包，差异就是替换件的效果本身。

| 区域 | 断言的是什么（不是"跑过了"，而是"这些事实被两侧核对过"） |
| --- | --- |
| 构建身份与来源 | 预检通过；篡改哈希、重排 bundle-patch 清单、换版本、同版本但文件被改过、未改动副本——五种情形各自的接受/拒绝都逐条断言 |
| 组合替换生效 | `dsh.profile.bundles` 读回正是 `["@deepseek-ai/dsh-base","@dsh-local-overlay/web-composition"]`；所有已加载组合层里 `ui-settings` 提供者**恰好一行**且指向预期包；`window.__DSH_BOOT__` 里设置 provider 模块恰好一个 |
| 远程页面持久化 | 非 loopback 页面上点开关 → 页面自己发出的 `settings/mutate` 报文（按结构解析：`ns`/`ops`/`expectedRevision`）→ profile patch 里出现该行 → 刷新、重连、重启后仍是同一个值 |
| provider 与凭据 | 远程页面上按人操作的方式新建/编辑/删除 provider；三类畸形输入的**就地拒绝**（按钮禁用、profile 逐字节不变、改回后同一表单重新可保存）；另一个写入者抢先时的 revision 冲突（拒绝 + 不落盘）；凭据只显示"已配置"、页面文本里不出现任何测试密钥、`$DSH_HOME/.credentials.yaml` 字段级核对 |
| 插件配置（标准机制） | 真实 `npm pack` + `dsh plugin add` 装一个普通第三方包；它的表单注册在标准槽 `plugins.bundle.config`；读、写、校验拒绝、另一访问端写入、重启后读回 |
| 实例偏好 | 主题与语言两行：一次点击 = 一笔 `settings/mutate`（即时保存，没有 Save 按钮）；第二个访问端、重建文档、重启实例都读到同一个值；值在 profile patch 里 |
| 刷新与重连 | 用 CDP 把页面真的离线：离线期间页面既开不出新传输连接、它自己发的请求也确实失败；恢复后**同一文档、不刷新**多出一条新流连接并仍显示 Host 值；overlay 组还在恢复后的连接上写一次再写回来 |
| 认证与 fence（18 项） | 可信 Host 无 cookie 401、loopback 无 cookie 401、未知 Host 403、未知 Host **带已认证 cookie 仍 403**、可信 Host 带同一枚 cookie 404、cookie 重放到 loopback authority 401、单独 `Origin` / 单独 `Sec-Fetch-Site` / 两者同时各自 403（再带 cookie 仍 403）、对照请求 401、`/api/remote.mux` 三次升级尝试 403/401/101、文档带 token 303 无 token 401 |
| 不兼容拒绝 | 人为破坏已装产物 → 预检先拒绝（不切换）；运行期身份校验在 `apply()` 第一句就不放行；恢复产物后又正常 |
| 保留配置的终端回退 | 回退前用页面写一条普通配置（`session-log-deepseek`）+ 一条一次性测试凭据；回退后：配置行仍在、`ui-settings` 那条 override 的 `name` 回到上游包名而 `config` 原样保留、`bundles` 回到上游两个包、两个自有包仍然装着、凭据只回 `configured: true`、凭据文件权限仍是 `600`；重启后 patch 与回退后逐字节相同；远程页面上原限制回来了（刷新即回默认） |
| 全范围设置面（issue #7） | §5：面板**每一行**（两个来源各驱动一遍，不再有"同上"的格子）、部署自带的**每一个**插件配置页里**每一个可编辑字段**（同样两个来源各一遍，Web search 的凭据来源与端点字段除外——它们只做清单，理由写在 §5）、Agent presets 默认、以及实例服务的**每一个**设置命名空间，或被本轮经页面真实写入并两侧核对，或被列进显式缺口表并给出理由；面板必须把登记表里的行**都渲染**（按行块计数恰好一块）**且不得渲染登记表不认识的行**；「不是实例设置」的两行必须真的被点过（点完交互确实生效）才允许记为"不写实例"；本轮算出的"未写"集合与登记表不一致时直接失败。**不在场的东西也说清楚**：Models 页的 provider 编辑器与 Built-in plugins 页的行不在这个矩阵里（§5 末尾逐条写明） |

## 3. 标准第三方配置机制，以及它没有被扩张成"任意配置编辑"

- **只有一种机制**：第三方 bundle 在 `dsh.client` 里声明依赖，再把配置表单注册到标准槽 `plugins.bundle.config`（key 就是包名，字段 id 由包自己起）。验收里用一个只会 `dsh.client` + bundle patch 的普通包证明这条路可用。
- **部署自带的配置页用的是同一个槽**：插件管理页里的 Shell、Agent loop、Subagent、Web search 四页，写的是各自的 Host 命名空间（§5 的插件表逐页给出命名空间与实测写入）。
- **没有新增写入通道**：替换件没有引入 JSON 编辑器、没有"随便写哪个命名空间"的入口；可写面仍然是 Host 已有的、带 volatile schema 的 ConfigForms 命名空间，Host 端的 schema 存在性校验、逐路径 volatile 校验、revision 冲突处理、secret 脱敏一行未动。
- **原插件管理不回退**：第三方包的卡片仍能列出、打开、配置，另一访问端的写入仍能被另一侧读到（issue #5 的两组断言在两种模式下都跑）。

## 4. 明确的范围外项（本仓不做，也不假装做了）

| 范围外项 | 本仓的边界 |
| --- | --- |
| 主机配置编辑器入口 | 仍然只在 loopback 页面上出现；远程页面拿到的 `$host.isLoopback` 仍是真实的 `false`（替换件只改"用不用它选持久化"，不改它本身） |
| 账号登录与账号级设置 | 不改登录流程；`llm-deepseek-account`、`ui-settings-account` 这类账号级命名空间不在驱动范围内（§5 缺口表列出） |
| 多用户/多所有者授权 | 不做。本仓的全部结论建立在"所有已认证访问端属于同一所有者"这一单人假设上（ADR-0002），多人共用实例时这个放大不成立 |
| 统一的保存提示 | 不做。菜单类行即时写、插件表单草稿 + Save，两种语义并存，本仓没有把它们统一 |
| 原子事务 | 不做。一笔成功写入就是一笔 RPC，跨命名空间没有事务，也没有补偿 |
| 自动回滚 | 不做。写入被拒时页面就地报错，不会撤销之前成功的那一笔；要撤销一次已保存的设置只能再写一次（显式补偿写入），终端入口 `rollback` 只移除本仓改动的两处，**不动**已保存的设置与凭据（ADR-0001） |

<!-- settings-surface:begin -->
## 5. 全范围清单与能力矩阵

本节的每一格都来自验收跑 `tools/e2e-remote-settings.mjs` 在**原设置面板**上的一次真实点击（或一次「这一行不在这里」的测量），由本生成器从 `evidence/*-evidence.json` 读回；第一列就是页面自己的文案。生成方式：`node tools/settings-report.mjs --write`（不带 `--write` 只打印）。生成器是 fail-closed 的：某个格子在证据里缺记录、写入没有真的落到实例（值不符或 revision 没动）、某一次跑有 FAIL 或 harness 异常、两个模式在 loopback 来源上的行为不一致——任一情况它都会打印问题并以退出码 1 结束，不会渲染一份跑得比证据更多的报告。

- overlay 模式：383 项检查全部通过（失败 0 项）
- control 模式：185 项检查全部通过（失败 0 项）
- 构建身份与来源：provenance verification PASSED: 18 recorded files (3 deliberately modified, 15 byte-identical), 2 pinned package manifests and the build identity bced54ff05f16443... (308 files) match the installed baseline @deepseek-ai/dsh@0.2.1-alpha.2
- 非 loopback 页面上的设置列表：overlay 共 16 条文本，其中 11 行是登记表里的设置项、5 条是面板自身的控件（导航、关闭、行内控件，以及它自己那句「设置在此不可用」）；control 共 14 条，9 行设置项（Language、Appearance、Font size、Work details、When to Collapse Work Details、Show coding view、Keyboard shortcuts、Send behavior while busy、Performance & usage）、5 条面板自身控件——原组合的远程页面读不到 Host 的设置，所以它能渲染的行更少。
- 面板上每一行的渲染块数（不是去重后的文本条数）：overlay 在非 loopback 与本机各 11 行都恰好 1 块；control 非 loopback 上它真正渲染的 9 行各 1 块、其余 2 行 0 块，本机 11 行各 1 块；

「本机（loopback）」= 浏览器 origin 与 Host 头都是 loopback（TCP 也都连本机）；「远程（非 loopback）」= origin 与 Host 头是非 loopback 的可信主机名，TCP 仍连本机。两者都跑在**隔离的临时 home 与临时 profile** 上，不是生产实例；生产侧的 Cloudflare、代理与真实认证没有在本轮改动，也没有被验证。

本节的**范围**：General 页的每一行（11 行，其中两行根本不是实例设置）、Agent presets 的默认预设、部署自带的 4 个插件配置页里**每一个可编辑字段**（Web search 的API key 与端点字段除外）。这个范围之外的东西逐条列在「本轮没有驱动的部分」，不在这里假装覆盖。


### 一次点击的多重效果

- overlay/loopback：Show coding view 这一行按下时另外还写动了 `agent-preset-registry`（该行只记它自己那一笔，台账把两个命名空间都算上了）

### 设置面板逐项

| 设置项（原设置面板的文案） | 写入的命名空间 / 路径 | overlay：远程（非 loopback） | overlay：本机（loopback） | control：远程（非 loopback） | control：本机（loopback） |
| --- | --- | --- | --- | --- | --- |
| Permission | `permission` `defaultPreset` | mutate(`permission.defaultPreset` = "read-only"，revision 0→1) | mutate(`permission.defaultPreset` = "workspace-write"，revision 1→2) | 原组合的远程页面不渲染这一行（无可点的控件） | mutate(`permission.defaultPreset` = "read-only"，revision 0→1) |
| Language（实例偏好阶段也驱动过） | `locale` `preference` | mutate(`locale.preference` = "zh"，revision 1→2) | mutate(`locale.preference` = "zh"，revision 3→4) | 页面内存：不写实例（值只留在页面，刷新即回默认） | mutate(`locale.preference` = "zh"，revision 0→1) |
| Appearance（实例偏好阶段也驱动过） | `ui-theme` `preference` | mutate(`ui-theme.preference` = "dark"，revision 0→1) | mutate(`ui-theme.preference` = "light"，revision 2→3) | 页面内存：不写实例（值只留在页面，刷新即回默认） | mutate(`ui-theme.preference` = "light"，revision 0→1) |
| Font size | `ui-theme` `fontSize` | mutate(`ui-theme.fontSize` = 15，revision 1→2) | mutate(`ui-theme.fontSize` = 16，revision 3→4) | 页面内存：不写实例（值只留在页面，刷新即回默认） | mutate(`ui-theme.fontSize` = 15，revision 1→2) |
| Work details | `ui-chat` `transcriptView` | mutate(`ui-chat.transcriptView` = "compact"，revision 0→1) | mutate(`ui-chat.transcriptView` = "standard"，revision 2→3) | 页面内存：不写实例（值只留在页面，刷新即回默认） | mutate(`ui-chat.transcriptView` = "compact"，revision 0→1) |
| When to Collapse Work Details | -（不是实例设置） | 不写实例（点击后无任何设置写，实例逐命名空间不变） | 不写实例（点击后无任何设置写，实例逐命名空间不变） | 不写实例（点击后无任何设置写，实例逐命名空间不变） | 不写实例（点击后无任何设置写，实例逐命名空间不变） |
| Show coding view（开关与重连阶段也驱动过） | `ui-settings` `enabled` | mutate(`ui-settings.enabled` = true，revision 0→1) | mutate(`ui-settings.enabled` = false，revision 1→2) | 页面内存：不写实例（值只留在页面，刷新即回默认） | mutate(`ui-settings.enabled` = true，revision 0→1) |
| Keyboard shortcuts | -（不是实例设置） | 不写实例（点击后无任何设置写，实例逐命名空间不变） | 不写实例（点击后无任何设置写，实例逐命名空间不变） | 不写实例（点击后无任何设置写，实例逐命名空间不变） | 不写实例（点击后无任何设置写，实例逐命名空间不变） |
| Send behavior while busy | `ui-conversation` `busyEnter` | mutate(`ui-conversation.busyEnter` = "steer"，revision 0→1) | mutate(`ui-conversation.busyEnter` = "queue"，revision 1→2) | 页面内存：不写实例（值只留在页面，刷新即回默认） | mutate(`ui-conversation.busyEnter` = "steer"，revision 0→1) |
| Performance & usage | `ui-chat` `performanceUsage` | mutate(`ui-chat.performanceUsage` = "compact"，revision 1→2) | mutate(`ui-chat.performanceUsage` = "detailed"，revision 3→4) | 页面内存：不写实例（值只留在页面，刷新即回默认） | mutate(`ui-chat.performanceUsage` = "compact"，revision 1→2) |
| Upload Session Log when using the official model API | `session-log-deepseek` `enabled` | mutate(`session-log-deepseek.enabled` = true，revision 0→1) | mutate(`session-log-deepseek.enabled` = false，revision 1→2) | 原组合的远程页面不渲染这一行（无可点的控件） | mutate(`session-log-deepseek.enabled` = false，revision 0→1) |

| 设置项 | 写入的命名空间 / 路径 | overlay：远程 | overlay：本机 | control：远程 | control：本机 |
| --- | --- | --- | --- | --- | --- |
| Agent presets：新会话默认预设 | `agent-preset-registry` `selectedDefault`（settings/update 的 patch） | update(`agent-preset-registry.selectedDefault` = "ptc"，revision 0→1) | update(`agent-preset-registry.selectedDefault` = "cordis"，revision 2→3) | update(`agent-preset-registry.selectedDefault` = "cordis"，revision 0→1) | update(`agent-preset-registry.selectedDefault` = "standard"，revision 1→2) |

### 实例服务的设置命名空间

矩阵的单位是**命名空间**和**面板上的行**：某个命名空间被写过，只说明这一轮有页面写入了它，不说明它下面每个字段都被驱动过（插件配置页那一节逐页给出字段数）。

| 实例服务的设置命名空间 | 本轮是否经页面写过 | 写过的来源 | 说明 |
| --- | --- | --- | --- |
| `session-log-deepseek` | 是 | 远程 ✓ / 本机 ✓ | 由「Upload Session Log when using the official model API」行写入 |
| `agent-default-model` | **未由本轮驱动** | 远程 - / 本机 - | 新会话用哪个模型是在输入框里当场选的；这个构建的设置面板没有任何控件会写这个命名空间 |
| `llm-pi-ai` | 是 | 远程 ✓ / 本机 - | 由本轮的设置面板写入 |
| `bash-sandbox` | 是 | 远程 ✓ / 本机 ✓ | 由插件管理页 `Shell` 的配置表单写入 |
| `permission` | 是 | 远程 ✓ / 本机 ✓ | 由「Permission」行写入 |
| `subagent` | 是 | 远程 ✓ / 本机 ✓ | 由插件管理页 `Subagent` 的配置表单写入 |
| `web-search-deepseek` | 是 | 远程 ✓ / 本机 ✓ | 由插件管理页 `Web search` 的配置表单写入 |
| `agent-loop` | 是 | 远程 ✓ / 本机 ✓ | 由插件管理页 `Agent loop` 的配置表单写入 |
| `llm-deepseek` | **未由本轮驱动** | 远程 - / 本机 - | 由内置的 DeepSeek provider 卡片承载（设置面板的 Models 页）：卡片里的字段是官方 provider 自己的配置——其中一部分（base URL、模型列表等）并不需要账号登录，另一部分是与账号绑定的密钥。本轮没有驱动其中任何字段，理由**不是**「它们都在账号面之外」，而是 provider 编辑器不在本轮的矩阵范围内（provider 的增删与凭据往返由更早的阶段在非 loopback 来源上驱动核对，见兼容性报告 §2） |
| `llm-deepseek-account` | **未由本轮驱动** | 远程 - / 本机 - | 账号级命名空间，只能经 DeepSeek 登录流程到达；issue #1 把它划在范围外，本轮也不拿真实账号去碰它 |
| `subagent-model-selection-settings` | **未由本轮驱动** | 远程 - / 本机 - | Host 提供它，但这个构建在这个配置下没有任何页面为它渲染表单，因此没有可记录的「由页面发起」的写入 |
| `ui-settings-account` | **未由本轮驱动** | 远程 - / 本机 - | 账号级（登录账号自己的设置页）；按 issue #1 属于范围外，本轮驱动的页面也从不写它 |
| `ui-theme` | 是 | 远程 ✓ / 本机 ✓ | 由「Appearance」行写入 |
| `locale` | 是 | 远程 ✓ / 本机 ✓ | 由「Language」行写入 |
| `ui-settings` | 是 | 远程 ✓ / 本机 ✓ | 由「Show coding view」行写入 |
| `ui-settings-general` | 是 | 远程 ✓ / 本机 - | 由本轮的设置面板写入 |
| `ui-conversation` | 是 | 远程 ✓ / 本机 ✓ | 由「Send behavior while busy」行写入 |
| `ui-chat` | 是 | 远程 ✓ / 本机 ✓ | 由「Work details」行写入 |
| `agent-preset-registry` | 是 | 远程 ✓ / 本机 ✓ | 由本轮的设置面板写入 |
| `e2e-config-probe` | 是 | 远程 ✓ / 本机 - | 由本轮的设置面板写入 |

### 部署自带的插件配置页

| 插件管理页（部署自带） | 字段 | 命名空间 / 路径 | overlay：远程 | overlay：本机 | control：远程 | control：本机 |
| --- | --- | --- | --- | --- | --- | --- |
| `Shell` | `timeoutMs` | `bash-sandbox` `timeoutMs` | mutate(`bash-sandbox.timeoutMs` = 60001，revision 0→1) | mutate(`bash-sandbox.timeoutMs` = 60002，revision 2→3) | 页面根本不出现（无卡片、无表单） | mutate(`bash-sandbox.timeoutMs` = 60001，revision 0→1) |
| `Shell` | `maxOutputBytes` | `bash-sandbox` `maxOutputBytes` | mutate(`bash-sandbox.maxOutputBytes` = 64001，revision 1→2) | mutate(`bash-sandbox.maxOutputBytes` = 64002，revision 3→4) | 页面根本不出现（无卡片、无表单） | mutate(`bash-sandbox.maxOutputBytes` = 64001，revision 1→2) |
| `Agent loop` | `maxParallelToolCalls` | `agent-loop` `maxParallelToolCalls` | mutate(`agent-loop.maxParallelToolCalls` = 11，revision 0→1) | mutate(`agent-loop.maxParallelToolCalls` = 12，revision 1→2) | 页面根本不出现（无卡片、无表单） | mutate(`agent-loop.maxParallelToolCalls` = 11，revision 0→1) |
| `Subagent` | `maxActiveSubagents` | `subagent` `maxActiveSubagents` | mutate(`subagent.maxActiveSubagents` = 9，revision 0→1) | mutate(`subagent.maxActiveSubagents` = 10，revision 2→3) | 页面根本不出现（无卡片、无表单） | mutate(`subagent.maxActiveSubagents` = 9，revision 0→1) |
| `Subagent` | `maxDepth` | `subagent` `maxDepth` | mutate(`subagent.maxDepth` = 2，revision 1→2) | mutate(`subagent.maxDepth` = 3，revision 3→4) | 页面根本不出现（无卡片、无表单） | mutate(`subagent.maxDepth` = 2，revision 1→2) |
| `Web search`（插件阶段也驱动过） | `maxUses` | `web-search-deepseek` `maxUses` | mutate(`web-search-deepseek.maxUses` = 7，revision 0→1) | mutate(`web-search-deepseek.maxUses` = 8，revision 1→2) | 页面根本不出现（无卡片、无表单） | mutate(`web-search-deepseek.maxUses` = 6，revision 0→1) |

- `Shell`：该页自己报了 2 个字段（`plugin-config-shell-timeout`、`plugin-config-shell-output`），本轮逐字段驱动 2 个（`plugin-config-shell-timeout`、`plugin-config-shell-output`）——这一页的字段全部驱动过。
- `Agent loop`：该页自己报了 1 个字段（`plugin-config-agent-loop-parallel`），本轮逐字段驱动 1 个（`plugin-config-agent-loop-parallel`）——这一页的字段全部驱动过。
- `Subagent`：该页自己报了 2 个字段（`plugin-config-subagent-depth`、`plugin-config-subagent-capacity`），本轮逐字段驱动 2 个（`plugin-config-subagent-capacity`、`plugin-config-subagent-depth`）——这一页的字段全部驱动过。
- `Web search`：该页自己报了 3 个字段（`plugin-config-web-search-key`、`plugin-config-web-search-endpoint`、`plugin-config-web-search-max-uses`），本轮逐字段驱动 1 个（`plugin-config-web-search-max-uses`）；`plugin-config-web-search-key`（apiKey）、`plugin-config-web-search-endpoint`（endpoint） 只做清单不做驱动，验收跑不往任何地方写API key 或端点。

### 本轮没有驱动的部分

- 账号级与模型选择类的命名空间（`agent-default-model`、`llm-deepseek`、`llm-deepseek-account`、`ui-settings-account`、`subagent-model-selection-settings`）：逐条理由写在上表里（表源是 `tools/lib/settings-surface.mjs` 的 `SURFACE_GAPS`），验收跑会断言「本轮没写过的命名空间」与那张表**完全一致**，所以新增的命名空间不会被悄悄漏掉。
- 插件配置页里没有驱动的字段：上一节逐页列出（Web search 的API key 与端点字段）。验收跑不往任何地方写 API key 或端点，所以这两个字段在矩阵里没有格子，也不借用同一个表单里别的字段的写入。
- 设置面板另外两页的控件：**Models 页**的自定义 provider 编辑器（新建、编辑、删除与凭据往返）由更早的阶段在**非 loopback** 来源上驱动并核对（见 §2 的回归表），但本轮没有为它画「两个来源 × 两种模式」的格子；**Built-in plugins 页本轮没有测**——验收跑只测到这一页在面板里存在（探针），既没有枚举它的条目，也没有点过它的开关，也没有在任何来源上读过它，所以它既不在矩阵里、也不在任何「已驱动」的清单里。**插件管理页那份证据不能借来充当它的证据**：那测的是独立插件管理器上的第三方测试包与 bundle 开关，不是设置面板内的这一页。
- 快捷键编辑器内部改键位的行为：本轮只测量了「用这一行打开编辑器不写实例」（而且实例服务的命名空间里没有快捷键这一类）；编辑器里改键位本身没有驱动。
- 两个不是实例设置的行（`When to Collapse Work Details`、`Keyboard shortcuts`）：值只活在页面里，实例逐命名空间不变——这一条是在两个来源上分别点出来的测量结果，不是推断。
- 真实部署侧：Cloudflare 边界、跨机器访问、真实账号、既有实例上的 enable/rollback、多访问端并发，见 [release-guide.md](release-guide.md) 第 8 节；本节的全部结论都来自隔离的临时 `DSH_HOME` 与临时 profile。
<!-- settings-surface:end -->

## 6. 已知限制与未完成项

- 真实部署侧的未完成检查（Cloudflare 边界、跨机器访问、真实账号、既有实例上的 enable/rollback、多访问端并发）逐条列在 [release-guide.md](release-guide.md) §8；
- 隔离验证**不是**生产证明：本报告证明的是"在这个构建 + 这个配置下，替换的机制与边界行为是这些"；
- 原页面自身的限制（无统一保存提示、无原子事务、无自动回滚、校验反馈就是页面那段文案、顺序写与并发行为）记录在 release-guide §9；
- 设置面板里有两行根本不是实例设置（`When to Collapse Work Details`、`Keyboard shortcuts`）：点击不发出任何设置写，值只活在页面里——§5 的矩阵把它们标成"非实例设置"，而不是假装它们被持久化了。**快捷键编辑器内部改键位**的行为没有驱动（实例服务的设置命名空间里也没有快捷键这一类）：本轮测到的只是"用这一行打开编辑器不写实例"。
- 隔离验证的**粒度**是"命名空间 + 面板上的行 + 插件配置页的字段"，不是"每个设置"：General 页逐行驱动、4 个插件配置页逐字段驱动（Web search 的 API key 与端点字段只做清单）。**Models 页的自定义 provider 编辑器**由更早的阶段在非 loopback 来源上驱动核对（新建、编辑、删除、凭据往返，§2），但没有逐来源的格子；**Built-in plugins 页本轮根本没有测**——只测到这一页在设置面板里存在，既没有枚举它的条目，也没有点过它的开关，也没有在任何来源上读过它（**插件管理页那份证据不能借来充当它的证据**）。
- 原组合的远程页面读不到 Host 的设置，所以 §5 的 control 列里有些行写的是"原组合的远程页面根本不渲染这一行"——这是**测出来的**，不是推断。
