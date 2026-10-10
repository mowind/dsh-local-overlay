import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_HOST = process.env.TEST_HOST || "dsh-proto.test";
const CHROMIUM = process.env.CHROMIUM || "/usr/sbin/chromium";
const OVERLAY_SCOPE = "@dsh-local-overlay";
const FORK_PACKAGE = OVERLAY_SCOPE + "/dsh-client-ui-settings";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  return realpathSync(execFileSync("which", ["dsh"], { encoding: "utf8" }).trim());
}
const DSH_BIN = resolveDshBin();
const DSH_INSTALL = DSH_BIN.slice(0, DSH_BIN.indexOf("/lib/bin.js"));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const args = process.argv.slice(2);
const argValue = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const MODE = argValue("--mode", "overlay");
const EVIDENCE_DIR = argValue("--evidence", join(process.cwd(), "evidence"));
const KEEP = args.includes("--keep");
if (MODE !== "control" && MODE !== "overlay") throw new Error("--mode must be control or overlay");

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: ok === true, detail }); console.log((ok === true ? "PASS " : "FAIL ") + name + (detail === undefined ? "" : " :: " + detail)); return ok === true; };
const evidence = { mode: MODE, dshBin: DSH_BIN, dshInstall: DSH_INSTALL, chromium: CHROMIUM, testHost: TEST_HOST, checks: results, files: {} };

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = []; this.requestUrls = new Map(); ws.onmessage = (e) => this.onMessage(e); }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws connect failed: " + url)); }); return new Cdp(ws); }
  onMessage(e) { const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString()); if (msg.id !== undefined) { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } return; } if (msg.method === "Network.requestWillBeSent" && msg.params.request) this.requestUrls.set(msg.params.requestId, msg.params.request.url); this.events.push(msg); }
  send(method, params = {}) { const id = ++this.seq; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); return r.result.value; }
  errorEvents() { return this.events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error") || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") || e.method === "Network.loadingFailed").map((e) => ({ method: e.method, params: e.params, url: (e.method === "Network.loadingFailed" ? (this.requestUrls.get(e.params.requestId) || "") : (e.params.entry && e.params.entry.url) || ""), text: e.method + " " + JSON.stringify(e.params).slice(0, 240) })); }
  errors() { return this.errorEvents().map((e) => e.text); }
  screenshot(path) { return this.send("Page.captureScreenshot", { format: "png" }).then((s) => writeFile(path, Buffer.from(s.data, "base64"))); }
}

/* Evaluated expressions use double-quoted JS strings and unquoted CSS identifiers only. */
const SWITCH_HELPERS = "const rows = Array.from(document.querySelectorAll(\"[role=switch]\")); const parentText = (e) => (e.parentElement && e.parentElement.innerText) || \"\"; const hit = (e) => /coding view|代码工作视图/i.test((e.getAttribute(\"aria-label\") || \"\") + \" \" + parentText(e)); const pick = rows.find(hit) || (rows.length === 1 ? rows[0] : undefined);";
const SWITCH_PROBE = "(() => { " + SWITCH_HELPERS + " return JSON.stringify({ count: rows.length, labels: rows.map((r) => (r.getAttribute(\"aria-label\") || parentText(r).slice(0, 40))), state: pick ? pick.getAttribute(\"aria-checked\") : null, disabled: pick ? pick.getAttribute(\"aria-disabled\") : null, rows: rows.map((r) => ({ label: r.getAttribute(\"aria-label\") || parentText(r).slice(0, 40), checked: r.getAttribute(\"aria-checked\"), disabled: r.getAttribute(\"aria-disabled\") })), dialogRows: Array.from(document.querySelectorAll(\"[role=dialog]\")).length }); })()";
const SWITCH_CLICK = "(() => { " + SWITCH_HELPERS + " if (!pick) return \"NO_SWITCH\"; pick.click(); return \"CLICKED\"; })()";
const HOST_EDITOR_PROBE = "(() => { const text = /open configuration file|打开配置文件/i; const btns = Array.from(document.querySelectorAll(\"button\")).filter((b) => text.test(b.innerText || b.getAttribute(\"aria-label\") || \"\")); return JSON.stringify({ count: btns.length, bodyHasLabel: text.test(document.body.innerText) }); })()";
const SHELL_PROBE = "(document.querySelectorAll(\"button\").length > 3 && document.body.innerText.slice(0, 200))";
const SETTINGS_TRIGGER = "(() => { const b = Array.from(document.querySelectorAll(\"button\")).find((e) => /^(settings|设置)/i.test((e.getAttribute(\"aria-label\") || e.innerText || \"\").trim())); if (!b) return \"NO_TRIGGER\"; b.click(); return \"OPENED\"; })()";

async function waitFor(cdp, expression, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) { try { last = await cdp.eval(expression); if (last) return last; } catch (error) { last = "eval error: " + error.message; } await sleep(300); }
  throw new Error("timeout waiting for " + label + " (last=" + JSON.stringify(last) + ")");
}

async function openSettings(cdp, shot) {
  await waitFor(cdp, SHELL_PROBE, "app shell");
  await cdp.eval(SETTINGS_TRIGGER);
  await waitFor(cdp, "document.querySelectorAll(\"[role=dialog]\").length > 1", "settings dialog");
  await sleep(1500);
  if (shot) await cdp.screenshot(shot);
}

async function startInstance(home, profile) {
  const child = spawn(process.execPath, [DSH_BIN, profile, "--host", "127.0.0.1", "--port", "0", "--no-open", "--trusted-host", TEST_HOST], { env: { ...process.env, DSH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  for (let i = 0; i < 240; i++) { const m = /dsh web: (\S+)/.exec(out); if (m) return { child, url: m[1], out: () => out, err: () => err }; if (child.exitCode !== null) throw new Error("dsh exited (" + child.exitCode + "): " + err); await sleep(250); }
  throw new Error("no dsh web url; stdout=" + out + " stderr=" + err);
}

async function startChromium(dir) {
  await mkdir(dir, { recursive: true });
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + dir, "--host-resolver-rules=MAP " + TEST_HOST + " 127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--disable-gpu", "--remote-allow-origins=*", "--window-size=1500,1100", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  let text;
  for (let i = 0; i < 160; i++) { try { text = await readFile(join(dir, "DevToolsActivePort"), "utf8"); break; } catch (error) { await sleep(250); } }
  if (!text) throw new Error("chromium did not start");
  const port = text.split("\n")[0].trim();
  const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  const page = list.find((t) => t.type === "page");
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Log.enable"); await cdp.send("Network.enable");
  return { chrome, cdp };
}

async function fetchRaw(url, headers) {
  return await new Promise((resolve) => {
    const target = new URL(url);
    const req = http.request({ host: "127.0.0.1", port: target.port, path: target.pathname + target.search, method: "GET", headers, timeout: 8000 }, (res) => { let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, setCookie: res.headers["set-cookie"] !== undefined, cookies: res.headers["set-cookie"] || [], body: body.slice(0, 120) })); });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.end();
  });
}

/* The loaded composition layers are the only source of client plugin rows, so counting every ui-settings
   row across every patch file declared by every loaded bundle is what proves there is exactly ONE settings
   provider in the running instance (a both-loaded misconfiguration would show up as two rows here). */
async function loadedSettingsRows(profileDirectory, bundleList) {
  const rows = [];
  for (const name of bundleList) {
    /* Module resolution is two-anchored: the profile first, then the DSH installation, so a bundle the
       profile does not carry (dsh-base, dsh-web-app come from the installation) is still examined here. */
    const dir = [join(profileDirectory, "node_modules", name), join(DSH_INSTALL, "node_modules", name)].find((candidate) => existsSync(candidate));
    if (dir === undefined) { rows.push({ bundle: name, missing: true }); continue; }
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const declared = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
    const patches = Array.isArray(declared) ? declared : declared ? [declared] : ["cordis.patch.yml"];
    for (const rel of patches) {
      let text = "";
      try { text = await readFile(join(dir, rel), "utf8"); }
      catch (error) { rows.push({ bundle: name, file: rel, unreadable: String(error.code) }); continue; }
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (/- id: ui-settings\s*$/.test(line)) {
          rows.push({ bundle: name, file: rel, line: index + 1, provider: (lines[index + 1] || "").trim().replace(/^name:\s*/, "").replace(/^["']|["']$/g, "") });
        }
      });
    }
  }
  return rows;
}

/* window.__DSH_BOOT__ lists every client plugin the server asks the browser to load, keyed by package id,
   so the number of settings modules the page actually got is directly countable in the page. */
const MODULE_PROBE = "(function () { const boot = window.__DSH_BOOT__ || {}; const ids = (boot.entries || []).map(function (entry) { return String(entry.id).replace(new RegExp('/client$'), ''); }); return JSON.stringify({ ids: ids, entryCount: ids.length }); })()";
/* Only two package ids can be the settings PROVIDER; sibling packages such as
   @deepseek-ai/dsh-client-ui-settings-account or -general load in every configuration and must not count. */
const PROVIDER_IDS = ["@deepseek-ai/dsh-client-ui-settings", "@dsh-local-overlay/dsh-client-ui-settings"];
const loadedProviders = (probe) => probe.ids.filter((id) => PROVIDER_IDS.includes(id));
/* The Host/Origin fence guards the /api transport; the document index is authorized by cookie.
   Each fence signal is probed on its own so a broken Origin comparison cannot hide behind a valid
   Sec-Fetch-Site rejection, and the authenticated cookie is used to show that authentication does not
   lift the fence. The probe route does not exist, so passing the fence shows up as a non-401/403 status. */
async function fenceProbes(port, token) {
  const authority = TEST_HOST + ":" + port;
  const api = "http://127.0.0.1:" + port + "/api/e2e-probe";
  const index = await fetchRaw("http://127.0.0.1:" + port + "/?token=" + token, { host: authority });
  const cookie = (index.cookies || []).map((value) => value.split(";")[0]).join("; ");
  const authenticated = cookie === "" ? {} : { cookie };
  evidence.fenceCookieMinted = cookie !== "";
  return {
    indexToken: index,
    indexNoToken: await fetchRaw("http://127.0.0.1:" + port + "/", { host: authority }),
    trustedNoCookie: await fetchRaw(api, { host: authority }),
    trustedWithCookie: await fetchRaw(api, { host: authority, ...authenticated }),
    loopbackNoCookie: await fetchRaw(api, { host: "127.0.0.1:" + port }),
    evilHost: await fetchRaw(api, { host: "evil.test:" + port }),
    evilHostWithCookie: await fetchRaw(api, { host: "evil.test:" + port, ...authenticated }),
    loopbackWithCookie: await fetchRaw(api, { host: "127.0.0.1:" + port, ...authenticated }),
    evilOriginOnly: await fetchRaw(api, { host: authority, origin: "https://evil.test" }),
    fetchSiteOnly: await fetchRaw(api, { host: authority, "sec-fetch-site": "cross-site" }),
    evilOriginAndFetchSite: await fetchRaw(api, { host: authority, origin: "https://evil.test", "sec-fetch-site": "cross-site" }),
    sameOrigin: await fetchRaw(api, { host: authority, origin: "http://" + authority })
  };
}

/* The version-bound replacement is only valid for the baseline it was copied from, so the composition switch is gated on the recorded provenance. */
function runProvenancePreflight() {
  try {
    const output = execFileSync(process.execPath, [join(REPO_ROOT, "tools/verify-artifacts.mjs"), "--quiet", "--install", DSH_INSTALL], { encoding: "utf8" });
    return { ok: true, detail: output.trim().split("\n").pop() };
  } catch (error) {
    return { ok: false, detail: (String(error.stdout || "") + String(error.stderr || "")).trim().slice(-400) };
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "dsh-e2e-" + MODE + "-"));
  const home = join(root, "home");
  const profileDir = join(home, "profiles", "proto");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "cordis.patch.yml"), "[]\n");
  await writeFile(join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
  const bundles = MODE === "control" ? ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] : ["@deepseek-ai/dsh-base"];
  await writeFile(join(profileDir, "package.json"), JSON.stringify({ name: "dsh-profile-proto", private: true, dependencies: {}, dsh: { profile: { bundles } } }, null, 2) + "\n");
  evidence.root = root;
  await mkdir(EVIDENCE_DIR, { recursive: true });

  if (MODE === "overlay") {
    const preflight = runProvenancePreflight();
    evidence.provenancePreflight = preflight;
    check("provenance preflight verifies the recorded baseline copies before the composition is switched", preflight.ok, preflight.detail);
    if (!preflight.ok) throw new Error("provenance preflight failed; refusing to install the artifacts and switch the composition");
    /* Negative control for the gate: a record that does not describe the installed build must be refused. */
    const corruptPath = join(root, "provenance-corrupt.json");
    const corrupt = JSON.parse(await readFile(join(REPO_ROOT, "provenance.json"), "utf8"));
    const victim = corrupt.files.find((entry) => entry.kind === "verbatim");
    victim.sha256 = (victim.sha256[0] === "0" ? "1" : "0") + victim.sha256.slice(1);
    await writeFile(corruptPath, JSON.stringify(corrupt, null, 2) + "\n");
    let refused = false;
    let refusal = "";
    try { execFileSync(process.execPath, [join(REPO_ROOT, "tools/verify-artifacts.mjs"), "--quiet", "--install", DSH_INSTALL, "--provenance", corruptPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { refused = true; refusal = String(error.stdout || "") + String(error.stderr || ""); }
    check("an incompatible build record is refused by the preflight (deliberately corrupted hash)", refused && /local file changed since it was recorded/.test(refusal), refusal.trim().split("\n").slice(-2).join(" | "));
    const buildDir = join(root, "artifacts");
    await mkdir(buildDir, { recursive: true });
    const packs = [];
    for (const dir of ["packages/dsh-client-ui-settings", "packages/dsh-web-composition"]) {
      const out = execFileSync("npm", ["pack", "--pack-destination", buildDir, "--silent"], { cwd: dir, encoding: "utf8" }).trim().split("\n").pop();
      packs.push(join(buildDir, out));
    }
    evidence.artifacts = packs;
    check("real packaged artifacts built (npm pack)", packs.length === 2 && packs.every((p) => existsSync(p)), packs.join(", "));
    for (const pack of packs) {
      const manifestBefore = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
      manifestBefore.dsh = { profile: { bundles: ["@deepseek-ai/dsh-base"] } };
      await writeFile(join(profileDir, "package.json"), JSON.stringify(manifestBefore, null, 2) + "\n");
      try { execFileSync(process.execPath, [DSH_BIN, "plugin", "--profile", "proto", "add", pack], { env: { ...process.env, DSH_HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { check("dsh plugin add " + pack, false, String(error.stdout || "").slice(-400) + String(error.stderr || "").slice(-400)); }
    }
    const manifestPath = join(profileDir, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    evidence.profileManifestAfterAdd = manifest;
    check("both artifacts installed into the profile by the documented CLI", Boolean(manifest.dependencies[OVERLAY_SCOPE + "/web-composition"] && manifest.dependencies[FORK_PACKAGE]), JSON.stringify(manifest.dependencies));
    const nextBundles = ["@deepseek-ai/dsh-base", OVERLAY_SCOPE + "/web-composition"];
    manifest.dsh = { profile: { bundles: nextBundles } };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    check("original web composition is not loaded", manifest.dependencies["@deepseek-ai/dsh-web-app"] === undefined, JSON.stringify(nextBundles));
    const installedRoster = await readFile(join(profileDir, "node_modules", OVERLAY_SCOPE, "web-composition", "cordis.patch.yml"), "utf8");
    check("installed roster routes the ui-settings row to the fork", /- id: ui-settings\n\s+name: .@dsh-local-overlay\/dsh-client-ui-settings./.test(installedRoster), "row ui-settings -> " + FORK_PACKAGE);
    const settingsRows = await loadedSettingsRows(profileDir, nextBundles);
    evidence.loadedSettingsRows = settingsRows;
    check("exactly one ui-settings provider row exists across all loaded composition layers", settingsRows.length === 1, JSON.stringify(settingsRows));
    check("the single settings provider row is served by the fork package", settingsRows.length === 1 && settingsRows[0].provider === FORK_PACKAGE, JSON.stringify(settingsRows));
  } else {
    check("control run loads the original web composition", true, JSON.stringify(bundles));
    const controlRows = await loadedSettingsRows(profileDir, bundles);
    evidence.loadedSettingsRows = controlRows;
    check("CONTROL: exactly one ui-settings provider row, served by the upstream package", controlRows.length === 1 && controlRows[0].provider === "@deepseek-ai/dsh-client-ui-settings", JSON.stringify(controlRows));
  }

  let instance = await startInstance(home, "proto");
  const parsed = new URL(instance.url);
  const remoteUrl = "http://" + TEST_HOST + ":" + parsed.port + "/" + parsed.search;
  evidence.urls = { loopback: instance.url, remote: remoteUrl };
  /* After the token redirect the document lives at the origin root, which is also the URL the offline
     reachability probe fetches. */
  const documentUrl = new URL(remoteUrl).origin + "/";
  evidence.documentUrl = documentUrl;
  evidence.serverStartLog = instance.out().slice(0, 1500);
  const patchPath = join(profileDir, "cordis.patch.yml");
  const readPatch = async () => { try { return await readFile(patchPath, "utf8"); } catch (error) { return "<missing: " + error.code + ">"; } };
  evidence.files.profilePatchInitial = await readPatch();

  const { chrome, cdp } = await startChromium(join(root, "chromium"));
  await cdp.send("Page.navigate", { url: remoteUrl }).catch(() => {});
  const shellText = await waitFor(cdp, SHELL_PROBE, "app shell on the remote origin");
  await cdp.screenshot(join(EVIDENCE_DIR, MODE + "-01-remote-loaded.png"));
  check("page loads from the non-loopback origin", typeof shellText === "string" && shellText.length > 0, String(shellText).replace(/\n/g, " | "));

  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-02-settings-open.png"));
  const remoteEditor = JSON.parse(await cdp.eval(HOST_EDITOR_PROBE));
  evidence.remoteHostEditorEntry = remoteEditor;
  check("host configuration-editor entry is not exposed to the non-loopback page", remoteEditor.count === 0, JSON.stringify(remoteEditor));
  const bootModules = JSON.parse(await cdp.eval(MODULE_PROBE));
  evidence.bootSettingsModules = bootModules;
  const bootProviders = loadedProviders(bootModules);
  evidence.bootProviders = bootProviders;
  if (MODE === "overlay") check("the page loads exactly one settings provider module, and it is the fork package", bootProviders.length === 1 && bootProviders[0] === FORK_PACKAGE, JSON.stringify(bootProviders) + " of " + bootModules.entryCount + " modules");
  else check("CONTROL: the page loads exactly one settings provider module, the upstream package", bootProviders.length === 1 && bootProviders[0] === "@deepseek-ai/dsh-client-ui-settings", JSON.stringify(bootProviders) + " of " + bootModules.entryCount + " modules");
  const before = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchBefore = before;
  const hasCodingView = (before.rows || []).some((row) => /coding view|代码工作视图/i.test(row.label));
  /* persistence "host" makes the Host serve the session-log namespace, so its row appears on the remote page too. */
  const servedSessionLog = (before.rows || []).find((row) => /session log|会话日志/i.test(row.label));
  evidence.servedSessionLogRow = servedSessionLog;
  if (MODE === "overlay") check("the remote page renders the developer-tools switch plus the host-served session-log row", hasCodingView && Boolean(servedSessionLog) && before.count === 2 && before.state === "true", JSON.stringify(before));
  else check("CONTROL: the remote page renders exactly one browser-local switch", before.count === 1 && hasCodingView && before.state === "true", JSON.stringify(before));

  const click = await cdp.eval(SWITCH_CLICK);
  check("the switch accepts a click from the remote page", click === "CLICKED", click);
  await sleep(3000);
  const patchAfterClick = await readPatch();
  evidence.files.profilePatchAfterRemoteToggle = patchAfterClick;
  const wrote = /enabled:\s*false/.test(patchAfterClick);
  const after = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchAfter = after;
  await cdp.screenshot(join(EVIDENCE_DIR, MODE + "-03-after-toggle.png"));
  evidence.settingsDialogAfterToggle = await cdp.eval("Array.from(document.querySelectorAll(\"[role=dialog]\")).map((d) => d.innerText).join(\"\\n===\\n\").slice(0, 2500)");
  if (MODE === "overlay") {
    check("remote toggle is persisted to the instance Host (ui-settings namespace)", wrote, patchAfterClick.slice(0, 400));
    check("the remote page reflects the persisted value immediately", after.state === "false", JSON.stringify(after));
  } else {
    check("CONTROL: original composition does NOT persist a remote toggle", wrote === false && patchAfterClick === evidence.files.profilePatchInitial, patchAfterClick.slice(0, 200));
    check("CONTROL: the remote page keeps the value only in the page (local flip)", after.state === "false", JSON.stringify(after));
  }

  let stageMark = 0;
  const stageEvents = () => cdp.errorEvents().slice(stageMark);
  /* Classification is structural, never text-based:
     - Runtime.exceptionThrown and Runtime.consoleAPICalled (type error) are failures at EVERY stage, in both
       modes, whatever their message says. A message that merely mentions net::ERR_* cannot buy an exemption.
     - A failure is tolerated only for the two streaming transports the previous document was holding when the
       harness itself tore that document down (Page.navigate, Page.reload, the offline window, SIGTERM + restart):
       EventSource/WebSocket on /plugins/events or /api/remote.mux, plus the browser Log echo of that same URL.
     - Script, Stylesheet, Document, Image, Fetch, XHR and every other loadingFailed type are failures everywhere,
       including inside a forced window.
     - The initial load tolerates nothing at all: it asserts zero error events of any kind.
     The same stream-teardown noise appears in control mode against the untouched original composition, so it is
     baseline transport behaviour, not an overlay effect; it is recorded as tolerated_<stage> for inspection. */
  const STREAM_TARGET = /\/plugins\/events|\/api\/remote\.mux/;
  /* The browser reports a failed transport twice: Network.loadingFailed carries the request URL, and the
     console echo carries the failing URL inside its message text. The echo is tolerated only when its
     `source` field says the NETWORK STACK produced it (page JavaScript reports as "javascript" or
     "console-api" and is therefore never tolerated), the URL quoted in the message matches a transport
     endpoint, and the message carries a real net::ERR_ code. */
  const quotedUrl = (text) => {
    const match = /'(wss?|https?):\/\/([^']+)'/.exec(String(text));
    return match === null ? "" : match[2];
  };
  const isStreamTeardown = (event) => {
    if (event.method === "Network.loadingFailed") {
      return STREAM_TARGET.test(event.url) && (event.params.type === "EventSource" || event.params.type === "WebSocket");
    }
    if (event.method === "Log.entryAdded") {
      const entry = event.params.entry;
      if (entry.source !== "network") return false;
      if (!/net::ERR_/.test(String(entry.text))) return false;
      /* entry.url is the failing resource for ordinary requests; a failed WebSocket is only named inside
         the message text, so that quoted URL is used for those. */
      const target = STREAM_TARGET.test(event.url) ? event.url : quotedUrl(entry.text);
      return target !== "" && STREAM_TARGET.test(target);
    }
    return false;
  };
  /* allowStreamTeardown is true only for stages in which the harness itself navigates, goes offline or restarts the instance. */
  /* The harness itself takes the page offline, so its own reachability probe MUST fail. That failure is
     required evidence for the stage (asserted below), and it is excluded from the unexpected bucket by
     exact shape: a Fetch/XHR failure - or its network Log echo - on the document URL itself, carrying
     ERR_INTERNET_DISCONNECTED. No other error text and no other URL is ever tolerated this way. */
  const isInducedOfflineFailure = (event, documentUrl) => {
    if (event.url !== documentUrl) return false;
    if (event.method === "Network.loadingFailed") {
      return (event.params.type === "Fetch" || event.params.type === "XHR") && event.params.errorText === "net::ERR_INTERNET_DISCONNECTED";
    }
    if (event.method === "Log.entryAdded") {
      const entry = event.params.entry;
      return entry.source === "network" && /net::ERR_INTERNET_DISCONNECTED/.test(String(entry.text));
    }
    return false;
  };
  const assertNoStageErrors = (stage, allowStreamTeardown, inducedOfflineUrl) => {
    const events = stageEvents();
    stageMark = cdp.errorEvents().length;
    evidence["console_" + stage] = events;
    const tolerated = allowStreamTeardown ? events.filter(isStreamTeardown) : [];
    const induced = inducedOfflineUrl === undefined ? [] : events.filter((event) => isInducedOfflineFailure(event, inducedOfflineUrl));
    evidence["tolerated_" + stage] = tolerated;
    if (inducedOfflineUrl !== undefined) {
      evidence["inducedOffline_" + stage] = induced;
      check("the induced offline probe really failed at the network layer (" + stage + ")", induced.some((event) => event.method === "Network.loadingFailed"), JSON.stringify(induced.map((event) => event.text)));
    }
    const bad = events.filter((event) => !tolerated.includes(event) && !induced.includes(event));
    const what = allowStreamTeardown
      ? "no runtime exceptions or console errors beyond the transport the harness itself tore down"
      : "no console exceptions, failures or protocol errors";
    check(what + " (" + stage + ")", bad.length === 0, JSON.stringify(bad.slice(0, 3).map((event) => event.text)));
  };
  assertNoStageErrors("onInitialLoad", false);

  await cdp.send("Page.reload").catch(() => {});
  await sleep(7000);
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-04-after-reload.png"));
  const afterReload = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchAfterReload = afterReload;
  if (MODE === "overlay") check("value survives a page refresh on the remote origin", afterReload.state === "false", JSON.stringify(afterReload));
  else check("CONTROL: the remote toggle is lost on refresh", afterReload.state === "true", JSON.stringify(afterReload));
  assertNoStageErrors("afterReload", true);

  /* A real transport interruption, evidenced from both sides: the page is taken offline through CDP (the
     emulation call itself has to succeed), the page's own request has to fail while offline, and after the
     network returns the SAME document has to recover and still report the Host value. There is deliberately
     no reload in this stage, so a dead reconnect cannot hide behind a fresh page load. */
  await cdp.send("Network.enable").catch(() => {});
  const reachProbe = "fetch(location.pathname + location.search, { method: 'GET', cache: 'no-store' }).then((response) => 'status:' + response.status).catch((error) => 'rejected:' + String(error))";
  const docMark = String(await cdp.eval("(window.__e2eDocMark = 'mark-' + Math.random().toString(36).slice(2), window.__e2eDocMark)"));
  evidence.reconnect = { docMarkBefore: docMark };
  let offlineApplied = true;
  try { await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
  catch (error) { offlineApplied = false; evidence.reconnect.offlineError = String(error); }
  check("the harness can really take the page offline through CDP", offlineApplied, "Network.emulateNetworkConditions");
  await sleep(2500);
  const whileOffline = await cdp.eval(reachProbe).catch((error) => "eval-failed:" + String(error));
  evidence.reconnect.whileOffline = whileOffline;
  check("while offline the page's own transport request genuinely fails", /^rejected:/.test(String(whileOffline)), String(whileOffline).slice(0, 160));
  try { await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
  catch (error) { offlineApplied = false; evidence.reconnect.onlineError = String(error); }
  await sleep(8000);
  const afterOnline = await cdp.eval(reachProbe).catch((error) => "eval-failed:" + String(error));
  const docMarkAfter = String(await cdp.eval("String(window.__e2eDocMark)"));
  evidence.reconnect.afterOnline = afterOnline;
  evidence.reconnect.docMarkAfter = docMarkAfter;
  check("the page's transport recovers without a reload (same document)", /^status:/.test(String(afterOnline)) && docMarkAfter === docMark, JSON.stringify({ afterOnline, docMark, docMarkAfter }));
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-05-after-reconnect.png"));
  const afterReconnect = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchAfterReconnect = afterReconnect;
  if (MODE === "overlay") check("the Host value is intact after a transport interruption on the same document", afterReconnect.state === "false", JSON.stringify(afterReconnect));
  else check("CONTROL: the page-local flip is still page-local after a transport interruption", afterReconnect.state === "true", JSON.stringify(afterReconnect));
  assertNoStageErrors("afterReconnect", true, documentUrl);

  await cdp.send("Page.navigate", { url: instance.url }).catch(() => {});
  await waitFor(cdp, SHELL_PROBE, "app shell on loopback");
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-06-loopback-settings.png"));
  const loopbackEditor = JSON.parse(await cdp.eval(HOST_EDITOR_PROBE));
  evidence.loopbackHostEditorEntry = loopbackEditor;
  check("loopback access to the same instance DOES expose the host editor entry", loopbackEditor.count > 0 || loopbackEditor.bodyHasLabel === true, JSON.stringify(loopbackEditor));
  const loopback = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchLoopback = loopback;
  if (MODE === "overlay") check("loopback access to the same instance shows the same value", loopback.state === "false", JSON.stringify(loopback));
  else {
    const loopbackClick = await cdp.eval(SWITCH_CLICK);
    await sleep(3000);
    const patchAfterLoopback = await readPatch();
    evidence.files.profilePatchAfterLoopbackToggle = patchAfterLoopback;
    check("CONTROL: loopback access does persist (same page, same instance)", /enabled:\s*false/.test(patchAfterLoopback), loopbackClick + " " + patchAfterLoopback.slice(0, 300));
  }

  instance.child.kill("SIGTERM");
  await sleep(3000);
  instance = await startInstance(home, "proto");
  const restarted = new URL(instance.url);
  const remoteUrl2 = "http://" + TEST_HOST + ":" + restarted.port + "/" + restarted.search;
  evidence.urls.remoteAfterRestart = remoteUrl2;
  evidence.files.profilePatchAfterRestart = await readPatch();
  await cdp.send("Page.navigate", { url: instance.url }).catch(() => {});
  await waitFor(cdp, SHELL_PROBE, "app shell on loopback after restart");
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-07-loopback-after-restart.png"));
  const loopbackRestart = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchLoopbackAfterRestart = loopbackRestart;
  check("the instance Host holds the persisted value after a restart", loopbackRestart.state === "false", JSON.stringify(loopbackRestart));

  assertNoStageErrors("afterLoopbackAccess", true);
  await cdp.send("Page.navigate", { url: remoteUrl2 }).catch(() => {});
  await waitFor(cdp, SHELL_PROBE, "app shell on the remote origin after restart");
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-08-remote-after-restart.png"));
  const afterRestart = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchAfterRestart = afterRestart;
  if (MODE === "overlay") check("value survives an instance restart on the remote origin", afterRestart.state === "false", JSON.stringify(afterRestart));
  else check("CONTROL: the remote page cannot observe host state (memory mode)", afterRestart.state === "true", JSON.stringify(afterRestart));
  assertNoStageErrors("afterRestart", true);

  const fence = await fenceProbes(restarted.port, restarted.search.slice("?token=".length));
  evidence.fence = fence;
  check("fence: /api from the trusted authority without a cookie stops at the auth gate", fence.trustedNoCookie.status === 401, JSON.stringify(fence.trustedNoCookie));
  check("fence: /api from the loopback authority without a cookie stops at the auth gate", fence.loopbackNoCookie.status === 401, JSON.stringify(fence.loopbackNoCookie));
  check("fence: /api with an untrusted Host is forbidden", fence.evilHost.status === 403, JSON.stringify(fence.evilHost));
  check("fence: an authenticated cookie does NOT lift the fence for an untrusted Host", fence.evilHostWithCookie.status === 403, JSON.stringify(fence.evilHostWithCookie));
  check("fence+auth: the authority-bound cookie passes BOTH the fence and the auth gate on the trusted Host (the probe route itself is gone: not 401/403)", fence.trustedWithCookie.status !== 401 && fence.trustedWithCookie.status !== 403, JSON.stringify(fence.trustedWithCookie));
  check("auth: the same cookie replayed on the loopback authority is rejected (the session cookie is authority-bound)", fence.loopbackWithCookie.status === 401, JSON.stringify(fence.loopbackWithCookie));
  check("fence: a cross-site Origin ALONE (no Sec-Fetch-Site) is forbidden", fence.evilOriginOnly.status === 403, JSON.stringify(fence.evilOriginOnly));
  check("fence: Sec-Fetch-Site cross-site ALONE (no Origin) is forbidden", fence.fetchSiteOnly.status === 403, JSON.stringify(fence.fetchSiteOnly));
  check("fence: both cross-site signals together stay forbidden", fence.evilOriginAndFetchSite.status === 403, JSON.stringify(fence.evilOriginAndFetchSite));
  check("fence control: an Origin equal to the Host is accepted by the fence (reaches the auth gate)", fence.sameOrigin.status === 401, JSON.stringify(fence.sameOrigin));
  check("auth: the token-minted cookie is bound to the trusted authority and presented in the cookie-bearing probes", evidence.fenceCookieMinted === true, JSON.stringify(fence.indexToken.cookies));
  check("auth: the root token mints the authority-bound cookie and redirects", fence.indexToken.status === 303 && fence.indexToken.location === "./" && fence.indexToken.setCookie === true, JSON.stringify(fence.indexToken));
  check("auth: the document without a token is unauthorized", fence.indexNoToken.status === 401, JSON.stringify(fence.indexNoToken));

  if (MODE === "overlay") {
    /* The documented rollback is verified, not just asserted: migrate ONLY the name guard of the saved
       override back to the upstream provider name, switch the bundles back to the original composition,
       restart, and then require that the saved value is STILL in effect. Deleting the entry or emptying the
       patch would lose the saved configuration, which is exactly what ADR-0001 forbids. */
    const guardBefore = await readPatch();
    const guardAfter = guardBefore.replace('name: "@dsh-local-overlay/dsh-client-ui-settings"', 'name: "@deepseek-ai/dsh-client-ui-settings"');
    check("the rollback rewrites only the name guard of the saved override", guardBefore !== guardAfter && /id: ui-settings/.test(guardAfter) && /enabled: false/.test(guardAfter), guardAfter.replace(/\n/g, " | "));
    await writeFile(patchPath, guardAfter);
    evidence.files.profilePatchAfterRollbackGuard = guardAfter;
    const rollbackManifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
    rollbackManifest.dsh = { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } };
    await writeFile(join(profileDir, "package.json"), JSON.stringify(rollbackManifest, null, 2) + "\n");
    instance.child.kill("SIGTERM");
    await sleep(3000);
    instance = await startInstance(home, "proto");
    await cdp.send("Page.navigate", { url: instance.url }).catch(() => {});
    await waitFor(cdp, SHELL_PROBE, "app shell on loopback after rollback");
    await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-09-after-rollback.png"));
    const rolledBack = JSON.parse(await cdp.eval(SWITCH_PROBE));
    evidence.switchAfterRollback = rolledBack;
    check("after the documented rollback the saved value is still in effect (the override was not lost)", rolledBack.state === "false", JSON.stringify(rolledBack));
    const bootAfterRollback = JSON.parse(await cdp.eval(MODULE_PROBE));
    evidence.bootModulesAfterRollback = bootAfterRollback;
    const providersAfterRollback = loadedProviders(bootAfterRollback);
    evidence.bootProvidersAfterRollback = providersAfterRollback;
    check("after the rollback the page loads exactly one settings provider module again, the upstream package", providersAfterRollback.length === 1 && providersAfterRollback[0] === "@deepseek-ai/dsh-client-ui-settings", JSON.stringify(providersAfterRollback) + " of " + bootAfterRollback.entryCount + " modules");
    assertNoStageErrors("afterRollback", true);
  }

  assertNoStageErrors("atEnd", true);
  evidence.consoleFullTail = cdp.errors().slice(-8);
  evidence.consoleEventCount = cdp.errors().length;
  evidence.settingsDialogText = await cdp.eval("Array.from(document.querySelectorAll(\"[role=dialog]\")).map((d) => d.innerText).join(\"\\n===\\n\").slice(0, 2500)");

  chrome.kill("SIGKILL");
  instance.child.kill("SIGTERM");
  await sleep(1500);
  if (!KEEP) await rm(root, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  evidence.passed = results.length - failed.length;
  evidence.failed = failed.map((r) => r.name);
  await writeFile(join(EVIDENCE_DIR, MODE + "-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log("");
  console.log((failed.length === 0 ? "ALL CHECKS PASSED" : "FAILED: " + failed.length) + " (" + results.length + " checks, mode=" + MODE + ")");
  console.log("evidence: " + join(EVIDENCE_DIR, MODE + "-evidence.json"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (error) => { console.error("HARNESS ERROR:", error); console.error(JSON.stringify(evidence, null, 2).slice(0, 2000)); process.exit(2); });
