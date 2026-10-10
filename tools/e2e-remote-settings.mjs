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
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = []; ws.onmessage = (e) => this.onMessage(e); }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws connect failed: " + url)); }); return new Cdp(ws); }
  onMessage(e) { const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString()); if (msg.id !== undefined) { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } return; } this.events.push(msg); }
  send(method, params = {}) { const id = ++this.seq; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); return r.result.value; }
  errors() { return this.events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error") || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") || e.method === "Network.loadingFailed").map((e) => e.method + " " + JSON.stringify(e.params).slice(0, 240)); }
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
    const req = http.request({ host: "127.0.0.1", port: target.port, path: target.pathname + target.search, method: "GET", headers, timeout: 8000 }, (res) => { let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, setCookie: res.headers["set-cookie"] !== undefined, body: body.slice(0, 120) })); });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.end();
  });
}

/* The Host/Origin fence guards the /api transport; the document index is authorized by cookie. */
async function fenceProbes(port, token) {
  const authority = TEST_HOST + ":" + port;
  const api = "http://127.0.0.1:" + port + "/api/e2e-probe";
  return {
    trustedNoCookie: await fetchRaw(api, { host: authority }),
    loopbackNoCookie: await fetchRaw(api, { host: "127.0.0.1:" + port }),
    evilHost: await fetchRaw(api, { host: "evil.test:" + port }),
    evilOrigin: await fetchRaw(api, { host: authority, origin: "https://evil.test", "sec-fetch-site": "cross-site" }),
    indexToken: await fetchRaw("http://127.0.0.1:" + port + "/?token=" + token, { host: authority }),
    indexNoToken: await fetchRaw("http://127.0.0.1:" + port + "/", { host: authority })
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
  } else {
    check("control run loads the original web composition", true, JSON.stringify(bundles));
  }

  let instance = await startInstance(home, "proto");
  const parsed = new URL(instance.url);
  const remoteUrl = "http://" + TEST_HOST + ":" + parsed.port + "/" + parsed.search;
  evidence.urls = { loopback: instance.url, remote: remoteUrl };
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

  const initialConsoleErrors = cdp.errors();
  evidence.consoleOnInitialLoad = initialConsoleErrors;
  check("no console exceptions, failures or protocol errors on the initial load", initialConsoleErrors.length === 0, JSON.stringify(initialConsoleErrors.slice(0, 3)));

  await cdp.send("Page.reload").catch(() => {});
  await sleep(7000);
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-04-after-reload.png"));
  const afterReload = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchAfterReload = afterReload;
  if (MODE === "overlay") check("value survives a page refresh on the remote origin", afterReload.state === "false", JSON.stringify(afterReload));
  else check("CONTROL: the remote toggle is lost on refresh", afterReload.state === "true", JSON.stringify(afterReload));

  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
  await sleep(2500);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
  await sleep(6000);
  await cdp.send("Page.reload").catch(() => {});
  await sleep(6000);
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-05-after-reconnect.png"));
  const afterReconnect = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchAfterReconnect = afterReconnect;
  if (MODE === "overlay") check("value survives a transport reconnect", afterReconnect.state === "false", JSON.stringify(afterReconnect));

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

  await cdp.send("Page.navigate", { url: remoteUrl2 }).catch(() => {});
  await waitFor(cdp, SHELL_PROBE, "app shell on the remote origin after restart");
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-08-remote-after-restart.png"));
  const afterRestart = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchAfterRestart = afterRestart;
  if (MODE === "overlay") check("value survives an instance restart on the remote origin", afterRestart.state === "false", JSON.stringify(afterRestart));
  else check("CONTROL: the remote page cannot observe host state (memory mode)", afterRestart.state === "true", JSON.stringify(afterRestart));

  const fence = await fenceProbes(restarted.port, restarted.search.slice("?token=".length));
  evidence.fence = fence;
  check("fence: /api from the trusted authority passes the Host/Origin fence (401 auth gate)", fence.trustedNoCookie.status === 401, JSON.stringify(fence.trustedNoCookie));
  check("fence: /api from the loopback authority passes the fence", fence.loopbackNoCookie.status === 401, JSON.stringify(fence.loopbackNoCookie));
  check("fence: /api with an untrusted Host is forbidden", fence.evilHost.status === 403, JSON.stringify(fence.evilHost));
  check("fence: /api with a cross-site Origin is forbidden", fence.evilOrigin.status === 403, JSON.stringify(fence.evilOrigin));
  check("auth: the root token mints the authority-bound cookie and redirects", fence.indexToken.status === 303 && fence.indexToken.location === "./" && fence.indexToken.setCookie === true, JSON.stringify(fence.indexToken));
  check("auth: the document without a token is unauthorized", fence.indexNoToken.status === 401, JSON.stringify(fence.indexNoToken));

  evidence.consoleAfterAllSteps = cdp.errors().filter((e) => e.startsWith("Runtime.exceptionThrown") || e.includes("\"level\":\"error\"") === false);
  evidence.consoleFullTail = cdp.errors().slice(-8);
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
