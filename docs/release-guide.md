# 发布使用说明：安装、切换、重启、升级复核与兜底

> 适用对象：在自己的单机实例上安装本覆盖层的操作者。
> 前提：实例是**单人所有**（ADR-0002），并且 DSH 本身是按基线身份安装的（见 §2）。
> 本仓不自动部署：所有命令都由人显式执行，`enable`/`rollback` 都要求 `--home`，本仓不会猜 home，
> 也不会去改既有的生产实例、Cloudflare、反向代理或真实认证。

## 1. 这套东西是什么（一句话）

`@dsh-local-overlay/dsh-client-ui-settings` 是上游设置提供者 `@deepseek-ai/dsh-client-ui-settings` 的**版本绑定替换**：
上游在非 loopback（已认证的远程）页面上把设置留在页面内存里，替换件让远程页面也用 Host 持久化，
而 loopback 页面上的行为**逐项不变**（见 [compatibility-report.md](compatibility-report.md) 的矩阵与本机列）。
`@dsh-local-overlay/web-composition` 是上游 `@deepseek-ai/dsh-web-app` 组合层的定点替换，只改了设置行指向的包名。

## 2. 基线身份：先核验，再谈安装

版本号相同**不足以**证明构建相同（ADR-0001）。本仓用三层证据把「同一构建」钉死：

| 证据 | 内容 | 判据 |
| --- | --- | --- |
| 包版本 | `@deepseek-ai/dsh@0.2.1-alpha.2` | 与 `provenance.json` 的 `baseline.version` 一致 |
| 上游来源 | 提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`，仓库 `deepseek-ai/deepseek-harness` | 与 `baseline.commit` / `baseline.repository` 一致 |
| 构建身份 | 16 个已记录包、308 个文件的 `sha256` 摘要 `bced54ff05f16443449162f00be33c2a0aea802d7f5046648262c0185942e321` | 由 `tools/verify-artifacts.mjs` 重算，逐文件 `sha256` 与 `expectedDiff` 一并核对 |

许可与归属：上游与基线均为 MIT，`Copyright (c) 2026 DeepSeek`；两个自有包各自带 `LICENSE`、`NOTICE` 与
`provenance.json`，逐文件记录来源位置、类型、`sha256` 与（对 3 个故意改动的文件）与该基线副本的完整 diff。

```bash
# 只看不改：核验当前安装是否就是被批准的构建
node tools/overlay.mjs preflight
# 等价的老入口（同一份 tools/lib/preflight.mjs 实现）
node tools/verify-artifacts.mjs
```

`preflight` 打印一份报告（包版本、身份摘要、逐文件核对结论）。**任何一项不符即退出码 1，并拒绝后续动作**；
`enable` 在安装任何东西、修改任何文件之前会先跑同一份预检（"one implementation, two entry points"），
所以"人手动跑的闸门"和"工具自己跑的闸门"是同一段代码。

## 3. 首次安装（全程终端，Web UI 打不开也能做）

```bash
# 3.1 核验基线（见 §2）；不通过就停在这里，什么都别装
node tools/overlay.mjs preflight

# 3.2 预检 → 打包 → 装两个自有包 → 把组合层就地换成自有组合包 → 写切换记录
node tools/overlay.mjs enable \
  --home "$DSH_HOME" \
  --profile proto \
  --install /path/to/@deepseek-ai/dsh \
  --artifacts /tmp/dsh-overlay-artifacts
```

`enable` 做的事，按顺序：

1. 跑共享预检（不通过就一个字节都不改，连包都不装）；
2. `npm pack` 出两个 tarball（默认落在临时目录，也可用 `--artifacts DIR` 自己指定）；
3. 用文档化的包管理器入口装包：`dsh plugin --profile proto add <tarball>`（两次）；
4. 把 `dsh.profile.bundles` 里的 `@deepseek-ai/dsh-web-app` **就地换成** `@dsh-local-overlay/web-composition`，
   期望读回 `["@deepseek-ai/dsh-base", "@dsh-local-overlay/web-composition"]`；
5. 写 `<profile>/dsh-local-overlay.state.json`（schema `dsh-local-overlay/state@1`，含 `enabledAt`、构建身份、
   两个包的包名、`previousBundles`、`switchedBundles`）。

第 4 步不能交给 `dsh plugin add` 自己做：`add` 只做**追加**，两个组合层同时加载就会出现两个 `ui-settings` 提供者。
这也是预检必须排在安装之前的原因——一旦装错了层，实例下次启动就同时加载两份设置面。

## 4. profile bundle 切换：语义与生效边界

- 组合层清单（`dsh.profile.bundles`）**只在实例启动时读取一次**，所以 `enable` / `rollback` 之后必须重启实例；
  刷新页面或重连传输都不够。
- 设置行的替换靠 profile patch 里的 `name` 守卫（`- id: ui-settings` + `name: "@dsh-local-overlay/dsh-client-ui-settings"`），
  同样在启动时匹配，所以它也跟着重启才生效。
- 读回现状（不会改任何东西）：

```bash
node tools/overlay.mjs status   --home "$DSH_HOME" --profile proto        # 当前 bundles、装没装、切换记录
node tools/overlay.mjs status   --home "$DSH_HOME" --profile proto --json # 机器可读
node tools/overlay.mjs diagnose --home "$DSH_HOME" --profile proto        # 为什么"没在服务"
```

## 5. 升级 DSH 之后：重新核验，而不是重新祈祷

升级上游后，版本号可能一样、构建身份一定不同。处理顺序：

1. `node tools/overlay.mjs preflight`（或 `diagnose`）应当**失败并说明哪一项不符**；这是设计行为（fail-closed），
   不是故障：在预检通过之前，本仓不会加载替换件。
2. 人复核新构建的差异，确认替换点在新构建里仍然存在、语义未变：组件里那一行持久化选择
   （上游 `ctx.remote.$host.isLoopback ? "host" : "memory"` → 替换件 `const persistence = "host"`），
   以及组合层里 `ui-settings` 那条 override 指向的包名。
3. 确认后刷新记录：`node tools/overlay.mjs record --adopt <path>`。`--adopt` 是**显式**声明「这个文件相对记录里的基线被故意改过」，而不是让工具自己把差异吞掉。刷新后的 `provenance.json` 进版本库，作为下一个被批准的构建身份。
4. 重跑验收：`DSH_PROFILE=e2e node tools/e2e-remote-settings.mjs --mode overlay` 和 `--mode control`，两条都绿、
   证据重新生成之后，才可以把它当成"这个构建也成立"。

替换件在运行时同样是**失败关闭**的，而且它**不会**自动退回上游：`apply()` 的第一句就是构建身份核验，一旦不符就抛错，
自有 provider 根本不会注册。后果是如实的——实例进程照常运行，但页面拿不到可用的设置界面，对该命名空间的写入被拒绝
（`settings/rejected`），既不假报成功，也不悄悄降级回上游那种"设置留在页面里"的行为（ADR-0003 末尾一节）。已保存的
实例配置与凭据在文件里原样保留，只是没人再读它。

所以升级的推荐顺序是**先回退、再升级、然后重新核验**：

1. 升级前：`rollback`（或先确认预检仍通过），让 profile 回到上游组合；
2. 升级 DSH；
3. 按上面四步重新核验、重新记录、`enable` 重新启用；
4. 如果没有先回退就升级了：页面上的设置界面会不可用，按上面第 1–3 步在终端恢复——`diagnose` 指出不符之处，
   `rollback` 退回原组合即可，不需要重装 DSH 本身。

## 6. Web UI 不可用时的终端兜底

什么时候会需要它：预检通过但运行期身份校验拒绝（替换件 `apply()` 的第一句就是 `assertBaselineIdentity()`，
锚在 `process.argv[1]`，没有环境变量或版本区间可以豁免）、页面 boot 失败、或者页面装上了错的组合层。

```bash
# 6.1 诊断：现在是哪个提供者在服务，为什么
node tools/overlay.mjs diagnose --home "$DSH_HOME" --profile proto

# 6.2 回退：把组合层与设置行的 provider 名放回去（只撤它自己改过的两处）
node tools/overlay.mjs rollback --home "$DSH_HOME" --profile proto

# 6.3 连包也一起卸（可选）
node tools/overlay.mjs rollback --home "$DSH_HOME" --profile proto --remove-packages

# 6.4 回退后重启实例，再打开页面复核
```

`rollback` 的边界要说清楚：它只恢复**加载的组合层**与**那条 override 的 provider 名**，
不恢复任何配置快照——实例在被替换期间积累的普通配置与测试凭据属于实例本身，回退后仍然在，
凭据文件权限保持 `600`。回退后原来的远程限制会回来：设置又只留在页面内存里，刷新即回默认，
而那条已经保存的 `enabled: false` 原样留在文件里但不再被读取。

如果连终端入口都跑不起来（DSH 安装损坏等），最后手段是手工两步：

```bash
# a) 把 dsh.profile.bundles 里的自有组合包换回上游组合包，期望得到：
#    ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
# b) 把 profile 的 cordis.patch.yml 里那条 id: ui-settings 的 name 守卫改回
#    "@deepseek-ai/dsh-client-ui-settings"（config 原样保留），或者把那条 override 整体留着但让它匹配不上——
#    匹配不上的 override 不会被读，但也不会被丢掉。
```

## 7. 部署前置条件（人工确认；本仓不自动改）

本覆盖层把"所有已认证访问端都能改实例配置"这件事从"只有 loopback 能"放宽到"已认证就能"，
这**只在单人实例**上是可接受的放大（ADR-0002）。上线前必须逐条人工确认：

| 检查 | 判据 | 本仓会不会代做 |
| --- | --- | --- |
| Cloudflare（或其它入口边界）只允许操作者自己的邮箱 | 在边界控制台人工核对 Access 策略，只有自己的邮箱在允许列表里 | **不会**；本仓不读也不改 Access 策略 |
| DSH 自身认证仍然保留 | 未带 token 访问返回 401/303；`/api` 上的 Host/Origin fence 与认证门禁都还在 | 不会；替换件只改设置提供者的持久化选择，认证与 fence 一行未动 |
| origin 不能被公网绕过 | 实例只绑 `127.0.0.1`（或在防火墙/隧道层只允许边界进），公网直连该端口不可达 | 不会；本仓不做公网绑定、不建隧道 |

```bash
# 例：确认实例没有绑到公网地址（只应看到 127.0.0.1 / ::1）
ss -ltnp | grep <port>
# 例：从公网直连该端口应该是"连不上"（超时/拒绝），而不是 401/200
# 注意 DSH 自身是明文 HTTP：要用 http:// 探，而且把 TLS/协议握手错误算作"连上了"，
# 它只说明端口可达，不能当成隔离成功
curl --max-time 5 -sv "http://<你的公网地址>:<port>/" 2>&1 | tail -5
```

**本轮没有在真实的 Cloudflare 边界之后做过这些检查**：本仓的验证跑在隔离的临时 home + 临时 profile 上，
只绑 `127.0.0.1`，用 `--trusted-host dsh-proto.test` 模拟非 loopback 来源（TCP 仍连本机）。
未完成的真实部署项逐条列在 §8。

## 8. 本轮未完成的真实部署检查（如实列出，不当成生产证明）

- 没有在真实域名 + 真实 TLS + Cloudflare Access 策略之后跑过：Access 的邮箱限制、tunnel/代理行为、真实证书链都未验证；
- 没有跨机器访问：实例只绑 loopback，验证中的"远程"只是浏览器 origin 与 Host 头非 loopback；
- 没有真实 DSH 账号登录，也没有驱动账号级设置命名空间（`llm-deepseek-account`、`ui-settings-account` 等，见兼容性报告的缺口表）；
- 没有在既有生产实例上执行过 `enable` / `rollback`：所有验证都用一次性 profile，跑完即丢；
- 没有多访问端并发写入的真实场景（多用户、多所有者的隔离与授权不在范围内，见 ADR-0002）。

因此：本仓的证据说明的是"在这个构建 + 这个配置下，替换的机制与边界行为是这些"，**不是**"在你的生产环境里不会出问题"。
隔离验证不能当作生产证明。

## 9. 实例级偏好的影响范围与原页面的已知限制

### 9.1 偏好从此属于实例

主题、语言、字号、工作明细展示、性能与用量、忙碌时的发送行为、新会话默认预设……这些行现在写的是**实例设置**
（profile 的 `cordis.patch.yml` 里对应命名空间的行），不是浏览器内存。后果：**一个访问端改了，其它访问端都会看到**——
刷新、重连、重启实例后读到的都是同一个值。单人实例上这是期望行为；只要还有别人能访问这个实例，它就是共享状态。

### 9.2 原页面自己的限制（本轮实测记录，未修补）

- **没有统一的保存提示**：菜单类行点完即写；插件配置页是草稿 + `Save`。两种语义并存，本仓**没有**把它们统一成一种流程；
- **没有原子事务**：一笔成功写入就是一笔 `settings/mutate` 或 `settings/update`；跨命名空间没有事务，也没有补偿。实测到的形状：provider 编辑器的一次应用会分两笔走——配置进 profile、凭据进凭据库——验收跑故意让第二笔失败（把凭据文件换成目录）时**第一笔已经落盘**，只有第二笔失败并在编辑器里报错（`evidence/overlay-evidence.json` 的 `modelsPage.partialSuccess`），没有回滚；
- **删除 provider 那一笔不带 revision 守卫**：页面发出的删除实测没有携带 `expectedRevision`（同上证据），所以它不是乐观并发写入；其余菜单类行与插件表单的保存都带着读到的 revision；
- **没有自动回滚**：设置 provider 与插件配置表单这两条路径上，写入被拒（revision 冲突、校验失败、传输断开）时页面就地报错，之前成功的那一笔不会撤销；要撤销一次已经落盘的设置只能**再写一次**（显式补偿写入）。终端入口 `rollback` 只移除本仓改动的两处，**不会**改回任何已保存的设置或凭据（ADR-0001）；
- **即时保存的偏好行不保证同样的文案反馈**：菜单、开关、方块这些行点完即写，写被拒时替换件的表单控制器会先把 Host 的当前值读回来再返回，页面**不一定**显示"保存失败"这类文案（实测见 `evidence/*-evidence.json` 的拒绝与恢复场景）。"有校验文案 + 禁用保存按钮"只对插件配置表单那条路径成立，两条路径没有统一；
- **校验反馈就是页面自己那段文案**：例如数字字段给出 `Enter a number, or leave blank to use the default.`，保存按钮同时禁用；
- **顺序写与并发**：同一行快速连点时，替换后的 provider 把写入**串行化**（后写覆盖前写，不做合并）；跨访问端没有锁，
  两个写入者拿着同一个 revision 时后者被拒（revision 守卫），页面显示冲突并且什么都不落盘；
- **两个设置行根本不写实例**：`When to Collapse Work Details` 与 `Keyboard shortcuts` 的点击不发出任何设置写，
  值只活在页面里（兼容性报告里把它们标成"非实例设置"，而不是假装它们被持久化了）。

### 9.3 新会话默认预设的写入路径与其他行不同

上面这些行写的是**设置 provider** 的命名空间（`settings/mutate`），而「设为新会话默认预设」走的是 Host 的
`settings/update`，**不经过设置 provider**。后果：**非 loopback 页面本来就能写它**——原组合如此（两种模式的对照跑里，
control 组在非 loopback 来源上唯一写进实例的命名空间就是它），替换件没有改变这一点。能力矩阵（兼容性报告 §5）
把这一格按模式与来源分别列出来，而不是把它算进「loopback 才能写」的那一类。

## 10. 想自己复现这套验证

```bash
# 两条验收跑（各用独立 profile，且不动当前会话所在的 profile）
DSH_PROFILE=e2e node tools/e2e-remote-settings.mjs --mode overlay
DSH_PROFILE=e2e node tools/e2e-remote-settings.mjs --mode control

# 用刚生成的证据渲染兼容性矩阵（默认打印到标准输出，--write 会替换文档里的标记块）
node tools/settings-report.mjs
node tools/settings-report.mjs --write
```

两条跑的差异就是"替换前 vs 替换后"：同样的点击、同样的断言，control 组用的是上游包，
overlay 组用的是替换件；证据分别是 `evidence/overlay-evidence.json` 与 `evidence/control-evidence.json`，
以及同名截图。
