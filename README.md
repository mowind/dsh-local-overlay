# dsh-local-overlay

在固定的 DSH 基线上，用**自有设置组件**加**自有 Web 组合包**的临时实例，验证一个可行性门槛：在**访问端**的原设置页上修改一个即时保存的设置，刷新、重新连接、实例重启后仍然保留。

对应 Issue #2；背景与边界见 [CONTEXT.md](CONTEXT.md) 与 [docs/adr/](docs/adr/)。本仓是验证覆盖层：它不改动安装中的 DSH，也不修改上游源码。

## 基线身份与许可

- 基线包：`@deepseek-ai/dsh` `0.2.1-alpha.2`
- 基线提交：`d743267388641bc76f17c45ce8b4c231aed1d32c`
- 上游项目：<https://github.com/deepseek-ai/deepseek-harness>，MIT，Copyright (c) 2026 DeepSeek
- 两个交付包的 `LICENSE` 是上游 MIT 许可证的逐字节副本；`NOTICE` 说明来源与改动；[provenance.json](provenance.json) 逐文件记录来源路径、sha256 与改动行的完整 diff。
- 上面这个提交号是**声明的候选基线身份**：安装目录不含 git 元数据（`git rev-parse` 失败），所以本地能独立核实的只是已安装包的 `name`/`version`、18 个记录文件的 sha256，以及两个改动文件相对该基线的完整 diff；提交号本身无法从安装产物反推，换安装就必须按新基线重新生成清单与证据。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| [packages/dsh-client-ui-settings/](packages/dsh-client-ui-settings/) | 自有设置组件：上游 `@deepseek-ai/dsh-client-ui-settings` 的版本绑定副本，只改 2 处 |
| [packages/dsh-web-composition/](packages/dsh-web-composition/) | 自有 Web 组合包：上游 `@deepseek-ai/dsh-web-app` patch 层（roster + 4 个 preset）的副本，只改 1 行 |
| [provenance.json](provenance.json) | 18 个文件的来源清单（路径、上游位置、kind、sha256、`expectedDiff`） |
| [tools/verify-artifacts.mjs](tools/verify-artifacts.mjs) | 来源预检：核对已安装基线与记录是否一致，不一致则失败退出 |
| [tools/e2e-remote-settings.mjs](tools/e2e-remote-settings.mjs) | 端到端验证：真实打包产物 + 隔离 profile + 真实浏览器 |
| [evidence/](evidence/) | 最近一次 `control` 与 `overlay` 的证据（JSON + 截图） |
| [docs/adr/](docs/adr/) | ADR-0001 复用原设置页的版本绑定替换；ADR-0002 单所有者认证边界 |

## 替换机制（为什么这样装配）

组合包承载**完整的** dsh-web-app roster（`cordis.patch.yml` 加 `presets/{standard,ptc,minimal,cordis}.patch.yml`），唯一的差异是设置 provider 行：

```yaml
- id: ui-settings
  name: "@dsh-local-overlay/dsh-client-ui-settings"   # 上游为 @deepseek-ai/dsh-client-ui-settings
```

- profile 的 `dsh.profile.bundles` 用 `["@deepseek-ai/dsh-base", "@dsh-local-overlay/web-composition"]` **取代** `@deepseek-ai/dsh-web-app`，因此原组合不会加载，只有一个设置服务。
- 行 id 仍是 `ui-settings`，所以 `ui-settings` 的 Host 配置命名空间、主机声明和原设置页都保持不变；patch 引擎里 `name` 只是守卫（不匹配会跳过该 patch），因此这里用带 `insert` 的行来改名，而不是改配置。
- 设置组件的唯一行为差异：不再用 `ctx.remote.$host.isLoopback` 选择持久化模式，非 loopback（已认证）页面也用 `"host"`。`remote.$host.isLoopback` 本身、`/api` 的 Host/Origin 检查、认证门禁、主机编辑器入口的 loopback 判定都未改动。

## 可复现安装步骤

以下步骤就是 [tools/e2e-remote-settings.mjs](tools/e2e-remote-settings.mjs) 在 `--mode overlay` 下自动执行的流程，可手工照做。第 1–5 步（建隔离 home、打包、装组件、来源预检、装组合包）在开发时按下面的命令逐条照抄执行过一次，每一步都成功结束；本节记录的 `dsh plugin add` 行为就是那次实测的结果，而不是从源码推测的。

1. 准备一个隔离的实例 home（不触碰现有实例）：

   ```bash
   export DSH_HOME=$(mktemp -d /tmp/dsh-overlay-XXXX)/home
   mkdir -p "$DSH_HOME/profiles/proto"
   printf '[]\n' > "$DSH_HOME/profiles/proto/cordis.patch.yml"
   printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$DSH_HOME/profiles/proto/pnpm-workspace.yaml"
   printf '{"name":"dsh-profile-proto","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n' > "$DSH_HOME/profiles/proto/package.json"
   ```

2. 打包两个交付包（真实打包产物，不是源码导入；命令都以仓库根为起点，用子 shell 避免把当前目录留在包内）：

   ```bash
   mkdir -p /tmp/dsh-overlay-artifacts
   (cd packages/dsh-client-ui-settings && npm pack --pack-destination /tmp/dsh-overlay-artifacts)
   (cd packages/dsh-web-composition   && npm pack --pack-destination /tmp/dsh-overlay-artifacts)
   ```

3. 先用文档化的 CLI 把设置组件装进 profile（这一步不会切换组合；组合包等预检通过后再装）：

   ```bash
   DSH_HOME="$DSH_HOME" dsh plugin --profile proto add /tmp/dsh-overlay-artifacts/dsh-local-overlay-dsh-client-ui-settings-0.1.0.tgz
   ```

   先装组件是必须的：组合包的 roster 行要能从 profile 的 `node_modules` 解析到它。

   `dsh plugin add` 的实测行为（按本文命令逐条照抄执行过）：包一定进 profile 的 `node_modules`；如果这个包**是**组合层（manifest 里有 `dsh.bundle.patch`），它会顺带把 `dsh.profile.bundles` 重写成「基础包 + 本次添加的包」。所以装组件后 bundles 仍是 `["@deepseek-ai/dsh-base"]`，装组合包后（下一步）被改写成 `["@deepseek-ai/dsh-base", "@dsh-local-overlay/web-composition"]`；想装多个组合层时每次 `add` 之前都要重新写一遍期望的 bundles（自动化脚本就是这样做的）。顺带一提，profile 的 `node_modules` 里只会出现我们自己装的 `@dsh-local-overlay/*`：`@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 是从 DSH 安装目录解析的，这也是验证脚本查组合层时要先查 profile、再回退到安装目录的原因。

4. 装组合包**之前**先跑来源预检（这是门禁，不通过就不要继续）：

   ```bash
   node tools/verify-artifacts.mjs
   ```

   它要求已安装的 DSH 正好是记录的基线版本，逐文件核对 sha256 与改动 diff，核对两个交付包实际打包出的文件清单、两个自有 manifest 的字段（包名、版本、基线标记、`files` 清单、`dsh.bundle.patch` 的顺序与重复项）以及包内 `provenance.json` 与仓库副本逐字节一致；不匹配则退出码 1 并列出问题。

   门禁必须正好排在这一步：下一行的 `dsh plugin add` 自己就会把组合切过去，装完再预检就不再是「切换前」了。自动化脚本还会跑两次负向对照：故意改坏记录里某个 verbatim 文件的 sha256，以及把组合包 `dsh.bundle.patch` 的顺序调换后重跑校验，两次都要求退出码 1。

5. 只有预检通过，才把自有组合包装进 profile（这一次 `add` 会把 `dsh.profile.bundles` 自己改成 `["@deepseek-ai/dsh-base", "@dsh-local-overlay/web-composition"]`，不再包含 `@deepseek-ai/dsh-web-app`）：

   ```bash
   DSH_HOME="$DSH_HOME" dsh plugin --profile proto add /tmp/dsh-overlay-artifacts/dsh-local-overlay-web-composition-0.1.0.tgz
   node -e 'console.log(require(process.env.DSH_HOME + "/profiles/proto/package.json").dsh.profile.bundles)'
   ```

   第二行应打印 `[ '@deepseek-ai/dsh-base', '@dsh-local-overlay/web-composition' ]`。要装多个组合层时，每次 `add` 之前重新写一遍期望的 bundles（自动化脚本就是这样做的）。

6. 启动实例（隔离 home，非 loopback 来源要显式声明为可信主机）：

   ```bash
   DSH_HOME="$DSH_HOME" dsh proto --host 127.0.0.1 --port 0 --no-open --trusted-host dsh-proto.test
   ```

   终端打印一行 `dsh web: http://127.0.0.1:<port>/?token=...`；把主机名换成 `dsh-proto.test` 就是访问端使用的地址。

7. 从访问端打开页面：把访问端的浏览器指向实例主机上可达的地址，例如 `http://dsh-proto.test:<port>/?token=...`（`dsh-proto.test` 需要解析到实例主机，或用你自己的域名加 `--trusted-host`）。本轮验证里实例绑定的是 `127.0.0.1`，所以只有**同一台机器**才能只靠主机名解析访问；从真正另一台机器访问还需要 SSH 隧道或改变绑定地址（本仓未做公网绑定）。

   单机演示时可用真实浏览器模拟非 loopback 来源（TCP 仍连本机，但浏览器 origin 与 Host 头是非 loopback 的 `dsh-proto.test`）：

   ```bash
   chromium --host-resolver-rules="MAP dsh-proto.test 127.0.0.1" --user-data-dir=$(mktemp -d) "http://dsh-proto.test:<port>/?token=..."
   ```

## 演示脚本（远程页面上的即时保存）

1. 在访问端的页面上打开设置，找到 `Developer tools` / `开发者工具` 里的 `Show coding view` / `代码工作视图` 开关（初始为开）。
2. 关闭它，等待约 3 秒。
3. 观察 `$DSH_HOME/profiles/proto/cordis.patch.yml` 从 `[]` 变成：

   ```yaml
   - id: ui-settings
     name: "@dsh-local-overlay/dsh-client-ui-settings"
     config:
       enabled: false
   ```

   注意写入的 `name` 就是我们组件的包名——这正是下次启动时 patch 引擎 `name` 守卫仍能匹配的原因。

4. 刷新页面、断开再重新连接（或重启实例后用新 token 打开），开关保持关闭。

5. 对照：同一实例的本机访问端（`http://127.0.0.1:<port>/?token=...`）仍会显示主机配置编辑器入口，并显示同一个值。

6. 控制组对照（原组合）：`--mode control` 用 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` 启动同一套流程。远程页面上点开关只会翻转页面状态，`cordis.patch.yml` 始终是 `[]`，刷新即丢失；而同一页面的**本机**访问会写入 `name: "@deepseek-ai/dsh-client-ui-settings"` 这一行，说明原组合的即时保存是本机专属的。

## 自动化验证与证据

```bash
node tools/verify-artifacts.mjs                                   # 来源预检
node tools/e2e-remote-settings.mjs --mode control                 # 控制组：原组合
node tools/e2e-remote-settings.mjs --mode overlay                 # 覆盖组：自有组合包
```

两个模式断言同一批事实：真实打包产物、由文档化 CLI 装入隔离 profile（并在每次 `add` 之后读回 `dsh.profile.bundles`：装组件不切组合、装组合包自己切组合，这正说明门禁必须排在装组合包之前）、**所有已加载组合层里恰好只有一行 ui-settings provider（且它指向预期的包）**、页面侧 `window.__DSH_BOOT__` 里设置 provider 模块恰好只有一个（`-account`、`-general`、`-models` 等同族设置包在任何配置下都会加载，按精确包名排除）、组合替换生效、从非 loopback 来源加载页面、远程页面不暴露主机配置编辑器入口、远程点击能被接受、持久化行为、刷新后的取值、**一次真实的传输中断**（先记录文档当时持有的流连接，CDP 离线必须成功 → 离线期间页面既打不开新的传输连接、它自己发的请求也确实失败 → 恢复后**同一文档、不带刷新**多出一条新的流连接并仍显示 Host 值；`overlay` 模式还在恢复后的连接上把开关写一次再写回来，证明这条连接真的能写入 Host，而不只是能连通）、重启后的取值、控制台异常在 6 个阶段（初次加载、刷新后、重连后、loopback 访问后、重启后、结束时；`overlay` 模式另有第 7 个「回退后」阶段）逐段断言，以及 18 项 fence/认证检查：`/api` 上可信 Host 不带 cookie 与 loopback 不带 cookie 都是 401（未认证不越界）；未知 Host 是 403，且**带上已认证 cookie 仍是 403**（认证不能绕过 Host fence）；同一枚 authority 绑定的 cookie 在可信 Host 上同时通过 fence 与认证门禁（读到 404，即真的到达了那个故意不存在的探针路由——若网络层失败拿到 `status: 0` 就不算通过），而把它重放到 loopback authority 上会被判 401（会话 cookie 绑定 authority，不能跨 authority 复用）；单独的跨站 `Origin`（不带 `Sec-Fetch-Site`）是 403；单独的 `Sec-Fetch-Site: cross-site`（不带 `Origin`）是 403；两者同时是 403；这两个信号各自**再带上已认证 cookie** 仍然是 403；`Origin` 与 Host 相同的对照请求能穿过 fence 到达认证门禁；对真实传输端点 `/api/remote.mux` 的三次 WebSocket 升级尝试（未知 Host 403、可信 Host 未认证 401、两者都过时真的升级成功）证明升级路径不被绕过；文档带 token 是 303 加 `location: ./` 与 Set-Cookie，无 token 是 401。每个 fence 信号单独探测，避免一个信号的有效拒绝掩盖另一个信号的失效。证据写入 [evidence/](evidence/) 的 `<mode>-evidence.json` 与 `<mode>-NN-*.png` 截图，任一检查失败时退出码为 1。

`overlay` 模式在装组合包**之前**就会跑来源预检；预检失败即抛错中止（`provenance preflight failed; refusing to install the artifacts and switch the composition`），不会用未核对基线的副本继续验证。同一个预检还会跑两次负向对照：把记录里某个 verbatim 文件的 sha256 故意改坏，以及把组合包 `dsh.bundle.patch` 的顺序调换后重跑校验，两次都要求退出码 1，证明门禁不是永远通过。

控制台断言按阶段**结构性**分类，不靠错误文本关键词：`Runtime.exceptionThrown` 与 `Runtime.consoleAPICalled` 的 error 在任何阶段、两种模式下都判失败，消息里出现 `net::ERR_*` 字样也换不来豁免；`Script`、`Stylesheet`、`Document`、`Fetch`、`XHR` 等类型的 `Network.loadingFailed` 在任何阶段都判失败（强制断网窗口内由测试自己触发的两类失败除外，见下）。

流式传输的容忍有**两把尺子，且都以阶段为窗口**：一是 `requestId` 绑定——该 `requestId` 必须落在本阶段开始时记录、进入下一阶段即清空的 `discontinued` 集合里（也就是这条连接是测试自己用导航、刷新、强制断网或重启主动拆掉的）；二是 authority 绑定——一个**新的** `WebSocket`/`EventSource` 请求，只要它的 authority 等于本阶段被测试自己拆过的连接的 authority、且携带**网络层**失败码（`^net::ERR_`，页面 JS 造不出这种 `loadingFailed`），也按「测试自己在这阶段拆了这个 authority」容忍。两条都要求 URL 精确命中 `/plugins/events` 或 `/api/remote.mux` 且类型是 `WebSocket`/`EventSource`。之所以需要第二条：被导航走掉的页面和实例被重启前的页面会**不断用新 `requestId` 重试**，而浏览器对 CDP 强制离线切断的 socket 干脆不报关闭事件（实测 5 秒内既没有 `webSocketClosed` 也没有 `loadingFailed`）。窗口随阶段关闭，所以「一直坏着」的传输躲不过去：它在**下一个**阶段还会继续开新请求，而那时 `discontinued` 已清空、authority 也不再匹配，于是判失败。另外，凡是在阶段结束时**页面应当可用**的阶段，都还会断言「页面上仍持有一条握手成功（101）的 `/api/remote.mux` 连接」（且这条连接**从未**被测试自己拆过，避免把浏览器不报关闭的僵尸 socket 当成可用连接）——容忍只能是插曲，不能是结局。authority 豁免**永远不适用于页面当前所在的 authority**：当下就坏着的传输必须由它自己的 `requestId` 说话，否则判失败。恢复网络之后，测试还会在**同一份被中断的文档**上再开一段**零容忍静默窗**（`afterReconnectQuiescent`，5 秒、不允许任何容忍）：该页面不得再有**任何**错误事件，然后才允许导航离开。否则「恢复后仍然坏着的流」可以借本阶段的豁免混过去，再被下一次导航连同证据一起销毁。浏览器还会把同一次失败以网络日志的形式再报一遍，这条回声只在**同一阶段**已经容忍过**同一 authority** 上的拆除时才被接受（`entry.source === "network"`、含真实 `net::ERR_` 码、URL 命中流端点；文本里出现 `net::ERR_*` 本身不算豁免），页面 JS 自己的报错来源是 `javascript`/`console-api`，永不豁免。

强制断网阶段另有一类**必需证据**（`inducedOffline_afterReconnect`）：测试自己造成的 `ERR_INTERNET_DISCONNECTED` 必须真的在网络上出现，且不能只被静默容忍——具体是文档 URL 上的 `Fetch` 失败，以及测试自己发起的传输探针在流端点上的失败，两者都必须有记录。传输探针本身的返回值也被收紧：只有 `failed`（浏览器报告连接错误）或 `closed` 才算离线证据，`timeout`、构造函数异常、`eval-failed` 一律判**失败**而不是通过——探针自己坏掉不等于网络被切断。除了「文档请求在离线期间真的失败」之外，还额外断言强制的离线窗口**真的打到了设置传输**（`inducedTransport_afterReconnect`：流端点上的 `WebSocket`/`EventSource` 失败，或它的网络日志回声，且必须携带 `ERR_INTERNET_DISCONNECTED`），只有文档请求失败不算数。结构性容忍的流拆除连同理由逐条记入 `tolerated_<stage>`，被测试自己诱发的离线失败单独记入 `inducedOffline_<stage>`，每阶段被主动拆掉的连接记入 `discontinuedConnections_<stage>`。

最近一次记录（基线 `0.2.1-alpha.2` / `d7432673`，冻结树）：`control` 55 项全部通过，`overlay` 73 项全部通过，两个模式退出码都是 0，日志里没有任何 `FAIL` 行。`overlay` 多出的 18 项净增量来自：来源预检与它的两次负向对照（改坏记录里的 sha256、调换组合包 `dsh.bundle.patch` 顺序）、用文档化 CLI 装包后**逐次**读回 `dsh.profile.bundles`、单行 provider 与单设置模块断言、真实传输中断与恢复后 Host 写回环的额外断言，以及最后整段「文档化回退被真实执行」的断言（含回退阶段自己的控制台断言）。

同一份证据里的关键取值（`overlay`）：远程页面开关初始为开（`"true"`，浏览器本地态），点一下后刷新、重连、重启、回退重启之后都读到 `"false"`（每次都是 2 行：`Show coding view` 为关、Host 提供的 `Upload Session Log when using the official model API` 为开）；组合层里重定向到自有包的 `ui-settings` 行只有一行（`./cordis.patch.yml:301`），页面侧 boot 里设置 provider 模块也只有自有包一个，回退后重新变回上游包。

`/api` 上的 fence 判定为可信 Host 无 cookie 401、loopback 无 cookie 401、未知 Host 403、未知 Host **带已认证 cookie 仍 403**、可信 Host 带同一枚 cookie 404（fence 与认证都过了，只是这个探针路由不存在）、同一枚 cookie 重放到 loopback authority 401、单独 `Origin` 403、单独 `Sec-Fetch-Site` 403、两者同时 403、这两个信号各自**再带 cookie** 仍是 403、`Origin` 与 Host 相同的对照 401；`/api/remote.mux` 的三次 WebSocket 升级尝试分别是 403、401 与**真的升级成功**（101）；文档带 token 303 加 `location: ./` 与 Set-Cookie、无 token 401。

重连阶段的证据是「同一文档」：页面标记中断前后一致、离线期间页面自身请求返回 `rejected:TypeError: Failed to fetch`、测试自己的传输探针结果为 `failed`、恢复后文档请求 `status:200` 并且**多出一条新的、握手真的成功（101）的** `/api/remote.mux` 连接（新 `requestId`；断言不看 `/plugins/events`，也不接受「只是被创建过」的 socket——只有 `Network.webSocketHandshakeResponseReceived` 的 101 才算数）。旧连接不要求出现关闭事件：浏览器对 CDP 强制切断的 socket 不报 `webSocketClosed`，证据里 `preReconnectTeardown`/`preReconnectClosed` 为空正是这个原因，所以「不再复用」是靠**新连接的身份与握手**断言的，而不是靠旧连接的死讯；恢复后还会在这条新连接上把开关写一次再写回来（`enabled: true` → `enabled: false`，页面读数 `true` → `false`），证明它不只是「能连通」而是**真能写入 Host**；而且这两次写入还被**绑定到新连接**上：被测试自己切断的旧连接在恢复之后**不得再出现任何帧流量**（`roundTripTraffic.oldUsedAfterRecovery` 必须为空），新连接上则必须观察到帧（或恢复点之后出现 `/api` 请求）。本轮实测新 `requestId` 上共 8 个帧（发 3 / 收 5，最后一帧在恢复点之后），恢复点之后还有 12 个 `/api` 请求，而旧连接的最后一帧停在恢复点之前——所以「新连接」不是一句声明，而是有帧证据的。控制台方面，`afterReconnect` 的 3 条事件全是测试自己强制断网诱发的 `ERR_INTERNET_DISCONNECTED`（文档 `Fetch` 失败、传输探针失败及其网络日志回声），作为**必需证据**单独断言（`inducedOffline_afterReconnect`），不是被静默容忍；真正被结构性容忍的只有测试自己重启实例造成的传输拆除——`afterLoopbackAccess` 与 `afterRollback` 各 7 条，其余阶段（初次加载、刷新后、重启后、结束时）事件数都是 0。

## 已知行为差异与后果

- 远程页面会比原组合多出一个由 Host 提供的设置行 `Upload Session Log when using the official model API`：只有 Host 真正提供 `session-log-deepseek` 命名空间时它才出现，而 `"host"` 持久化正是这样。控制组的远程页面只有 1 个浏览器本地行，覆盖组是 2 行，这个差异是预期结果而不是缺陷。
- 非 loopback（已认证）页面从此可以直接修改实例配置：设置页会为**每一个由 Host 提供、且带 volatile schema 的 ConfigForms 命名空间**渲染通用表单，所以写面不止 `ui-settings` 下的一两个开关，而是「所有已存在的 Host 端 volatile 设置项」，例如上面那行 session-log 上传开关。上游设置服务本身仍要求 schema 里已存在该项、逐路径的 volatile 校验与 revision 冲突处理，且对 secret 字段做脱敏；即便如此，这仍是「所有已认证访问端属于同一所有者」这一单人假设（ADR-0002:3）下的显著放大，在多个互不信任的访问端共用同一实例时不成立。
- 主机配置编辑器入口仍然只在 loopback 页面上出现；远程页面拿到的 `remote.$host.isLoopback` 仍是真实的 `false`。这是**间接**证据：同一个实例上远程页面探测到该入口数量为 0（且页面里没有对应标签文本），而 loopback 页面数量大于 0；再加上远程 Host 上 `/api` 的 403 判定仍然按非 loopback 主机生效。浏览器端的 `$host.isLoopback` 没有对外暴露给测试直接读取的 getter，所以本仓只断言它的可观测后果，不断言内部字段本身。

## 适用边界与未覆盖

- 只对记录的基线 `0.2.1-alpha.2` / `d7432673` 有效。换 DSH 版本必须重新生成副本、重算 `provenance.json` 并重跑证据。
- 不做所有者与访客的权限隔离；不改认证与 Host/Origin 检查；不提供多实例协调。
- 「非 loopback 来源」在这里只指**浏览器的 origin 与 Host 头**非 loopback（TCP 仍然连本机）。本仓没有做公网绑定或多机部署，真实网络位置需要 SSH 隧道或另一台机器；按 ADR-0002:5，生产侧的 Cloudflare 边界不在本原型验证范围内。
- 供应链只锁到「已安装基线 + 18 个复制文件的 sha256 + 两个自有 manifest 的字段」这一层：不固定 tarball 哈希、不签名、不校验 pnpm 锁文件。
- 没有覆盖账号登录门禁的负向用例、设置写入冲突（revision 竞争）、以及 secret 字段的负向用例；回退段落里「凭据不会丢」是读实现得出的推论（只有 `name` 守卫被改，`config` 原样保留），没有用真实 secret 做过负向用例。

## 组件回退

回退要两步，顺序不能反，而且**不要删掉那条 patch**：

1. 先把 profile `cordis.patch.yml` 里那条 `- id: ui-settings` 的 `name:` 守卫改回上游包名 `name: "@deepseek-ai/dsh-client-ui-settings"`（等价做法是只删掉 `name:` 这一行，保留 `id`、`config` 与已保存的凭据）。
2. 再把 `dsh.profile.bundles` 恢复为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`。

为什么不能「只换 bundles」：patch 引擎对非 `insert` 的补丁只把 `name` 当守卫，名字不匹配时会警告 `patch: name mismatch for ... skipping` 并**整条跳过**，于是回去加载的原 provider 收不到 `enabled: false`，用户会看到设置「自己变回去了」，而 patch 文件里还留着我们的包名。

为什么不能「删掉 patch 或清成 `[]`」：那等于把已保存的实例配置（可能还有凭据）一起丢掉；ADR-0001 要求覆盖层可回退且回退后保留配置。改 `name` 守卫只是让这条 patch 重新指向上游 provider，`config` 里的值原样继续生效。

这条回退路径不是纸上说明：`--mode overlay` 的最后一步会真实执行它（只改 `name` 守卫 → 把 `bundles` 换回 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` → 重启），并断言两件事：保存的值仍然生效（开关仍是关闭），以及页面又只加载一个设置模块、且是上游包。
