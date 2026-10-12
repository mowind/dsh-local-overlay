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
| [packages/dsh-client-ui-settings/](packages/dsh-client-ui-settings/) | 自有设置组件：上游 `@deepseek-ai/dsh-client-ui-settings` 的版本绑定副本，只改 2 处；另有自撰并随包发布的构建身份模块 [lib/baseline-identity.js](packages/dsh-client-ui-settings/lib/baseline-identity.js) |
| [packages/dsh-web-composition/](packages/dsh-web-composition/) | 自有 Web 组合包：上游 `@deepseek-ai/dsh-web-app` patch 层（roster + 4 个 preset）的副本，只改 1 行 |
| [provenance.json](provenance.json) | 18 个文件的来源清单（路径、上游位置、kind、sha256、`expectedDiff`）与 `baseline.buildIdentity` 构建身份 |
| [tools/overlay.mjs](tools/overlay.mjs) | 终端入口：`preflight` / `enable` / `status` / `diagnose` / `rollback` / `record`，安装与切换都经它执行 |
| [tools/verify-artifacts.mjs](tools/verify-artifacts.mjs) | 来源预检的 CLI：核对记录与实际安装（含构建身份），不一致则失败退出 |
| [tools/lib/preflight.mjs](tools/lib/preflight.mjs) | 预检实现：`verify-artifacts.mjs` 与 `overlay.mjs` 共用同一份检查，不是两份实现 |
| [tools/e2e-remote-settings.mjs](tools/e2e-remote-settings.mjs) | 端到端验证：真实打包产物 + 终端入口安装 + 隔离 profile + 真实浏览器 |
| [evidence/](evidence/) | 最近一次 `control` 与 `overlay` 的证据（JSON + 截图） |
| [docs/adr/](docs/adr/) | ADR-0001 版本绑定替换；ADR-0002 单所有者认证边界；ADR-0003 构建身份核验与失败关闭 |

## 替换机制（为什么这样装配）

组合包承载**完整的** dsh-web-app roster（`cordis.patch.yml` 加 `presets/{standard,ptc,minimal,cordis}.patch.yml`），唯一的差异是设置 provider 行：

```yaml
- id: ui-settings
  name: "@dsh-local-overlay/dsh-client-ui-settings"   # 上游为 @deepseek-ai/dsh-client-ui-settings
```

- profile 的 `dsh.profile.bundles` 用 `["@deepseek-ai/dsh-base", "@dsh-local-overlay/web-composition"]` **取代** `@deepseek-ai/dsh-web-app`，因此原组合不会加载，只有一个设置服务。
- 行 id 仍是 `ui-settings`，所以 `ui-settings` 的 Host 配置命名空间、主机声明和原设置页都保持不变；patch 引擎里 `name` 只是守卫（不匹配会跳过该 patch），因此这里用带 `insert` 的行来改名，而不是改配置。
- 设置组件的唯一行为差异：不再用 `ctx.remote.$host.isLoopback` 选择持久化模式，非 loopback（已认证）页面也用 `"host"`。`remote.$host.isLoopback` 本身、`/api` 的 Host/Origin 检查、认证门禁、主机编辑器入口的 loopback 判定都未改动。
- 运行时也核验：设置组件的 `apply()` 第一条语句就核对构建身份，不符即拒绝提供该 provider，没有环境变量或版本范围豁免（[docs/adr/0003](docs/adr/0003-build-identity-verification-and-refusal.md)）。

## 可复现安装步骤

以下步骤就是 [tools/e2e-remote-settings.mjs](tools/e2e-remote-settings.mjs) 在 `--mode overlay` 下自动执行的流程：第 2–5 步（打包、来源预检、装组件、装组合包并写回组合列表）现在由终端入口一条命令完成——`node tools/overlay.mjs enable --home "$DSH_HOME" --profile proto`，它先跑预检，不通过就什么都不装、什么都不切；下面的命令是它的手工等价物，逐条可照做。第 1–5 步在开发时按下面的命令逐条照抄执行过一次，每一步都成功结束；本节记录的 `dsh plugin add` 行为就是那次实测的结果，而不是从源码推测的。顺序是关键：**来源预检必须排在两次 `dsh plugin add` 之前**，因为后一个 `add` 会把组合层加进 `dsh.profile.bundles`，装完再预检就不再是「切换前」了。

1. 准备一个隔离的实例 home（不触碰现有实例）：

   ```bash
   export DSH_HOME=$(mktemp -d /tmp/dsh-overlay-XXXX)/home
   mkdir -p "$DSH_HOME/profiles/proto"
   printf '[]\n' > "$DSH_HOME/profiles/proto/cordis.patch.yml"
   printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$DSH_HOME/profiles/proto/pnpm-workspace.yaml"
   printf '{"name":"dsh-profile-proto","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}\n' > "$DSH_HOME/profiles/proto/package.json"
   ```

   初始 bundles 与真实实例一致（基础包 + 原 Web 组合包）：第 5 步要把后者换成自有组合包。

2. 打包两个交付包（真实打包产物，不是源码导入；命令都以仓库根为起点，用子 shell 避免把当前目录留在包内）：

   ```bash
   mkdir -p /tmp/dsh-overlay-artifacts
   (cd packages/dsh-client-ui-settings && npm pack --pack-destination /tmp/dsh-overlay-artifacts)
   (cd packages/dsh-web-composition   && npm pack --pack-destination /tmp/dsh-overlay-artifacts)
   ```

3. 装任何东西**之前**先跑来源预检（这是门禁，不通过就不要继续）：

   ```bash
   node tools/verify-artifacts.mjs
   ```

   它要求已安装的 DSH 正好是记录的基线版本，逐文件核对 sha256 与改动 diff，核对两个交付包实际打包出的文件清单、两个自有 manifest 的字段（包名、版本、基线标记、`files` 清单、`dsh.bundle.patch` 的顺序与重复项）、包内 `provenance.json` 与仓库副本逐字节一致，以及固定包清单的**构建身份**摘要（[docs/adr/0003](docs/adr/0003-build-identity-verification-and-refusal.md)）；不匹配则退出码 1 并列出问题。门禁必须正好排在这里：下一次 `dsh plugin add` 之后组合就已经变了，装完再预检就不再是「切换前」。

   自动化脚本还会跑负向对照，都要求退出码 1：改坏记录里某个 verbatim 文件的 sha256；把组合包 `dsh.bundle.patch` 的顺序调换后重跑校验；以及三份 `cp -al` 硬链接副本（未改动的必须通过、把版本号改成 `9.9.9` 的、改坏一个已记录文件的）——后两份用来证明「只比版本字符串」和「同版本不同产物」都过不了门禁。

4. 预检通过后，用文档化的 CLI 把设置组件装进 profile（这一步不改组合）：

   ```bash
   DSH_HOME="$DSH_HOME" dsh plugin --profile proto add /tmp/dsh-overlay-artifacts/dsh-local-overlay-dsh-client-ui-settings-0.1.0.tgz
   ```

   先装组件是必须的：组合包的 roster 行要能从 profile 的 `node_modules` 解析到它。

   `dsh plugin add` 的实测行为（按本文命令逐条照抄执行过，与 `@deepseek-ai/dsh-app-boot` 的 `reconcileProfilePlugins` 一致）：包一定进 profile 的 `node_modules`；如果这个包**是**组合层（manifest 里有 `dsh.bundle.patch`），它会**把自身追加到** `dsh.profile.bundles` 末尾，不删除已有的层。所以这一步之后 bundles 仍是 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`。顺带一提，profile 的 `node_modules` 里只会出现我们自己装的 `@dsh-local-overlay/*`：`@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 是从 DSH 安装目录解析的，这也是验证脚本查组合层时要先查 profile、再回退到安装目录的原因。

5. 装自有组合包，并把 `dsh.profile.bundles` 里原有的组合层**换成**它：

   ```bash
   DSH_HOME="$DSH_HOME" dsh plugin --profile proto add /tmp/dsh-overlay-artifacts/dsh-local-overlay-web-composition-0.1.0.tgz
   node -e 'const f = process.env.DSH_HOME + "/profiles/proto/package.json"; const m = require(f); const b = m.dsh.profile.bundles.filter((n) => n !== "@deepseek-ai/dsh-web-app"); if (!b.includes("@dsh-local-overlay/web-composition")) b.push("@dsh-local-overlay/web-composition"); m.dsh.profile.bundles = b; require("fs").writeFileSync(f, JSON.stringify(m, null, 2) + "\n"); console.log(b);'
   ```

   第二行应打印 `[ '@deepseek-ai/dsh-base', '@dsh-local-overlay/web-composition' ]`。这一步不能省：`add` 只做追加（实测从 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` 出发、装完组合包变成 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-local-overlay/web-composition"]`），两个组合层同时加载就会出现两个 `ui-settings` 提供者。要装多个组合层时，同样在 `add` 之后显式写一遍期望的 bundles（自动化脚本走终端入口 `enable`，由它统一写）。

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
DSH_PROFILE=e2e node tools/e2e-remote-settings.mjs --mode control # 控制组：原组合
DSH_PROFILE=e2e node tools/e2e-remote-settings.mjs --mode overlay # 覆盖组：自有组合包
```

两个模式都在自己的临时 `DSH_HOME` 里建一个由 `DSH_PROFILE` 命名的 profile（默认 `e2e`），启动本会话的那个 profile 全程不被读写。

两个模式断言同一批事实：真实打包产物、由终端入口 `overlay.mjs enable` 装入隔离 profile（它先跑预检、装组件、装组合包，再把 `dsh.profile.bundles` 里的 `@deepseek-ai/dsh-web-app` 就地换成自有组合包，并断言读回正是 `["@deepseek-ai/dsh-base", "@dsh-local-overlay/web-composition"]`；`dsh plugin add` 自己只会把组合层**追加**进列表，替换层这件事必须显式做，这也是预检必须排在安装之前的原因）、**所有已加载组合层里恰好只有一行 ui-settings provider（且它指向预期的包）**、页面侧 `window.__DSH_BOOT__` 里设置 provider 模块恰好只有一个（`-account`、`-general`、`-models` 等同族设置包在任何配置下都会加载，按精确包名排除）、组合替换生效、从非 loopback 来源加载页面、远程页面不暴露主机配置编辑器入口、远程点击能被接受、持久化行为、刷新后的取值、**一次真实的传输中断**（先记录文档当时持有的流连接，CDP 离线必须成功 → 离线期间页面既打不开新的传输连接、它自己发的请求也确实失败 → 恢复后**同一文档、不带刷新**多出一条新的流连接并仍显示 Host 值；`overlay` 模式还在恢复后的连接上把开关写一次再写回来，证明这条连接真的能写入 Host，而不只是能连通）、重启后的取值、控制台异常在 9 个阶段（初次加载、原 provider 页交互后、刷新后、重连后、重连后的零容忍静默窗、loopback 访问后、重启后、插件页交互后、结束时；`overlay` 模式另有产物损坏后、产物恢复后、插件页打开后、插件页写入后、插件页表单后、插件页重连后、回退后 7 个阶段，共 16 个）逐段断言，以及 18 项 fence/认证检查：`/api` 上可信 Host 不带 cookie 与 loopback 不带 cookie 都是 401（未认证不越界）；未知 Host 是 403，且**带上已认证 cookie 仍是 403**（认证不能绕过 Host fence）；同一枚 authority 绑定的 cookie 在可信 Host 上同时通过 fence 与认证门禁（读到 404，即真的到达了那个故意不存在的探针路由——若网络层失败拿到 `status: 0` 就不算通过），而把它重放到 loopback authority 上会被判 401（会话 cookie 绑定 authority，不能跨 authority 复用）；单独的跨站 `Origin`（不带 `Sec-Fetch-Site`）是 403；单独的 `Sec-Fetch-Site: cross-site`（不带 `Origin`）是 403；两者同时是 403；这两个信号各自**再带上已认证 cookie** 仍然是 403；`Origin` 与 Host 相同的对照请求能穿过 fence 到达认证门禁；对真实传输端点 `/api/remote.mux` 的三次 WebSocket 升级尝试（未知 Host 403、可信 Host 未认证 401、两者都过时真的升级成功）证明升级路径不被绕过；文档带 token 是 303 加 `location: ./` 与 Set-Cookie，无 token 是 401。每个 fence 信号单独探测，避免一个信号的有效拒绝掩盖另一个信号的失效。证据写入 [evidence/](evidence/) 的 `<mode>-evidence.json` 与 `<mode>-NN-*.png` 截图，任一检查失败时退出码为 1。

两个模式还会**用远程（非 loopback）来源真正操作原 provider 页**（设置里的 `Models` 一节，Issue #4）。这一阶段按人操作的方式走页面自己的按钮与输入框：新建 provider（route、显示名、Base URL、API 协议、API key、一个 model，且没有 model 时保存按钮必须是禁用的）、页面自己的字段校验（畸形 route、已被占用的 route、畸形 Base URL 三种拒绝都要就地报告、保存按钮禁用，且 profile 逐字节不变——这三种拒绝都在**其余字段已按成功新建的样子填好**（含一个 model 与一把 key）的表单上做出，并在把出错字段改回正确后断言同一个表单重新变为可保存，否则「按钮禁用」可能只是被「没有 model 就不许保存」那条规则解释掉）、编辑（改名、改 Base URL、换 API 协议、加第二个 model、换 key）、删除（确认框点名 provider 与 `stored API key`；先 `credentials/unset` 再 `settings/mutate`，且**不带** `expectedRevision`——这一条是按原页面的行为记录下来的，不当作保护来宣称）、以及**另一个写入者抢先**时 revision 守卫的冲突（页面拒绝并显示冲突文案，什么都不落盘；随后重新打开编辑器换一次 key）。每一笔写入都从两侧核对：页面自己渲染出的行（`custom`、是否已配置密钥、只显示 `Configured` 占位符、页面文本里不出现任何测试密钥），以及实例 Host（页面自己发出的 RPC 报文按**结构**解析出 `settings/mutate` 的 `ns`/`ops`/`expectedRevision` 与 `credentials/set` 的 `ref`/`value`，再加 profile patch 与 `$DSH_HOME/.credentials.yaml` 的字段级断言）。刷新、重连（同一份文档）、重启之后都重新打开 `Models` 一节，用同一段断言读三样东西：provider 仍在、密钥仍只报「已配置」、凭据值逐字节未变；同一段还断言**被删除的那个 provider 依旧不存在**（页面没有它的行、profile 没有它的条目、凭据文件里没有它的引用、`credentials/describe` 也不把它的 ref 报成 `configured`），所以「删掉的东西在下一个边界复活」会让断言失败。

原页面的**部分成功**也照实记录，不额外承诺：把 `cordis.patch.yml` 换成目录时，Apply 在页面里报错、编辑器保持打开，恢复文件后 profile 逐字节不变；把 `.credentials.yaml` 换成目录时，**配置那一半真的落盘了**、密钥那一半失败（页面报错且不宣称成功），恢复文件后**再按一次 Apply** 只把欠着的那笔密钥写下去。这一阶段的失败证据不靠关键词放过：窗口内记录的事件逐条记入 `inducedFailureEvents`，另有一条断言要求**只有点名这些诱发失败的事件**（补丁读写失败、`EISDIR`、目录被当成文件、`.credentials.yaml` 之类）才被豁免，窗口里任何其他运行时异常、控制台错误或网络失败都照常判失败——成功重试与恢复也在这个窗口里；随后才把阶段标记推进一步，让后面阶段的断言只评判后面自己的窗口。配置写失败那一笔「什么都没落盘」的证明也不与测试自己恢复的备份比较：断言读的是**失败当下**那个写入目标仍是测试造出来的目录、实例 Host 前后两次 `settings/describe` 报出的 llm-pi-ai revision 相同、且被拒绝的值在整个 profile 里查不到。

控制组同样跑这一阶段，断言的是反面，而且这一面比「不持久化」更早失效：原组合下页面在远程来源上**连 provider 目录都解析不出来**，`Models` 一节自己写着 `Loading the provider directory failed: settings are unavailable in this browser` 并给出 `Retry`，既没有 `Add model provider` 入口、也没有任何 provider 行，所以控制组不去驱动一个并不存在的「新建」（那正是 Issue #4 要修的缺陷本身，照实记录而不是跳过）。它断言三件事：原页面确实被送到远程浏览器、并且这条失败文案来自页面自己；这一节不提供任何 provider 管理入口（无新建动作、无 provider 行）；这一节对实例 Host **什么都没写**（profile 逐字节不变，报文里只有 `llm/listProviders`、`llm/listConfigurableProviders` 这类读，没有任何 `settings/mutate` 或 `credentials/*`），报文逐条记进证据。反差因此落在同一份页面上：同样的远程来源、同样的 `Models` 一节，自有组合包里 provider 目录可用，上面那套新建/编辑/删除全部走通。`overlay` 模式的回退阶段还会核对：通过页面写入的 provider 配置与密钥都是普通存储状态，回退后原样还在。

两个模式接着用同一个**真实安装的第三方插件**验证插件配置这条路径（Issue #5）。测试包 [tools/fixtures/dsh-config-probe](tools/fixtures/dsh-config-probe) 是普通第三方包：只有 `dsh.client` 与 bundle patch 两项声明，不依赖任何 `@deepseek-ai/dsh*` 框架包，配置表单按官方伴生包的做法注册在标准槽位 `plugins.bundle.config`（key 就是包名），字段 id 也由包自己起名。安装走文档化的包管理器入口（`npm pack` 出 tarball，再交给 `dsh plugin --profile <profile> add <tarball>`），bundle 列表只在实例启动时读取，所以装完要重启实例。之后测试在**远程（非 loopback）来源**上打开原插件管理页——左侧导航的 `Plugins`（不是设置面板里的 `Built-in plugins`，那是另一张清单页）——先逐轮关掉引导弹窗（弹窗期间 `#root` 带 `inert`，焦点被忽略、输入会落进别的字段），再按包名打开卡片，随后全部读写都按包自己起的字段 id 进行。

`overlay` 模式在这一页上断言：卡片与实例服务该命名空间的默认值一致（表单里就是 `probe-default` / `3`）；**暂存**一次编辑后页面显示草稿、保存按钮才可用，而实例的 `settings/describe` 该命名空间仍是原值与原 revision、profile patch 里那一行没有出现、窗口内也没有任何点名该命名空间的 `settings/mutate` 报文；**保存**时页面发出的报文点名该命名空间与它读到的 revision，实例 revision 加一、profile patch 出现 `- id: e2e-config-probe … config: label: …`、按钮回到禁用，**整页重新加载**后表单显示已保存值且没有待保存内容；字段自己解析不了的输入（`not-a-number`）会让该字段带上 `aria-invalid="true"`、把提示换成包自己的文案、保存按钮禁用，而且页面根本不提交；超出部署 schema 范围的值（`10`）则照样提交、被 Host 以 `settings/rejected` 拒绝，页面显示包自己的失败文案、**草稿留在输入框里**、实例与 patch 逐字节不变；**陈旧 revision**（另一端先用同一套 RPC 把命名空间写走）让页面保存时仍带着暂存那一刻冻结的 revision，被拒（`settings/conflict`）后页面显示的是与业务拒绝**同一条**失败文案、草稿保留、另一端写的值和 patch 都还在——这里照实记录，不宣称存在统一的冲突体验；把 profile 的 `cordis.patch.yml` 换成同名目录后保存，页面报失败、草稿保留、目录里什么都没写，恢复后字节与失败前相同；**启停**分别走组件开关发出 `pluginManager/setPluginEnabled`（按行 id）、bundle 开关发出 `pluginManager/setBundleEnabled`（按包名，是另一个方法），被点的那一行或那张卡片随之报告 off，组件开关还会在 patch 里留下 `disabled: true`（bundle 开关的账不在 `cordis.patch.yml` 里：这个文件逐字节不变），插件被关掉后实例不再服务该命名空间（`describe` 里那一项整体消失）、配置区跟着消失，再点回来时之前保存的值仍在。

控制组跑同一套安装与同一段页面驱动，断言的是反面：原组合在远程页面上把设置状态留在页面里，所以它**不向实例取命名空间**，插件注册的配置表单也就不会被挂上——页面上没有这些字段、槽位里没有内容——而实例本身仍在服务该命名空间，bundle 与组件也仍然可列出、可启停。差别因此恰好落在替换的那一处：同一份页面、同一个远程来源、同一个真实第三方包。

最后一条断言专门针对「不新增专用硬编码适配」：自有设置组件与自有组合包的源码里不得出现探针的包名、命名空间或它自己的文案（`bespokeMentions` 必须为空数组），也就是页面能驱动这个插件，靠的是标准槽位与标准 RPC，而不是仓里认识它。这一阶段页面上的开关动作还有一条时序事实被记进了测试：插件管理页每次启停都会重新向 Host 读一遍清单，所以在它的调用回来之前，开关会短暂处于不可用状态——测试因此先等开关可用、点一次、再等页面自己报出新状态，而不是点完立刻读 DOM。

同一阶段还驱动一个**随产品发布**的显式保存表单，而不只是测试包自己写的那个：实例服务 `web-search-deepseek` 时，随包发布的 `dsh-client-ui-settings-web-search` 会按标准槽位 `plugins.item` 注册自己的配置页，测试用同一段驱动打开它，按它自己的字段 id（`plugin-config-web-search-key`、`-endpoint`、`-max-uses`）读写，并断言页面渲染的是产品自己的文案（`Save`、`Leave blank to use the provider default.`、`Enter a number, or leave blank to use the default.`、`The deployment did not accept these values; they were left for you to correct.`）。两者的分工是：随包发布的表单覆盖「暂存不落盘 → 保存落地 → 陈旧 revision 被拒 → 客户端非法输入」这条线（Issue #5 的 AC1/AC2/AC4/AC5a），第三方测试包覆盖「宿主业务拒绝」（AC5b：`attempts: 10` 越界，实例回 `settings/rejected`）与「写入失败」（AC5c：把 `cordis.patch.yml` 换成目录）。保存之后的持久化在三个边界上读回：页面自己制造的强制离线与恢复、整页刷新、以及同一次运行里**把实例重启**——两套值都从页面读回，并与实例 `settings/describe` 与 profile patch 对齐；重启后读回的是另一端先写进去的那个值（`maxUses: 6`），不是被拒的草稿。强制离线这一段由它自己的阶段（`afterPluginReconnect`）逐条结算：被中断的那份文档既没有刷新、也没有重挂，所以先断言**当初打开的那个表单仍在同一份文档里**（字段还在、还带着值、保存按钮还在），再断言这份文档在连接恢复后仍然能到达实例，最后才允许导航离开（此后的导航与重启是测试自己的动作，它们带来的流断开按证据容忍；这里不宣称存在零容忍的静默窗）。写入失败这一段照实记录它的实际限制：`cordis.patch.yml` 一旦被换成目录，实例连自己的 overlay 都读不了，所以**失败窗口内连 `settings/describe` 都做不了**（回 `gateway/internal` 加 `EISDIR`），测试断言的正是这一点。这个窗口里读得到的是三件事：页面报出保存失败且草稿保留、写入目标仍是测试造出来的那个目录**且目录里是空的**、以及窗口内除了被点名的诱发失败事件之外没有别的失败文本；而「什么都没落盘」的证明放在**恢复目标之后**：实例再次 `settings/describe` 报出的 `value` 与 `revision` 与失败前逐字节相同、不等于草稿，草稿在 profile 里也查不到。控制组也按同一段驱动去开那张随包发布的表单，断言它同样不存在（卡片列表里没有、打开动作 `no-card`、字段全不 present），而实例仍在服务 `web-search-deepseek`——差别仍然只落在替换的那一处。
`overlay` 模式在装任何东西**之前**就会跑来源预检；预检失败时终端入口打印 `refusing to install or switch anything` 并退出 1，profile 目录逐字节不变，也不会用未核对基线的副本继续验证。同一个预检还会跑两次负向对照：把记录里某个 verbatim 文件的 sha256 故意改坏，以及把组合包 `dsh.bundle.patch` 的顺序调换后重跑校验，两次都要求退出码 1，证明门禁不是永远通过。

`overlay` 模式还会用三份**硬链接副本**（`cp -al`，复制品与安装在同一个文件系统内，绝不触碰真实安装）验证「版本号不是身份」：未改动的副本通过；把副本 `package.json` 的 `version` 改成 `9.9.9` 被拒（`installed version is 9.9.9, recorded 0.2.1-alpha.2`）；把同版本副本里一个已记录文件（`node_modules/@deepseek-ai/cordis/LICENSE`）改一个字节也被拒（`installed build differs from the recorded build identity`）。终端入口指向被拒副本时退出 1 并打印 `refusing to install or switch anything`，同时 profile 目录（manifest、patch、是否装过自有包、状态文件）逐字节不变——失败的预检不可能留下半装状态。

同一份被拒副本还被用来验证**运行时**也拒绝：用它的 `lib/bin.js` 启动第二个实例，日志里出现 `refusing to serve the settings provider` 与 `differs from the recorded build identity`，对该实例的 `settings/mutate`（`ui-settings`）返回 `ok:false` 且 `error.code === "settings/rejected"`，patch 保持原样；`overlay.mjs diagnose --install <被拒副本>` 退出 1，而真实安装仍然通过预检。

「浏览器产物被改坏」是另一类失败，单独验证：在 profile 里已装的 `node_modules/@dsh-local-overlay/dsh-client-ui-settings/lib/client.js` 的 `apply()` 首行**注入一次** `throw`（外科式改动，而不是把整文件换成一个 `throw`：模块仍然能加载，只在注册自己时抛错——那正是下载残缺或被篡改的产物在页面里的样子），随后 `diagnose` 退出 1 并点名该文件（`lib/client.js as installed in the profile (…) differs from the recorded artifact (…)`）；页面整页 boot 失败——该 provider 持有设置面与 `configForms` 服务，它一倒，`locale`/`theme`/`layout` 等 47 个 entry 全部 `pending (waiting for service: configForms)`，根槽没注册，boot 报告把 `@dsh-local-overlay/dsh-client-ui-settings` 记为 `failed`。没有任何写入被当成成功（patch 逐字节未变）。这一阶段的控制台错误正是「测试自己造的产物失败」，所以只在 boot 报告**点名自有 entry** 时才被容忍，被容忍的事件逐条记入 `inducedArtifact_afterDamagedArtifact`，并且那条点名观察本身是必过的自证断言——豁免不会静默生效。把原始字节写回并核对 sha256 后 `diagnose` 恢复通过，设置面也回来了。

回退同样走终端入口：`node tools/overlay.mjs rollback --home "$DSH_HOME" --profile proto`。这一阶段先用页面同一套 RPC 写一条普通配置（`session-log-deepseek` 命名空间）和一个一次性测试凭据，回退后断言：普通配置行与它的 `enabled: false` 仍在、`- id: ui-settings` 那条的 `name` 守卫回到上游包名且 `config` 原样保留、`bundles` 回到 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`、两个自有包仍然装着（只回退选择，不卸包）、`credentials/describe` 对该 ref 只回 `configured: true`（不回明文）、`$DSH_HOME/.credentials.yaml` 仍在且权限仍是 `600`。重启后 patch 与回退后**逐字节相同**（那条保存的 override 原样留着：既没被读回去，也没被丢掉），但页面读数回到 `"true"`：上游 provider 在非 loopback 页面上把状态留在页面里（与控制组逐项一致——控制组同样是初次打开 `true`、点一下 `false`、刷新回 `true`），也就是保存的 `enabled: false` 不再被读取；再点开关只翻转页面且 patch 不变，刷新即恢复原值——原组合的远程限制确实回来了。

控制台断言按阶段**结构性**分类，不靠错误文本关键词：`Runtime.exceptionThrown` 与 `Runtime.consoleAPICalled` 的 error 在任何阶段、两种模式下都判失败，消息里出现 `net::ERR_*` 字样也换不来豁免；`Script`、`Stylesheet`、`Document`、`Fetch`、`XHR` 等类型的 `Network.loadingFailed` 在任何阶段都判失败（强制断网窗口内由测试自己触发的两类失败除外，见下）。唯一另一类被豁免的加载失败是浏览器自己标的 `canceled`：测试导航或刷新页面时，仍在途的请求会被浏览器作废并报成取消，这不是页面的失败——这一豁免只在测试自己搅动页面的阶段生效（初次加载永不豁免），流式端点被排除在外，因此它绝不能替一条坏掉的传输开脱，被豁免的事件连同理由逐条记入 `tolerated_<阶段>`。

流式传输的容忍有**两把尺子，且都以阶段为窗口**：一是 `requestId` 绑定——该 `requestId` 必须落在本阶段开始时记录、进入下一阶段即清空的 `discontinued` 集合里（也就是这条连接是测试自己用导航、刷新、强制断网或重启主动拆掉的）；二是 authority 绑定——一个**新的** `WebSocket`/`EventSource` 请求，只要它的 authority 等于本阶段被测试自己拆过的连接的 authority、且携带**网络层**失败码（`^net::ERR_`，页面 JS 造不出这种 `loadingFailed`），也按「测试自己在这阶段拆了这个 authority」容忍。两条都要求 URL 精确命中 `/plugins/events` 或 `/api/remote.mux` 且类型是 `WebSocket`/`EventSource`。之所以需要第二条（只适用于**页面已经离开的** authority，见下）：被导航走掉的页面和实例被重启前的页面会**不断用新 `requestId` 重试**，而浏览器对 CDP 强制离线切断的 socket 干脆不报关闭事件（实测 5 秒内既没有 `webSocketClosed` 也没有 `loadingFailed`）。窗口随阶段关闭，所以「一直坏着」的传输躲不过去：它在**下一个**阶段还会继续开新请求，而那时 `discontinued` 已清空、authority 也不再匹配，于是判失败。另外，凡是在阶段结束时**页面应当可用**的阶段，都还会断言「页面上仍持有一条握手成功（101）的 `/api/remote.mux` 连接」（且这条连接**从未**被测试自己拆过，避免把浏览器不报关闭的僵尸 socket 当成可用连接）——容忍只能是插曲，不能是结局。authority 豁免**永远不适用于页面当前所在的 authority**：当下就坏着的传输必须由它自己的 `requestId` 说话，否则判失败。恢复网络之后，测试还会在**同一份被中断的文档**上再开一段**零容忍静默窗**（`afterReconnectQuiescent`，5 秒、不允许任何容忍）：该页面不得再有**任何**错误事件，然后才允许导航离开。否则「恢复后仍然坏着的流」可以借本阶段的豁免混过去，再被下一次导航连同证据一起销毁。浏览器还会把同一次失败以网络日志的形式再报一遍，而日志条目**不带 `requestId`**，所以这条回声必须**成对**成立：同一 authority、**同一个流端点路径**、同一个 `net::ERR_` 错误码（`entry.source === "network"` 且 URL 命中流端点；文本里出现 `net::ERR_*` 本身不算豁免），且它的搭档必须是「本阶段已经容忍过的同一端点上的失败」**或**「本阶段被测试自己拆掉的同一端点上的连接」二者之一。后一种搭档是必需的，因为**失败的 WebSocket 握手在 Chromium 里只报为一条网络日志、没有 `loadingFailed` 可以和它配对**；而只要端点路径必须相等，一个 `/plugins/events` 上的失败就买不到 `/api/remote.mux` 上失败的豁免。这条回声同样**排除页面当前所在的 authority**——页面当下正在用的 authority 上出现的新失败，不能因为本阶段早些时候拆过同一 authority 就被放过。页面 JS 自己的报错来源是 `javascript`/`console-api`，永不豁免。

强制断网阶段另有一类**必需证据**（`inducedOffline_afterReconnect`）：测试自己造成的 `ERR_INTERNET_DISCONNECTED` 必须真的在网络上出现，且不能只被静默容忍——具体是文档 URL 上的 `Fetch` 失败，以及测试自己发起的传输探针在流端点上的失败，两者都必须有记录。传输探针本身的返回值也被收紧：只有 `failed`（浏览器报告连接错误）或 `closed` 才算离线证据，`timeout`、构造函数异常、`eval-failed` 一律判**失败**而不是通过——探针自己坏掉不等于网络被切断。除了「文档请求在离线期间真的失败」之外，还额外断言强制的离线窗口**真的打到了设置传输**（`inducedTransport_afterReconnect`：流端点上的 `WebSocket`/`EventSource` 失败，或它的网络日志回声，且必须携带 `ERR_INTERNET_DISCONNECTED`），只有文档请求失败不算数。结构性容忍的流拆除连同理由逐条记入 `tolerated_<stage>`，被测试自己诱发的离线失败单独记入 `inducedOffline_<stage>`，每阶段被主动拆掉的连接记入 `discontinuedConnections_<stage>`。

冻结基线（`0.2.1-alpha.2` / `d7432673`）第一次记录下来的那次运行：`control` 55 项全部通过，`overlay` 114 项全部通过，两个模式退出码都是 0，日志里没有任何 `FAIL` 行。`overlay` 多出的 59 项净增量来自：来源预检与它的两次负向对照（改坏记录里的 sha256、调换组合包 `dsh.bundle.patch` 顺序）、终端入口写入并读回 `dsh.profile.bundles`（已有的上游 `ui-settings` 守卫行会被迁移成自有包名、`config` 原样保留，`state.guardRows` 记 1）、单行 provider 与单设置模块断言、真实传输中断与恢复后 Host 写回环的额外断言（其中「写入发生在恢复之后、且不再走被拆掉的旧连接」被拆成三条独立断言：旧连接在恢复点之后不得再出现帧增量、写请求必须被解析成 `settings/mutate` RPC、恢复后的 mux 连接必须有帧活动），三份硬链接副本上的安装身份负向对照（未改动副本通过、改版本被拒、同版本改一个已记录文件被拒）、失败预检下终端入口拒绝且 profile 逐字节不变、运行时拒绝整套断言（第二实例日志、`settings/rejected`、`diagnose` 退出 1）、损坏浏览器产物阶段（诊断点名 + 整页 boot 失败 + 无假成功 + 恢复），替换期间新增的无关组合层（`@dsh-local-overlay/e2e-unrelated-layer`）在回退后仍然在列表里、测试凭据的值逐字节未变（不只是 `configured: true`）、以 `DSH_INSTALL` 指向获准安装也救不了被改坏的启动副本（拒绝跟随的是**启动脚本**），以及整段「文档化回退被真实执行」的断言（含回退阶段自己的控制台断言、普通配置与测试凭据的保留、凭据脱敏与文件权限、重启后 patch 逐字节不变而远程限制恢复）。

加入 Issue #5 阶段之后，当前代码（同一冻结基线）的最近一次运行：`control` 66 项、`overlay` 251 项全部通过，两个模式退出码都是 0，日志里没有任何 `FAIL` 行。`overlay` 的净增量里，Issue #5 阶段贡献了安装真实第三方包、驱动原插件页、随包发布的显式保存表单、断网重连与实例重启后的读回、以及组件与 bundle 的启停往返这几组断言。

同一份证据里的关键取值（`overlay`）：启用后远程页面开关初始为开（`"true"`，浏览器本地态），点一下读到 `"false"`，此后刷新、重连、重启读到的都是 `"false"`（每次都是 2 行：`Show coding view` 为关、Host 提供的 `Upload Session Log when using the official model API` 为开）——这正是「替换期间远程页面能持久化」的直接证据；回退并重启后同一页面只剩 1 行、读数回到 `"true"`，点一下 `"false"`、刷新回 `"true"`（与控制组逐项一致），而服务端 patch 里那条保存的 `enabled: false` 依然在、只是不再被读取。组合层里重定向到自有包的 `ui-settings` 行只有一行（`./cordis.patch.yml:301`），页面侧 boot 里设置 provider 模块也只有自有包一个，回退后重新变回上游包。

`/api` 上的 fence 判定为可信 Host 无 cookie 401、loopback 无 cookie 401、未知 Host 403、未知 Host **带已认证 cookie 仍 403**、可信 Host 带同一枚 cookie 404（fence 与认证都过了，只是这个探针路由不存在）、同一枚 cookie 重放到 loopback authority 401、单独 `Origin` 403、单独 `Sec-Fetch-Site` 403、两者同时 403、这两个信号各自**再带 cookie** 仍是 403、`Origin` 与 Host 相同的对照 401；`/api/remote.mux` 的三次 WebSocket 升级尝试分别是 403、401 与**真的升级成功**（101）；文档带 token 303 加 `location: ./` 与 Set-Cookie、无 token 401。

重连阶段的证据是「同一文档」：页面标记中断前后一致、离线期间页面自身请求返回 `rejected:TypeError: Failed to fetch`、测试自己的传输探针结果为 `failed`、恢复后文档请求 `status:200` 并且**多出一条新的、握手真的成功（101）的** `/api/remote.mux` 连接（新 `requestId`；断言不看 `/plugins/events`，也不接受「只是被创建过」的 socket——只有 `Network.webSocketHandshakeResponseReceived` 的 101 才算数）。旧连接不要求出现关闭事件：浏览器对 CDP 强制切断的 socket 不报 `webSocketClosed`，证据里 `preReconnectTeardown`/`preReconnectClosed` 为空正是这个原因，所以「不再复用」是靠**新连接的身份与握手**断言的，而不是靠旧连接的死讯；恢复后还会在**同一份恢复后的文档**上把开关写一次再写回来（`enabled: true` → `enabled: false`，页面读数 `true` → `false`），证明它不只是「能连通」而是**真能写入 Host**（设置写入走 HTTP `/api`，因此它被绑定的是**这份恢复后的文档与恢复点之后**，而不是某一条 WebSocket）；这三件事各由一条独立断言证明：一是被测试自己切断的旧连接在恢复之后**不得再出现任何帧流量**（`roundTripTraffic.oldUsedAfterRecovery` 必须为空，帧计数按**恢复点之后的增量**算，不用自创建以来的累计值）；二是写请求本身必须被**解析出来**——`POST` 且路径恰好 `/api/settings/mutate`、信封里 `method: "settings/mutate"`、`ns: "ui-settings"`、`ops` 中 `enabled` 的取值序列恰好是 `true|false`（`roundTripTraffic.settingsWritesAfterRecovery`，含 `rpcId` 与 `expectedRevision`）。设置写入走的是 HTTP `/api`，**不是** mux WebSocket 里的帧，所以「有帧」只被当作传输存活证据，绝不被当作写入证据；本轮实测两条 mutate RPC 齐备，新连接在恢复点之后另有 2 个帧，旧连接的最后一帧停在恢复点之前。控制台方面，`afterReconnect` 的 3 条事件全是测试自己强制断网诱发的 `ERR_INTERNET_DISCONNECTED`（文档 `Fetch` 失败、传输探针失败及其网络日志回声），作为**必需证据**单独断言（`inducedOffline_afterReconnect`），不是被静默容忍；真正被结构性容忍的只有测试自己重启实例造成的传输拆除——`afterLoopbackAccess` 与 `afterRollback` 各 7 条，其余阶段（初次加载、刷新后、重启后、结束时）事件数都是 0。

## 已知行为差异与后果

- 远程页面会比原组合多出一个由 Host 提供的设置行 `Upload Session Log when using the official model API`：只有 Host 真正提供 `session-log-deepseek` 命名空间时它才出现，而 `"host"` 持久化正是这样。控制组的远程页面只有 1 个浏览器本地行，覆盖组是 2 行，这个差异是预期结果而不是缺陷。
- 非 loopback（已认证）页面从此可以直接修改实例配置：设置页会为**每一个由 Host 提供、且带 volatile schema 的 ConfigForms 命名空间**渲染通用表单，所以写面不止 `ui-settings` 下的一两个开关，而是「所有已存在的 Host 端 volatile 设置项」，例如上面那行 session-log 上传开关。上游设置服务本身仍要求 schema 里已存在该项、逐路径的 volatile 校验与 revision 冲突处理，且对 secret 字段做脱敏；即便如此，这仍是「所有已认证访问端属于同一所有者」这一单人假设（ADR-0002:3）下的显著放大，在多个互不信任的访问端共用同一实例时不成立。
- 主机配置编辑器入口仍然只在 loopback 页面上出现；远程页面拿到的 `remote.$host.isLoopback` 仍是真实的 `false`。这是**间接**证据：同一个实例上远程页面探测到该入口数量为 0（且页面里没有对应标签文本），而 loopback 页面数量大于 0；再加上远程 Host 上 `/api` 的 403 判定仍然按非 loopback 主机生效。浏览器端的 `$host.isLoopback` 没有对外暴露给测试直接读取的 getter，所以本仓只断言它的可观测后果，不断言内部字段本身。

## 适用边界与未覆盖

- 只对记录的基线 `0.2.1-alpha.2` / `d7432673` 有效。换 DSH 版本必须重新生成副本、重算 `provenance.json`（`node tools/overlay.mjs record` 会一并重新记录构建身份）并重跑证据。
- 不做所有者与访客的权限隔离；不改认证与 Host/Origin 检查；不提供多实例协调。
- 「非 loopback 来源」在这里只指**浏览器的 origin 与 Host 头**非 loopback（TCP 仍然连本机）。本仓没有做公网绑定或多机部署，真实网络位置需要 SSH 隧道或另一台机器；按 ADR-0002:5，生产侧的 Cloudflare 边界不在本原型验证范围内。
- 供应链锁到「已安装基线 + 18 个复制文件的 sha256 + 两个自有 manifest 的字段 + 构建身份」这一层：仍不固定 tarball 哈希、不签名、不校验 pnpm 锁文件。构建身份只覆盖那份 16 个包的策划清单（308 个文件、7,649,159 字节），不含其余目录与依赖的嵌套 `node_modules`。
- 仍然没有覆盖账号登录门禁的负向用例。设置写入冲突（revision 竞争）现在由 Issue #5 那一阶段覆盖：另一端先把命名空间写走后，原页面用暂存那一刻冻结的 revision 保存会被拒，草稿与另一端的值都保留下来——覆盖的是原页面的**原生语义**（冲突与业务拒绝显示同一条失败文案），而不是一个统一的冲突体验。`overlay` 模式的回退阶段现在用**一次性测试凭据**（写进 throwaway `DSH_HOME`，不是真实密钥）验证「回退保留凭据」：回退后该 ref 仍在 `.credentials.yaml` 且权限仍是 `600`，`credentials/describe` 只回 `configured` 标志。这验证的是凭据文件与读取脱敏，不构成对真实密钥生命周期的验证。

## 终端入口（安装、诊断与重新记录）

所有会改动 profile 的动作都经由 [tools/overlay.mjs](tools/overlay.mjs) 执行，只想看不动手时用 `status` / `diagnose`：

```bash
node tools/overlay.mjs preflight                                # 只核对来源清单与构建身份，不改动任何东西
node tools/overlay.mjs enable    --home "$DSH_HOME" --profile proto   # 先预检，再打包、装两个包、切换组合并把已保存的 override 接到自有 provider
node tools/overlay.mjs status    --home "$DSH_HOME" --profile proto   # 当前组合、装了哪些自有包、保存的配置
node tools/overlay.mjs diagnose  --home "$DSH_HOME" --profile proto   # 预检 + profile 内已装产物与记录逐文件比对
node tools/overlay.mjs rollback  --home "$DSH_HOME" --profile proto   # 只撤销自有组合与包选择
node tools/overlay.mjs record                                   # 换基线后重新记录来源清单与构建身份
```

- `--home` 对每个 profile 命令都是必填的：工具从不猜 home，因此不可能误操作正在服务的生产实例。`--install` / `--dsh-bin` 可以指向另一份安装（例如验证用的硬链接副本），`--artifacts` 指定打包产物的落地目录。
- 退出码：`0` 成功；`1` 拒绝或发现问题（预检不过、诊断发现问题）；`2` 用法错误。
- `enable` 先跑预检，不通过就打印 `refusing to install or switch anything` 并说明 profile 未被触碰——不存在「先装一半再发现」的路径；它写的状态文件 `dsh-local-overlay.state.json` 只有原 bundle 列表、构建身份、时间、包名与「改写了几条 `name` 守卫」，**不含**任何配置快照。
- `enable` 还会把实例自己 patch 里已有的 `- id: ui-settings` 覆盖行的 `name` 守卫改写成自有组件名（`config` 原样保留）：否则那条已经保存的配置会因为守卫不匹配而整条被跳过，用户会看到设置「自己变回去了」。`rollback` 做的是这句话的反向，并且只换掉自有组合这一项。
- 构建身份发现「哪份安装」时以**本进程的启动脚本**（`<install>/lib/bin.js`）为锚点，`DSH_INSTALL` 只是终端与测试调用方的显式覆盖，排在它后面：环境变量不能把门禁引向另一份获准安装而掩盖真正在跑的代码。
- 构建身份不符时先跑 `diagnose`：它会把安装层面的差异（版本、构建身份、缺失的包）与 profile 层面的差异（已装产物与记录里的 sha256 不一致，直接点名文件）分开列出。

## 组件回退

```bash
node tools/overlay.mjs rollback --home "$DSH_HOME" --profile proto
```

这条命令做的就是手工两步，顺序不能反，而且**不要删掉那条 patch**：

1. 把 profile `cordis.patch.yml` 里那条 `- id: ui-settings` 的 `name:` 守卫改回上游包名 `name: "@deepseek-ai/dsh-client-ui-settings"`（保留 `id`、`config` 与已经保存的配置）。
2. 把 `dsh.profile.bundles` 里的自有组合换成它顶掉的那个上游 roster：**只**从当前列表里摘掉 `@dsh-local-overlay/web-composition`，再把 `@deepseek-ai/dsh-web-app` 放回它原来的位置（默认回到 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`）。替换期间新增的其它层一律保持原样——回退不是把状态文件里记下的整份旧列表写回去，那种写法会把别人后来加的层一起删掉。

回退**只**撤销这两项——自有组合的选择与自有包的加载：不恢复任何整份配置快照，不删除凭据（它们在 `$DSH_HOME/.credentials.yaml`，全程没有被谁动过），也不回滚替换期间修改过的普通配置。加 `--remove-packages` 才会再把两个自有包从 profile 的 `node_modules` 里移除（默认保留，方便再次启用或继续诊断）。

为什么不能「只换 bundles」：patch 引擎对非 `insert` 的补丁只把 `name` 当守卫，名字不匹配时会警告 `patch: name mismatch for ... skipping` 并**整条跳过**，于是回去加载的原 provider 收不到 `enabled: false`，用户会看到设置「自己变回去了」，而 patch 文件里还留着我们的包名。

为什么不能「删掉 patch 或清成 `[]`」：那等于把已保存的实例配置（可能还有凭据）一起丢掉；ADR-0001 要求覆盖层可回退且回退后保留配置。改 `name` 守卫只是让这条 patch 重新指向上游 provider，`config` 里的值原样继续生效。

这条回退路径不是纸上说明：`--mode overlay` 的最后一步就用上面这条命令真实执行它，并断言保存的配置行本身原样留着（`id`、`config` 与值都没被改成快照里的旧值）、替换期间写的普通配置行仍在、测试凭据连**值**都逐字节未变且依旧只回 `configured` 标志、`bundles` 只换掉自有组合一项（同时装入的无关层保留），以及页面又只加载一个设置模块、且是上游包。

回退后打开远程页面时，那条保存的 override 会**原样留在文件里但不再被读取**：上游 provider 在非 loopback 页面上把状态留在页面内存里（与未替换的控制组逐项一致：首次打开为开，点一下只在页面里变关，刷新或重启后又回到开）。这正是「撤销替换」要达到的效果——原来的远程限制回来了，而实例配置一个字没丢；想让它重新生效就再 `enable` 一次。
