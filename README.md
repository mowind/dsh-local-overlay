# dsh-local-overlay

在固定的 DSH 基线上，用**自有设置组件**加**自有 Web 组合包**的临时实例，验证一个可行性门槛：在**访问端**的原设置页上修改一个即时保存的设置，刷新、重新连接、实例重启后仍然保留。

对应 Issue #2；背景与边界见 [CONTEXT.md](CONTEXT.md) 与 [docs/adr/](docs/adr/)。本仓是验证覆盖层：它不改动安装中的 DSH，也不修改上游源码。

## 基线身份与许可

- 基线包：`@deepseek-ai/dsh` `0.2.1-alpha.2`
- 基线提交：`d743267388641bc76f17c45ce8b4c231aed1d32c`
- 上游项目：<https://github.com/deepseek-ai/deepseek-harness>，MIT，Copyright (c) 2026 DeepSeek
- 两个交付包的 `LICENSE` 是上游 MIT 许可证的逐字节副本；`NOTICE` 说明来源与改动；[provenance.json](provenance.json) 逐文件记录来源路径、sha256 与改动行的完整 diff。

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

以下步骤就是 [tools/e2e-remote-settings.mjs](tools/e2e-remote-settings.mjs) 在 `--mode overlay` 下自动执行的流程，可手工照做。

1. 准备一个隔离的实例 home（不触碰现有实例）：

   ```bash
   export DSH_HOME=$(mktemp -d /tmp/dsh-overlay-XXXX)/home
   mkdir -p "$DSH_HOME/profiles/proto"
   printf '[]\n' > "$DSH_HOME/profiles/proto/cordis.patch.yml"
   printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$DSH_HOME/profiles/proto/pnpm-workspace.yaml"
   printf '{"name":"dsh-profile-proto","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n' > "$DSH_HOME/profiles/proto/package.json"
   ```

2. 打包两个交付包（真实打包产物，不是源码导入）：

   ```bash
   cd packages/dsh-client-ui-settings && npm pack --pack-destination /tmp/dsh-overlay-artifacts
   cd ../dsh-web-composition     && npm pack --pack-destination /tmp/dsh-overlay-artifacts
   ```

3. 用文档化的 CLI 把两个包装进 profile（先装组件，再装组合包）：

   ```bash
   DSH_HOME="$DSH_HOME" dsh plugin --profile proto add /tmp/dsh-overlay-artifacts/dsh-local-overlay-dsh-client-ui-settings-0.1.0.tgz
   DSH_HOME="$DSH_HOME" dsh plugin --profile proto add /tmp/dsh-overlay-artifacts/dsh-local-overlay-web-composition-0.1.0.tgz
   ```

   先装组件是必须的：组合包的 roster 行要能从 profile 的 `node_modules` 解析到它。

4. 让 profile 加载自有组合包：把 `dsh.profile.bundles` 改为 `["@deepseek-ai/dsh-base", "@dsh-local-overlay/web-composition"]`（不再包含 `@deepseek-ai/dsh-web-app`）。

5. 运行来源预检（切换组合前的门禁）：

   ```bash
   node tools/verify-artifacts.mjs
   ```

   它要求已安装的 DSH 正好是记录的基线版本，并逐文件核对 sha256 与改动 diff；不匹配则退出码 1 并列出问题。

6. 启动实例（隔离 home，非 loopback 来源要显式声明为可信主机）：

   ```bash
   DSH_HOME="$DSH_HOME" dsh proto --host 127.0.0.1 --port 0 --no-open --trusted-host dsh-proto.test
   ```

   终端打印一行 `dsh web: http://127.0.0.1:<port>/?token=...`；把主机名换成 `dsh-proto.test` 就是访问端使用的地址。

7. 从访问端打开页面：把访问端的浏览器指向实例主机上可达的地址，例如 `http://dsh-proto.test:<port>/?token=...`（`dsh-proto.test` 需要解析到实例主机，或用你自己的域名加 `--trusted-host`）。

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

两个模式断言同一批事实：真实打包产物、由 CLI 装入隔离 profile、组合替换生效、从非 loopback 来源加载页面、远程页面不暴露主机配置编辑器入口、远程点击能被接受、持久化行为、刷新/重连/重启后的取值、控制台无异常，以及 6 项 fence/认证检查（`/api` 上可信 Host 与 loopback 都是 401，未知 Host 与跨站 Origin 是 403；文档带 token 是 303 加 `location: ./` 与 Set-Cookie，无 token 是 401）。证据写入 [evidence/](evidence/) 的 `<mode>-evidence.json` 与 `<mode>-NN-*.png` 截图，任一检查失败时退出码为 1。

`overlay` 模式在切换组合包之前会先跑来源预检；预检失败即中止，不会用未核对基线的副本继续验证。

最近一次记录（基线 `0.2.1-alpha.2` / `d7432673`）：`control` 19 项全部通过，`overlay` 24 项全部通过（多出的 5 项是来源预检与逐行断言）。两个模式都会在全部检查通过时才以退出码 0 结束。

## 已知行为差异与后果

- 远程页面会比原组合多出一个由 Host 提供的设置行 `Upload Session Log when using the official model API`：只有 Host 真正提供 `session-log-deepseek` 命名空间时它才出现，而 `"host"` 持久化正是这样。控制组的远程页面只有 1 个浏览器本地行，覆盖组是 2 行，这个差异是预期结果而不是缺陷。
- 非 loopback（已认证）页面从此可以直接修改实例配置：`ui-settings` 命名空间下的即时保存设置，以及上面那行 session-log 上传开关。这是「所有已认证访问端都属于同一所有者」这一单人假设下的预期写面。
- 主机配置编辑器入口仍然只在 loopback 页面上出现；远程页面拿到的 `remote.$host.isLoopback` 仍是真实的 `false`。

## 适用边界与未覆盖

- 只对记录的基线 `0.2.1-alpha.2` / `d7432673` 有效。换 DSH 版本必须重新生成副本、重算 `provenance.json` 并重跑证据。
- 不做所有者与访客的权限隔离；不改认证与 Host/Origin 检查；不提供多实例协调。

## 组件回退

把 profile 的 `dsh.profile.bundles` 恢复为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` 即可回到原设置组件；已保存的实例配置与凭据不受影响。
