import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm, stat, chmod } from "node:fs/promises";
import { cpSync, existsSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_HOST = process.env.TEST_HOST || "dsh-proto.test";
const CHROMIUM = process.env.CHROMIUM || "/usr/sbin/chromium";
const OVERLAY_SCOPE = "@dsh-local-overlay";
const FORK_PACKAGE = OVERLAY_SCOPE + "/dsh-client-ui-settings";
/* A credential the harness stores through the public RPC and then looks for after the rollback. It is a test
   value, never a real secret, and it exists only inside the throwaway DSH_HOME of this run. */
const TEST_CREDENTIAL_REF = "DSH_E2E_TEST_CREDENTIAL";
/* A throwaway bundle layer installed while the replacement is active: the rollback has to leave it alone. */
const UNRELATED_LAYER = OVERLAY_SCOPE + "/e2e-unrelated-layer";
/* The provider, its models and its TEST-ONLY credentials that the ORIGINAL provider page creates, edits and
   deletes through the remote origin (issue #4). None of these values is a real secret; they are literals of
   this file and they only ever exist inside the throwaway DSH_HOME of one run. The route is lower case and
   dash separated because the page's own field validation rejects everything else. */
const PAGE_PROVIDER = "e2e-page-gateway";
const PAGE_PROVIDER_DISPLAY = "E2E Page Gateway";
const PAGE_PROVIDER_DISPLAY_2 = "E2E Page Gateway v2";
const PAGE_PROVIDER_STALE = "E2E Page Gateway other writer";
const PAGE_PROVIDER_BLOCKED = "E2E Page Gateway write blocked";
const PAGE_PROVIDER_PARTIAL = "E2E Page Gateway key pending";
const PAGE_PROVIDER_BASE = "https://e2e-page.test/v1";
const PAGE_PROVIDER_BASE_2 = "https://e2e-page.test/v2";
const PAGE_MODEL = "e2e-page-model-alpha";
const PAGE_MODEL_NAME = "E2E Page Alpha";
const PAGE_MODEL_2 = "e2e-page-model-beta";
const PAGE_MODEL_NAME_2 = "E2E Page Beta";
/* The credential reference the PAGE derives from the route: <ROUTE upcased, non-alphanumeric to underscore>_API_KEY. */
const PAGE_KEY_REF = "E2E_PAGE_GATEWAY_API_KEY";
const PAGE_KEY_1 = "e2e-page-key-1111";
const PAGE_KEY_2 = "e2e-page-key-2222";
const PAGE_KEY_3 = "e2e-page-key-3333";
const PAGE_KEY_ROTATED = "e2e-page-key-rotated";
/* A second provider, created and then deleted again while the first one stays configured, so the stage can show
   that a deletion touches nothing but its own provider. */
const PAGE_PROVIDER_2 = "e2e-page-relay";
const PAGE_PROVIDER_2_DISPLAY = "E2E Page Relay";
const PAGE_PROVIDER_2_BASE = "https://e2e-relay.test/v1";
const PAGE_KEY_REF_2 = "E2E_PAGE_RELAY_API_KEY";
const PAGE_KEY_2_OF_2 = "e2e-page-relay-key-4444";
const PAGE_SECRETS = [PAGE_KEY_1, PAGE_KEY_2, PAGE_KEY_3, PAGE_KEY_ROTATED, PAGE_KEY_2_OF_2];

/* The THIRD-PARTY probe bundle the last stage installs (issue #5). Everything below belongs to the BUNDLE:
   its package name, the row it registers under, and the ids and copy it chose for its own form. The suite
   asserts that the page rendered exactly that, which is also what shows the form came from the installed
   package and not from anything this repository knows. The values are fixtures of one throwaway run. */
const PROBE_PACKAGE = OVERLAY_SCOPE + "/e2e-config-probe";
const PROBE_NS = "e2e-config-probe";
const PROBE_LABEL_FIELD = "plugin-config-probe-label";
const PROBE_ATTEMPTS_FIELD = "plugin-config-probe-attempts";
const PROBE_DEFAULT_LABEL = "probe-default";
const PROBE_DEFAULT_ATTEMPTS = 3;
/* Test-only drafts and field inputs. None of them is a secret; they only ever exist inside this run's profile. */
const PROBE_DRAFT = "probe-draft-from-the-page";
const PROBE_OTHER_END = "probe-written-by-the-other-end";
const PROBE_CONFLICT_DRAFT = "probe-draft-against-a-stale-revision";
const PROBE_FAILED_DRAFT = "probe-draft-that-cannot-land";
const PROBE_OUT_OF_RANGE = 10;
const PROBE_UNPARSEABLE = "not-a-number";
const PROBE_COPY = {
  title: "Probe configuration",
  labelHint: "Staged until you save; the instance keeps its own value until then.",
  attemptsHint: "A whole number between 1 and 9.",
  invalidNumber: "Enter a whole number, or leave the field empty.",
  save: "Save probe",
  saveFailed: "The deployment did not accept these values; they were left for you to correct.",
};
/* The deployment's OWN explicit-save plugin form, reachable from the same remote plugin list: the Web search
   page, registered in the standard slot by the package that ships with the deployment while the Host serves the
   provider's namespace. Every id and every line of copy below belongs to the PRODUCT, not to this repository -
   they are asserted verbatim because matching them is what shows the page rendered the deployment's own form. */
const SHIPPED_ITEM = "Web search";
const SHIPPED_NS = "web-search-deepseek";
const SHIPPED_KEY_FIELD = "plugin-config-web-search-key";
const SHIPPED_ENDPOINT_FIELD = "plugin-config-web-search-endpoint";
const SHIPPED_MAX_USES_FIELD = "plugin-config-web-search-max-uses";
const SHIPPED_COPY = {
  description: "Set up the DeepSeek search provider.",
  baseUrlHint: "Leave blank to use the provider default.",
  maxUsesHint: "How many times one request may search before it must answer.",
  save: "Save",
  invalidNumber: "Enter a number, or leave blank to use the default.",
  saveFailed: "The deployment did not accept these values; they were left for you to correct.",
};
/* Test-only drafts for the deployment's own form: the value this stage saves, the draft the other end's write
   makes stale, and the value that other end stores. */
const SHIPPED_SAVED_MAX_USES = 7;
const SHIPPED_STALE_MAX_USES = 8;
const SHIPPED_OTHER_END_MAX_USES = 6;
/* The refs block of the credential store is the only place a stored key can be observed at all. */
const credentialRefsOf = (text) => {
  const marker = text.lastIndexOf("\nrefs:");
  const block = marker === -1 ? "" : text.slice(marker);
  const found = {};
  for (const line of block.split("\n")) {
    const match = /^[ \t]+([A-Za-z0-9_]+):[ \t]*(\S+)[ \t]*$/.exec(line);
    if (match !== null) found[match[1]] = match[2];
  }
  return found;
};
/* Any test secret found in a piece of text the page produced. Always expected to be empty. */
const secretsIn = (text) => PAGE_SECRETS.filter((secret) => String(text).indexOf(secret) !== -1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* The two server-push transports a loaded page holds open, and the authority of a transport URL.
   Every console/network tolerance below is bound to a connection that already existed when the stage
   started (or to its authority), never to a URL substring, so a transport that keeps failing on fresh
   attempts after the disruption can never be tolerated. */
/* The two streaming endpoints the app shell holds open. Matched on the exact pathname so a look-alike
   path (/plugins/events-malicious) can never borrow the tolerance meant for the real transport. */
const STREAM_PATH = /^\/(?:api\/remote\.mux|plugins\/events)$/;
/* Works for absolute URLs and for the scheme-less 'host:port/path' text the browser Log quotes. */
const streamPath = (value) => {
  const text = String(value).split("?")[0].split("#")[0];
  const scheme = text.indexOf("://");
  const rest = scheme === -1 ? text : text.slice(scheme + 3);
  const slash = rest.indexOf("/");
  return slash === -1 ? "" : rest.slice(slash);
};
const isStreamTarget = (value) => STREAM_PATH.test(streamPath(value));
const authorityOf = (url) => { try { return new URL(url).host; } catch (error) { return ""; } };
const pathnameOf = (url) => { try { return new URL(url).pathname; } catch (error) { return ""; } };

function resolveDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  return realpathSync(execFileSync("which", ["dsh"], { encoding: "utf8" }).trim());
}
const DSH_BIN = resolveDshBin();
const DSH_INSTALL = DSH_BIN.slice(0, DSH_BIN.indexOf("/lib/bin.js"));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OVERLAY_TOOL = join(REPO_ROOT, "tools/overlay.mjs");
const VERIFY_TOOL = join(REPO_ROOT, "tools/verify-artifacts.mjs");
/* Installations this test has to edit get their own copy, and the copy wants hard links (cp -al): the
   copy has to be reachable on the SAME filesystem as the installation, which a temporary directory is
   not guaranteed to be. The copies are removed again at the end of the run. */
const COPY_BASE = join(homedir(), ".cache", "dsh-local-overlay-e2e-" + process.pid);

const args = process.argv.slice(2);
const argValue = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const MODE = argValue("--mode", "overlay");
const EVIDENCE_DIR = argValue("--evidence", join(process.cwd(), "evidence"));
const KEEP = args.includes("--keep");
if (MODE !== "control" && MODE !== "overlay") throw new Error("--mode must be control or overlay");

/* The profile this run creates inside its OWN throwaway home. DSH_PROFILE names it (the documented invocation
   passes DSH_PROFILE=e2e); the default is a name of its own. Every reference to the profile - its directory, the
   instance booted on it, the terminal entry point that installs into it - uses this one name. */
const PROFILE = process.env.DSH_PROFILE || "e2e";
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: ok === true, detail }); console.log((ok === true ? "PASS " : "FAIL ") + name + (detail === undefined ? "" : " :: " + detail)); return ok === true; };
const evidence = { mode: MODE, dshBin: DSH_BIN, dshInstall: DSH_INSTALL, chromium: CHROMIUM, testHost: TEST_HOST, checks: results, files: {} };

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = []; this.requestUrls = new Map(); this.requests = [];
    /* requestId -> { url, kind, createdSeq, closedSeq } for the streaming transports only */
    this.connections = new Map(); this.eventSeq = 0;
    ws.onmessage = (e) => this.onMessage(e);
  }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws connect failed: " + url)); }); return new Cdp(ws); }
  onMessage(e) {
    const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
    if (msg.id !== undefined) { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } return; }
    msg.seq = ++this.eventSeq;
    this.track(msg);
    this.events.push(msg);
  }
  track(msg) {
    const params = msg.params || {};
    if (msg.method === "Network.requestWillBeSent" && params.request) {
      this.requestUrls.set(params.requestId, params.request.url);
      /* Every HTTP request the page makes, with its body: the settings write is an /api RPC, so the
         recovery assertion has to see the write itself, not merely "some /api traffic". */
      this.requests.push({ seq: msg.seq, requestId: params.requestId, url: params.request.url, method: params.request.method, postData: params.request.postData === undefined ? "" : params.request.postData });
    }
    if (params.requestId === undefined) return;
    if (msg.method === "Network.webSocketCreated") this.connections.set(params.requestId, { url: params.url, kind: "WebSocket", createdSeq: msg.seq, closedSeq: null });
    else if (msg.method === "Network.requestWillBeSent" && params.type === "EventSource") this.connections.set(params.requestId, { url: params.request.url, kind: "EventSource", createdSeq: msg.seq, closedSeq: null });
    else if (msg.method === "Network.webSocketFrameSent" || msg.method === "Network.webSocketFrameReceived") {
      const connection = this.connections.get(params.requestId);
      if (connection !== undefined) {
        const key = msg.method === "Network.webSocketFrameSent" ? "framesSent" : "framesReceived";
        connection[key] = (connection[key] || 0) + 1;
        connection.lastFrameSeq = msg.seq;
        if (connection.frameSeqs === undefined) connection.frameSeqs = [];
        connection.frameSeqs.push(msg.seq);
      }
    }
    else if (msg.method === "Network.webSocketHandshakeResponseReceived") {
      const connection = this.connections.get(params.requestId);
      if (connection !== undefined) connection.handshake = { status: params.response === undefined ? null : params.response.status, responseSeq: msg.seq };
    }
    else if (msg.method === "Network.webSocketClosed" || msg.method === "Network.loadingFailed" || msg.method === "Network.loadingFinished") {
      const connection = this.connections.get(params.requestId);
      if (connection !== undefined && connection.closedSeq === null) connection.closedSeq = msg.seq;
    }
  }
  /* Frames this connection carried AFTER a sequence point. The cumulative counter cannot prove anything about
     the post-recovery window: a socket can be created before the page is online again. */
  framesAfter(connection, sinceSeq) {
    const state = this.connections.get(connection.requestId);
    return state === undefined || state.frameSeqs === undefined ? 0 : state.frameSeqs.filter((seq) => seq > sinceSeq).length;
  }
  /* Every streaming connection the browser currently holds open. */
  liveConnections() { return [...this.connections.entries()].filter(([, c]) => c.closedSeq === null && isStreamTarget(c.url)).map(([requestId, c]) => ({ requestId, url: c.url, kind: c.kind, createdSeq: c.createdSeq, handshake: c.handshake === undefined ? null : c.handshake, framesSent: c.framesSent || 0, framesReceived: c.framesReceived || 0, lastFrameSeq: c.lastFrameSeq === undefined ? null : c.lastFrameSeq })); }
  /* Every teardown the browser reported for a streaming connection after the given sequence number. This is
     the outside observation that a connection really ended, not an inference from a failed fetch. */
  teardownEvents(sinceSeq) {
    const out = [];
    for (const event of this.events) {
      if (event.seq <= sinceSeq) continue;
      if (event.method !== "Network.webSocketClosed" && event.method !== "Network.loadingFailed" && event.method !== "Network.loadingFinished") continue;
      const connection = this.connections.get(event.params.requestId);
      if (connection === undefined || !isStreamTarget(connection.url)) continue;
      out.push({ seq: event.seq, method: event.method, requestId: event.params.requestId, url: connection.url, kind: connection.kind, type: event.params.type, errorText: event.params.errorText });
    }
    return out;
  }

  send(method, params = {}) { const id = ++this.seq; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); return r.result.value; }
  errorEvents() { return this.events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error") || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") || e.method === "Network.loadingFailed").map((e) => ({ seq: e.seq, method: e.method, params: e.params, url: (e.method === "Network.loadingFailed" ? (this.requestUrls.get(e.params.requestId) || "") : (e.params.entry && e.params.entry.url) || ""), text: e.method + " " + JSON.stringify(e.params).slice(0, 240), full: e.method + " " + JSON.stringify(e.params) })); }
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

/* A one-off dump of the provider section's own buttons and key fields, printed only when a row a read expected
   is not there: the page draws a card already expanded in some states, and that card offers no Edit button. */
const MODELS_CARDS = [
  "(() => {",
  " const vis = (e) => !!e && e.offsetParent !== null;",
  " const txt = (e) => (e.innerText || e.textContent || \"\").replace(/\\s+/g, \" \").trim();",
  " const buttons = Array.from(document.querySelectorAll(\"button\")).filter(vis).map((b) => (b.getAttribute(\"aria-label\") || \"-\") + \" :: \" + txt(b).slice(0, 30));",
  " const keys = Array.from(document.querySelectorAll('[aria-label=\"API key\"]')).map((input) => ({ visible: vis(input), value: input.value, placeholder: input.getAttribute(\"placeholder\"), card: txt(input.parentElement && input.parentElement.parentElement ? input.parentElement.parentElement : input).slice(0, 160) }));",
  " const dialogs = Array.from(document.querySelectorAll(\"[role=dialog]\")).filter(vis);",
  " return JSON.stringify({ buttons, keys, section: dialogs.length ? txt(dialogs[dialogs.length - 1]).slice(0, 900) : txt(document.body).slice(0, 300) });",
  "})()",
].join(" ");
/* Used only when the Models section cannot be reached: it reports what the document actually offered, so a
   failure here is debuggable from the run log instead of by guesswork. */
const MODELS_DIAG = "(() => { const vis = (e) => !!e && e.offsetParent !== null; const txt = (e) => (e.innerText || e.textContent || \"\").replace(/\\s+/g, \" \").trim(); const dialogs = Array.from(document.querySelectorAll(\"[role=dialog]\")).map((d) => ({ visible: vis(d), text: txt(d).slice(0, 200) })); const navish = Array.from(document.querySelectorAll(\"nav button, [role=tab], [role=navigation] button, [role=menuitem]\")).filter(vis).map((b) => ({ text: txt(b).slice(0, 40), aria: b.getAttribute(\"aria-label\"), role: b.getAttribute(\"role\") })); const buttons = Array.from(document.querySelectorAll(\"button\")).filter(vis).map((b) => txt(b).slice(0, 30)); return JSON.stringify({ dialogs, navish, buttons: buttons.slice(0, 60), body: txt(document.body).slice(0, 300) }); })()";

async function waitFor(cdp, expression, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) { try { last = await cdp.eval(expression); if (last) return last; } catch (error) { last = "eval error: " + error.message; } await sleep(300); }
  throw new Error("timeout waiting for " + label + " (last=" + JSON.stringify(last) + ")");
}

/* Is the settings panel on screen? It is a dialog of its own, so it is recognised by its own navigation
   entries rather than by any dialog being present. */
const SETTINGS_PANEL_PROBE = "(Array.from(document.querySelectorAll(\"[role=dialog]\")).some((d) => d.offsetParent !== null && /Built-in plugins|Agent presets/.test(d.innerText || \"\")))";

/* Puts an already-open settings panel back on General. The switch stages read the General section's own row, and
   a document that survived a transport interruption can still show the panel an earlier stage walked into the
   Models section. General is also the section a newly opened panel shows, so a panel that is reopened and a
   panel that is reset end up in the same place. */
const SETTINGS_GENERAL = "(() => { const b = Array.from(document.querySelectorAll(\"button\")).find((e) => /^(general|通用)$/i.test((e.getAttribute(\"aria-label\") || e.innerText || \"\").trim())); if (!b) return \"no-general-entry\"; b.click(); return \"clicked\"; })()";

/* The settings panel is a dialog of its own, and whether a second dialog (the first-run card that asks for an
   official key) is on screen depends on what the profile already holds - a profile with a configured key no
   longer draws it. So the wait is for the count to RISE by opening the panel, not for a fixed total. If the
   panel is already up (a document that never went away), the trigger is not pressed again - pressing it blind
   can only close the panel it is meant to show - and the panel is reset to General instead. */
async function openSettings(cdp, shot) {
  await waitFor(cdp, SHELL_PROBE, "app shell");
  if ((await cdp.eval(SETTINGS_PANEL_PROBE)) === true) {
    await cdp.eval(SETTINGS_GENERAL);
    await sleep(900);
  } else {
    const dialogsBefore = await cdp.eval("document.querySelectorAll(\"[role=dialog]\").length");
    await cdp.eval(SETTINGS_TRIGGER);
    await waitFor(cdp, "document.querySelectorAll(\"[role=dialog]\").length > " + JSON.stringify(dialogsBefore) + " || " + SETTINGS_PANEL_PROBE, "settings dialog");
  }
  await sleep(1500);
  if (shot) await cdp.screenshot(shot);
}

async function startInstance(home, profile, bin = DSH_BIN, extraEnv = {}) {
  const child = spawn(process.execPath, [bin, profile, "--host", "127.0.0.1", "--port", "0", "--no-open", "--trusted-host", TEST_HOST], { env: { ...process.env, DSH_HOME: home, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
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

/* A WebSocket handshake on the REAL transport endpoint held by the fence. The upgrade attempt is answered by
   the fence itself, and `upgraded` records whether the socket was ever switched to the WebSocket protocol, so
   a rejection cannot be confused with a transport failure. This probe runs from Node, outside the page. */
async function upgradeProbe(port, authority, cookie) {
  return await new Promise((resolve) => {
    const headers = { host: authority, connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: "127.0.0.1", port, path: "/api/remote.mux", method: "GET", headers, timeout: 8000 });
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    req.on("upgrade", (res) => { done({ status: res.statusCode, upgraded: true }); req.destroy(); });
    req.on("response", (res) => { res.resume(); done({ status: res.statusCode, upgraded: false }); });
    req.on("error", (error) => done({ status: 0, upgraded: false, body: String(error.message) }));
    req.on("timeout", () => { req.destroy(); done({ status: 0, upgraded: false, body: "timeout" }); });
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
    evilOriginWithCookie: await fetchRaw(api, { host: authority, origin: "https://evil.test", ...authenticated }),
    fetchSiteOnly: await fetchRaw(api, { host: authority, "sec-fetch-site": "cross-site" }),
    fetchSiteWithCookie: await fetchRaw(api, { host: authority, "sec-fetch-site": "cross-site", ...authenticated }),
    evilOriginAndFetchSite: await fetchRaw(api, { host: authority, origin: "https://evil.test", "sec-fetch-site": "cross-site" }),
    sameOrigin: await fetchRaw(api, { host: authority, origin: "http://" + authority }),
    upgradeEvilHost: await upgradeProbe(port, "evil.test:" + port, ""),
    upgradeTrustedNoCookie: await upgradeProbe(port, authority, ""),
    upgradeTrustedWithCookie: await upgradeProbe(port, authority, cookie)
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

/* Drives one of the two terminal entry points and reports its exit code, so a refusal can be asserted
   instead of throwing the harness off its track. */
function runTool(script, args, env) {
  try {
    return { code: 0, output: String(execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(env || {}) } })) };
  } catch (error) {
    return { code: typeof error.status === "number" ? error.status : 1, output: String(error.stdout || "") + String(error.stderr || "") };
  }
}

/* A copy of an installation that this test is allowed to edit. Every variant gets its OWN link tree, so
   replacing a file in a variant (unlink first, then write) leaves the real installation's inode alone. */
function cloneInstall(from, to) {
  try { execFileSync("cp", ["-al", from, to], { stdio: ["ignore", "pipe", "pipe"] }); return "hard links"; }
  catch (error) { cpSync(from, to, { recursive: true, verbatimSymlinks: true }); return "copied bytes"; }
}

/* Writing over a hard-linked file reaches the original inode, so the link is broken before the write. */
async function replaceFile(path, content) { await rm(path, { force: true }); await writeFile(path, content); }

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/* The settings and credentials RPC the page itself uses, called from Node: the GET mints the session
   cookie and the POST carries the request envelope. Needed wherever a broken instance has to answer over
   HTTP instead of through the page. */
async function callRpc(port, token, method, args) {
  const authority = TEST_HOST + ":" + port;
  const index = await fetchRaw("http://127.0.0.1:" + port + "/?token=" + token, { host: authority });
  const cookie = (index.cookies || []).map((value) => value.split(";")[0]).join("; ");
  const payload = JSON.stringify({ type: "client-request", rpcId: "e2e-" + method.replace(/\W/g, "-") + "-" + Date.now(), method, payload: { args } });
  return await new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/api/" + method, method: "POST", headers: { host: authority, cookie, "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: 10000 }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => { try { resolve(JSON.parse(body).result); } catch (error) { resolve({ ok: false, raw: body.slice(0, 400) }); } });
    });
    request.on("error", (error) => resolve({ ok: false, raw: String(error.message) }));
    request.on("timeout", () => { request.destroy(); resolve({ ok: false, raw: "timeout" }); });
    request.write(payload);
    request.end();
  });
}

/* The profile's own state, byte for byte: what a refusal or a rollback must never change by accident. */
async function profileSnapshot(profileDir, patchPath) {
  const manifest = await readFile(join(profileDir, "package.json"), "utf8");
  const patch = existsSync(patchPath) ? await readFile(patchPath, "utf8") : "";
  const statePath = join(profileDir, "dsh-local-overlay.state.json");
  const state = existsSync(statePath) ? await readFile(statePath, "utf8") : "";
  const installed = existsSync(join(profileDir, "node_modules", FORK_PACKAGE));
  return manifest + "\n---\n" + patch + "\n---\n" + state + "\n---\n" + String(installed);
}

/* The block one "- id: <id>" patch row covers, up to the next top-level row. */
function patchRow(text, id) {
  const start = String(text).indexOf("- id: " + id);
  if (start === -1) return "";
  const tail = String(text).slice(start);
  const end = tail.indexOf("\n- id:", 1);
  return end === -1 ? tail : tail.slice(0, end);
}

/* Read one credential value out of $DSH_HOME/.credentials.yaml without a YAML parser: the file is small and
   shaped as "refs:" followed by indented "<REF>: <value>" lines. */
function storedCredentialValue(text) {
  const match = String(text).match(new RegExp("^[ \\t]+" + TEST_CREDENTIAL_REF + ":[ \\t]*(\\S+)[ \\t]*$", "m"));
  return match === null ? null : match[1];
}

/* A bound client for one running instance, so a stage names only the method and its arguments. */
function rpcFor(instance) {
  const url = instance instanceof URL ? instance : new URL(instance);
  const port = Number(url.port);
  const token = url.search.slice("?token=".length);
  return (method, args) => callRpc(port, token, method, args);
}

/* ------------------------------------------------------------------------------------------------------
   The page-side driver for the ORIGINAL provider page (issue #4). Every method is a thin wrapper around
   the page's own DOM: it clicks the page's own buttons, focuses the page's own inputs and reads back what
   the page itself rendered. It knows NOTHING about persistence - the harness proves that separately, from
   the page's own RPC bodies (read out of the CDP network log by shape) and from the files on disk.
   Two page facts shape this driver:
     * The page's controlled text inputs ignore synthetic input/change events (a dispatched event changes
       the DOM value but not the component state, so the next render wipes it). Text is therefore typed
       through the browser's own input pipeline; selects do react to value + change.
     * The page embeds the CURRENT display name in its own aria-labels, so a provider is always addressed
       by its ROUTE, never by a display name captured earlier.
   ------------------------------------------------------------------------------------------------------ */
const PAGE_DRIVER = [
  "(function () {",
  "  var visible = function (element) { return !!element && element.offsetParent !== null; };",
  "  var list = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };",
  "  var trimmed = function (value) { return (value || \"\").replace(/\\s+/g, \" \").trim(); };",
  "  var buttonText = function (text, root) { return list(\"button\", root).filter(visible).filter(function (button) { return trimmed(button.innerText) === text; })[0]; };",
  "  var dialog = function () { return list(\"[role=dialog]\").filter(visible).pop(); };",
  "  /* A confirmation dialog opens OVER the settings panel, so the section is read from the dialog that holds",
  "     the section itself (the one with the page's own Add action), falling back to the last visible dialog. */",
  "  var sectionDialog = function () {",
  "    var dialogs = list(\"[role=dialog]\").filter(visible);",
  "    for (var index = dialogs.length - 1; index >= 0; index -= 1) {",
  "      if (buttonText(\"Add model provider\", dialogs[index])) return dialogs[index];",
  "    }",
  "    return dialogs.pop() || null;",
  "  };",
  "  var field = function (label, root) { return list(\"[aria-label=\" + JSON.stringify(label) + \"]\", root).filter(visible)[0]; };",
  "  var addCard = function () {",
  "    var tab = list(\"[role=tab]\").filter(visible)[0];",
  "    if (!tab) return null;",
  "    var node = tab;",
  "    while (node && node !== document.body) {",
  "      if (list(\"button\", node).filter(visible).some(function (button) { return trimmed(button.innerText) === \"Cancel\"; })) return node;",
  "      node = node.parentElement;",
  "    }",
  "    return null;",
  "  };",
  "  var editCard = function (route) {",
  "    var edit = list(\"button\").filter(visible).filter(function (button) {",
  "      var label = button.getAttribute(\"aria-label\") || \"\";",
  "      return label.indexOf(\"Edit \") === 0 && label.indexOf(\"(\" + route + \")\") !== -1;",
  "    })[0];",
  "    if (!edit) return null;",
  "    var node = edit;",
  "    while (node && node !== document.body) {",
  "      if (list(\"button\", node).filter(visible).some(function (button) { return trimmed(button.innerText) === \"Apply\"; })) return node;",
  "      node = node.parentElement;",
  "    }",
  "    return null;",
  "  };",
  "  var openDetails = function (scope) {",
  "    var details = scope.querySelector(\"details\");",
  "    if (!details) return false;",
  "    if (!details.open) { var summary = details.querySelector(\"summary\"); if (summary) summary.click(); }",
  "    return details.open === true;",
  "  };",
  "  var describe = function (scope) {",
  "    return {",
  "      text: trimmed(scope.innerText).slice(0, 700),",
  "      buttons: list(\"button\", scope).filter(visible).map(function (button) { return { label: trimmed(button.innerText) || (button.getAttribute(\"aria-label\") || \"?\"), disabled: button.disabled === true }; }),",
  "      fields: list(\"input,select,textarea\", scope).filter(visible).map(function (element) { return { label: element.getAttribute(\"aria-label\") || element.tagName, value: element.value, disabled: element.disabled === true, placeholder: element.getAttribute(\"placeholder\") || \"\" }; }),",
  "      paragraphs: list(\"p\", scope).filter(visible).map(function (p) { return trimmed(p.innerText).slice(0, 240); }).filter(function (text) { return text.length > 0; }),",
  "      detailsOpen: scope.querySelector(\"details\") ? scope.querySelector(\"details\").open === true : false",
  "    };",
  "  };",
  "  var focusIn = function (scope, label) {",
  "    if (!scope) return \"no-card\";",
  "    var element = field(label, scope);",
  "    if (!element) return \"no-field\";",
  "    element.focus();",
  "    if (element.select && element.tagName !== \"SELECT\") element.select();",
  "    return document.activeElement === element ? \"focused\" : \"blocked\";",
  "  };",
  "  var pickIn = function (scope, label, value) {",
  "    if (!scope) return \"no-card\";",
  "    var element = field(label, scope);",
  "    if (!element) return \"no-field\";",
  "    element.value = value;",
  "    element.dispatchEvent(new Event(\"change\", { bubbles: true }));",
  "    return \"picked:\" + element.value;",
  "  };",
  "  var saveIn = function (scope, text) {",
  "    if (!scope) return { state: \"no-card\" };",
  "    var button = list(\"button\", scope).filter(visible).filter(function (candidate) { return trimmed(candidate.innerText) === text; })[0];",
  "    if (!button) return { state: \"no-target\" };",
  "    if (button.disabled) return { state: \"disabled\" };",
  "    button.click();",
  "    return { state: \"clicked\" };",
  "  };",
  "  var providerRows = function () {",
  "    var scope = sectionDialog();",
  "    if (!scope) return [];",
  "    return list(\"button\", scope).filter(visible).filter(function (button) { return (button.getAttribute(\"aria-label\") || \"\").indexOf(\"Edit \") === 0; }).map(function (edit) {",
  "      var label = edit.getAttribute(\"aria-label\") || \"\";",
  "      var match = /^Edit (.*) \\(([^()]+)\\)$/.exec(label);",
  "      if (!match) return null;",
  "      var head = edit.parentElement && edit.parentElement.parentElement ? edit.parentElement.parentElement : edit;",
  "      var container = head.parentElement || head;",
  "      var keyField = list(\"[aria-label=\" + JSON.stringify(\"API key\") + \"]\", container).filter(visible)[0];",
  "      var deleteLabel = \"Delete \" + match[1] + \" (\" + match[2] + \")\";",
  "      return {",
  "        route: match[2],",
  "        displayName: match[1],",
  "        custom: trimmed(container.innerText).indexOf(\"Custom\") !== -1,",
  "        keyConfigured: list(\"[role=img]\", container).filter(visible).some(function (dot) { return (dot.getAttribute(\"aria-label\") || \"\") === \"API key configured\"; }),",
  "        keyPlaceholder: keyField ? (keyField.getAttribute(\"placeholder\") || \"\") : \"\",",
  "        keyValue: keyField ? keyField.value : \"\",",
  "        editorOpen: list(\"button\", container).filter(visible).some(function (button) { return trimmed(button.innerText) === \"Apply\"; }),",
  "        hasDelete: list(\"button\", container).filter(visible).some(function (button) { return (button.getAttribute(\"aria-label\") || \"\").indexOf(deleteLabel) === 0; })",
  "      };",
  "    }).filter(function (row) { return row !== null; });",
  "  };",
  "  window.__e2ePage = {",
  "    start: function () {",
  "      var trigger = list(\"button\").filter(visible).filter(function (button) {",
  "        var label = ((button.getAttribute(\"aria-label\") || \"\") + \" \" + trimmed(button.innerText)).trim();",
  "        return /^(settings|设置)/i.test(label);",
  "      })[0];",
  "      if (!trigger) return \"no-settings-trigger\";",
  "      trigger.click();",
  "      return \"clicked\";",
  "    },",
  "    dialogText: function () { var scope = dialog(); return scope ? trimmed(scope.innerText) : \"\"; },",
  "    bodyText: function () { return trimmed(document.body.innerText); },",
  "    hasText: function (text) { return trimmed(document.body.innerText).indexOf(text) !== -1; },",
  "    openModels: function () {",
  "      /* The section entry is looked up in the whole document, the way a person finds it in the sidebar: the",
  "         settings panel is not always the topmost dialog (the onboarding card can sit above it). */",
  "      if (!dialog()) return \"no-dialog\";",
  "      var entry = buttonText(\"Models\") || buttonText(\"模型\");",
  "      if (!entry) return \"no-models-entry\";",
  "      entry.click();",
  "      return \"clicked\";",
  "    },",
  "    dismiss: function () {",
  "      /* Both labels the onboarding card can carry; it can also come back over the section after it opens. */",
  "      var roots = list(\"[role=dialog]\").filter(visible);",
  "      var scopes = roots.length > 0 ? roots : [document];",
  "      var clicked = 0;",
  "      [\"Continue\", \"Configure later\"].forEach(function (label) {",
  "        var button = null;",
  "        scopes.forEach(function (scope) { if (!button) button = buttonText(label, scope === document ? undefined : scope); });",
  "        if (button) { button.click(); clicked += 1; }",
  "      });",
  "      return clicked === 0 ? \"none\" : \"clicked-\" + clicked;",
  "    },",
  "    providerRows: providerRows,",
  "    providerRow: function (route) { var rows = providerRows().filter(function (row) { return row.route === route; }); return rows.length === 0 ? null : rows[0]; },",
  "    rowButton: function (route, prefix) {",
  "      var scope = dialog();",
  "      var button = list(\"button\", scope).filter(visible).filter(function (candidate) {",
  "        var label = candidate.getAttribute(\"aria-label\") || \"\";",
  "        return label.indexOf(prefix + \" \") === 0 && label.indexOf(\"(\" + route + \")\") !== -1;",
  "      })[0];",
  "      if (!button) return \"no-target\";",
  "      button.click();",
  "      return \"clicked\";",
  "    },",
  "    addProvider: function () { var button = buttonText(\"Add model provider\", dialog()) || buttonText(\"Add model provider\"); if (!button) return \"no-target\"; button.click(); return \"clicked\"; },",
  "    customTab: function () { var tabs = list(\"[role=tab]\", dialog()).filter(visible); if (tabs.length === 0) return \"no-tabs\"; tabs[tabs.length - 1].click(); return \"clicked\"; },",
  "    addCard: addCard,",
  "    editCard: editCard,",
  "    addDump: function () { var scope = addCard(); return scope ? describe(scope) : \"no-card\"; },",
  "    editDump: function (route) { var scope = editCard(route); return scope ? describe(scope) : \"no-card\"; },",
  "    addDetails: function () { var scope = addCard(); if (!scope) return \"no-card\"; return openDetails(scope) ? \"open\" : \"no-details\"; },",
  "    editDetails: function (route) { var scope = editCard(route); if (!scope) return \"no-card\"; return openDetails(scope) ? \"open\" : \"no-details\"; },",
  "    focusAdd: function (label) { return focusIn(addCard(), label); },",
  "    focusEdit: function (route, label) { return focusIn(editCard(route), label); },",
  "    pickAdd: function (label, value) { return pickIn(addCard(), label, value); },",
  "    pickEdit: function (route, label, value) { return pickIn(editCard(route), label, value); },",
  "    addModel: function (route) { var scope = route ? editCard(route) : addCard(); if (!scope) return \"no-card\"; var button = buttonText(\"Add model\", scope); if (!button) return \"no-target\"; button.click(); return \"clicked\"; },",
  "    saveAdd: function (text) { return saveIn(addCard(), text); },",
  "    saveEdit: function (route) { return saveIn(editCard(route), \"Apply\"); },",
  "    cancel: function (route) { var scope = route ? editCard(route) : addCard(); if (!scope) return \"no-card\"; var button = buttonText(\"Cancel\", scope); if (!button) return \"no-target\"; button.click(); return \"clicked\"; },",
  "    /* The confirmation dialog's confirm button carries the provider name as its own text (\"Delete <name> (<route>)\")",
  "       and has no aria-label of its own, unlike the row button: click it by its text, scoped to the dialog. */",
  "    confirmDelete: function () { var scope = dialog(); if (!scope) return \"no-dialog\"; var button = list(\"button\", scope).filter(visible).filter(function (candidate) { return /^Delete\\b/.test(trimmed(candidate.innerText)); })[0]; if (!button) return \"no-target\"; button.click(); return \"clicked\"; },",
  "    cardButton: function (text, route) { var scope = route ? editCard(route) : addCard(); if (!scope) return \"no-card\"; var button = list(\"button\", scope).filter(visible).filter(function (candidate) { return trimmed(candidate.innerText) === text; })[0]; return button ? (button.disabled === true ? \"disabled\" : \"enabled\") : \"no-target\"; },",
  "    modelLabels: function (route) { var scope = route ? editCard(route) : addCard(); return scope ? list(\"input\", scope).filter(visible).map(function (element) { return element.getAttribute(\"aria-label\") || element.tagName; }) : []; }",
  "  };",
  "  return \"installed\";",
  "})()"
].join("\n");

async function installPageDriver(cdp) {
  return cdp.eval(PAGE_DRIVER);
}

/* Polls until the expression returns something truthy, and returns it (waitFor below cannot hand a value back). */
async function waitForValue(cdp, expression, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await cdp.eval(expression).catch((error) => "eval-failed: " + error.message);
    if (last) return last;
    if (Date.now() > deadline) throw new Error("timeout waiting for " + label + " (last=" + JSON.stringify(last) + ")");
    await sleep(300);
  }
}

/* Fills a text field the way a person does: focus the page's own input (which selects its content) and let the
   browser type. The page's controlled inputs ignore dispatched input/change events, so this is the only path
   that actually reaches the component state. */
async function typeText(cdp, focusExpression, text) {
  const focused = await cdp.eval(focusExpression);
  if (focused !== "focused") throw new Error("could not focus a field for typing: " + JSON.stringify(focused));
  if (text !== "") await cdp.send("Input.insertText", { text });
  await sleep(250);
}

/* Empties a focused field with real backspaces. */
async function clearText(cdp, focusExpression, presses = 48) {
  const focused = await cdp.eval(focusExpression);
  if (focused !== "focused") throw new Error("could not focus a field for clearing: " + JSON.stringify(focused));
  const backspace = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
  for (let index = 0; index < presses; index += 1) {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...backspace });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...backspace });
  }
  await sleep(250);
}

/* ------------------------------------------------------------------------------------------------------
   The page-side driver for the ORIGINAL Plugins page (issue #5). Like the provider driver above it is a thin
   wrapper around the page's own DOM - it clicks the page's own buttons, focuses the page's own inputs and
   reads back what the page itself rendered - and it knows NOTHING about persistence or about the plugin it is
   pointed at. It is deliberately generic: a bundle is addressed by its PACKAGE NAME, a field by the ID THE
   BUNDLE CHOSE, and a switch by its own aria-label, so nothing here names the fixture's page. Two page facts
   shape it:
     * The onboarding dialogs come up over the app, and while one is up the app shell is inert: focus() is
       ignored, so typing through the browser's own input pipeline would reach whatever field still holds
       focus. They are dismissed first, one round at a time, until nothing is in the way.
     * Opening a bundle's card replaces the plugin list with that bundle's detail view, so the cards are read
       while they are still on screen, before any card is opened.
   ------------------------------------------------------------------------------------------------------ */
const PLUGIN_PAGE_DRIVER = [
  "(function () {",
  "  var list = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };",
  "  var visible = function (element) { return !!element && element.getClientRects().length > 0; };",
  "  var shown = function (selector, root) { return list(selector, root).filter(visible); };",
  "  var trimmed = function (value) { return (value || \"\").replace(/\\s+/g, \" \").trim(); };",
  "  var dialogs = function () { return shown(\"[role=dialog]\"); };",
  "  var buttonNamed = function (text, root) { return shown(\"button\", root).filter(function (button) { return trimmed(button.innerText) === text; })[0]; };",
  "  var configSection = function () { return document.querySelector(\"[data-plugin-config]\"); };",
  "  var saveButton = function () {",
  "    return shown(\"button\", configSection() || document).filter(function (button) { return /^save/i.test(trimmed(button.innerText)); })[0];",
  "  };",
  "  var api = {",
  "    blockers: function () {",
  "      var root = document.getElementById(\"root\");",
  "      return { count: dialogs().length, titles: dialogs().map(function (dialog) { return trimmed(dialog.innerText).slice(0, 60); }), rootInert: !!root && root.hasAttribute(\"inert\") };",
  "    },",
  "    dismiss: function () {",
  "      /* One round: the topmost dialog and, inside it, the one action a person would take. The card can come",
  "         back over the page, so the caller repeats this until nothing is in the way. */",
  "      var scope = dialogs().pop();",
  "      if (!scope) return \"none\";",
  "      var button = buttonNamed(\"Continue\", scope) || buttonNamed(\"Configure later\", scope) || null;",
  "      if (button === null) return \"no-action\";",
  "      var text = trimmed(button.innerText);",
  "      button.click();",
  "      return \"clicked \" + text;",
  "    },",
  "    openPlugins: function () {",
  "      var button = shown(\"button\").filter(function (candidate) { return candidate.getAttribute(\"aria-label\") === \"Plugins\" || trimmed(candidate.innerText) === \"Plugins\"; })[0];",
  "      if (!button) return \"no-nav\";",
  "      button.click();",
  "      return \"clicked\";",
  "    },",
  "    cards: function () {",
  "      return list(\"[data-plugin-package]\").map(function (node) { return { pkg: node.getAttribute(\"data-plugin-package\"), status: node.getAttribute(\"data-plugin-status\") }; });",
  "    },",
  "    openItem: function (label) {",
  "      var button = shown(\"button\").filter(function (candidate) { return candidate.getAttribute(\"aria-label\") === \"View \" + label; })[0];",
  "      if (!button) return \"no-card\";",
  "      button.click();",
  "      return \"clicked\";",
  "    },",
  "    openBundle: function (pkg) { return api.openItem(pkg); },",
  "    items: function () {",
  "      return list(\"[data-plugin-item]\").map(function (node) { return trimmed(node.innerText).slice(0, 140); });",
  "    },",
  "    detail: function () {",
  "      var section = configSection();",
  "      var slot = document.querySelector(\"[data-slot=\\\"plugins.bundle.config\\\"]\");",
  "      return {",
  "        detailCount: list(\"[data-plugin-detail]\").length,",
  "        configCount: list(\"[data-plugin-config]\").length,",
  "        slotPresent: !!slot,",
  "        slotHoldsForm: !!slot && list(\"input\", slot).length > 0,",
  "        fieldIds: section === null ? [] : shown(\"input\", section).map(function (input) { return input.id; }).filter(function (id) { return id !== \"\"; }),",
  "        buttons: section === null ? [] : shown(\"button\", section).map(function (button) { return trimmed(button.innerText); }).filter(function (text) { return text !== \"\"; }),",
  "        switches: list(\"[role=switch]\").map(function (node) { return { label: node.getAttribute(\"aria-label\") || \"\", checked: node.getAttribute(\"aria-checked\"), disabled: node.disabled === true }; }),",
  "        rows: list(\"[data-plugin-row]\").map(function (node) { return { row: node.getAttribute(\"data-plugin-row\"), state: node.getAttribute(\"data-state\") }; }),",
  "        text: section === null ? \"\" : trimmed(section.innerText),",
  "        body: trimmed(document.body.innerText).slice(0, 400)",
  "      };",
  "    },",
  "    fields: function (ids) {",
  "      return ids.map(function (id) {",
  "        var input = document.getElementById(id);",
  "        var message = document.getElementById(id + \"-message\");",
  "        return { id: id, present: !!input, value: input === null ? null : input.value, invalid: input === null ? null : input.getAttribute(\"aria-invalid\"), message: message === null ? null : trimmed(message.innerText) };",
  "      });",
  "    },",
  "    paragraphs: function () {",
  "      var section = configSection();",
  "      return section === null ? [] : list(\"p\", section).map(function (paragraph) { return trimmed(paragraph.innerText); });",
  "    },",
  "    save: function () {",
  "      var button = saveButton();",
  "      return { present: !!button, text: button === undefined ? null : trimmed(button.innerText), disabled: button === undefined ? null : button.disabled };",
  "    },",
  "    clickSave: function () {",
  "      var button = saveButton();",
  "      if (button === undefined) return \"missing\";",
  "      if (button.disabled) return \"disabled\";",
  "      button.click();",
  "      return \"clicked\";",
  "    },",
  "    focusField: function (id) {",
  "      var input = document.getElementById(id);",
  "      if (!input) return \"missing\";",
  "      input.focus();",
  "      if (input.select && input.tagName !== \"SELECT\") input.select();",
  "      return document.activeElement === input ? \"focused\" : \"blocked\";",
  "    },",
  "    clickSwitch: function (label) {",
  "      var node = shown(\"[role=switch]\").filter(function (candidate) { return candidate.getAttribute(\"aria-label\") === label; })[0];",
  "      if (!node) return \"missing\";",
  "      node.click();",
  "      return \"clicked\";",
  "    },",
  "    bodyText: function () { return trimmed(document.body.innerText); }",
  "  };",
  "  window.__e2ePlugins = api;",
  "  return \"installed\";",
  "})()",
].join("\n");

/* Opens the settings dialog and the ORIGINAL Models section on whatever document is loaded, and waits until the
   section settles. The onboarding card ("Add an API key to get started") is dismissed first: it is a dialog of its
   own, and while it is up it is the topmost dialog, so a reader that looks at the topmost dialog would see none of
   the section's rows. Both callers share this opening sequence and differ only in the expression that says the
   section has settled: the overlay reaches its provider list, the control reaches either that list or the failure
   the ORIGINAL composition reports for a remote origin. */
async function openModelsFrame(cdp, label, ready) {
  await installPageDriver(cdp);
  const trace = {};
  await waitFor(cdp, SHELL_PROBE, "app shell (" + label + ")");
  if ((await cdp.eval("window.__e2ePage.dialogText().length > 0")) !== true) trace.started = await cdp.eval("window.__e2ePage.start()");
  await waitForValue(cdp, "window.__e2ePage.dialogText().length > 0", "the settings dialog (" + label + ")", 25000);
  await sleep(1200);
  trace.dismissed = await cdp.eval("window.__e2ePage.dismiss()");
  await sleep(1200);
  trace.opened = await cdp.eval("window.__e2ePage.openModels()");
  try {
    await waitForValue(cdp, ready, "the Models section (" + label + ")", 25000);
  } catch (error) {
    console.log("MODELS-DIAG " + label + " " + JSON.stringify(trace) + " " + (await cdp.eval(MODELS_DIAG)));
    throw error;
  }
  return trace;
}

/* The section frame plus the page's own provider list, as the overlay's page draws it. */
async function openModelsSection(cdp, label) {
  const trace = await openModelsFrame(cdp, label, "window.__e2ePage.hasText('Add model provider')");
  trace.dismissedAgain = await cdp.eval("window.__e2ePage.dismiss()");
  await sleep(900);
  return JSON.parse(await cdp.eval("(function () { window.__e2ePage.dismiss(); return JSON.stringify({ rows: window.__e2ePage.providerRows(), text: window.__e2ePage.dialogText().slice(0, 400), body: window.__e2ePage.bodyText() }); })()"));
}

/* The Models section as the ORIGINAL composition serves it to a remote origin: the section frame appears, but its
   provider directory cannot resolve off-loopback, so the page reports that failure itself and offers no provider
   management. The read tolerates exactly that state and reports what the page said - it is the defect this issue
   is about, so the control records it instead of driving an Add action that is not there. */
async function openModelsSectionUnavailable(cdp, label) {
  const available = "window.__e2ePage.hasText(\"Add model provider\")";
  const unavailable = "window.__e2ePage.hasText(\"settings are unavailable in this browser\") || window.__e2ePage.hasText(\"Loading the provider directory failed\")";
  await openModelsFrame(cdp, label, available + " || " + unavailable);
  await sleep(900);
  const dump = await cdp.eval("(function () { return JSON.stringify({ rows: window.__e2ePage.providerRows(), text: window.__e2ePage.dialogText().slice(0, 600), body: window.__e2ePage.bodyText().slice(0, 600) }); })()");
  return JSON.parse(dump);
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "dsh-e2e-" + MODE + "-"));
  const home = join(root, "home");
  const profileDir = join(home, "profiles", PROFILE);
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "cordis.patch.yml"), "[]\n");
  await writeFile(join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
  /* Both modes start from the composition a real instance carries, so the overlay gate has something to
     replace and the rollback has something to restore. */
  const bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
  await writeFile(join(profileDir, "package.json"), JSON.stringify({ name: "dsh-profile-" + PROFILE, private: true, dependencies: {}, dsh: { profile: { bundles } } }, null, 2) + "\n");
  evidence.root = root;
  evidence.profile = PROFILE;
  await mkdir(EVIDENCE_DIR, { recursive: true });
  /* The profile's own patch file, read in every stage: a refusal, a restart or a rollback must never change
     it except where the change is the point of the stage. */
  const patchPath = join(profileDir, "cordis.patch.yml");
  const readPatch = async () => { try { return await readFile(patchPath, "utf8"); } catch (error) { return "<missing: " + error.code + ">"; } };
  /* The install copies outlive the install stage: a later stage points a second instance at the damaged copy
     to show what the running replacement does with a build it never verified. */
  const copies = join(COPY_BASE, "install-copies");
  const damagedCopy = join(copies, "damaged");

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
    /* Second negative control for the same gate: the recorded build must pin the manifest itself, not only
       the copied files, so a manifest whose bundle-patch sequence was reordered has to be refused. */
    const negativeDir = join(root, "verify-negative");
    cpSync(REPO_ROOT, negativeDir, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes(".git") });
    const negativeManifestPath = join(negativeDir, "packages/dsh-web-composition/package.json");
    const negativeManifest = JSON.parse(await readFile(negativeManifestPath, "utf8"));
    const reordered = negativeManifest.dsh.bundle.patch.slice();
    reordered.unshift(reordered.pop());
    negativeManifest.dsh.bundle.patch = reordered;
    await writeFile(negativeManifestPath, JSON.stringify(negativeManifest, null, 2) + "\n");
    let reorderRefused = false;
    let reorderRefusal = "";
    try { execFileSync(process.execPath, [join(negativeDir, "tools/verify-artifacts.mjs"), "--quiet", "--install", DSH_INSTALL], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reorderRefused = true; reorderRefusal = String(error.stdout || "") + String(error.stderr || ""); }
    evidence.negativeReorder = { refused: reorderRefused, output: reorderRefusal.trim().split("\n").slice(-3) };
    check("a reordered bundle-patch manifest is refused too (the record pins the manifest, not just the files)", reorderRefused && /changed since it was recorded|patch sequence/.test(reorderRefusal), reorderRefusal.trim().split("\n").slice(-2).join(" | "));
    /* The acceptance test drives the terminal entry point, so the operator's own command is what installs
       and switches here: nothing in this section edits the profile by hand. */
    await mkdir(copies, { recursive: true });
    const pristineCopy = join(copies, "pristine");
    const versionCopy = join(copies, "version");
    const mechanisms = [cloneInstall(DSH_INSTALL, pristineCopy), cloneInstall(DSH_INSTALL, versionCopy), cloneInstall(DSH_INSTALL, damagedCopy)];
    evidence.installCopies = { base: COPY_BASE, mechanisms, pristine: pristineCopy, version: versionCopy, damaged: damagedCopy };
    /* A different version of the same package, and the SAME version whose content changed: neither may pass
       the gate, so a version string alone is never what this replacement trusts. */
    const versionManifest = await readJson(join(versionCopy, "package.json"));
    await replaceFile(join(versionCopy, "package.json"), JSON.stringify({ ...versionManifest, version: "9.9.9" }, null, 2) + "\n");
    const damagedFile = join(damagedCopy, "node_modules/@deepseek-ai/cordis/LICENSE");
    await replaceFile(damagedFile, (await readFile(damagedFile, "utf8")) + "\n/* DSH_E2E_DAMAGED_INSTALLATION */\n");
    const pristineCheck = runTool(VERIFY_TOOL, ["--quiet", "--install", pristineCopy]);
    const versionCheck = runTool(VERIFY_TOOL, ["--quiet", "--install", versionCopy]);
    const damagedCheck = runTool(VERIFY_TOOL, ["--quiet", "--install", damagedCopy]);
    evidence.installCopyChecks = { pristine: pristineCheck.code, version: versionCheck.code, damaged: damagedCheck.code };
    check("an untouched copy of the installation passes the same preflight as the installation itself", pristineCheck.code === 0, pristineCheck.output.trim().split("\n").slice(-1)[0]);
    check("an installation carrying another version of the same package is refused (the version is checked, not compared as a string)", versionCheck.code === 1 && /installed version is 9\.9\.9, recorded 0\.2\.1-alpha\.2/.test(versionCheck.output), versionCheck.output.trim().split("\n").slice(-2).join(" | "));
    check("a SAME-version installation whose recorded file changed is refused too (the build identity catches it)", damagedCheck.code === 1 && /installed build differs from the recorded build identity/.test(damagedCheck.output), damagedCheck.output.trim().split("\n").slice(-2).join(" | "));
    /* The gate runs inside the terminal entry point as well: pointed at an installation it must refuse, it
       has to leave the profile byte-for-byte as it was, so a failed preflight can never half-install. */
    const snapshotBeforeRefusal = await profileSnapshot(profileDir, patchPath);
    const refusedEnable = runTool(OVERLAY_TOOL, ["enable", "--home", home, "--profile", PROFILE, "--install", damagedCopy]);
    evidence.enableRefused = refusedEnable.output.trim().split("\n").slice(-4);
    check("the terminal entry point refuses to install or switch anything when the preflight fails", refusedEnable.code === 1 && /refusing to install or switch anything/.test(refusedEnable.output), refusedEnable.output.trim().split("\n").slice(-2).join(" | "));
    check("a refused enable leaves the profile exactly as it was (no half install, no switch, no state file)", (await profileSnapshot(profileDir, patchPath)) === snapshotBeforeRefusal, "profile state unchanged");
    /* An instance that already saved a setting through the upstream provider carries that override in its own
       patch file. Enable has to carry the row over to the own provider, or the saved value would silently stop
       applying the moment the composition changes (the patch engine matches the row by its name guard). */
    const seededOverride = '- id: ui-settings\n  name: "@deepseek-ai/dsh-client-ui-settings"\n  config:\n    enabled: true\n';
    await writeFile(patchPath, seededOverride);
    evidence.files.profilePatchSeeded = seededOverride;
    const enable = runTool(OVERLAY_TOOL, ["enable", "--home", home, "--profile", PROFILE, "--install", DSH_INSTALL, "--dsh-bin", DSH_BIN, "--artifacts", join(root, "artifacts")]);
    evidence.enableOutput = enable.output.trim().split("\n").slice(-8);
    check("the documented enable runs the preflight and then installs the artifacts itself", enable.code === 0 && /provenance verification PASSED/.test(enable.output) && /switched dsh\.profile\.bundles/.test(enable.output), enable.output.trim().split("\n").slice(-3).join(" | "));
    const artifactNames = await readdir(join(root, "artifacts"));
    evidence.artifacts = artifactNames.map((name) => join(root, "artifacts", name));
    check("real packaged artifacts built (npm pack)", artifactNames.length === 2 && artifactNames.every((name) => name.endsWith(".tgz")), artifactNames.join(", "));
    const manifestPath = join(profileDir, "package.json");
    const manifest = await readJson(manifestPath);
    evidence.profileManifestAfterEnable = manifest;
    const nextBundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
    check("enable loads the own composition in place of the upstream roster", JSON.stringify(nextBundles) === JSON.stringify(["@deepseek-ai/dsh-base", OVERLAY_SCOPE + "/web-composition"]), JSON.stringify(nextBundles));
    check("both artifacts installed into the profile by the documented CLI", Boolean(manifest.dependencies[OVERLAY_SCOPE + "/web-composition"] && manifest.dependencies[FORK_PACKAGE]), JSON.stringify(manifest.dependencies));
    check("original web composition is not loaded", manifest.dependencies["@deepseek-ai/dsh-web-app"] === undefined, JSON.stringify(nextBundles));
    /* The swap record holds the bundle list it replaced and the build it was verified against, and nothing
       that could be mistaken for a configuration snapshot: the saved settings belong to the instance. */
    const swapPath = join(profileDir, "dsh-local-overlay.state.json");
    const swap = existsSync(swapPath) ? await readJson(swapPath) : null;
    evidence.swapState = swap;
    const patchAfterEnable = await readPatch();
    evidence.files.profilePatchAfterEnable = patchAfterEnable;
    const enabledOverrideBlock = patchRow(patchAfterEnable, "ui-settings");
    check("enable carries an override saved through the upstream provider over to the own provider", enabledOverrideBlock.includes('name: "@dsh-local-overlay/dsh-client-ui-settings"'), enabledOverrideBlock.replace(/\n/g, " | ").slice(0, 240));
    check("enable keeps that override's saved configuration (the row is translated, never replaced)", /id: ui-settings\n\s+name: "@dsh-local-overlay\/dsh-client-ui-settings"\n\s+config:\n\s+enabled: true\n?$/.test(enabledOverrideBlock), enabledOverrideBlock.replace(/\n/g, " | ").slice(0, 240));
    check("enable records that it translated a saved override row", swap !== null && swap.guardRows === 1, JSON.stringify(swap && swap.guardRows));
    check("enable records the bundle list it replaced and the verified build, and no configuration snapshot", swap !== null && swap.schema === "dsh-local-overlay/state@1" && JSON.stringify(swap.previousBundles) === JSON.stringify(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]) && typeof swap.identity === "string" && !JSON.stringify(swap).includes("cordis.patch") && !JSON.stringify(swap).includes("config"), JSON.stringify(swap));
  } else {
    check("control run loads the original web composition", true, JSON.stringify(bundles));
    const controlRows = await loadedSettingsRows(profileDir, bundles);
    evidence.loadedSettingsRows = controlRows;
    check("CONTROL: exactly one ui-settings provider row, served by the upstream package", controlRows.length === 1 && controlRows[0].provider === "@deepseek-ai/dsh-client-ui-settings", JSON.stringify(controlRows));
  }

  let instance = await startInstance(home, PROFILE);
  const parsed = new URL(instance.url);
  const remoteUrl = "http://" + TEST_HOST + ":" + parsed.port + "/" + parsed.search;
  evidence.urls = { loopback: instance.url, remote: remoteUrl };
  /* After the token redirect the document lives at the origin root, which is also the URL the offline
     reachability probe fetches. */
  const documentUrl = new URL(remoteUrl).origin + "/";
  /* The authority of the document currently loaded in the browser. A blanket exemption granted to a whole
     authority is only ever legitimate for an authority the page has LEFT (a retired port after a restart);
     a failure on the authority the page is on right now has to be named by its own request ID. */
  let pageAuthority = authorityOf(documentUrl);
  evidence.documentUrl = documentUrl;
  evidence.serverStartLog = instance.out().slice(0, 1500);
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
  /* The connections the harness itself deliberately discontinued. Every disruptive action it takes (a
     navigation, a reload, the forced offline window, a SIGTERM restart) records the streaming connections
     that were live at that moment, and only those exact request IDs may be tolerated - inside that stage
     only. Fresh retry attempts are handled separately (see isDisruptedStreamFailure) and are NEVER exempt on
     the authority the page is currently on, so a transport that is broken right now has to be named by its
     own request ID or fail the stage. */
  let discontinued = new Map();
  /* Every request ID the harness has ever discontinued. The browser never reports a close for a socket it
     severed through CDP, so such a connection stays in the bookkeeping as if it were still open; anything
     asserted to be CURRENTLY usable therefore has to be a connection the harness never discontinued. */
  const everDiscontinued = new Set();
  const discontinue = (reason) => {
    const marked = [];
    for (const connection of cdp.liveConnections()) {
      discontinued.set(connection.requestId, { reason, url: connection.url });
      everDiscontinued.add(connection.requestId);
      marked.push({ requestId: connection.requestId, kind: connection.kind, url: connection.url });
    }
    evidence["discontinued_" + reason] = (evidence["discontinued_" + reason] || []).concat(marked);
    return marked;
  };
  const navigate = async (url) => { discontinue("navigation"); pageAuthority = authorityOf(url); await cdp.send("Page.navigate", { url }).catch(() => {}); };
  const reload = async () => { discontinue("reload"); await cdp.send("Page.reload").catch(() => {}); };
  const stageEvents = () => cdp.errorEvents().slice(stageMark);
  /* Classification is structural, never text-based:
     - Runtime.exceptionThrown and Runtime.consoleAPICalled (type error) are failures at EVERY stage, in both
       modes, whatever their message says. A message that merely mentions net::ERR_* cannot buy an exemption.
     - A streaming failure is tolerated only when its request ID is one the harness discontinued by its own
       action, and only in the stage that took that action. Script, Stylesheet, Document, Image, Fetch, XHR and
       every other loadingFailed type are failures everywhere, including inside a forced window.
     - The initial load tolerates nothing at all: it asserts zero error events of any kind.
     The same stream-teardown noise appears in control mode against the untouched original composition, so it is
     baseline transport behaviour, not an overlay effect; every tolerated event is recorded in tolerated_<stage>
     together with the reason that let it through, and the discontinued set is recorded per stage. */
  /* The browser reports a failed transport twice: Network.loadingFailed carries the request URL, and the
     console echo carries the failing URL inside its message text. The echo is tolerated only when its
     `source` field says the NETWORK STACK produced it (page JavaScript reports as "javascript" or
     "console-api" and is therefore never tolerated), the URL quoted in the message matches a transport
     endpoint, and the message carries a real net::ERR_ code. */
  const quotedUrl = (text) => {
    const match = /'(wss?|https?):\/\/[^']+'/.exec(String(text));
    return match === null ? "" : match[0].slice(1, -1);
  };
  /* A connection the harness itself discontinued, failing on a real transport endpoint. */
  const isDiscontinuedTeardown = (event, discontinuedInStage) => {
    if (event.method !== "Network.loadingFailed") return "";
    if (!isStreamTarget(event.url)) return "";
    if (event.params.type !== "EventSource" && event.params.type !== "WebSocket") return "";
    if (!discontinuedInStage.has(event.params.requestId)) return "";
    return "the harness discontinued this connection by its own action: " + discontinuedInStage.get(event.params.requestId).reason;
  };
  /* The same disruptive action also breaks FOLLOW-UP attempts: a page the harness navigated away from, or one
     still pointed at an authority it just restarted, keeps retrying its stream with brand-new request IDs.
     Those are tolerated only on an authority the harness itself disrupted inside THIS stage, and only for
     EventSource/WebSocket on a stream endpoint; the window closes with the stage, so a transport that stays
     broken past the stage boundary still fails. */
  const isDisruptedStreamFailure = (event, discontinuedInStage) => {
    if (event.method !== "Network.loadingFailed") return "";
    if (event.params.type !== "EventSource" && event.params.type !== "WebSocket") return "";
    if (!isStreamTarget(event.url)) return "";
    /* Only the network stack can produce a loadingFailed of a stream type on this endpoint, and only a real
       network-layer failure code is accepted - a page that merely mentions an error string cannot produce one. */
    if (!/^net::ERR_/.test(String(event.params.errorText === undefined ? "" : event.params.errorText))) return "";
    const authority = authorityOf(event.url);
    if (authority === "") return "";
    /* The page's CURRENT authority is never exempt as a whole: a transport that is failing there right now
       must be named by request ID (the legitimately torn-down connection) or fail the stage. */
    if (authority === pageAuthority) return "";
    const reasons = [...discontinuedInStage.values()].filter((meta) => authorityOf(meta.url) === authority).map((meta) => meta.reason);
    if (reasons.length === 0) return "";
    return "the harness itself disrupted this authority in this stage (" + [...new Set(reasons)].join(", ") + ")";
  };
  /* The browser echoes a failed transport through the network Log too, and a Log entry carries no request ID.
     So the echo has to be matched against a teardown this stage ALREADY tolerated: the same authority, a
     stream endpoint, and the SAME network error code as that tolerated failure. It can therefore never stand
     alone, and it can never re-open a failure class the loadingFailed path rejects: the page's CURRENT
     authority is excluded here exactly as it is there, so a transport that is broken right now on the
     authority the page is using cannot be waved through just because the harness disrupted that authority
     earlier in this same stage. */
  const errorCodeOf = (text) => { const match = /net::ERR_[A-Z_]+/.exec(String(text)); return match === null ? "" : match[0]; };
  const isStreamLogEcho = (event, tolerated, discontinuedInStage) => {
    if (event.method !== "Log.entryAdded") return "";
    const entry = event.params.entry;
    if (entry.source !== "network") return "";
    const code = errorCodeOf(entry.text);
    if (code === "") return "";
    const target = isStreamTarget(event.url) ? event.url : quotedUrl(entry.text);
    if (target === "" || !isStreamTarget(target)) return "";
    const authority = authorityOf(target);
    if (authority === "" || authority === pageAuthority) return "";
    const endpoint = streamPath(target);
    /* The echo must belong to the SAME endpoint, not merely to the same authority: otherwise a failure of one
       stream endpoint could buy an exemption for another one (a /plugins/events error covering a settings-mux
       error). Two things can make the echo legitimate, and only two: a teardown of that very endpoint this
       stage already tolerated, or a connection on that endpoint + authority that the harness itself
       discontinued in this stage. The second case is needed because Chromium reports a failed WebSocket
       HANDSHAKE only as a network Log entry - there is no loadingFailed event for it to pair with. */
    const matchedTeardown = tolerated.filter((item) => item.event.method === "Network.loadingFailed" && isStreamTarget(item.event.url) && authorityOf(item.event.url) === authority && streamPath(item.event.url) === endpoint && errorCodeOf(item.event.text) === code);
    const matchedDiscontinued = [...discontinuedInStage.values()].filter((meta) => authorityOf(meta.url) === authority && streamPath(meta.url) === endpoint);
    if (matchedTeardown.length === 0 && matchedDiscontinued.length === 0) return "";
    return "network Log echo of the " + code + " failure on " + endpoint + " at " + authority + " (" + (matchedTeardown.length > 0 ? "the same endpoint was already tolerated in this stage" : "the harness itself discontinued this endpoint in this stage") + ")";
  };
  /* allowStreamTeardown is true only for stages in which the harness itself navigates, goes offline or restarts the instance. */
  /* The harness itself takes the page offline, so its own probes MUST fail. Those failures are required
     evidence for the stage (asserted below), and they are excluded from the unexpected bucket by exact
     shape: the reachability probe is a Fetch/XHR failure - or its network Log echo - on the document URL,
     and the transport probe is a WebSocket/EventSource failure or its Log echo on a stream endpoint. Both
     have to carry exactly ERR_INTERNET_DISCONNECTED, the error this harness provokes by going offline; no
     other error text and no other URL is ever tolerated this way. */
  const isInducedOfflineFailure = (event, documentUrl) => {
    const offlineText = (text) => /net::ERR_INTERNET_DISCONNECTED/.test(String(text));
    if (event.method === "Network.loadingFailed") {
      if (event.url === documentUrl) return (event.params.type === "Fetch" || event.params.type === "XHR") && event.params.errorText === "net::ERR_INTERNET_DISCONNECTED";
      return (event.params.type === "WebSocket" || event.params.type === "EventSource") && isStreamTarget(event.url) && offlineText(event.params.errorText);
    }
    if (event.method === "Log.entryAdded") {
      const entry = event.params.entry;
      if (entry.source !== "network" || !offlineText(entry.text)) return false;
      const target = isStreamTarget(event.url) ? event.url : (quotedUrl(entry.text) || event.url);
      return target === documentUrl || isStreamTarget(target);
    }
    return false;
  };
  /* A stream connection whose WebSocket handshake really succeeded. Network.webSocketCreated alone only says
     the browser tried: a refused or blocked handshake still creates the request, so the acceptance test for a
     recovered transport looks for the 101 response, and it names the settings endpoint explicitly - a
     /plugins/events EventSource cannot stand in for the settings transport. */
  const liveMuxConnections = () => cdp.liveConnections().filter((connection) => connection.kind === "WebSocket" && /\/api\/remote\.mux/.test(connection.url) && connection.handshake !== null && connection.handshake.status === 101 && !everDiscontinued.has(connection.requestId));
  /* Tolerating a teardown must never be the whole story: whenever a stage ends with the page expected to be
     usable, the page has to be holding a handshaken settings transport again. Otherwise a transport that the
     harness broke and that never came back could end the stage with no error event and still pass. */
  const assertLiveTransport = (stage) => {
    const live = liveMuxConnections();
    evidence["liveTransport_" + stage] = live;
    check("the page still holds a working settings transport (" + stage + ")", live.length > 0, JSON.stringify(live).slice(0, 240));
  };
  /* The forced-offline window has to reach the SETTINGS TRANSPORT, not merely the document request: the page's
     own socket (or the app's socket) must be reported as failing on a stream endpoint with the offline code.
     A page-side probe that returned something other than "failed"/"closed" therefore cannot satisfy it. */
  const isInducedTransportFailure = (event) => {
    if (event.method === "Network.loadingFailed") return (event.params.type === "WebSocket" || event.params.type === "EventSource") && isStreamTarget(event.url) && String(event.params.errorText) === "net::ERR_INTERNET_DISCONNECTED";
    if (event.method === "Log.entryAdded") { const target = isStreamTarget(event.url) ? event.url : quotedUrl(event.params.entry.text); return isStreamTarget(target) && /net::ERR_INTERNET_DISCONNECTED/.test(String(event.params.entry.text)); }
    return false;
  };
  /* A request the browser itself cancelled is not a failure of the page: when the harness navigates or reloads
     the document, whatever was still in flight is aborted and reported as canceled. The flag is the browser's
     own structural statement, it is accepted only in the stages where the harness was the one disrupting the
     page (never on the initial load), and streams are excluded so this can never excuse a broken transport. */
  const isCancelledInFlightRequest = (event) => {
    if (event.method !== "Network.loadingFailed") return "";
    if (event.params.canceled !== true) return "";
    if (isStreamTarget(event.url)) return "";
    return "the browser cancelled a request that was still in flight when the harness reloaded or navigated the page";
  };
  const assertNoStageErrors = (stage, allowStreamTeardown, inducedOfflineUrl, expectInducedTransport, inducedArtifactPatterns) => {
    const events = stageEvents();
    const discontinuedInStage = discontinued;
    stageMark = cdp.errorEvents().length;
    discontinued = new Map();
    evidence["console_" + stage] = events;
    evidence["discontinuedConnections_" + stage] = [...discontinuedInStage.entries()].map(([requestId, meta]) => ({ requestId, reason: meta.reason, url: meta.url }));
    /* A tolerated event must be the teardown of a connection the harness itself discontinued, and the Log
       echo of such a teardown is the only other thing accepted - never a standalone failure. */
    const tolerated = [];
    if (allowStreamTeardown) {
      for (const event of events) {
        const reason = isDiscontinuedTeardown(event, discontinuedInStage) || isDisruptedStreamFailure(event, discontinuedInStage) || isCancelledInFlightRequest(event);
        if (reason !== "") tolerated.push({ event, reason });
      }
      for (const event of events) {
        if (tolerated.some((item) => item.event === event)) continue;
        const echo = isStreamLogEcho(event, tolerated, discontinuedInStage);
        if (echo !== "") tolerated.push({ event, reason: echo });
      }
    }
    const induced = inducedOfflineUrl === undefined ? [] : events.filter((event) => isInducedOfflineFailure(event, inducedOfflineUrl));
    evidence["tolerated_" + stage] = tolerated.map((item) => ({ method: item.event.method, url: item.event.url, reason: item.reason, text: item.event.text }));
    if (inducedOfflineUrl !== undefined) {
      evidence["inducedOffline_" + stage] = induced;
      check("the induced offline probe really failed at the network layer (" + stage + ")", induced.some((event) => event.method === "Network.loadingFailed" && event.url === inducedOfflineUrl), JSON.stringify(induced.map((event) => event.text)));
      if (expectInducedTransport === true) {
        const transportFailures = induced.filter(isInducedTransportFailure);
        evidence["inducedTransport_" + stage] = transportFailures;
        check("the forced offline window really breaks the page's settings transport, not just the document request (" + stage + ")", transportFailures.length > 0, JSON.stringify(transportFailures.map((event) => event.text).slice(0, 2)));
      }
    }
    /* A damaged browser artifact is a failure the harness itself produced, and it is tolerated only when the
       events show what that artifact did to the page: the first pattern has to NAME the damaged entry, and the
       remaining patterns are the boot-failure signature that entry's absence produces. The naming observation is
       asserted below, so this exemption can never pass silently. */
    const artifactText = (event) => String(event.full) + " " + String(event.text);
    const inducedArtifact = inducedArtifactPatterns === undefined ? [] : events.filter((event) => inducedArtifactPatterns.some((pattern) => artifactText(event).includes(pattern)));
    if (inducedArtifactPatterns !== undefined) {
      evidence["inducedArtifact_" + stage] = inducedArtifact.map((event) => ({ method: event.method, url: event.url, full: String(event.full).slice(0, 1500) }));
      check("the damaged browser artifact really failed in the page (" + stage + ")", inducedArtifact.some((event) => String(event.full).includes(inducedArtifactPatterns[0])), JSON.stringify(inducedArtifact.map((event) => String(event.full).slice(0, 300)).slice(0, 2)));
    }
    const bad = events.filter((event) => !tolerated.some((item) => item.event === event) && !induced.includes(event) && !inducedArtifact.includes(event));
    const what = allowStreamTeardown
      ? "no runtime exceptions or console errors beyond the transport the harness itself tore down"
      : "no console exceptions, failures or protocol errors";
    check(what + " (" + stage + ")", bad.length === 0, JSON.stringify(bad.slice(0, 3).map((event) => event.text)));
  };
  assertNoStageErrors("onInitialLoad", false);

  /* =====================================================================================================
     Issue #4: the ORIGINAL provider page, driven from the remote (non-loopback) origin. Everything above
     only used the developer-tools switch; this is the page the issue is about, driven the way a person
     drives it - the page's own buttons, its own fields, its own validation messages. Every write is
     verified twice: from what the page rendered, and from the instance Host (the page's own RPC bodies
     read out of the CDP network log BY SHAPE, plus the profile patch and the credentials file on disk).
     No atomicity is claimed anywhere here: the induced-failure steps at the end record exactly what the
     original page does when only one of its two writes can land.
     ===================================================================================================== */
  const credentialsPath = join(home, ".credentials.yaml");
  const readTextFile = async (path) => { try { return await readFile(path, "utf8"); } catch (error) { return "<missing: " + (error && error.code ? error.code : String(error)) + ">"; } };
  /* llm-pi-ai providers.<route>, exactly as the page writes it: the route block is indented under "providers:". */
  const providerBlock = (patchText, route) => {
    const match = new RegExp("^ {6}" + route + ":\\s*\\n((?: {8}[^\\n]*\\n?)*)", "m").exec(patchText);
    return match === null ? null : match[1];
  };
  const providerFieldOf = (patchText, route, field) => {
    const block = providerBlock(patchText, route);
    if (block === null) return null;
    const match = new RegExp("^ {8}" + field + ":\\s*(.*)$", "m").exec(block);
    return match === null ? null : match[1].trim();
  };
  const providerModelIds = (patchText, route) => {
    const block = providerBlock(patchText, route) || "";
    return Array.from(block.matchAll(/^ {10}- id:\s*(\S+)\s*$/gm)).map((match) => match[1]);
  };
  /* The revision the instance's settings Host reports for the provider namespace: two reads bracketing a failed
     write must agree on it, which is what "nothing was persisted" means from the Host's own point of view. */
  const namespaceRevision = (described) => {
    const entry = described !== null && described.ok === true ? described.value.namespaces.filter((item) => item.ns === "llm-pi-ai")[0] : null;
    return entry === undefined || entry === null ? null : entry.revision;
  };
  /* Every RPC the PAGE itself sent since a mark, parsed from its own request bodies: method plus the args it
     carried. Every assertion below is made on this parsed shape, never on a stringified blob. */
  const pageRpcCallsSince = (sinceSeq) => cdp.requests
    .filter((request) => request.seq > sinceSeq && request.method === "POST" && /^\/api\/[^/]+\/[^/]+$/.test(pathnameOf(request.url)))
    .map((request) => { let body = null; try { body = JSON.parse(request.postData); } catch (error) { body = null; } return body === null ? null : { seq: request.seq, method: body.method, args: body.payload ? body.payload.args : undefined }; })
    .filter((call) => call !== null);
  const settingsMutatesOf = (calls) => calls.filter((call) => call.method === "settings/mutate");
  const credentialCallsOf = (calls, method) => calls.filter((call) => call.method === method);
  const rowOf = (state, route) => state.rows.filter((row) => row.route === route)[0] || null;
  const openEditor = async (route) => {
    await cdp.eval('window.__e2ePage.rowButton(' + JSON.stringify(route) + ', "Edit")');
    await waitForValue(cdp, '!!window.__e2ePage.editCard(' + JSON.stringify(route) + ')', "the inline provider editor (" + route + ")", 20000);
    await cdp.eval('window.__e2ePage.editDetails(' + JSON.stringify(route) + ')');
    await sleep(600);
  };
  const closeEditor = async (route) => { await cdp.eval('window.__e2ePage.cancel(' + JSON.stringify(route) + ')'); await sleep(700); };
  /* A read of the page's provider list. A caller that expects a specific provider names it, and the read waits
     for that row: the section draws its frame before its own settings read resolves. There is deliberately no
     generic "the list is non-empty" wait, because in a pristine profile the page draws its built-in provider
     card ALREADY EXPANDED (that card has no Edit button then), so rows are only keyable off a collapsed card -
     which is exactly what this stage asserts about the provider it creates. */
  const readProviderSide = async (label, expectRoute) => {
    const state = await openModelsSection(cdp, label);
    if (expectRoute !== undefined) {
      try {
        await waitForValue(cdp, "window.__e2ePage.providerRows().some((row) => row.route === " + JSON.stringify(expectRoute) + ")", "the provider row (" + expectRoute + ", " + label + ")", 20000);
      } catch (error) {
        console.log("PROVIDERS-DIAG " + label + " routes=" + JSON.stringify(state.rows.map((row) => row.route)) + " dump=" + (await cdp.eval(MODELS_CARDS)));
        throw error;
      }
    }
    return state;
  };
  /* What the page's own editor shows for the key: it can only offer to replace a stored value, never reveal one. */
  const keySideOf = async (route) => {
    await openEditor(route);
    const form = await cdp.eval('window.__e2ePage.editDump(' + JSON.stringify(route) + ')');
    await closeEditor(route);
    const fields = form && Array.isArray(form.fields) ? form.fields : [];
    return fields.filter((field) => field.label === "API key")[0] || null;
  };
  const pageSecrets = async () => secretsIn(await cdp.eval("window.__e2ePage.bodyText()"));
  /* The credential criterion of issue #4, read the same way at every boundary the page survives - a refresh, a
     forced reconnect, a restart: the page's own rendering, the store on the instance Host and the editor's offer
     to replace, plus the provider the page deleted through its own flow, which must still be gone on every side.
     The phrase names the boundary inside each check and the evidence entry stays separate per boundary. */
  const assertCredentialSurvival = async (label, phrase, evidenceKey) => {
    const state = await readProviderSide(label, PAGE_PROVIDER);
    const row = rowOf(state, PAGE_PROVIDER);
    const refs = credentialRefsOf(await readTextFile(credentialsPath));
    const deleted = await rpcFor(instance.url)("credentials/describe", { refs: [PAGE_KEY_REF_2] });
    const deletedRef = deleted.ok === true && deleted.value[PAGE_KEY_REF_2] !== undefined ? deleted.value[PAGE_KEY_REF_2] : null;
    const patch = await readPatch();
    const key = await keySideOf(PAGE_PROVIDER);
    const deletedRow = rowOf(state, PAGE_PROVIDER_2);
    evidence.modelsPage[evidenceKey] = { row, refs, text: state.text.slice(0, 200), deletedRow, deletedRef: deletedRef === null ? null : { configured: deletedRef.configured }, profileHasDeletedProvider: providerBlock(patch, PAGE_PROVIDER_2) !== null };
    check("after " + phrase + " the provider page still lists the provider, with its key reported as configured only", row !== null && row.displayName === PAGE_PROVIDER_DISPLAY_2 && row.keyConfigured === true && row.keyValue === "", JSON.stringify(row));
    check("after " + phrase + " the stored credential is unchanged and still not readable from the page", refs[PAGE_KEY_REF] === PAGE_KEY_ROTATED && secretsIn(state.body).length === 0, JSON.stringify(refs));
    check("after " + phrase + " the page's own editor still only offers to replace the stored key, never shows it", key !== null && key.value === "" && key.placeholder.indexOf("Configured") !== -1, JSON.stringify(key));
    check("the provider the page deleted is still gone after " + phrase + ": no row, no profile entry, no stored credential, and the Host does not report its reference as configured", deletedRow === null && state.body.indexOf(PAGE_PROVIDER_2) === -1 && providerBlock(patch, PAGE_PROVIDER_2) === null && refs[PAGE_KEY_REF_2] === undefined && (deletedRef === null || deletedRef.configured !== true), JSON.stringify({ deletedRow, deletedRef: deletedRef === null ? null : { configured: deletedRef.configured }, refs: Object.keys(refs) }));
  };

  if (MODE !== "overlay") {
    /* CONTROL: the original composition. The Models section is served by the original page, and that page resolves
       its provider directory off the loopback origin: from a remote origin it reports its own failure and offers no
       provider management at all. That is the defect this issue is about, so the control records what the page
       actually did rather than driving an Add action that is not there, and asserts that nothing reached the
       instance Host either. The persisted-value contrast is covered by the switch stages, which run in both modes. */
    const controlPatchBefore = await readPatch();
    const controlMark = cdp.eventSeq;
    const controlPage = await openModelsSectionUnavailable(cdp, "control provider page");
    const controlCalls = pageRpcCallsSince(controlMark);
    const controlPatchAfter = await readPatch();
    evidence.modelsPage = { controlText: controlPage.text.slice(0, 300), controlRows: controlPage.rows.map((row) => row.route), controlCalls: controlCalls.map((call) => call.method), patchBefore: controlPatchBefore, patchAfter: controlPatchAfter };
    check("CONTROL: the ORIGINAL page is served to the remote browser, and its own provider directory cannot resolve there - it says so itself", /settings are unavailable in this browser/.test(controlPage.text) || /Loading the provider directory failed/.test(controlPage.text), controlPage.text.slice(0, 240));
    check("CONTROL: the original page offers no provider management from a remote origin (no Add action, no provider rows)", controlPage.text.indexOf("Add model provider") === -1 && controlPage.rows.length === 0, JSON.stringify({ rows: controlPage.rows.map((row) => row.route), text: controlPage.text.slice(0, 160) }));
    check("CONTROL: the original page's Models section writes nothing to the instance Host", controlPatchAfter === controlPatchBefore && controlCalls.filter((call) => /settings\/mutate|credentials\//.test(call.method)).length === 0, JSON.stringify(controlCalls.map((call) => call.method)));
  } else {
  /* ---- the page's own provider list, read from the remote origin ---- */
  const modelsInitial = await readProviderSide("initial provider page");
  const patchBefore = await readPatch();
  evidence.modelsPage = { initialRows: modelsInitial.rows, initialText: modelsInitial.text.slice(0, 240), patchBefore };
  check("the remote browser gets the ORIGINAL provider page: its own provider list and its own Add action", modelsInitial.text.indexOf("Enter your API keys to use models from the following providers") !== -1 && modelsInitial.text.indexOf("DeepSeek") !== -1 && modelsInitial.text.indexOf("deepseek-official") !== -1 && modelsInitial.text.indexOf("Add model provider") !== -1, modelsInitial.text.slice(0, 240));
  check("the route this stage works on does not exist yet (the stage starts from a known state)", modelsInitial.body.indexOf(PAGE_PROVIDER) === -1, JSON.stringify(modelsInitial.rows.map((row) => row.route)));

  /* ---- 1. create a provider through the page (route, name, base URL, protocol, key, one model) ---- */
  const createMark = cdp.eventSeq;
  await cdp.eval('window.__e2ePage.addProvider()');
  await waitForValue(cdp, '!!window.__e2ePage.addCard()', "the add provider card", 20000);
  await cdp.eval('window.__e2ePage.customTab()');
  await sleep(800);
  await cdp.eval('window.__e2ePage.addDetails()');
  await typeText(cdp, 'window.__e2ePage.focusAdd("Provider ID")', PAGE_PROVIDER);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Display name")', PAGE_PROVIDER_DISPLAY);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Base URL")', PAGE_PROVIDER_BASE);
  await cdp.eval('window.__e2ePage.pickAdd("API protocol", "anthropic-messages")');
  await typeText(cdp, 'window.__e2ePage.focusAdd("API key")', PAGE_KEY_1);
  const saveWithoutModel = await cdp.eval('window.__e2ePage.cardButton("Create provider")');
  await cdp.eval('window.__e2ePage.addModel("")');
  await sleep(800);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Model ID 1")', PAGE_MODEL);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Display name 1")', PAGE_MODEL_NAME);
  await sleep(400);
  const createForm = await cdp.eval('window.__e2ePage.addDump()');
  const createSave = await cdp.eval('window.__e2ePage.saveAdd("Create provider")');
  await sleep(3000);
  const createCalls = pageRpcCallsSince(createMark);
  const createMutation = settingsMutatesOf(createCalls)[0];
  const createOps = createMutation && Array.isArray(createMutation.args.ops) ? createMutation.args.ops : [];
  const createOp = createOps.length === 1 ? createOps[0] : null;
  const createValue = createOp && createOp.value && typeof createOp.value === "object" ? createOp.value : null;
  const createCredential = credentialCallsOf(createCalls, "credentials/set")[0];
  const patchAfterCreate = await readPatch();
  const refsAfterCreate = credentialRefsOf(await readTextFile(credentialsPath));
  evidence.modelsPage.create = { form: createForm, save: createSave, calls: createCalls, patch: patchAfterCreate, refs: refsAfterCreate };
  check("the page's own form cannot be submitted while the provider has no model", saveWithoutModel === "disabled", JSON.stringify(saveWithoutModel));
  check("the page created the provider as exactly one settings/mutate on its own namespace, guarded by the revision it read", createMutation !== undefined && createMutation.args.ns === "llm-pi-ai" && createOps.length === 1 && createOp.op === "set" && JSON.stringify(createOp.path) === JSON.stringify(["providers", PAGE_PROVIDER]) && typeof createMutation.args.expectedRevision === "number", JSON.stringify(createCalls.filter((call) => call.method === "settings/mutate")).slice(0, 500));
  check("the created configuration carries the fields the form held, plus the credential reference the page derives", createValue !== null && createValue.displayName === PAGE_PROVIDER_DISPLAY && createValue.baseURL === PAGE_PROVIDER_BASE && createValue.api === "anthropic-messages" && createValue.apiKeyEnv === PAGE_KEY_REF && Array.isArray(createValue.models) && createValue.models.length === 1 && createValue.models[0].id === PAGE_MODEL, JSON.stringify(createOp).slice(0, 500));
  check("the typed test key left the page write-only, under the reference derived from the route", createCredential !== undefined && createCredential.args.ref === PAGE_KEY_REF && createCredential.args.value === PAGE_KEY_1, JSON.stringify(credentialCallsOf(createCalls, "credentials/set")).slice(0, 300));
  check("the configuration the page saved is on the instance Host (profile patch, llm-pi-ai providers.<route>)", providerFieldOf(patchAfterCreate, PAGE_PROVIDER, "displayName") === PAGE_PROVIDER_DISPLAY && providerFieldOf(patchAfterCreate, PAGE_PROVIDER, "baseURL") === PAGE_PROVIDER_BASE && providerFieldOf(patchAfterCreate, PAGE_PROVIDER, "api") === "anthropic-messages" && providerFieldOf(patchAfterCreate, PAGE_PROVIDER, "apiKeyEnv") === PAGE_KEY_REF && providerModelIds(patchAfterCreate, PAGE_PROVIDER).join(",") === PAGE_MODEL, JSON.stringify(providerBlock(patchAfterCreate, PAGE_PROVIDER)).slice(0, 400));
  check("the credential the page typed is on the instance Host", refsAfterCreate[PAGE_KEY_REF] === PAGE_KEY_1, JSON.stringify(Object.keys(refsAfterCreate)));
  const afterCreate = await readProviderSide("after create", PAGE_PROVIDER);
  await cdp.screenshot(join(EVIDENCE_DIR, MODE + "-13-provider-created.png"));
  const createdRow = rowOf(afterCreate, PAGE_PROVIDER);
  check("the page lists the new provider with its own identity and actions", createdRow !== null && createdRow.displayName === PAGE_PROVIDER_DISPLAY && createdRow.custom === true && createdRow.hasDelete === true, JSON.stringify(createdRow));
  check("the page reports the credential as configured and cannot show the key itself", createdRow !== null && createdRow.keyConfigured === true && createdRow.keyValue === "" && createdRow.editorOpen === false, JSON.stringify(createdRow));
  check("no test secret appears in the page's own text after a create", (await pageSecrets()).length === 0, JSON.stringify(await pageSecrets()));
  const describeCreated = await rpcFor(instance.url)("credentials/describe", { refs: [PAGE_KEY_REF] });
  check("the page's own read path cannot read a stored secret back (describe reports configured, never a value)", describeCreated.ok === true && describeCreated.value[PAGE_KEY_REF].configured === true && describeCreated.value[PAGE_KEY_REF].value === undefined, JSON.stringify(describeCreated).slice(0, 300));

  /* ---- 2. the page's own field validation, with a provider that now exists ---- */
  const patchBeforeValidation = await readPatch();
  await cdp.eval('window.__e2ePage.addProvider()');
  await waitForValue(cdp, '!!window.__e2ePage.addCard()', "the add provider card (validation)", 20000);
  await cdp.eval('window.__e2ePage.customTab()');
  await sleep(800);
  await cdp.eval('window.__e2ePage.addDetails()');
  /* The form is filled the way a successful create fills it - route, name, base URL, protocol, key and one model -
     so that each refusal can be attributed to the single field under test. The create flow above already proves the
     no-model rule disables the button on its own, and that is why this form carries a model: without one, all three
     refusals would be explained by that rule instead of by the validator being measured. */
  await typeText(cdp, 'window.__e2ePage.focusAdd("Provider ID")', "Bad_Route");
  await typeText(cdp, 'window.__e2ePage.focusAdd("Display name")', "E2E Rejected Provider");
  await typeText(cdp, 'window.__e2ePage.focusAdd("Base URL")', PAGE_PROVIDER_BASE);
  await cdp.eval('window.__e2ePage.pickAdd("API protocol", "anthropic-messages")');
  await typeText(cdp, 'window.__e2ePage.focusAdd("API key")', PAGE_KEY_1);
  await cdp.eval('window.__e2ePage.addModel("")');
  await sleep(800);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Model ID 1")', PAGE_MODEL);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Display name 1")', PAGE_MODEL_NAME);
  await sleep(600);
  const malformedRoute = { form: await cdp.eval('window.__e2ePage.addDump()'), save: await cdp.eval('window.__e2ePage.cardButton("Create provider")') };
  await clearText(cdp, 'window.__e2ePage.focusAdd("Provider ID")');
  await typeText(cdp, 'window.__e2ePage.focusAdd("Provider ID")', PAGE_PROVIDER);
  await sleep(700);
  const takenRoute = { form: await cdp.eval('window.__e2ePage.addDump()'), save: await cdp.eval('window.__e2ePage.cardButton("Create provider")') };
  await typeText(cdp, 'window.__e2ePage.focusAdd("Provider ID")', PAGE_PROVIDER_2);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Base URL")', "not-a-url");
  await sleep(700);
  const malformedBase = { form: await cdp.eval('window.__e2ePage.addDump()'), save: await cdp.eval('window.__e2ePage.cardButton("Create provider")') };
  /* Put the only field that is still wrong back the way it was: the very same form must become saveable again. */
  await clearText(cdp, 'window.__e2ePage.focusAdd("Base URL")');
  await typeText(cdp, 'window.__e2ePage.focusAdd("Base URL")', PAGE_PROVIDER_BASE);
  await sleep(700);
  const corrected = { form: await cdp.eval('window.__e2ePage.addDump()'), save: await cdp.eval('window.__e2ePage.cardButton("Create provider")') };
  evidence.modelsPage.validation = { malformedRoute, takenRoute, malformedBase, corrected };
  check("the page keeps its own Provider ID validation (a malformed route is reported and cannot be saved)", malformedRoute.save === "disabled" && malformedRoute.form.paragraphs.some((text) => text.indexOf("Start with a lowercase letter") !== -1), JSON.stringify({ save: malformedRoute.save, paragraphs: malformedRoute.form.paragraphs }).slice(0, 400));
  check("the page refuses a Provider ID that is already taken (message reported, nothing saveable)", takenRoute.save === "disabled" && takenRoute.form.paragraphs.some((text) => text.indexOf("already uses this ID") !== -1), JSON.stringify({ save: takenRoute.save, paragraphs: takenRoute.form.paragraphs }).slice(0, 400));
  check("the page keeps its own Base URL validation", malformedBase.save === "disabled" && malformedBase.form.paragraphs.some((text) => text.indexOf("valid HTTP") !== -1), JSON.stringify({ save: malformedBase.save, paragraphs: malformedBase.form.paragraphs }).slice(0, 400));
  check("the three refusals were the fields' doing, not an unsaveable form: the same form saves once the wrong field is corrected", corrected.save === "enabled" && corrected.form.paragraphs.every((text) => text.indexOf("Start with a lowercase letter") === -1 && text.indexOf("already uses this ID") === -1 && text.indexOf("valid HTTP") === -1), JSON.stringify({ save: corrected.save, paragraphs: corrected.form.paragraphs }).slice(0, 400));
  await cdp.eval('window.__e2ePage.cancel("")');
  await sleep(900);
  check("none of the refused forms was persisted (the profile is byte-identical)", (await readPatch()) === patchBeforeValidation, JSON.stringify((await readPatch()).slice(0, 200)));

  /* ---- 3. edit the provider through the page: name, base URL, protocol, a second model, a new key ---- */
  const editMark = cdp.eventSeq;
  await openEditor(PAGE_PROVIDER);
  const editFormBefore = await cdp.eval('window.__e2ePage.editDump(' + JSON.stringify(PAGE_PROVIDER) + ')');
  check("the page's editor opens on the saved values and only says that a key is configured", editFormBefore.fields.some((field) => field.label === "Display name" && field.value === PAGE_PROVIDER_DISPLAY) && editFormBefore.fields.some((field) => field.label === "Base URL" && field.value === PAGE_PROVIDER_BASE) && editFormBefore.fields.some((field) => field.label === "API key" && field.value === "" && field.placeholder.indexOf("Configured") !== -1) && editFormBefore.fields.every((field) => secretsIn(String(field.value)).length === 0), JSON.stringify(editFormBefore.fields).slice(0, 700));
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "Display name")', PAGE_PROVIDER_DISPLAY_2);
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "Base URL")', PAGE_PROVIDER_BASE_2);
  await cdp.eval('window.__e2ePage.pickEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "API protocol", "openai-completions")');
  await cdp.eval('window.__e2ePage.addModel(' + JSON.stringify(PAGE_PROVIDER) + ')');
  await sleep(900);
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "Model ID 2")', PAGE_MODEL_2);
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "Display name 2")', PAGE_MODEL_NAME_2);
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "API key")', PAGE_KEY_2);
  await sleep(400);
  const editSave = await cdp.eval('window.__e2ePage.saveEdit(' + JSON.stringify(PAGE_PROVIDER) + ')');
  await sleep(3000);
  const editCalls = pageRpcCallsSince(editMark);
  const editMutation = settingsMutatesOf(editCalls)[0];
  const editOps = editMutation && Array.isArray(editMutation.args.ops) ? editMutation.args.ops : [];
  const editCredential = credentialCallsOf(editCalls, "credentials/set")[0];
  const patchAfterEdit = await readPatch();
  const refsAfterEdit = credentialRefsOf(await readTextFile(credentialsPath));
  evidence.modelsPage.edit = { save: editSave, calls: editCalls, patch: patchAfterEdit, refs: refsAfterEdit };
  check("the page's editor sent leaf-path operations under the same revision guard", editMutation !== undefined && editMutation.args.ns === "llm-pi-ai" && typeof editMutation.args.expectedRevision === "number" && editOps.length >= 3 && editOps.every((op) => op.op === "set" && op.path[0] === "providers" && op.path[1] === PAGE_PROVIDER && op.path.length === 3), JSON.stringify(editOps.map((op) => JSON.stringify(op.path.slice(2)))).slice(0, 400));
  check("the edit changed the name, the base URL, the protocol and the model list on the instance Host", providerFieldOf(patchAfterEdit, PAGE_PROVIDER, "displayName") === PAGE_PROVIDER_DISPLAY_2 && providerFieldOf(patchAfterEdit, PAGE_PROVIDER, "baseURL") === PAGE_PROVIDER_BASE_2 && providerFieldOf(patchAfterEdit, PAGE_PROVIDER, "api") === "openai-completions" && providerModelIds(patchAfterEdit, PAGE_PROVIDER).join(",") === PAGE_MODEL + "," + PAGE_MODEL_2, JSON.stringify(providerBlock(patchAfterEdit, PAGE_PROVIDER)).slice(0, 400));
  check("a second key typed into the page replaces the stored credential", editCredential !== undefined && editCredential.args.ref === PAGE_KEY_REF && editCredential.args.value === PAGE_KEY_2 && refsAfterEdit[PAGE_KEY_REF] === PAGE_KEY_2, JSON.stringify(refsAfterEdit));
  const afterEdit = await readProviderSide("after edit", PAGE_PROVIDER);
  const editedRow = rowOf(afterEdit, PAGE_PROVIDER);
  check("the page re-renders the provider under its new name and still only reports the key as configured", editedRow !== null && editedRow.displayName === PAGE_PROVIDER_DISPLAY_2 && editedRow.keyConfigured === true && editedRow.keyValue === "", JSON.stringify(editedRow));
  check("no test secret appears in the page's own text after an edit", (await pageSecrets()).length === 0, JSON.stringify(await pageSecrets()));
  const editedKey = await keySideOf(PAGE_PROVIDER);
  check("the page's own editor offers only to replace the stored key and cannot show it", editedKey !== null && editedKey.value === "" && editedKey.placeholder.indexOf("Configured") !== -1, JSON.stringify(editedKey));

  /* ---- 4. the revision guard is not bypassed: another writer wins and the page refuses ---- */
  const conflictMark = cdp.eventSeq;
  const described = await rpcFor(instance.url)("settings/describe", {});
  const llmNamespace = described.ok === true ? described.value.namespaces.filter((entry) => entry.ns === "llm-pi-ai")[0] : null;
  check("the Host reports the namespace revision the guard is built on", llmNamespace !== null && typeof llmNamespace.revision === "number", JSON.stringify(llmNamespace === null ? described : { ns: llmNamespace.ns, revision: llmNamespace.revision }));
  await openEditor(PAGE_PROVIDER);
  const bumped = await rpcFor(instance.url)("settings/mutate", { ns: "llm-pi-ai", ops: [{ op: "set", path: ["providers", PAGE_PROVIDER, "displayName"], value: PAGE_PROVIDER_STALE }], expectedRevision: llmNamespace.revision });
  check("another writer changes the same namespace while the editor is open (the revision moves on)", bumped.ok === true, JSON.stringify(bumped).slice(0, 300));
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "Display name")', PAGE_PROVIDER_BLOCKED);
  await sleep(400);
  const conflictSave = await cdp.eval('window.__e2ePage.saveEdit(' + JSON.stringify(PAGE_PROVIDER) + ')');
  await sleep(3000);
  const conflictCalls = pageRpcCallsSince(conflictMark);
  const conflictForm = await cdp.eval('window.__e2ePage.editDump(' + JSON.stringify(PAGE_PROVIDER) + ')');
  const patchAfterConflict = await readPatch();
  evidence.modelsPage.conflict = { save: conflictSave, calls: conflictCalls, form: conflictForm, patch: patchAfterConflict };
  check("the page's Apply really sent the stale revision it read when the editor opened", settingsMutatesOf(conflictCalls).some((call) => typeof call.args.expectedRevision === "number" && call.args.expectedRevision === llmNamespace.revision), JSON.stringify(settingsMutatesOf(conflictCalls).map((call) => call.args.expectedRevision)));
  check("the refused edit reports the recorded conflict message instead of overwriting silently", conflictForm.paragraphs.some((text) => text.indexOf("Someone else changed these settings") !== -1), JSON.stringify(conflictForm.paragraphs).slice(0, 400));
  check("the refused edit persisted nothing (the other writer's value is still the stored one)", providerFieldOf(patchAfterConflict, PAGE_PROVIDER, "displayName") === PAGE_PROVIDER_STALE, JSON.stringify(providerFieldOf(patchAfterConflict, PAGE_PROVIDER, "displayName")));
  await closeEditor(PAGE_PROVIDER);

  /* ---- 5. a key typed into the reopened editor replaces the stored one again ---- */
  const replaceMark = cdp.eventSeq;
  await openEditor(PAGE_PROVIDER);
  const reopenedForm = await cdp.eval('window.__e2ePage.editDump(' + JSON.stringify(PAGE_PROVIDER) + ')');
  check("the reopened editor reads the namespace again and shows the value the other writer left", reopenedForm.fields.some((field) => field.label === "Display name" && field.value === PAGE_PROVIDER_STALE), JSON.stringify(reopenedForm.fields).slice(0, 400));
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "Display name")', PAGE_PROVIDER_DISPLAY_2);
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "API key")', PAGE_KEY_3);
  await sleep(400);
  const replaceSave = await cdp.eval('window.__e2ePage.saveEdit(' + JSON.stringify(PAGE_PROVIDER) + ')');
  await sleep(3000);
  const replaceCalls = pageRpcCallsSince(replaceMark);
  const refsAfterReplace = credentialRefsOf(await readTextFile(credentialsPath));
  evidence.modelsPage.replaceKey = { save: replaceSave, calls: replaceCalls, refs: refsAfterReplace };
  check("a key typed into the page replaces the stored credential a second time", credentialCallsOf(replaceCalls, "credentials/set").some((call) => call.args.ref === PAGE_KEY_REF && call.args.value === PAGE_KEY_3) && refsAfterReplace[PAGE_KEY_REF] === PAGE_KEY_3, JSON.stringify(refsAfterReplace));
  check("the provider page is back on the name this stage keeps for the survival checks", providerFieldOf(await readPatch(), PAGE_PROVIDER, "displayName") === PAGE_PROVIDER_DISPLAY_2, JSON.stringify(providerFieldOf(await readPatch(), PAGE_PROVIDER, "displayName")));
  await closeEditor(PAGE_PROVIDER);

  /* ---- 6. delete: a second provider goes away with its configuration and its key, the first one stays ---- */
  const deleteMark = cdp.eventSeq;
  await cdp.eval('window.__e2ePage.addProvider()');
  await waitForValue(cdp, '!!window.__e2ePage.addCard()', "the add provider card (delete case)", 20000);
  await cdp.eval('window.__e2ePage.customTab()');
  await sleep(800);
  await cdp.eval('window.__e2ePage.addDetails()');
  await typeText(cdp, 'window.__e2ePage.focusAdd("Provider ID")', PAGE_PROVIDER_2);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Display name")', PAGE_PROVIDER_2_DISPLAY);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Base URL")', PAGE_PROVIDER_2_BASE);
  await cdp.eval('window.__e2ePage.pickAdd("API protocol", "anthropic-messages")');
  await typeText(cdp, 'window.__e2ePage.focusAdd("API key")', PAGE_KEY_2_OF_2);
  await cdp.eval('window.__e2ePage.addModel("")');
  await sleep(800);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Model ID 1")', PAGE_MODEL);
  await typeText(cdp, 'window.__e2ePage.focusAdd("Display name 1")', PAGE_MODEL_NAME);
  await sleep(400);
  const secondSave = await cdp.eval('window.__e2ePage.saveAdd("Create provider")');
  await sleep(3000);
  const secondState = await readProviderSide("second provider created", PAGE_PROVIDER_2);
  const secondRow = rowOf(secondState, PAGE_PROVIDER_2);
  const refsAfterSecond = credentialRefsOf(await readTextFile(credentialsPath));
  check("a second provider can be added while the first one stays configured", secondSave.state === "clicked" && secondRow !== null && secondRow.keyConfigured === true && refsAfterSecond[PAGE_KEY_REF_2] === PAGE_KEY_2_OF_2 && refsAfterSecond[PAGE_KEY_REF] === PAGE_KEY_3, JSON.stringify({ secondSave, secondRow, refs: refsAfterSecond }));
  await cdp.eval('window.__e2ePage.rowButton(' + JSON.stringify(PAGE_PROVIDER_2) + ', "Delete")');
  await waitForValue(cdp, 'window.__e2ePage.dialogText().indexOf(' + JSON.stringify(PAGE_PROVIDER_2) + ') !== -1 && /stored API key/.test(window.__e2ePage.dialogText())', "the delete confirmation", 15000);
  const confirmText = await cdp.eval('window.__e2ePage.dialogText()');
  await cdp.screenshot(join(EVIDENCE_DIR, MODE + "-14-provider-delete-confirm.png"));
  const confirmClick = await cdp.eval('window.__e2ePage.confirmDelete()');
  await sleep(3000);
  const deleteCalls = pageRpcCallsSince(deleteMark);
  const unsetCall = credentialCallsOf(deleteCalls, "credentials/unset")[0];
  const deleteMutation = settingsMutatesOf(deleteCalls).pop();
  const deleteOps = deleteMutation && Array.isArray(deleteMutation.args.ops) ? deleteMutation.args.ops : [];
  const patchAfterDelete = await readPatch();
  const refsAfterDelete = credentialRefsOf(await readTextFile(credentialsPath));
  const afterDelete = await readProviderSide("after delete", PAGE_PROVIDER);
  evidence.modelsPage.delete = { confirm: confirmText.slice(0, 300), calls: deleteCalls, patch: patchAfterDelete, refs: refsAfterDelete, rows: afterDelete.rows };
  check("the page's delete confirmation names the provider and says the stored API key goes with it", confirmClick === "clicked" && /stored API key/.test(confirmText) && confirmText.indexOf(PAGE_PROVIDER_2) !== -1 && confirmText.indexOf(PAGE_PROVIDER_2_DISPLAY) !== -1, JSON.stringify({ confirmClick, confirmText: confirmText.slice(0, 300) }));
  check("deleting through the page removes the stored credential and then the configuration, both through the ordinary service entry points", unsetCall !== undefined && unsetCall.args.ref === PAGE_KEY_REF_2 && deleteMutation !== undefined && deleteMutation.args.ns === "llm-pi-ai" && deleteOps.length === 1 && deleteOps[0].op === "unset" && JSON.stringify(deleteOps[0].path) === JSON.stringify(["providers", PAGE_PROVIDER_2]) && unsetCall.seq < deleteMutation.seq, JSON.stringify(deleteCalls).slice(0, 600));
  check("the delete path carries no expectedRevision (recorded as the original page sends it, not claimed as protection)", deleteMutation !== undefined && deleteMutation.args.expectedRevision === undefined, JSON.stringify(deleteMutation && deleteMutation.args).slice(0, 300));
  check("the deleted provider is gone from the page, from the profile and from the credential store", rowOf(afterDelete, PAGE_PROVIDER_2) === null && afterDelete.body.indexOf(PAGE_PROVIDER_2) === -1 && providerBlock(patchAfterDelete, PAGE_PROVIDER_2) === null && refsAfterDelete[PAGE_KEY_REF_2] === undefined, JSON.stringify({ routes: afterDelete.rows.map((row) => row.route), mentionedInPage: afterDelete.body.indexOf(PAGE_PROVIDER_2) !== -1, refs: Object.keys(refsAfterDelete) }));
  check("the deletion left the other provider and its credential untouched", providerFieldOf(patchAfterDelete, PAGE_PROVIDER, "displayName") === PAGE_PROVIDER_DISPLAY_2 && refsAfterDelete[PAGE_KEY_REF] === PAGE_KEY_3, JSON.stringify(refsAfterDelete));

  /* ---- the page-driven stage is a clean window of its own: nothing it did may error ---- */
  assertLiveTransport("modelsPage");
  assertNoStageErrors("modelsPage", false);

  /* ---- 7. induced write failures: what the page reports, and what it does not promise ---- */
  const patchBackup = await readPatch();
  const credentialsBackup = await readTextFile(credentialsPath);
  const induceUnwritable = async (path) => { await rm(path, { recursive: true, force: true }); await mkdir(path, { recursive: true, mode: 0o700 }); };
  /* The mode is part of the file: the credential store refuses to write a credentials file that is readable beyond
     its owner (the page says so in as many words), so a restored file has to come back with the mode it had. */
  const fileMode = async (path) => (await stat(path)).mode & 0o777;
  const patchMode = await fileMode(patchPath);
  const credentialsMode = await fileMode(credentialsPath);
  const restoreFile = async (path, text, mode) => { await rm(path, { recursive: true, force: true }); await writeFile(path, text); await chmod(path, mode); };
  const failureRange = cdp.eventSeq;
  const failureErrors = cdp.errorEvents().length;
  /* What the instance's settings Host serves before the attempt: a write that fails cannot have moved it. */
  const settingsBeforeFailure = await rpcFor(instance.url)("settings/describe", {});
  /* (a) the configuration write cannot land at all */
  await induceUnwritable(patchPath);
  await openEditor(PAGE_PROVIDER);
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "Display name")', PAGE_PROVIDER_BLOCKED);
  await sleep(400);
  const configFailureSave = await cdp.eval('window.__e2ePage.saveEdit(' + JSON.stringify(PAGE_PROVIDER) + ')');
  await sleep(3500);
  const configFailureForm = await cdp.eval('window.__e2ePage.editDump(' + JSON.stringify(PAGE_PROVIDER) + ')');
  /* Read the failure target WHILE the failure is still in force, before the harness puts its own file back:
     afterwards the directory is gone, and comparing with the backup would only show that the harness restored its
     own copy rather than that the page's write persisted nothing. */
  const failureTargetIsDirectory = (await stat(patchPath)).isDirectory();
  await restoreFile(patchPath, patchBackup, patchMode);
  const patchAfterConfigFailure = await readPatch();
  const settingsAfterConfigFailure = await rpcFor(instance.url)("settings/describe", {});
  evidence.modelsPage.configWriteFailure = { save: configFailureSave, form: configFailureForm, patch: patchAfterConfigFailure, targetIsDirectory: failureTargetIsDirectory, revisionBefore: namespaceRevision(settingsBeforeFailure), revisionAfter: namespaceRevision(settingsAfterConfigFailure) };
  check("a configuration write that cannot land is reported in the page and leaves the editor open", configFailureForm.paragraphs.length > 0 && configFailureForm.paragraphs.some((text) => /failed to (read|write) patches|EISDIR|is a directory/.test(text)), JSON.stringify(configFailureForm.paragraphs).slice(0, 400));
  check("the failed configuration write persisted nothing: its target was still the unusable directory the harness made while the page reported the failure, the instance serves the same settings revision it served before the attempt, and the refused value is nowhere in the profile", failureTargetIsDirectory === true && namespaceRevision(settingsBeforeFailure) !== null && namespaceRevision(settingsBeforeFailure) === namespaceRevision(settingsAfterConfigFailure) && patchAfterConfigFailure.indexOf(PAGE_PROVIDER_BLOCKED) === -1, JSON.stringify({ targetIsDirectory: failureTargetIsDirectory, revisionBefore: namespaceRevision(settingsBeforeFailure), revisionAfter: namespaceRevision(settingsAfterConfigFailure), refusedValueInProfile: patchAfterConfigFailure.indexOf(PAGE_PROVIDER_BLOCKED) !== -1 }).slice(0, 400));
  await closeEditor(PAGE_PROVIDER);
  /* (b) the configuration lands and the key cannot: the partial success the page documents */
  await induceUnwritable(credentialsPath);
  const partialMark = cdp.eventSeq;
  await openEditor(PAGE_PROVIDER);
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "Display name")', PAGE_PROVIDER_PARTIAL);
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "API key")', PAGE_KEY_ROTATED);
  await sleep(400);
  const partialSave = await cdp.eval('window.__e2ePage.saveEdit(' + JSON.stringify(PAGE_PROVIDER) + ')');
  await sleep(3500);
  const partialCalls = pageRpcCallsSince(partialMark);
  const partialForm = await cdp.eval('window.__e2ePage.editDump(' + JSON.stringify(PAGE_PROVIDER) + ')');
  const patchAfterPartial = await readPatch();
  evidence.modelsPage.partialSuccess = { save: partialSave, calls: partialCalls, form: partialForm, patch: patchAfterPartial, refs: "<the credentials file was a directory: unreadable>" };
  check("when only the key write can land, the configuration half really is persisted (no atomic transaction is claimed)", providerFieldOf(patchAfterPartial, PAGE_PROVIDER, "displayName") === PAGE_PROVIDER_PARTIAL, JSON.stringify(providerFieldOf(patchAfterPartial, PAGE_PROVIDER, "displayName")));
  check("the page reports the failed key write and does not claim success (the editor stays open)", partialForm.fields.length > 0 && partialForm.paragraphs.some((text) => /credentials|EISDIR|is a directory/.test(text)), JSON.stringify(partialForm.paragraphs).slice(0, 400));
  await restoreFile(credentialsPath, credentialsBackup, credentialsMode);
  /* the retry path: the same editor, nothing retyped - the page retries the outstanding write alone */
  const retryMark = cdp.eventSeq;
  await cdp.eval('window.__e2ePage.saveEdit(' + JSON.stringify(PAGE_PROVIDER) + ')');
  await sleep(3500);
  const retryCalls = pageRpcCallsSince(retryMark);
  const refsAfterRetry = credentialRefsOf(await readTextFile(credentialsPath));
  evidence.modelsPage.retryAfterFailure = { calls: retryCalls, refs: refsAfterRetry, form: await cdp.eval('window.__e2ePage.editDump(' + JSON.stringify(PAGE_PROVIDER) + ')') };
  check("once the file is writable again, one more Apply writes the outstanding key (the retry path only writes what is missing)", refsAfterRetry[PAGE_KEY_REF] === PAGE_KEY_ROTATED, JSON.stringify({ calls: retryCalls.map((call) => call.method), refs: refsAfterRetry }));
  await closeEditor(PAGE_PROVIDER);
  /* leave the provider on the name the survival checks below expect, with the rotated key in place */
  await openEditor(PAGE_PROVIDER);
  await typeText(cdp, 'window.__e2ePage.focusEdit(' + JSON.stringify(PAGE_PROVIDER) + ', "Display name")', PAGE_PROVIDER_DISPLAY_2);
  await sleep(400);
  await cdp.eval('window.__e2ePage.saveEdit(' + JSON.stringify(PAGE_PROVIDER) + ')');
  await sleep(3000);
  await closeEditor(PAGE_PROVIDER);
  const failureEvents = cdp.errorEvents().slice(failureErrors);
  evidence.modelsPage.inducedFailureEvents = failureEvents.map((event) => ({ method: event.method, text: String(event.text).slice(0, 300) }));
  evidence.modelsPage.inducedFailureWrites = pageRpcCallsSince(failureRange).map((call) => ({ method: call.method, args: call.args }));
  /* The induced failures above are the harness's own doing, but only a page error that names one of them is
     excused: anything else the browser reported inside this window - an unrelated runtime exception, console error
     or network failure, during the failures or during the successful retry that follows - fails the stage exactly
     as it would anywhere else. The stage mark then moves on so the stages that follow judge their own windows. */
  const inducedWords = /failed to (read|write) patches|EISDIR|illegal operation on a directory|is a directory|\.credentials\.yaml|credentials/i;
  const unrelatedFailureEvents = failureEvents.filter((event) => !inducedWords.test(String(event.text)));
  evidence.modelsPage.unrelatedFailureEvents = unrelatedFailureEvents.map((event) => ({ method: event.method, text: String(event.text).slice(0, 300) }));
  check("nothing but the page's own reported write failures surfaced in the induced-failure window (runtime, console and network errors stay fatal there too)", unrelatedFailureEvents.length === 0, JSON.stringify(unrelatedFailureEvents.map((event) => ({ method: event.method, text: String(event.text).slice(0, 200) }))).slice(0, 600));
  stageMark = cdp.errorEvents().length;
  }


  await reload();
  await sleep(7000);
  try {
    await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-04-after-reload.png"));
  } catch (error) {
    let diag = "unavailable";
    try { diag = await cdp.eval(MODELS_DIAG); } catch (inner) { diag = "eval failed: " + inner.message; }
    console.log("RELOAD-DIAG " + diag + " instance=" + JSON.stringify(instance.out().slice(-800)));
    throw error;
  }
  const afterReload = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchAfterReload = afterReload;
  if (MODE === "overlay") check("value survives a page refresh on the remote origin", afterReload.state === "false", JSON.stringify(afterReload));
  else check("CONTROL: the remote toggle is lost on refresh", afterReload.state === "true", JSON.stringify(afterReload));
  if (MODE === "overlay") {
    /* Issue #4, credential criterion: a refresh must leave the page's provider state correct, and the page may
       still only say that a key is configured. Both sides are read: the page's own rendering and the store. */
    await assertCredentialSurvival("after reload", "a refresh", "afterReload");
  }
  assertLiveTransport("afterReload");
  assertNoStageErrors("afterReload", true);

  /* A real transport interruption, evidenced from both sides: the page is taken offline through CDP (the
     emulation call itself has to succeed), the streaming connection the document was HOLDING has to be torn
     down while offline, the page's own request has to fail, and after the network returns the SAME document
     has to come back with a NEW streaming connection and still report the Host value. There is deliberately
     no reload in this stage, so a dead reconnect cannot hide behind a fresh page load. */
  await cdp.send("Network.enable").catch(() => {});
  const reachProbe = "fetch(location.pathname + location.search, { method: 'GET', cache: 'no-store' }).then((response) => 'status:' + response.status).catch((error) => 'rejected:' + String(error))";
  const docMark = String(await cdp.eval("(window.__e2eDocMark = 'mark-' + Math.random().toString(36).slice(2), window.__e2eDocMark)"));
  const preReconnect = cdp.liveConnections();
  const preReconnectIds = new Set(preReconnect.map((connection) => connection.requestId));
  evidence.reconnect = { docMarkBefore: docMark, connectionsBefore: preReconnect };
  check("the document holds a live streaming connection before the interruption", preReconnect.length > 0, JSON.stringify(preReconnect));
  const preSeq = cdp.eventSeq;
  let offlineApplied = true;
  discontinue("forced offline");
  try { await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
  catch (error) { offlineApplied = false; evidence.reconnect.offlineError = String(error); }
  check("the harness can really take the page offline through CDP", offlineApplied, "Network.emulateNetworkConditions");
  await sleep(4000);
  /* The interruption has to reach the transport the document was already holding, and that has to be shown
     from the page, not inferred from a failed document fetch. The browser reports no close event for sockets
     severed by CDP offline emulation (recorded below: no webSocketClosed and no RequestId-based teardown for
     the connections that were live at snapshot time), so the stage evidences the interruption page-side: the
     endpoint cannot be reached at all while the window lasts. Recovery is asserted separately - a NEW
     streaming requestId plus a working Host write. */
  const preReconnectTeardown = cdp.teardownEvents(preSeq).filter((event) => preReconnectIds.has(event.requestId));
  const preReconnectClosed = preReconnect.filter((connection) => { const state = cdp.connections.get(connection.requestId); return state !== undefined && state.closedSeq !== null && state.closedSeq > preSeq; });
  evidence.reconnect.preReconnectTeardown = preReconnectTeardown;
  evidence.reconnect.preReconnectClosed = preReconnectClosed;
  const transportProbe = "new Promise((resolve) => { const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://'; let socket = null; try { socket = new WebSocket(scheme + location.host + '/api/remote.mux'); } catch (error) { resolve('constructor:' + String(error)); return; } window.__e2eProbeSock = socket; let settled = false; const done = (value) => { if (!settled) { settled = true; resolve(value); } }; socket.onopen = () => done('opened'); socket.onerror = () => done('failed'); socket.onclose = () => done('closed'); setTimeout(() => done('timeout'), 4000); })";
  const transportWhileOffline = await cdp.eval(transportProbe).catch((error) => "eval-failed:" + String(error));
  evidence.reconnect.transportWhileOffline = transportWhileOffline;
  /* Only a real network-layer OUTCOME counts: "failed" (the browser reported a connection error) or "closed".
     "timeout", a constructor exception and an evaluation failure are NOT evidence that the network was cut -
     they are evidence that the harness broke, so they fail the check instead of passing it. */
  check("while offline the page's own settings transport fails at the network layer (a real error or close, never a probe failure or timeout)", /^(failed|closed)$/.test(String(transportWhileOffline)), String(transportWhileOffline));
  const whileOffline = await cdp.eval(reachProbe).catch((error) => "eval-failed:" + String(error));
  evidence.reconnect.whileOffline = whileOffline;
  check("while offline the page's own transport request genuinely fails", /^rejected:/.test(String(whileOffline)), String(whileOffline).slice(0, 160));
  try { await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
  catch (error) { offlineApplied = false; evidence.reconnect.onlineError = String(error); }
  await sleep(8000);
  const afterOnline = await cdp.eval(reachProbe).catch((error) => "eval-failed:" + String(error));
  const docMarkAfter = String(await cdp.eval("String(window.__e2eDocMark)"));
  const liveAfterReconnect = cdp.liveConnections();
  const recoveredConnections = liveAfterReconnect.filter((connection) => !preReconnectIds.has(connection.requestId));
  /* A new requestId is not enough: it has to be a WebSocket to the settings endpoint whose handshake actually
     completed (101), so a socket the browser merely tried to open cannot be reported as a recovery. */
  const recoveredMux = recoveredConnections.filter((connection) => connection.kind === "WebSocket" && /\/api\/remote\.mux/.test(connection.url) && connection.handshake !== null && connection.handshake.status === 101 && !everDiscontinued.has(connection.requestId));
  evidence.reconnect.afterOnline = afterOnline;
  evidence.reconnect.docMarkAfter = docMarkAfter;
  evidence.reconnect.connectionsAfter = liveAfterReconnect;
  evidence.reconnect.recoveredConnections = recoveredConnections;
  evidence.reconnect.recoveredMux = recoveredMux;
  const recoverySeq = cdp.eventSeq;
  check("the page's transport recovers without a reload (same document)", /^status:/.test(String(afterOnline)) && docMarkAfter === docMark, JSON.stringify({ afterOnline, docMark, docMarkAfter }));
  check("the recovered document re-establishes a NEW streaming connection (the old one is not reused)", recoveredConnections.length > 0, JSON.stringify(recoveredConnections));
  check("the recovered transport is a NEW settings WebSocket whose handshake really succeeded (101), not a merely attempted or unrelated stream", recoveredMux.length > 0, JSON.stringify(recoveredMux));
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-05-after-reconnect.png"));
  const afterReconnect = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchAfterReconnect = afterReconnect;
  if (MODE === "overlay") check("the Host value is intact after a transport interruption on the same document", afterReconnect.state === "false", JSON.stringify(afterReconnect));
  else check("CONTROL: the page-local flip is still page-local after a transport interruption", afterReconnect.state === "true", JSON.stringify(afterReconnect));
  if (MODE === "overlay") {
    /* The recovered transport has to be functional, not merely reachable: the same setting must still be
       writeable through it, and the stored YAML has to move and come back to exactly its former text. */
    const patchBeforeRoundTrip = await readPatch();
    const roundTripOn = await cdp.eval(SWITCH_CLICK);
    await sleep(3000);
    const patchRoundTripOn = await readPatch();
    const stateRoundTripOn = JSON.parse(await cdp.eval(SWITCH_PROBE));
    const roundTripBack = await cdp.eval(SWITCH_CLICK);
    await sleep(3000);
    const patchRoundTripBack = await readPatch();
    const stateRoundTripBack = JSON.parse(await cdp.eval(SWITCH_PROBE));
    evidence.reconnect.roundTrip = {
      click: roundTripOn, clickBack: roundTripBack, patchBefore: patchBeforeRoundTrip, patchOn: patchRoundTripOn,
      patchBack: patchRoundTripBack, stateOn: stateRoundTripOn.state, stateBack: stateRoundTripBack.state,
    };
    check("the recovered transport still writes the setting through to the instance Host", roundTripOn === "CLICKED" && /enabled:\s*true/.test(patchRoundTripOn) && stateRoundTripOn.state === "true", JSON.stringify({ click: roundTripOn, patch: patchRoundTripOn.slice(0, 240) }));
    check("reverting the setting rewrites the stored YAML to exactly its former text", roundTripBack === "CLICKED" && patchRoundTripBack === patchBeforeRoundTrip && stateRoundTripBack.state === "false", JSON.stringify({ clickBack: roundTripBack, sameText: patchRoundTripBack === patchBeforeRoundTrip, state: stateRoundTripBack.state }));
    /* Binding the writes to the NEW connection, in two separate claims: (a) the connections the harness
       severed must carry no frame after the recovery point, so a zombie socket cannot be reported as the
       transport in use; (b) the writes themselves have to appear as parsed settings/mutate RPCs after the
       recovery point. The settings RPC travels over HTTP /api, NOT inside the mux WebSocket, so (b) is the
       proof that the write really happened after recovery while (a) is the proof that it did not ride the
       socket the harness took away. */
    const muxAfterRoundTrip = cdp.liveConnections().filter((connection) => connection.kind === "WebSocket" && /\/api\/remote\.mux/.test(connection.url));
    /* Per-connection frame counts AFTER the recovery point (cdp.framesAfter), not the cumulative counters: a
       socket can be created before the page is back online, so its totals cannot prove post-recovery use. */
    const oldUsedAfterRecovery = preReconnect.filter((connection) => cdp.framesAfter(connection, recoverySeq) > 0);
    const newMuxConnections = muxAfterRoundTrip.filter((connection) => !preReconnectIds.has(connection.requestId));
    const newMuxFramesAfterRecovery = newMuxConnections.reduce((sum, connection) => sum + cdp.framesAfter(connection, recoverySeq), 0);
    /* The write itself: the settings page calls the Host RPC settings/mutate over the /api transport, so this
       does not look for "some /api traffic" (the fail-open the round-3 review named) but parses the RPC:
       POST, pathname exactly /api/settings/mutate, envelope method settings/mutate, namespace ui-settings,
       and the enabled paths the two clicks wrote. A poll or a catalog request cannot stand in for it. */
    const apiAfterRecovery = cdp.requests.filter((request) => request.seq > recoverySeq && pathnameOf(request.url).startsWith("/api/"));
    const parseMutate = (request) => {
      if (request.method !== "POST") return null;
      if (pathnameOf(request.url) !== "/api/settings/mutate") return null;
      let body = null;
      try { body = JSON.parse(request.postData); } catch (error) { return null; }
      if (body === null || body.method !== "settings/mutate") return null;
      const args = body.payload === undefined ? undefined : body.payload.args;
      if (args === undefined || args.ns !== "ui-settings" || !Array.isArray(args.ops)) return null;
      /* The round trip claims one switch write per RPC, so a batch carrying anything else is not recognised:
         the envelope must hold exactly one op, and it has to be a set on the single path ["enabled"]. */
      if (args.ops.length !== 1) return null;
      const op = args.ops[0];
      if (op.op !== "set" || !Array.isArray(op.path) || op.path.length !== 1 || op.path[0] !== "enabled") return null;
      const enabledOps = [op.value];
      return { seq: request.seq, rpcId: body.rpcId, ns: args.ns, expectedRevision: args.expectedRevision === undefined ? null : args.expectedRevision, enabledOps };
    };
    const settingsWritesAfterRecovery = apiAfterRecovery.map(parseMutate).filter((entry) => entry !== null);
    evidence.reconnect.roundTripTraffic = {
      recoverySeq, oldUsedAfterRecovery, newMuxFramesAfterRecovery, muxAfterRoundTrip,
      apiRequestsAfterRecovery: apiAfterRecovery.map((request) => request.method + " " + request.url),
      settingsWritesAfterRecovery: settingsWritesAfterRecovery.map((entry) => ({ seq: entry.seq, rpcId: entry.rpcId, ns: entry.ns, enabledOps: entry.enabledOps, expectedRevision: entry.expectedRevision })),
    };
    check("no frame traffic after the recovery point on the connections the harness severed (they are never used again)", oldUsedAfterRecovery.length === 0, JSON.stringify(oldUsedAfterRecovery));
    /* The two writes have to be recognised by SHAPE, not by stringifying whatever arrived: each RPC must carry
       exactly one op on the single path ["enabled"], and the two values must really be the JSON booleans true
       then false - a string "true" or a two-op batch is not the round trip this stage claims. */
    const enabledOf = (entry) => entry.enabledOps.length !== 1 ? "invalid" : entry.enabledOps[0] === true ? "on" : entry.enabledOps[0] === false ? "off" : "invalid";
    const roundTripWrites = settingsWritesAfterRecovery.map(enabledOf).join("|");
    check("the two post-recovery writes reached the Host as parsed settings/mutate RPCs on ui-settings (enabled true, then false) after the recovery point", settingsWritesAfterRecovery.length === 2 && roundTripWrites === "on|off", JSON.stringify({ roundTripWrites, settingsWritesAfterRecovery, apiRequestsAfterRecovery: apiAfterRecovery.length }));
    check("the recovered settings socket carried frames after the recovery point (activity, not just creation)", newMuxFramesAfterRecovery > 0, JSON.stringify({ newMuxFramesAfterRecovery, newMuxConnections }));
  }
  if (MODE === "overlay") {
    /* Issue #4, credential criterion: the same read after the forced reconnect - the page never reloaded here,
       so this is the state of the document that survived the transport interruption. */
    await assertCredentialSurvival("after reconnect", "the reconnect", "afterReconnect");
  }
  assertLiveTransport("afterReconnect");
  assertNoStageErrors("afterReconnect", true, documentUrl, true);
  /* Strict, zero-tolerance window on THIS resumed document, before the harness navigates away from it: once
     the transport is back and the write round trip has finished, nothing on this page may fail at all. The
     stage exemption above cannot cover this, because the next navigation destroys the document - and with it
     the evidence that its own transports stayed healthy. */
  await sleep(5000);
  assertLiveTransport("afterReconnectQuiescent");
  assertNoStageErrors("afterReconnectQuiescent", false);

  await navigate(instance.url);
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

  discontinue("instance restart");
  instance.child.kill("SIGTERM");
  await sleep(3000);
  instance = await startInstance(home, PROFILE);
  const restarted = new URL(instance.url);
  const remoteUrl2 = "http://" + TEST_HOST + ":" + restarted.port + "/" + restarted.search;
  evidence.urls.remoteAfterRestart = remoteUrl2;
  evidence.files.profilePatchAfterRestart = await readPatch();
  await navigate(instance.url);
  await waitFor(cdp, SHELL_PROBE, "app shell on loopback after restart");
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-07-loopback-after-restart.png"));
  const loopbackRestart = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchLoopbackAfterRestart = loopbackRestart;
  check("the instance Host holds the persisted value after a restart", loopbackRestart.state === "false", JSON.stringify(loopbackRestart));

  if (MODE === "overlay") {
    /* Issue #4, credential criterion, last leg: a new process has to find the same configuration and credential.
       Read on the remote origin again, so this also proves the provider page is served after the restart. */
    await assertCredentialSurvival("after restart", "a restart", "afterRestart");
  }
  assertLiveTransport("afterLoopbackAccess");
  assertNoStageErrors("afterLoopbackAccess", true);
  await navigate(remoteUrl2);
  // A restarted instance re-serves the remote origin from a cold cache; under CPU load the
  // 25s default is not enough, so give this boot its own budget instead of failing the run.
  await waitFor(cdp, SHELL_PROBE, "app shell on the remote origin after restart", 60000);
  await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-08-remote-after-restart.png"));
  const afterRestart = JSON.parse(await cdp.eval(SWITCH_PROBE));
  evidence.switchAfterRestart = afterRestart;
  if (MODE === "overlay") check("value survives an instance restart on the remote origin", afterRestart.state === "false", JSON.stringify(afterRestart));
  else check("CONTROL: the remote page cannot observe host state (memory mode)", afterRestart.state === "true", JSON.stringify(afterRestart));
  assertLiveTransport("afterRestart");
  assertNoStageErrors("afterRestart", true);

  const fence = await fenceProbes(restarted.port, restarted.search.slice("?token=".length));
  evidence.fence = fence;
  check("fence: /api from the trusted authority without a cookie stops at the auth gate", fence.trustedNoCookie.status === 401, JSON.stringify(fence.trustedNoCookie));
  check("fence: /api from the loopback authority without a cookie stops at the auth gate", fence.loopbackNoCookie.status === 401, JSON.stringify(fence.loopbackNoCookie));
  check("fence: /api with an untrusted Host is forbidden", fence.evilHost.status === 403, JSON.stringify(fence.evilHost));
  check("fence: an authenticated cookie does NOT lift the fence for an untrusted Host", fence.evilHostWithCookie.status === 403, JSON.stringify(fence.evilHostWithCookie));
  check("fence+auth: the authority-bound cookie passes BOTH the fence and the auth gate on the trusted Host (a real HTTP answer for the deliberately absent probe route)", fence.trustedWithCookie.status === 404, JSON.stringify(fence.trustedWithCookie));
  check("auth: the same cookie replayed on the loopback authority is rejected (the session cookie is authority-bound)", fence.loopbackWithCookie.status === 401, JSON.stringify(fence.loopbackWithCookie));
  check("fence: a cross-site Origin ALONE (no Sec-Fetch-Site) is forbidden", fence.evilOriginOnly.status === 403, JSON.stringify(fence.evilOriginOnly));
  check("fence: Sec-Fetch-Site cross-site ALONE (no Origin) is forbidden", fence.fetchSiteOnly.status === 403, JSON.stringify(fence.fetchSiteOnly));
  check("fence: both cross-site signals together stay forbidden", fence.evilOriginAndFetchSite.status === 403, JSON.stringify(fence.evilOriginAndFetchSite));
  check("fence: a cross-site Origin is still forbidden while the account cookie is presented", fence.evilOriginWithCookie.status === 403, JSON.stringify(fence.evilOriginWithCookie));
  check("fence: Sec-Fetch-Site cross-site is still forbidden while the account cookie is presented", fence.fetchSiteWithCookie.status === 403, JSON.stringify(fence.fetchSiteWithCookie));
  check("transport: an upgrade attempt on the real transport endpoint from an untrusted Host is refused, never upgraded", fence.upgradeEvilHost.upgraded === false && fence.upgradeEvilHost.status === 403, JSON.stringify(fence.upgradeEvilHost));
  check("transport: an unauthenticated upgrade attempt on the real transport endpoint stops at the auth gate, never upgraded", fence.upgradeTrustedNoCookie.upgraded === false && fence.upgradeTrustedNoCookie.status === 401, JSON.stringify(fence.upgradeTrustedNoCookie));
  check("transport control: the same endpoint really does upgrade for a request that passes both gates", fence.upgradeTrustedWithCookie.upgraded === true, JSON.stringify(fence.upgradeTrustedWithCookie));
  check("fence control: an Origin equal to the Host is accepted by the fence (reaches the auth gate)", fence.sameOrigin.status === 401, JSON.stringify(fence.sameOrigin));
  check("auth: the token-minted cookie is bound to the trusted authority and presented in the cookie-bearing probes", evidence.fenceCookieMinted === true, JSON.stringify(fence.indexToken.cookies));
  check("auth: the root token mints the authority-bound cookie and redirects", fence.indexToken.status === 303 && fence.indexToken.location === "./" && fence.indexToken.setCookie === true, JSON.stringify(fence.indexToken));
  check("auth: the document without a token is unauthorized", fence.indexNoToken.status === 401, JSON.stringify(fence.indexNoToken));

  if (MODE === "overlay") {
    /* A build the record does not describe must be refused at RUNTIME as well, not only while installing: the
       instance is started from a hard-link copy of the installation whose recorded file was changed, so the
       real installation is never touched. Both the refusal in its log and a rejected settings write are
       required, and the real installation is re-checked afterwards to prove the copy left no trace.
       DSH_INSTALL deliberately points at the APPROVED installation while this unapproved copy runs: the gate
       must follow the script the process actually runs, so an environment variable cannot mask a tampered
       build (a compatibility-style exemption is exactly what must not bypass the check). */
    const damagedInstance = await startInstance(home, PROFILE, join(damagedCopy, "lib/bin.js"), { DSH_INSTALL: DSH_INSTALL });
    evidence.damagedInstanceEnv = { DSH_INSTALL: DSH_INSTALL, argv1: join(damagedCopy, "lib/bin.js") };
    evidence.damagedInstanceUrl = damagedInstance.url;
    await sleep(4000);
    const damagedLog = damagedInstance.out() + damagedInstance.err();
    evidence.damagedInstanceLog = damagedLog.split("\n").filter((line) => /dsh-local-overlay|refusing|identity/.test(line)).slice(0, 12);
    check("an instance started from a build the record does not describe refuses to serve the settings provider", /refusing to serve the settings provider/.test(damagedLog), evidence.damagedInstanceLog.join(" | ").slice(0, 320));
    check("the runtime refusal names the recorded build identity and the installed one", /differs from the recorded build identity/.test(damagedLog) && /recorded [0-9a-f]{16}/.test(damagedLog), evidence.damagedInstanceLog.join(" | ").slice(0, 320));
    check("the refusal follows the script the process runs, not DSH_INSTALL pointing at the approved installation", /refusing to serve the settings provider/.test(damagedLog) && damagedLog.includes(damagedCopy), "DSH_INSTALL pointed at " + DSH_INSTALL);
    const damagedWrite = await rpcFor(damagedInstance.url)("settings/mutate", { ns: "ui-settings", ops: [{ op: "set", path: ["enabled"], value: true }] });
    evidence.damagedWrite = damagedWrite;
    check("a settings write against the unverified build is rejected instead of reported as saved", damagedWrite.ok === false && Boolean(damagedWrite.error) && damagedWrite.error.code === "settings/rejected", JSON.stringify(damagedWrite).slice(0, 300));
    check("the rejected write left the saved override untouched", (await readPatch()) === evidence.files.profilePatchAfterRestart, "patch unchanged");
    const damagedDiagnose = runTool(OVERLAY_TOOL, ["diagnose", "--home", home, "--profile", PROFILE, "--install", damagedCopy]);
    evidence.diagnoseDamagedInstall = damagedDiagnose.output.trim().split("\n").slice(-6);
    check("the terminal diagnose refuses the same unverified build the instance refused", damagedDiagnose.code === 1 && /installed build differs from the recorded build identity/.test(damagedDiagnose.output), evidence.diagnoseDamagedInstall.join(" | ").slice(0, 320));
    damagedInstance.child.kill("SIGTERM");
    await sleep(1500);

    /* The browser half of the replacement is a packed artifact too. Damaging it INSIDE the profile is what a
       broken download or a tampered unpack looks like: the page must not be able to present a working settings
       surface, nothing may be written on its behalf, and the terminal has to be able to name the artifact. */
    const installedClientPath = join(profileDir, "node_modules", FORK_PACKAGE, "lib", "client.js");
    const clientBytes = await readFile(installedClientPath);
    const clientSha = createHash("sha256").update(clientBytes).digest("hex");
    evidence.installedClient = { path: installedClientPath, sha256: clientSha, bytes: clientBytes.length };
    const patchBeforeArtifactDamage = await readPatch();
    /* The damage must be a *browser artifact* failure, not a syntactically dead file: the packed module keeps
       loading, and the provider throws exactly where it registers itself. That is what a broken download or a
       tampered unpack looks like to the page. */
    const damagePoint = "function apply(ctx) {";
    const pristineText = clientBytes.toString("utf8");
    const damagedText = pristineText.replace(damagePoint, damagePoint + "\n\t\t\tthrow new Error(\"DSH_E2E_DAMAGED_BROWSER_ARTIFACT\");");
    check("the harness really changed the packed browser artifact (not a no-op write)", damagedText !== pristineText && damagedText.includes("DSH_E2E_DAMAGED_BROWSER_ARTIFACT"), "throw injected into " + damagePoint);
    await replaceFile(installedClientPath, damagedText);
    const artifactDiagnose = runTool(OVERLAY_TOOL, ["diagnose", "--home", home, "--profile", PROFILE, "--install", DSH_INSTALL]);
    evidence.diagnoseDamagedArtifact = artifactDiagnose.output.trim().split("\n").slice(-6);
    check("the terminal diagnose names the damaged browser artifact instead of calling the profile healthy", artifactDiagnose.code === 1 && /lib\/client\.js as installed in the profile/.test(artifactDiagnose.output), evidence.diagnoseDamagedArtifact.join(" | ").slice(0, 320));
    discontinue("damaged artifact reload");
    await reload();
    /* Either the shell still renders and the settings surface is gone, or the page does not come back at all:
       both are "no working settings surface", and neither may be reported as a successful enable. */
    let shellAfterDamage = true;
    try { await waitFor(cdp, SHELL_PROBE, "app shell after the browser artifact was damaged", 12000); }
    catch (error) { shellAfterDamage = false; }
    await cdp.eval(SETTINGS_TRIGGER).catch(() => {});
    await sleep(4000);
    await cdp.screenshot(join(EVIDENCE_DIR, MODE + "-10-damaged-browser-artifact.png"));
    const damagedSwitch = JSON.parse(await cdp.eval(SWITCH_PROBE));
    evidence.switchAfterDamagedArtifact = { shellRendered: shellAfterDamage, probe: damagedSwitch };
    check("the page carrying the damaged artifact cannot present a usable settings toggle", shellAfterDamage === false || damagedSwitch.state === null || damagedSwitch.disabled === "true", JSON.stringify(evidence.switchAfterDamagedArtifact).slice(0, 280));
    check("nothing was written on behalf of the broken page (no false success)", (await readPatch()) === patchBeforeArtifactDamage, "patch unchanged");
    if (shellAfterDamage) assertLiveTransport("afterDamagedArtifact");
    else evidence.liveTransportAfterDamagedArtifact = "the page never rendered: there is no surface left to hold a transport";
    /* The tolerated events are exactly what this damaged artifact did to the page: the boot report names OUR
       entry as failed, and the page dies from that entry's absence (it owns the settings surface and the
       configForms service, so everything downstream of it stays pending). The first pattern is the naming
       observation the helper asserts, so the exemption is never silent. */
    assertNoStageErrors("afterDamagedArtifact", true, undefined, undefined, [
      "@dsh-local-overlay/dsh-client-ui-settings: failed",
      "renderSlot('root') before any 'root' registration",
      "entries did not activate",
    ]);
    /* Recovery is a terminal action, and the restored artifact has to give the settings surface back. */
    await replaceFile(installedClientPath, clientBytes);
    const restoredBytes = await readFile(installedClientPath);
    check("the browser artifact was restored byte for byte", restoredBytes.equals(clientBytes) && createHash("sha256").update(restoredBytes).digest("hex") === clientSha, "sha256 " + clientSha.slice(0, 16));
    const restoredDiagnose = runTool(OVERLAY_TOOL, ["diagnose", "--home", home, "--profile", PROFILE, "--install", DSH_INSTALL]);
    check("the terminal diagnose is clean again once the artifact is restored", restoredDiagnose.code === 0, restoredDiagnose.output.trim().split("\n").slice(-1)[0]);
    discontinue("artifact restore reload");
    await cdp.send("Network.clearBrowserCache").catch(() => {});
    await reload();
    await sleep(7000);
    await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-11-artifact-restored.png"));
    const restoredSwitch = JSON.parse(await cdp.eval(SWITCH_PROBE));
    evidence.switchAfterArtifactRestore = restoredSwitch;
    check("the restored artifact gives the settings surface back", restoredSwitch.state === "false", JSON.stringify(restoredSwitch).slice(0, 240));
    assertLiveTransport("afterArtifactRestore");
    assertNoStageErrors("afterArtifactRestore", true);
  }

  if (MODE === "overlay") {
    /* The rollback is exercised through the documented terminal command, and its blast radius is the point:
       it may undo its OWN composition and package choice, and nothing else. Before it runs, the harness stores
       an ordinary (unrelated) setting and a test credential through the public RPC, so both can be looked for
       afterwards. Restoring an old configuration snapshot - which would discard them - is what this forbids. */
    const rpc = rpcFor(restarted);
    const ordinaryWrite = await rpc("settings/mutate", { ns: "session-log-deepseek", ops: [{ op: "set", path: ["enabled"], value: false }] });
    evidence.ordinaryWrite = ordinaryWrite;
    check("an ordinary, unrelated setting can be written through the public RPC during the replacement", ordinaryWrite.ok === true, JSON.stringify(ordinaryWrite).slice(0, 240));
    const credentialWrite = await rpc("credentials/set", { ref: TEST_CREDENTIAL_REF, value: "e2e-not-a-real-secret" });
    evidence.credentialWrite = credentialWrite;
    check("a test credential can be stored through the public RPC during the replacement", credentialWrite.ok === true, JSON.stringify(credentialWrite).slice(0, 240));
    /* Comparing the stored VALUE (not just "configured: true") is what proves the rollback did not rotate or
       drop the credential: the digest is what goes into the evidence, the value stays in the throwaway home. */
    const credentialPathBefore = join(home, ".credentials.yaml");
    const credentialValueBefore = storedCredentialValue(await readFile(credentialPathBefore, "utf8"));
    evidence.credentialRefDigestBeforeRollback = credentialValueBefore === null ? null : createHash("sha256").update(credentialValueBefore).digest("hex").slice(0, 12);
    check("the harness can read back the stored test credential before the rollback", credentialValueBefore === "e2e-not-a-real-secret", evidence.credentialRefDigestBeforeRollback);
    const patchBeforeRollback = await readPatch();
    evidence.files.profilePatchBeforeRollback = patchBeforeRollback;
    check("the unrelated setting and the saved override live side by side before the rollback", patchBeforeRollback.includes("- id: session-log-deepseek") && patchBeforeRollback.includes("- id: ui-settings"), patchBeforeRollback.replace(/\n/g, " | ").slice(0, 400));
    /* The replacement is not necessarily the only layer in the list: an operator can add another bundle while
       it is active. The undo has to take our composition out and leave that layer exactly where it was, which is
       why the harness installs one here through the same documented CLI path. */
    const unrelatedDir = join(root, "unrelated-layer");
    await mkdir(unrelatedDir, { recursive: true });
    await writeFile(join(unrelatedDir, "package.json"), JSON.stringify({ name: UNRELATED_LAYER, version: "0.0.0", private: true, dsh: { bundle: { patch: ["./cordis.patch.yml"] } } }, null, 2) + "\n");
    await writeFile(join(unrelatedDir, "cordis.patch.yml"), "[]\n");
    const unrelatedPack = execFileSync("npm", ["pack", "--pack-destination", join(root, "artifacts"), "--silent"], { cwd: unrelatedDir, encoding: "utf8" }).trim().split("\n").pop();
    execFileSync(process.execPath, [DSH_BIN, "plugin", "--profile", PROFILE, "add", join(root, "artifacts", unrelatedPack)], { env: { ...process.env, DSH_HOME: home }, encoding: "utf8" });
    const bundlesWithUnrelated = (await readJson(join(profileDir, "package.json"))).dsh.profile.bundles;
    evidence.bundlesWithUnrelatedLayer = bundlesWithUnrelated;
    check("the harness added an unrelated bundle layer while the replacement was active", bundlesWithUnrelated.includes(UNRELATED_LAYER) && bundlesWithUnrelated.includes(OVERLAY_SCOPE + "/web-composition"), JSON.stringify(bundlesWithUnrelated));
    const rollback = runTool(OVERLAY_TOOL, ["rollback", "--home", home, "--profile", PROFILE]);
    evidence.rollbackOutput = rollback.output.trim().split("\n");
    check("the documented terminal rollback succeeds", rollback.code === 0, evidence.rollbackOutput.slice(-3).join(" | ").slice(0, 320));
    const patchAfterRollback = await readPatch();
    evidence.files.profilePatchAfterRollback = patchAfterRollback;
    const overrideBlock = patchRow(patchAfterRollback, "ui-settings");
    check("the rollback rewrites ONLY the name guard of its own override, back to the upstream provider", overrideBlock.includes('name: "@deepseek-ai/dsh-client-ui-settings"'), overrideBlock.replace(/\n/g, " | ").slice(0, 240));
    check("the rollback keeps the saved value instead of restoring an old configuration snapshot", overrideBlock.includes("enabled: false"), overrideBlock.replace(/\n/g, " | ").slice(0, 240));
    const ordinaryBlock = patchRow(patchAfterRollback, "session-log-deepseek");
    check("the unrelated setting written during the replacement survives the rollback", ordinaryBlock.includes('name: "@deepseek-ai/dsh-session-log-deepseek"') && ordinaryBlock.includes("enabled: false"), ordinaryBlock.replace(/\n/g, " | ").slice(0, 240));
    const manifestAfterRollback = await readJson(join(profileDir, "package.json"));
    evidence.profileManifestAfterRollback = manifestAfterRollback;
    const bundlesAfterRollback = manifestAfterRollback.dsh.profile.bundles;
    check("the rollback puts the upstream roster back in the place its own composition occupied", JSON.stringify(bundlesAfterRollback) === JSON.stringify(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", UNRELATED_LAYER]), JSON.stringify(bundlesAfterRollback));
    check("the rollback undoes its own selection only: an unrelated bundle layer added during the replacement is kept", bundlesAfterRollback.includes(UNRELATED_LAYER), JSON.stringify(bundlesAfterRollback));
    check("the rollback leaves the installed packages alone (only the selection is reverted)", Boolean(manifestAfterRollback.dependencies[FORK_PACKAGE] && manifestAfterRollback.dependencies[OVERLAY_SCOPE + "/web-composition"]), JSON.stringify(manifestAfterRollback.dependencies));
    discontinue("instance restart");
    instance.child.kill("SIGTERM");
    await sleep(3000);
    instance = await startInstance(home, PROFILE);
    const rolled = new URL(instance.url);
    const remoteUrl3 = "http://" + TEST_HOST + ":" + rolled.port + "/" + rolled.search;
    evidence.urls.remoteAfterRollback = remoteUrl3;
    await navigate(remoteUrl3);
    await waitFor(cdp, SHELL_PROBE, "app shell on the remote origin after rollback", 60000);
    await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-09-remote-after-rollback.png"));
    const rolledBack = JSON.parse(await cdp.eval(SWITCH_PROBE));
    evidence.switchAfterRollback = rolledBack;
    const patchAfterRollbackRestart = await readPatch();
    evidence.files.profilePatchAfterRollbackRestart = patchAfterRollbackRestart;
    check("the restart after the rollback leaves the saved override exactly where the rollback put it", patchAfterRollbackRestart === patchAfterRollback, patchAfterRollbackRestart.replace(/\n/g, " | ").slice(0, 240));
    /* The upstream provider keeps its settings state in the page on a remote origin: the control composition
       behaves identically (true on first open, false after a local flip, true again on the next load), so the
       stored override is no longer read here. That IS the original remote restriction coming back. */
    check("after the rollback the remote page ignores the stored override (the original remote restriction is back)", rolledBack.state === "true", JSON.stringify(rolledBack));
    const bootAfterRollback = JSON.parse(await cdp.eval(MODULE_PROBE));
    evidence.bootModulesAfterRollback = bootAfterRollback;
    const providersAfterRollback = loadedProviders(bootAfterRollback);
    evidence.bootProvidersAfterRollback = providersAfterRollback;
    check("after the rollback the page loads exactly one settings provider module again, the upstream package", providersAfterRollback.length === 1 && providersAfterRollback[0] === "@deepseek-ai/dsh-client-ui-settings", JSON.stringify(providersAfterRollback) + " of " + bootAfterRollback.entryCount + " modules");
    /* The original remote restriction has to be back after the restart: the same remote page may still flip
       its own switch, but the instance must no longer accept that as a stored value - the flip stays in the
       page, the saved override is untouched, and the flip is gone after the next load. */
    const rolledClick = await cdp.eval(SWITCH_CLICK);
    await sleep(3500);
    const patchAfterRolledClick = await readPatch();
    evidence.files.profilePatchAfterRolledClick = patchAfterRolledClick;
    const afterRolledClick = JSON.parse(await cdp.eval(SWITCH_PROBE));
    evidence.switchAfterRollbackClick = afterRolledClick;
    check("the remote page after the rollback keeps its toggle in the page only (no stored value)", rolledClick === "CLICKED" && afterRolledClick.state === "false" && patchAfterRolledClick === patchAfterRollback, rolledClick + " " + JSON.stringify(afterRolledClick).slice(0, 200));
    discontinue("remote restriction reload");
    await reload();
    await sleep(7000);
    await openSettings(cdp, join(EVIDENCE_DIR, MODE + "-12-remote-restriction-back.png"));
    const afterRolledReload = JSON.parse(await cdp.eval(SWITCH_PROBE));
    evidence.switchAfterRollbackReload = afterRolledReload;
    const patchAfterRolledReload = await readPatch();
    evidence.files.profilePatchAfterRolledReload = patchAfterRolledReload;
    check("the remote restriction is really back: the flipped value is gone after a refresh and nothing was stored", afterRolledReload.state === "true" && patchAfterRolledReload === patchAfterRollback, JSON.stringify(afterRolledReload).slice(0, 240));
    const credentialDescribe = await rpcFor(rolled)("credentials/describe", { refs: [TEST_CREDENTIAL_REF] });
    evidence.credentialDescribeAfterRollback = credentialDescribe;
    const credentialEntry = credentialDescribe.ok === true && credentialDescribe.value ? credentialDescribe.value[TEST_CREDENTIAL_REF] : undefined;
    check("the test credential survives the rollback, reported as configured and never in plaintext", Boolean(credentialEntry) && credentialEntry.configured === true && !JSON.stringify(credentialDescribe).includes("e2e-not-a-real-secret"), JSON.stringify(credentialDescribe).slice(0, 240));
    const credentialPath = join(home, ".credentials.yaml");
    const credentialFile = await readFile(credentialPath, "utf8");
    const credentialMode = statSync(credentialPath).mode & 0o777;
    const credentialValueAfter = storedCredentialValue(credentialFile);
    const credentialDigestAfter = credentialValueAfter === null ? null : createHash("sha256").update(credentialValueAfter).digest("hex").slice(0, 12);
    evidence.credentialsFile = { path: credentialPath, mode: credentialMode.toString(8), holdsRef: credentialFile.includes(TEST_CREDENTIAL_REF), refDigest: credentialDigestAfter };
    check("the credential file itself is untouched and still owner-only", credentialFile.includes(TEST_CREDENTIAL_REF) && credentialMode === 0o600, "mode " + credentialMode.toString(8));
    check("the stored credential VALUE is the same one the replacement saw (it was not rotated, dropped or replaced)", credentialValueAfter !== null && credentialDigestAfter === evidence.credentialRefDigestBeforeRollback, credentialDigestAfter + " vs " + evidence.credentialRefDigestBeforeRollback);
    /* Issue #4: the provider configuration and the key written through the ORIGINAL page are ordinary stored
       state too, so the rollback must not discard them either. Read straight off the disk after the rollback. */
    const refsAfterRollback = credentialRefsOf(await readFile(join(home, ".credentials.yaml"), "utf8"));
    evidence.modelsPage.afterRollback = { refs: refsAfterRollback, block: providerBlock(patchAfterRollback, PAGE_PROVIDER) };
    check("the provider configuration created through the page survives the rollback", providerFieldOf(patchAfterRollback, PAGE_PROVIDER, "displayName") === PAGE_PROVIDER_DISPLAY_2 && providerFieldOf(patchAfterRollback, PAGE_PROVIDER, "baseURL") === PAGE_PROVIDER_BASE_2 && providerFieldOf(patchAfterRollback, PAGE_PROVIDER, "apiKeyEnv") === PAGE_KEY_REF && providerModelIds(patchAfterRollback, PAGE_PROVIDER).join(",") === PAGE_MODEL + "," + PAGE_MODEL_2, JSON.stringify(providerBlock(patchAfterRollback, PAGE_PROVIDER)).slice(0, 400));
    check("the key stored through the page survives the rollback", refsAfterRollback[PAGE_KEY_REF] === PAGE_KEY_ROTATED, JSON.stringify(Object.keys(refsAfterRollback)));
    assertLiveTransport("afterRollback");
    assertNoStageErrors("afterRollback", true);
  }

  /* =====================================================================================================
     Issue #5: the ORIGINAL Plugins page, on the REMOTE origin, driving a THIRD-PARTY plugin.

     Everything above this point ships with the deployment. This stage installs a probe bundle through the
     documented package-manager path and then drives the page's own plugin manager with it. What has to hold:
     the bundle's configuration form is mounted by the page's STANDARD slot and filled with what the instance
     serves; a staged edit reaches nothing; a save lands on the instance and in the profile; a namespace a
     second access end has moved on is refused while the draft survives; the field's own validation and the
     deployment's own refusals are never reported as success; and the plugin's switches really take it away and
     bring it back. None of that may depend on this repository knowing the plugin: the driver addresses the
     bundle by its package name and its fields by the ids the bundle itself chose, and the composition that is
     installed here mentions the probe nowhere.
     ===================================================================================================== */
  const probeSource = join(REPO_ROOT, "tools", "fixtures", "dsh-config-probe");
  const probeManifest = await readJson(join(probeSource, "package.json"));
  /* Installed the way a user installs a plugin: packed out of its own directory and handed to the documented
     CLI, which forwards to the profile's package manager. */
  /* The pack destination is created first: only the overlay stages build into it, so in control mode this
     directory would not exist at all and packing the fixture would fail before a single check ran. */
  await mkdir(join(root, "artifacts"), { recursive: true });
  const probeTarball = execFileSync("npm", ["pack", "--pack-destination", join(root, "artifacts"), "--silent"], { cwd: probeSource, encoding: "utf8" }).trim().split("\n").pop();
  execFileSync(process.execPath, [DSH_BIN, "plugin", "--profile", PROFILE, "add", join(root, "artifacts", probeTarball)], { env: { ...process.env, DSH_HOME: home }, encoding: "utf8" });
  const manifestWithProbe = await readJson(join(profileDir, "package.json"));
  const probeEvidence = {};
  evidence.probePlugin = probeEvidence;
  probeEvidence.install = {
    tarball: probeTarball,
    dependency: manifestWithProbe.dependencies[PROBE_PACKAGE],
    bundles: manifestWithProbe.dsh.profile.bundles,
    peerDependencies: probeManifest.peerDependencies === undefined ? null : probeManifest.peerDependencies,
    clientPlatform: probeManifest.dsh && probeManifest.dsh.client ? probeManifest.dsh.client.platform : null,
  };
  check("a third-party bundle joins the profile's bundle list through the documented package-manager path", manifestWithProbe.dsh.profile.bundles.includes(PROBE_PACKAGE), JSON.stringify(manifestWithProbe.dsh.profile.bundles));
  check("the probe is an ordinary third-party package: a tarball dependency, and no framework dependency of its own", String(manifestWithProbe.dependencies[PROBE_PACKAGE] || "").indexOf("file:") === 0 && probeManifest.peerDependencies === undefined, JSON.stringify(probeEvidence.install));

  if (MODE === "overlay") {
    /* The replacement was rolled back above, so the documented enable runs again on that same profile. */
    const reEnabled = runTool(OVERLAY_TOOL, ["enable", "--home", home, "--profile", PROFILE, "--install", DSH_INSTALL, "--dsh-bin", DSH_BIN, "--artifacts", join(root, "artifacts")]);
    probeEvidence.reEnable = reEnabled.output.trim().split("\n").slice(-4);
    check("the documented enable runs again on the rolled-back profile and switches the composition back", reEnabled.code === 0 && /switched dsh\.profile\.bundles/.test(reEnabled.output), probeEvidence.reEnable.slice(-2).join(" | ").slice(0, 320));
  }

  /* The bundle list is read when an instance starts, so the new layer needs a fresh process - the same restart
     every other installed layer in this suite goes through. Everything below is read on the REMOTE origin. */
  discontinue("instance restart");
  instance.child.kill("SIGTERM");
  await sleep(3000);
  instance = await startInstance(home, PROFILE);
  const withProbe = new URL(instance.url);
  const remoteUrl4 = "http://" + TEST_HOST + ":" + withProbe.port + "/" + withProbe.search;
  evidence.urls.remoteWithProbePlugin = remoteUrl4;
  await navigate(remoteUrl4);
  await waitFor(cdp, SHELL_PROBE, "app shell on the remote origin with the third-party plugin installed", 60000);

  /* Re-derived after every restart below: a fresh instance listens on a fresh port. */
  let remoteRpc = rpcFor(instance.url);
  /* The page's OWN calls, read out of the CDP network log by shape, so the harness never has to trust the
     page's account of what it did. Settings writes are filtered by NAMESPACE as well: the page writes
     namespaces of its own in the same window (the onboarding notice, for one), and those belong to no stage. */
  const probeRequestMark = () => (cdp.requests.length === 0 ? 0 : cdp.requests[cdp.requests.length - 1].seq);
  const pageCalls = (since, method, ns) => pageRpcCallsSince(since).filter((call) => call.method === method && call.args !== undefined && (method !== "settings/mutate" || ns === undefined || call.args.ns === ns));
  const probeCalls = (since, method) => pageCalls(since, method, PROBE_NS);
  /* What the instance serves for one namespace, read through the same public RPC the page uses. */
  const servedNamespace = async (ns) => {
    const described = await remoteRpc("settings/describe", {});
    if (described.ok !== true) throw new Error("the instance refused settings/describe: " + JSON.stringify(described).slice(0, 300));
    const entry = described.value.namespaces.filter((item) => item.ns === ns)[0];
    /* The namespace entries themselves carry no writability flag: the describe answer states it once for the
       whole document, and every namespace it lists comes from that same editable document. */
    return entry === undefined ? null : { ns: entry.ns, revision: entry.revision, value: entry.value, user: entry.user, writable: described.value.writable === true };
  };
  const servedProbe = async () => await servedNamespace(PROBE_NS);
  /* settings/describe reads the profile's overlay, so while the harness is deliberately holding a broken write
     target the host cannot describe anything at all: that refusal is part of this stage's evidence, not a crash. */
  const tryServedNamespace = async (ns) => {
    try {
      return { state: await servedNamespace(ns), error: null };
    } catch (error) {
      return { state: null, error: String((error && error.message) || error) };
    }
  };
  const pageFields = async (ids) => JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins.fields(" + JSON.stringify(ids) + "))"));
  const fieldOf = (fields, id) => fields.filter((field) => field.id === id)[0] || { id: id, present: false, value: null, invalid: null, message: null };
  const probeFields = async () => await pageFields([PROBE_LABEL_FIELD, PROBE_ATTEMPTS_FIELD]);
  const pageSave = async () => JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins.save())"));
  const pageParagraphs = async () => JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins.paragraphs())"));
  /* Brings whatever document is loaded to an interactive state and installs the page driver. The onboarding
     dialogs are dismissed first, one round at a time: while one is up the app shell is inert, focus is ignored
     and typing would land in whatever field still held focus. */
  const settlePage = async (label) => {
    await waitFor(cdp, SHELL_PROBE, "app shell (" + label + ")");
    await cdp.eval(PLUGIN_PAGE_DRIVER);
    const blockers = [];
    for (let round = 0; round < 6; round += 1) {
      const state = JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins.blockers())"));
      blockers.push(state);
      if (state.count === 0) break;
      blockers.push({ dismissed: await cdp.eval("window.__e2ePlugins.dismiss()") });
      await sleep(1500);
    }
    const settled = JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins.blockers())"));
    if (settled.count !== 0 || settled.rootInert === true) throw new Error("the page never became interactive (" + label + "): " + JSON.stringify(settled));
    return blockers;
  };
  /* Opens one card of the ORIGINAL plugin page's list and returns what that list held as it opened. Both callers
     do the same four things - open the app, wait for their entry to be listed, read the list, open the card - and
     differ only in the entry they look for. */
  const openCardInList = async (label, spec) => {
    const navigated = await cdp.eval("window.__e2ePlugins.openPlugins()");
    if (navigated !== "clicked") throw new Error("the plugin manager could not be opened (" + label + "): " + navigated);
    await waitForValue(cdp, spec.wait, spec.waitLabel + " (" + label + ")", 30000);
    const listed = JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins." + spec.list + "())"));
    const opened = await cdp.eval("window.__e2ePlugins." + spec.open + "(" + JSON.stringify(spec.key) + ")");
    if (opened !== "clicked") throw new Error(spec.card + " could not be opened (" + label + "): " + opened);
    return listed;
  };
  /* Opens the plugin manager on whatever document is loaded, opens the bundle's own card and waits for the form
     the bundle registers. */
  const openPluginPage = async (label, expectForm) => {
    const blockers = await settlePage(label);
    const cards = await openCardInList(label, {
      wait: "window.__e2ePlugins.cards().some(function (card) { return card.pkg === " + JSON.stringify(PROBE_PACKAGE) + "; })",
      waitLabel: "the installed bundle's card",
      list: "cards",
      open: "openBundle",
      key: PROBE_PACKAGE,
      card: "the bundle's card",
    });
    if (expectForm === true) await waitForValue(cdp, "window.__e2ePlugins.detail().fieldIds.indexOf(" + JSON.stringify(PROBE_LABEL_FIELD) + ") !== -1", "the bundle's configuration form (" + label + ")", 30000);
    else await sleep(2500);
    await sleep(500);
    return { blockers: blockers, cards: cards, detail: JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins.detail())")) };
  };
  /* The same plugin list also carries the pages the DEPLOYMENT ships: its own packages register them in the
     very same slot, so this driver reaches them keyed by the page's own title, with no knowledge of the probe. */
  const openItemPage = async (label, itemLabel, fieldId) => {
    const blockers = await settlePage(label);
    const items = await openCardInList(label, {
      wait: "window.__e2ePlugins.items().some(function (text) { return text.indexOf(" + JSON.stringify(itemLabel) + ") !== -1; })",
      waitLabel: "the deployment's own page in the list",
      list: "items",
      open: "openItem",
      key: itemLabel,
      card: "the page's own card",
    });
    await waitForValue(cdp, "window.__e2ePlugins.detail().fieldIds.indexOf(" + JSON.stringify(fieldId) + ") !== -1", "the deployment's own form (" + label + ")", 30000);
    await sleep(500);
    return { blockers: blockers, items: items, detail: JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins.detail())")) };
  };

  if (MODE === "overlay") {
    const hostAtOpen = await servedProbe();
    const opened = await openPluginPage("first open", true);
    probeEvidence.opened = opened;
    probeEvidence.hostAtOpen = hostAtOpen;
    check("the plugin manager lists the installed third-party bundle as running on the remote origin", opened.cards.some((card) => card.pkg === PROBE_PACKAGE && card.status === "running"), JSON.stringify(opened.cards));
    check("the instance serves the third-party plugin's namespace with the bundle's own defaults", hostAtOpen !== null && hostAtOpen.writable === true && hostAtOpen.revision === 0 && hostAtOpen.value.label === PROBE_DEFAULT_LABEL && hostAtOpen.value.attempts === PROBE_DEFAULT_ATTEMPTS, JSON.stringify(hostAtOpen));
    check("the plugin's form is mounted by the page's STANDARD configuration slot, keyed by the bundle's own name", opened.detail.detailCount === 1 && opened.detail.configCount === 1 && opened.detail.slotPresent === true && opened.detail.slotHoldsForm === true, JSON.stringify(opened.detail).slice(0, 400));
    check("the form renders the fields the bundle declares, under the ids the bundle itself chose", opened.detail.fieldIds.indexOf(PROBE_LABEL_FIELD) !== -1 && opened.detail.fieldIds.indexOf(PROBE_ATTEMPTS_FIELD) !== -1, JSON.stringify(opened.detail.fieldIds));
    const fieldsAtOpen = await probeFields();
    const saveAtOpen = await pageSave();
    const paragraphsAtOpen = await pageParagraphs();
    probeEvidence.formAtOpen = { fields: fieldsAtOpen, save: saveAtOpen, paragraphs: paragraphsAtOpen };
    check("the page reads the plugin's configuration from the instance, not from anything of its own", fieldOf(fieldsAtOpen, PROBE_LABEL_FIELD).value === hostAtOpen.value.label && fieldOf(fieldsAtOpen, PROBE_ATTEMPTS_FIELD).value === String(hostAtOpen.value.attempts), JSON.stringify({ page: fieldsAtOpen, host: hostAtOpen.value }));
    check("the form carries the bundle's own copy and opens with nothing to save", paragraphsAtOpen.indexOf(PROBE_COPY.labelHint) !== -1 && paragraphsAtOpen.indexOf(PROBE_COPY.attemptsHint) !== -1 && saveAtOpen.text === PROBE_COPY.save && saveAtOpen.disabled === true, JSON.stringify({ save: saveAtOpen, paragraphs: paragraphsAtOpen }));
    const forkSource = await readFile(join(REPO_ROOT, "packages", "dsh-client-ui-settings", "lib", "client.js"), "utf8");
    const compositionSource = await readFile(join(REPO_ROOT, "packages", "dsh-web-composition", "cordis.patch.yml"), "utf8");
    const bespokeMentions = [PROBE_PACKAGE, PROBE_NS, PROBE_COPY.title].filter((needle) => (forkSource + compositionSource).indexOf(needle) !== -1);
    probeEvidence.bespokeMentions = bespokeMentions;
    check("the replacement knows nothing about this plugin: neither its name, nor its namespace, nor its copy appears in the fork or its composition", bespokeMentions.length === 0, JSON.stringify(bespokeMentions));
    await cdp.screenshot(join(EVIDENCE_DIR, MODE + "-15-plugin-page.png"));
    assertLiveTransport("afterPluginPageOpen");
    assertNoStageErrors("afterPluginPageOpen", true);

    /* Staged edit: it must show in the page, and it must reach nothing else - not the instance's value, not
       its revision, not the profile - with no write of any kind leaving the page. */
    const patchBeforeDraft = await readPatch();
    const markBeforeDraft = probeRequestMark();
    await typeText(cdp, "window.__e2ePlugins.focusField(" + JSON.stringify(PROBE_LABEL_FIELD) + ")", PROBE_DRAFT);
    await sleep(900);
    const fieldsStaged = await probeFields();
    const saveStaged = await pageSave();
    const hostAfterDraft = await servedProbe();
    const patchAfterDraft = await readPatch();
    const draftWrites = probeCalls(markBeforeDraft, "settings/mutate");
    probeEvidence.stagedDraft = { fields: fieldsStaged, save: saveStaged, host: hostAfterDraft, writes: draftWrites };
    check("the page holds the staged draft and offers to save it", fieldOf(fieldsStaged, PROBE_LABEL_FIELD).value === PROBE_DRAFT && saveStaged.disabled === false, JSON.stringify({ fields: fieldsStaged, save: saveStaged }));
    check("staging an edit reaches nothing: the instance still reports the stored value at the stored revision", hostAfterDraft.revision === hostAtOpen.revision && hostAfterDraft.value.label === hostAtOpen.value.label && hostAfterDraft.value.attempts === hostAtOpen.value.attempts, JSON.stringify({ before: hostAtOpen, after: hostAfterDraft }));
    check("staging an edit sends no write for the plugin's namespace", draftWrites.length === 0, JSON.stringify(draftWrites));
    check("staging an edit leaves the profile's patch file byte-identical", patchAfterDraft === patchBeforeDraft, patchAfterDraft.replace(/\n/g, " | ").slice(0, 240));

    /* Saved edit: the page's own action starts the write, the value lands on the instance and in the profile. */
    const markBeforeSave = probeRequestMark();
    const saveClick = await cdp.eval("window.__e2ePlugins.clickSave()");
    check("the page's own save action is what starts the write", saveClick === "clicked", String(saveClick));
    await waitForValue(cdp, "window.__e2ePlugins.save().disabled === true", "the page's save action to settle back to its clean state", 25000);
    const saveWrites = probeCalls(markBeforeSave, "settings/mutate");
    const hostAfterSave = await servedProbe();
    const patchAfterSave = await readPatch();
    probeEvidence.savedDraft = { writes: saveWrites, host: hostAfterSave, patchRow: patchRow(patchAfterSave, PROBE_NS) };
    check("the page's own write names the plugin's namespace, the field it staged and the revision it had read", saveWrites.length === 1 && JSON.stringify(saveWrites[0].args.ops) === JSON.stringify([{ op: "set", path: ["label"], value: PROBE_DRAFT }]) && saveWrites[0].args.expectedRevision === hostAtOpen.revision, JSON.stringify(saveWrites));
    check("the saved value lands on the instance as exactly one new revision", hostAfterSave.revision === hostAtOpen.revision + 1 && hostAfterSave.value.label === PROBE_DRAFT && hostAfterSave.value.attempts === hostAtOpen.value.attempts, JSON.stringify({ before: hostAtOpen, after: hostAfterSave }));
    check("the saved value lands in the profile's patch file, on the plugin's own row", patchRow(patchAfterSave, PROBE_NS).indexOf("id: " + PROBE_NS) !== -1 && patchRow(patchAfterSave, PROBE_NS).indexOf(PROBE_PACKAGE) !== -1 && patchRow(patchAfterSave, PROBE_NS).indexOf(PROBE_DRAFT) !== -1, patchRow(patchAfterSave, PROBE_NS).replace(/\n/g, " | ").slice(0, 240));

    /* A full reload proves the value came from the instance and not from anything the page held in memory. */
    await navigate(remoteUrl4);
    const reopened = await openPluginPage("after the refresh", true);
    const fieldsAfterReload = await probeFields();
    const saveAfterReload = await pageSave();
    const hostAfterReload = await servedProbe();
    probeEvidence.afterReload = { cards: reopened.cards, fields: fieldsAfterReload, save: saveAfterReload, host: hostAfterReload };
    check("after a full page load the form shows the saved value and has nothing left to save", fieldOf(fieldsAfterReload, PROBE_LABEL_FIELD).value === PROBE_DRAFT && fieldOf(fieldsAfterReload, PROBE_ATTEMPTS_FIELD).value === String(hostAfterSave.value.attempts) && saveAfterReload.disabled === true, JSON.stringify({ fields: fieldsAfterReload, save: saveAfterReload }));
    check("the value survives the reload because the instance serves it, not because the page remembered it", hostAfterReload.revision === hostAfterSave.revision && hostAfterReload.value.label === PROBE_DRAFT, JSON.stringify(hostAfterReload));

    /* Input the field cannot parse: the field itself reports it, and nothing is sent. */
    const markBeforeInvalid = probeRequestMark();
    await typeText(cdp, "window.__e2ePlugins.focusField(" + JSON.stringify(PROBE_ATTEMPTS_FIELD) + ")", PROBE_UNPARSEABLE);
    await sleep(900);
    const fieldsInvalid = await probeFields();
    const saveInvalid = await pageSave();
    const invalidWrites = probeCalls(markBeforeInvalid, "settings/mutate");
    probeEvidence.invalidInput = { fields: fieldsInvalid, save: saveInvalid, writes: invalidWrites };
    check("a value the field cannot parse is reported by the field itself, in the bundle's own words", fieldOf(fieldsInvalid, PROBE_ATTEMPTS_FIELD).invalid === "true" && fieldOf(fieldsInvalid, PROBE_ATTEMPTS_FIELD).message === PROBE_COPY.invalidNumber, JSON.stringify(fieldsInvalid));
    check("a value the field cannot parse is never sent, and the page stops offering to save", invalidWrites.length === 0 && saveInvalid.disabled === true, JSON.stringify({ writes: invalidWrites, save: saveInvalid }));

    /* Input the field accepts but the DEPLOYMENT refuses: the bundle's own schema bounds it. */
    await typeText(cdp, "window.__e2ePlugins.focusField(" + JSON.stringify(PROBE_ATTEMPTS_FIELD) + ")", String(PROBE_OUT_OF_RANGE));
    await sleep(900);
    const hostBeforeRefusal = await servedProbe();
    const patchBeforeRefusal = await readPatch();
    const markBeforeRefusal = probeRequestMark();
    const refusalClick = await cdp.eval("window.__e2ePlugins.clickSave()");
    await waitForValue(cdp, "window.__e2ePlugins.paragraphs().indexOf(" + JSON.stringify(PROBE_COPY.saveFailed) + ") !== -1", "the deployment's refusal to be reported in the page", 25000);
    const refusalWrites = probeCalls(markBeforeRefusal, "settings/mutate");
    const fieldsRefused = await probeFields();
    const saveRefused = await pageSave();
    const hostAfterRefusal = await servedProbe();
    const patchAfterRefusal = await readPatch();
    probeEvidence.refusedValue = { writes: refusalWrites, fields: fieldsRefused, save: saveRefused, host: hostAfterRefusal, patchRow: patchRow(patchAfterRefusal, PROBE_NS) };
    check("the page submits a value the deployment's own bounds reject", refusalClick === "clicked" && refusalWrites.length === 1 && JSON.stringify(refusalWrites[0].args.ops) === JSON.stringify([{ op: "set", path: ["attempts"], value: PROBE_OUT_OF_RANGE }]), JSON.stringify(refusalWrites));
    check("a configuration the deployment refuses is reported as a failure, with the draft left in place", saveRefused.disabled === false && fieldOf(fieldsRefused, PROBE_ATTEMPTS_FIELD).value === String(PROBE_OUT_OF_RANGE), JSON.stringify({ save: saveRefused, fields: fieldsRefused }));
    check("the refused configuration persists nothing on the instance", hostAfterRefusal.revision === hostBeforeRefusal.revision && hostAfterRefusal.value.attempts === hostBeforeRefusal.value.attempts && hostAfterRefusal.value.label === hostBeforeRefusal.value.label, JSON.stringify({ before: hostBeforeRefusal, after: hostAfterRefusal }));
    check("the refused configuration persists nothing in the profile's patch file", patchAfterRefusal === patchBeforeRefusal, patchAfterRefusal.replace(/\n/g, " | ").slice(0, 240));

    /* Two access ends: the harness plays the second one through the same public RPC the page uses. */
    await navigate(remoteUrl4);
    await openPluginPage("before the second access end writes", true);
    const hostBeforeConflict = await servedProbe();
    await typeText(cdp, "window.__e2ePlugins.focusField(" + JSON.stringify(PROBE_LABEL_FIELD) + ")", PROBE_CONFLICT_DRAFT);
    await sleep(900);
    const fieldsConflictDraft = await probeFields();
    check("the page stages a draft and keeps the revision it read for it", fieldOf(fieldsConflictDraft, PROBE_LABEL_FIELD).value === PROBE_CONFLICT_DRAFT, JSON.stringify(fieldsConflictDraft));
    const otherEndWrite = await remoteRpc("settings/mutate", { ns: PROBE_NS, ops: [{ op: "set", path: ["label"], value: PROBE_OTHER_END }], expectedRevision: hostBeforeConflict.revision });
    const hostAfterOtherEnd = await servedProbe();
    const patchAfterOtherEnd = await readPatch();
    probeEvidence.otherEnd = { write: otherEndWrite, host: hostAfterOtherEnd, patchRow: patchRow(patchAfterOtherEnd, PROBE_NS) };
    check("a second access end moves the plugin's namespace on while the page holds its draft", otherEndWrite.ok === true && hostAfterOtherEnd.revision === hostBeforeConflict.revision + 1 && hostAfterOtherEnd.value.label === PROBE_OTHER_END, JSON.stringify({ write: otherEndWrite, host: hostAfterOtherEnd }));
    const markBeforeStaleSave = probeRequestMark();
    const staleClick = await cdp.eval("window.__e2ePlugins.clickSave()");
    await waitForValue(cdp, "window.__e2ePlugins.paragraphs().indexOf(" + JSON.stringify(PROBE_COPY.saveFailed) + ") !== -1", "the stale save to be reported in the page", 25000);
    const staleWrites = probeCalls(markBeforeStaleSave, "settings/mutate");
    const fieldsAfterStale = await probeFields();
    const saveAfterStale = await pageSave();
    const paragraphsAfterStale = await pageParagraphs();
    const hostAfterStale = await servedProbe();
    const patchAfterStale = await readPatch();
    probeEvidence.staleSave = { writes: staleWrites, fields: fieldsAfterStale, save: saveAfterStale, host: hostAfterStale, patchRow: patchRow(patchAfterStale, PROBE_NS) };
    check("the page's stale save still carries the revision the draft was staged at, which the second end has moved past", staleClick === "clicked" && staleWrites.length === 1 && staleWrites[0].args.expectedRevision === hostBeforeConflict.revision && hostBeforeConflict.revision < hostAfterOtherEnd.revision, JSON.stringify(staleWrites));
    check("the page reports the refusal in its own failure copy and still offers to save", paragraphsAfterStale.indexOf(PROBE_COPY.saveFailed) !== -1 && saveAfterStale.disabled === false, JSON.stringify({ save: saveAfterStale, paragraphs: paragraphsAfterStale }));
    check("the refused save does not overwrite the newer value: the draft stays, and so does the other end's value", fieldOf(fieldsAfterStale, PROBE_LABEL_FIELD).value === PROBE_CONFLICT_DRAFT && hostAfterStale.revision === hostAfterOtherEnd.revision && hostAfterStale.value.label === PROBE_OTHER_END && patchAfterStale === patchAfterOtherEnd && patchRow(patchAfterStale, PROBE_NS).indexOf(PROBE_OTHER_END) !== -1, JSON.stringify({ fields: fieldsAfterStale, host: hostAfterStale, row: patchRow(patchAfterStale, PROBE_NS) }).slice(0, 400));
    await cdp.screenshot(join(EVIDENCE_DIR, MODE + "-16-plugin-refused.png"));
    assertLiveTransport("afterPluginPageWrites");
    assertNoStageErrors("afterPluginPageWrites", true);

    /* A write that cannot land at all: the patch file is replaced by an unusable directory of the same name,
       the same induced failure the provider page above is driven through. */
    await navigate(remoteUrl4);
    await openPluginPage("before the induced write failure", true);
    const patchBackup = await readPatch();
    const patchMode = (await stat(patchPath)).mode & 0o777;
    const hostBeforeInduced = await servedProbe();
    const failureErrors = cdp.errorEvents().length;
    await rm(patchPath, { recursive: true, force: true });
    await mkdir(patchPath, { recursive: true, mode: 0o700 });
    const markBeforeInduced = probeRequestMark();
    await typeText(cdp, "window.__e2ePlugins.focusField(" + JSON.stringify(PROBE_LABEL_FIELD) + ")", PROBE_FAILED_DRAFT);
    await sleep(900);
    const inducedClick = await cdp.eval("window.__e2ePlugins.clickSave()");
    await waitForValue(cdp, "window.__e2ePlugins.paragraphs().indexOf(" + JSON.stringify(PROBE_COPY.saveFailed) + ") !== -1", "the impossible write to be reported in the page", 25000);
    const inducedWrites = probeCalls(markBeforeInduced, "settings/mutate");
    const fieldsInduced = await probeFields();
    const hostWhileInduced = await tryServedNamespace(PROBE_NS);
    const targetStillDirectory = (await stat(patchPath)).isDirectory();
    const targetEntries = targetStillDirectory ? await readdir(patchPath) : ["target was not a directory at all"];
    const failureEvents = cdp.errorEvents().slice(failureErrors);
    /* The failure text this window may account for. Deliberately narrow: a bare "patch" would excuse almost
       anything a broken implementation could print, and the exemption has to be earned by an event, not assumed. */
    const inducedWords = /failed to (read|write) patches|EISDIR|illegal operation on a directory|is a directory/i;
    const inducedFailureEvents = failureEvents.filter((event) => inducedWords.test(String(event.text)));
    const unrelatedFailureEvents = failureEvents.filter((event) => !inducedWords.test(String(event.text)));
    probeEvidence.inducedFailure = { writes: inducedWrites, fields: fieldsInduced, hostBefore: hostBeforeInduced, hostWhileFailing: hostWhileInduced, targetStillDirectory: targetStillDirectory, targetEntries: targetEntries, inducedEvents: inducedFailureEvents.map((event) => ({ method: event.method, text: String(event.text).slice(0, 300) })) };
    check("a configuration write that cannot land is reported in the page and leaves the draft open", inducedClick === "clicked" && inducedWrites.length === 1 && fieldOf(fieldsInduced, PROBE_LABEL_FIELD).value === PROBE_FAILED_DRAFT, JSON.stringify({ click: inducedClick, writes: inducedWrites, fields: fieldsInduced }));
    check("while the write target is unusable the instance refuses to describe the namespace at all (it cannot read its own overlay)", hostWhileInduced.state === null && /EISDIR|illegal operation on a directory|is a directory/i.test(hostWhileInduced.error || ""), JSON.stringify({ whileFailing: hostWhileInduced }).slice(0, 400));
    check("nothing was written anywhere: the target is still the unusable directory the harness made, and that directory is empty", targetStillDirectory === true && targetEntries.length === 0, JSON.stringify({ targetStillDirectory: targetStillDirectory, targetEntries: targetEntries }));
    /* This window may hold the failure text it induced - and nothing else. Here the host refuses the write inside the response, so the page reports it without any runtime or network event at all; the exemption is therefore earned only when it is needed, and an empty window is a pass, not an excuse. */
    check("the refusal is the page's own report of a real failed write, and the window invents no failure text of its own", unrelatedFailureEvents.length === 0 && (failureEvents.length === 0 || inducedFailureEvents.length > 0), JSON.stringify({ events: failureEvents.length, induced: inducedFailureEvents.map((event) => String(event.text).slice(0, 200)), unrelated: unrelatedFailureEvents.map((event) => String(event.text).slice(0, 200)) }).slice(0, 700));
    await rm(patchPath, { recursive: true, force: true });
    await writeFile(patchPath, patchBackup);
    await chmod(patchPath, patchMode);
    const patchAfterRestore = await readPatch();
    const hostAfterInduced = await servedProbe();
    probeEvidence.inducedFailure.hostAfter = hostAfterInduced;
    check("the profile's patch file is restored byte-identically after the induced failure", patchAfterRestore === patchBackup, patchAfterRestore.replace(/\n/g, " | ").slice(0, 240));
    check("the failed write left the instance's own value and revision exactly as they were, and never the draft", hostAfterInduced.revision === hostBeforeInduced.revision && JSON.stringify(hostAfterInduced.value) === JSON.stringify(hostBeforeInduced.value) && hostBeforeInduced.value.label !== PROBE_FAILED_DRAFT && patchAfterRestore.indexOf(PROBE_FAILED_DRAFT) === -1, JSON.stringify({ before: hostBeforeInduced.value, after: hostAfterInduced.value, revisions: [hostBeforeInduced.revision, hostAfterInduced.revision], draftInProfile: patchAfterRestore.indexOf(PROBE_FAILED_DRAFT) !== -1 }));
    /* The failure above is expected evidence for that window alone: the stage's accounting starts after it. */
    stageMark = cdp.errorEvents().length;

    /* The plugin's switches, driven from the same page through the plugin manager's own calls. */
    await navigate(remoteUrl4);
    const reopenedForSwitches = await openPluginPage("before the enable/disable round trip", true);
    const hostBeforeSwitches = await servedProbe();
    const componentSwitch = "Enable component " + PROBE_PACKAGE;
    const bundleSwitch = "Enable " + PROBE_PACKAGE;
    probeEvidence.switchesBefore = { switches: reopenedForSwitches.detail.switches, rows: reopenedForSwitches.detail.rows };
    check("the plugin's own component and its bundle are both listed with their own switches, both on", reopenedForSwitches.detail.switches.some((item) => item.label === componentSwitch && item.checked === "true") && reopenedForSwitches.detail.switches.some((item) => item.label === bundleSwitch && item.checked === "true"), JSON.stringify(reopenedForSwitches.detail.switches));

    /* The page re-reads the plugin inventory after every toggle (the manager's own run-then-reload path), so a
       toggle's visible effect lands a moment after its call does - and the switch is briefly unusable while its
       own call is in flight, which would swallow a second click. Each step below therefore waits for the page to
       report the new state, and for the switch to be usable again, before the next step is taken. */
    const switchOf = (label) => "window.__e2ePlugins.detail().switches.filter(function (item) { return item.label === " + JSON.stringify(label) + "; })[0]";
    const switchIdle = (label) => "(function (item) { return !!item && item.disabled === false; })(" + switchOf(label) + ")";
    const switchReports = (label, checked) => "(function (item) { return !!item && item.checked === " + JSON.stringify(checked) + " && item.disabled === false; })(" + switchOf(label) + ")";

    await waitForValue(cdp, switchIdle(componentSwitch), "the component switch to be usable", 25000);
    const markBeforeDisable = probeRequestMark();
    const disableClick = await cdp.eval("window.__e2ePlugins.clickSwitch(" + JSON.stringify(componentSwitch) + ")");
    await waitForValue(cdp, switchReports(componentSwitch, "false"), "the page to report the plugin as off", 25000);
    const disableCalls = probeCalls(markBeforeDisable, "pluginManager/setPluginEnabled");
    const detailWhileDisabled = JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins.detail())"));
    const hostWhileDisabled = await servedProbe();
    const patchWhileDisabled = await readPatch();
    probeEvidence.componentOff = { calls: disableCalls, switches: detailWhileDisabled.switches, rows: detailWhileDisabled.rows, host: hostWhileDisabled, patchRow: patchRow(patchWhileDisabled, PROBE_NS) };
    check("switching the component off is the plugin manager's own call, keyed by the component's own id", disableClick === "clicked" && disableCalls.length === 1 && disableCalls[0].args.id === "include:" + PROBE_NS && disableCalls[0].args.enabled === false, JSON.stringify(disableCalls));
    check("a plugin that is switched off stops being served, and its configuration section goes with it", hostWhileDisabled === null && detailWhileDisabled.configCount === 0, JSON.stringify({ host: hostWhileDisabled, configCount: detailWhileDisabled.configCount }));
    check("the switch and the row report the plugin as off", detailWhileDisabled.switches.some((item) => item.label === componentSwitch && item.checked === "false") && detailWhileDisabled.rows.some((item) => item.state === "off"), JSON.stringify({ switches: detailWhileDisabled.switches, rows: detailWhileDisabled.rows }));
    check("the disable is recorded in the profile's patch file, on the plugin's own row", /disabled:\s*true/.test(patchRow(patchWhileDisabled, PROBE_NS)), patchRow(patchWhileDisabled, PROBE_NS).replace(/\n/g, " | ").slice(0, 240));

    await waitForValue(cdp, switchIdle(componentSwitch), "the component switch to be usable again", 25000);
    const markBeforeReEnable = probeRequestMark();
    const reEnableClick = await cdp.eval("window.__e2ePlugins.clickSwitch(" + JSON.stringify(componentSwitch) + ")");
    await waitForValue(cdp, switchReports(componentSwitch, "true"), "the page to report the plugin as on again", 25000);
    await waitForValue(cdp, "window.__e2ePlugins.detail().fieldIds.indexOf(" + JSON.stringify(PROBE_LABEL_FIELD) + ") !== -1", "the configuration form to come back", 25000);
    const reEnableCalls = probeCalls(markBeforeReEnable, "pluginManager/setPluginEnabled");
    const hostAfterReEnable = await servedProbe();
    const patchAfterReEnable = await readPatch();
    const fieldsAfterReEnable = await probeFields();
    probeEvidence.componentOn = { calls: reEnableCalls, host: hostAfterReEnable, patchRow: patchRow(patchAfterReEnable, PROBE_NS) };
    check("switching the component back on restores the plugin and the value it had saved", reEnableClick === "clicked" && reEnableCalls.length === 1 && reEnableCalls[0].args.enabled === true && hostAfterReEnable !== null && hostAfterReEnable.value.label === hostBeforeSwitches.value.label && fieldOf(fieldsAfterReEnable, PROBE_LABEL_FIELD).value === hostAfterReEnable.value.label, JSON.stringify({ calls: reEnableCalls, host: hostAfterReEnable, fields: fieldsAfterReEnable }));
    check("the re-enable is recorded in the profile's patch file, on the same row", /disabled:\s*false/.test(patchRow(patchAfterReEnable, PROBE_NS)), patchRow(patchAfterReEnable, PROBE_NS).replace(/\n/g, " | ").slice(0, 240));

    await waitForValue(cdp, switchIdle(bundleSwitch), "the bundle switch to be usable", 25000);
    const markBeforeBundleOff = probeRequestMark();
    const bundleOffClick = await cdp.eval("window.__e2ePlugins.clickSwitch(" + JSON.stringify(bundleSwitch) + ")");
    await waitForValue(cdp, switchReports(bundleSwitch, "false"), "the page to report the bundle as off", 25000);
    /* Switching a whole bundle is the plugin manager's other call: setBundleEnabled, keyed by the bundle's
       own package name (the row switch above is setPluginEnabled, keyed by the entry id). */
    const bundleOffCalls = probeCalls(markBeforeBundleOff, "pluginManager/setBundleEnabled");
    const detailBundleOff = JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins.detail())"));
    const hostWhileBundleOff = await servedProbe();
    probeEvidence.bundleOff = { calls: bundleOffCalls, switches: detailBundleOff.switches, rows: detailBundleOff.rows, host: hostWhileBundleOff };
    check("switching the bundle off is the plugin manager's own bundle call, keyed by the bundle's package name", bundleOffClick === "clicked" && bundleOffCalls.length === 1 && bundleOffCalls[0].args.name === PROBE_PACKAGE && bundleOffCalls[0].args.enabled === false, JSON.stringify(bundleOffCalls));
    check("with the bundle off the whole plugin is gone: nothing is served, no form, and the row reports it off", hostWhileBundleOff === null && detailBundleOff.configCount === 0 && detailBundleOff.rows.some((item) => item.state === "off"), JSON.stringify({ host: hostWhileBundleOff, configCount: detailBundleOff.configCount, rows: detailBundleOff.rows }));
    await waitForValue(cdp, switchIdle(bundleSwitch), "the bundle switch to be usable again", 25000);
    const markBeforeBundleOn = probeRequestMark();
    const bundleOnClick = await cdp.eval("window.__e2ePlugins.clickSwitch(" + JSON.stringify(bundleSwitch) + ")");
    await waitForValue(cdp, switchReports(bundleSwitch, "true"), "the page to report the bundle as on again", 25000);
    await waitForValue(cdp, "window.__e2ePlugins.detail().fieldIds.indexOf(" + JSON.stringify(PROBE_LABEL_FIELD) + ") !== -1", "the configuration form to come back with the bundle", 25000);
    const hostAfterBundleRoundTrip = await servedProbe();
    const fieldsAfterBundleRoundTrip = await probeFields();
    const bundleOnCalls = probeCalls(markBeforeBundleOn, "pluginManager/setBundleEnabled");
    probeEvidence.bundleOn = { calls: bundleOnCalls, host: hostAfterBundleRoundTrip, fields: fieldsAfterBundleRoundTrip };
    check("the bundle's own switch round trip leaves the plugin serving the value it had saved", bundleOnClick === "clicked" && bundleOnCalls.length === 1 && bundleOnCalls[0].args.name === PROBE_PACKAGE && bundleOnCalls[0].args.enabled === true && hostAfterBundleRoundTrip !== null && hostAfterBundleRoundTrip.value.label === hostAfterReEnable.value.label && fieldOf(fieldsAfterBundleRoundTrip, PROBE_LABEL_FIELD).value === hostAfterBundleRoundTrip.value.label, JSON.stringify({ host: hostAfterBundleRoundTrip, fields: fieldsAfterBundleRoundTrip }));

    /* ------------------- The deployment's OWN explicit-save plugin form -------------------
       Everything above proves that a THIRD-PARTY package can register a form into the standard slot and drive
       it. The criterion also names a form the DEPLOYMENT ships, so the same remote plugin list is now used to
       drive the Web search configuration page: a page nobody wrote for this test, on a namespace the Host
       serves on its own. Its ids and its copy are the product's own. ------------------------------------ */
    await navigate(remoteUrl4);
    const shippedOpened = await openItemPage("the deployment's own form", SHIPPED_ITEM, SHIPPED_ENDPOINT_FIELD);
    const shippedHostAtOpen = await servedNamespace(SHIPPED_NS);
    const shippedFieldsAtOpen = await pageFields([SHIPPED_KEY_FIELD, SHIPPED_ENDPOINT_FIELD, SHIPPED_MAX_USES_FIELD]);
    const shippedParagraphsAtOpen = await pageParagraphs();
    const shippedSaveAtOpen = await pageSave();
    probeEvidence.shipped = { opened: shippedOpened, host: shippedHostAtOpen, fields: shippedFieldsAtOpen, paragraphs: shippedParagraphsAtOpen, save: shippedSaveAtOpen };
    /* The deployment's own page registers into plugins.item, so the manager gives it a section of its own (one
       [data-plugin-config] and the product's own field ids) instead of the bundle slot the fixture uses. */
    check("the deployment's own configuration page is reachable from the same remote plugin list, on its own field ids", shippedOpened.items.some((text) => text.indexOf(SHIPPED_ITEM) !== -1) && shippedOpened.detail.configCount === 1 && [SHIPPED_KEY_FIELD, SHIPPED_ENDPOINT_FIELD, SHIPPED_MAX_USES_FIELD].every((id) => shippedOpened.detail.fieldIds.indexOf(id) !== -1), JSON.stringify({ items: shippedOpened.items, detail: { detailCount: shippedOpened.detail.detailCount, configCount: shippedOpened.detail.configCount, slotPresent: shippedOpened.detail.slotPresent, fieldIds: shippedOpened.detail.fieldIds } }).slice(0, 600));
    check("it renders the deployment's own copy and its own fields, and opens with nothing to save", shippedOpened.items.some((text) => text.indexOf(SHIPPED_COPY.description) !== -1) && shippedParagraphsAtOpen.indexOf(SHIPPED_COPY.baseUrlHint) !== -1 && shippedParagraphsAtOpen.indexOf(SHIPPED_COPY.maxUsesHint) !== -1 && shippedFieldsAtOpen.every((field) => field.present === true) && shippedSaveAtOpen.text === SHIPPED_COPY.save && shippedSaveAtOpen.disabled === true, JSON.stringify({ save: shippedSaveAtOpen, paragraphs: shippedParagraphsAtOpen }));
    check("the deployment's own page reads its values from the instance", shippedHostAtOpen !== null && shippedHostAtOpen.writable === true && fieldOf(shippedFieldsAtOpen, SHIPPED_MAX_USES_FIELD).value === String(shippedHostAtOpen.value.maxUses), JSON.stringify({ page: shippedFieldsAtOpen, host: shippedHostAtOpen === null ? null : shippedHostAtOpen.value }));

    /* Staged edit on the deployment's own form: visible in the page, and nothing else moves. */
    const shippedPatchBeforeDraft = await readPatch();
    const markBeforeShippedDraft = probeRequestMark();
    await typeText(cdp, "window.__e2ePlugins.focusField(" + JSON.stringify(SHIPPED_MAX_USES_FIELD) + ")", String(SHIPPED_SAVED_MAX_USES));
    await sleep(700);
    const shippedFieldsStaged = await pageFields([SHIPPED_MAX_USES_FIELD]);
    const shippedSaveStaged = await pageSave();
    const shippedWritesWhileStaged = pageCalls(markBeforeShippedDraft, "settings/mutate", SHIPPED_NS);
    const shippedHostWhileStaged = await servedNamespace(SHIPPED_NS);
    const shippedPatchWhileStaged = await readPatch();
    probeEvidence.shippedDraft = { writes: shippedWritesWhileStaged, fields: shippedFieldsStaged, save: shippedSaveStaged, host: shippedHostWhileStaged, patchRow: patchRow(shippedPatchWhileStaged, SHIPPED_NS) };
    check("editing the deployment's own form stages the value without touching the instance's configuration", fieldOf(shippedFieldsStaged, SHIPPED_MAX_USES_FIELD).value === String(SHIPPED_SAVED_MAX_USES) && shippedSaveStaged.disabled === false && shippedWritesWhileStaged.length === 0 && shippedHostWhileStaged.revision === shippedHostAtOpen.revision && shippedHostWhileStaged.value.maxUses === shippedHostAtOpen.value.maxUses && shippedPatchWhileStaged === shippedPatchBeforeDraft, JSON.stringify({ fields: shippedFieldsStaged, writes: shippedWritesWhileStaged, host: shippedHostWhileStaged }));

    /* The save: one standard settings write, carrying the revision the draft was staged at. */
    const markBeforeShippedSave = probeRequestMark();
    const shippedSaveClick = await cdp.eval("window.__e2ePlugins.clickSave()");
    await waitForValue(cdp, "window.__e2ePlugins.save().disabled === true", "the deployment's own form to accept the save", 25000);
    const shippedSaveWrites = pageCalls(markBeforeShippedSave, "settings/mutate", SHIPPED_NS);
    const shippedFieldsSaved = await pageFields([SHIPPED_MAX_USES_FIELD]);
    const shippedHostAfterSave = await servedNamespace(SHIPPED_NS);
    const shippedPatchAfterSave = await readPatch();
    probeEvidence.shippedSave = { writes: shippedSaveWrites, fields: shippedFieldsSaved, host: shippedHostAfterSave, patchRow: patchRow(shippedPatchAfterSave, SHIPPED_NS) };
    check("saving the deployment's own form is one standard settings write, carrying the revision it read", shippedSaveClick === "clicked" && shippedSaveWrites.length === 1 && shippedSaveWrites[0].args.ns === SHIPPED_NS && shippedSaveWrites[0].args.expectedRevision === shippedHostAtOpen.revision && shippedSaveWrites[0].args.ops.length === 1 && shippedSaveWrites[0].args.ops[0].path.join(".") === "maxUses" && shippedSaveWrites[0].args.ops[0].value === SHIPPED_SAVED_MAX_USES, JSON.stringify(shippedSaveWrites));
    check("the saved value is in the instance and in the profile's patch file, and the form is clean again", shippedHostAfterSave.revision === shippedHostAtOpen.revision + 1 && shippedHostAfterSave.value.maxUses === SHIPPED_SAVED_MAX_USES && shippedHostAfterSave.user.maxUses === SHIPPED_SAVED_MAX_USES && /maxUses:\s*7(\s|$)/.test(patchRow(shippedPatchAfterSave, SHIPPED_NS)) && fieldOf(shippedFieldsSaved, SHIPPED_MAX_USES_FIELD).value === String(SHIPPED_SAVED_MAX_USES), JSON.stringify({ host: shippedHostAfterSave, patchRow: patchRow(shippedPatchAfterSave, SHIPPED_NS) }));

    /* The same stale-revision race, on the deployment's own form: the draft was staged at the revision the page
       read, another end has moved past it, and the save has to be refused instead of overwriting it. */
    const markBeforeShippedStale = probeRequestMark();
    await typeText(cdp, "window.__e2ePlugins.focusField(" + JSON.stringify(SHIPPED_MAX_USES_FIELD) + ")", String(SHIPPED_STALE_MAX_USES));
    await sleep(700);
    const shippedOtherEnd = await remoteRpc("settings/mutate", { ns: SHIPPED_NS, ops: [{ op: "set", path: ["maxUses"], value: SHIPPED_OTHER_END_MAX_USES }], expectedRevision: shippedHostAfterSave.revision });
    const shippedHostAfterOtherEnd = await servedNamespace(SHIPPED_NS);
    const shippedStaleClick = await cdp.eval("window.__e2ePlugins.clickSave()");
    await waitForValue(cdp, "window.__e2ePlugins.paragraphs().indexOf(" + JSON.stringify(SHIPPED_COPY.saveFailed) + ") !== -1", "the deployment's own form to report the refusal", 25000);
    const shippedStaleWrites = pageCalls(markBeforeShippedStale, "settings/mutate", SHIPPED_NS);
    const shippedFieldsStale = await pageFields([SHIPPED_MAX_USES_FIELD]);
    const shippedSaveStale = await pageSave();
    const shippedHostAfterStale = await servedNamespace(SHIPPED_NS);
    const shippedPatchAfterStale = await readPatch();
    probeEvidence.shippedStale = { otherEnd: shippedOtherEnd, writes: shippedStaleWrites, fields: shippedFieldsStale, host: shippedHostAfterStale, patchRow: patchRow(shippedPatchAfterStale, SHIPPED_NS) };
    check("the deployment's own form sends the revision it staged at, which the other end has moved past", shippedOtherEnd.ok === true && shippedHostAfterOtherEnd.revision === shippedHostAfterSave.revision + 1 && shippedStaleClick === "clicked" && shippedStaleWrites.length === 1 && shippedStaleWrites[0].args.expectedRevision === shippedHostAfterSave.revision, JSON.stringify({ writes: shippedStaleWrites, host: shippedHostAfterOtherEnd }));
    check("its refused save is reported in the deployment's own failure copy, keeps the draft, and leaves the other end's value in place", shippedFieldsStale[0].value === String(SHIPPED_STALE_MAX_USES) && shippedSaveStale.disabled === false && shippedHostAfterStale.value.maxUses === SHIPPED_OTHER_END_MAX_USES && /maxUses:\s*6(\s|$)/.test(patchRow(shippedPatchAfterStale, SHIPPED_NS)), JSON.stringify({ fields: shippedFieldsStale, save: shippedSaveStale, host: shippedHostAfterStale, patchRow: patchRow(shippedPatchAfterStale, SHIPPED_NS) }));

    /* Input the deployment's own form cannot read: refused in the page, never sent anywhere. */
    const markBeforeShippedInvalid = probeRequestMark();
    await typeText(cdp, "window.__e2ePlugins.focusField(" + JSON.stringify(SHIPPED_MAX_USES_FIELD) + ")", PROBE_UNPARSEABLE);
    await sleep(700);
    const shippedFieldsInvalid = await pageFields([SHIPPED_MAX_USES_FIELD]);
    const shippedSaveInvalid = await pageSave();
    const shippedWritesWhileInvalid = pageCalls(markBeforeShippedInvalid, "settings/mutate", SHIPPED_NS);
    probeEvidence.shippedInvalid = { fields: shippedFieldsInvalid, save: shippedSaveInvalid, writes: shippedWritesWhileInvalid };
    check("unreadable input on the deployment's own form is refused in its own copy and never written", fieldOf(shippedFieldsInvalid, SHIPPED_MAX_USES_FIELD).invalid === "true" && fieldOf(shippedFieldsInvalid, SHIPPED_MAX_USES_FIELD).message === SHIPPED_COPY.invalidNumber && shippedSaveInvalid.disabled === true && shippedWritesWhileInvalid.length === 0, JSON.stringify({ fields: shippedFieldsInvalid, save: shippedSaveInvalid, writes: shippedWritesWhileInvalid }));
    await cdp.screenshot(join(EVIDENCE_DIR, MODE + "-16-shipped-form.png"));

    /* ------------------- Persistence: interruption, refresh, restart -------------------
       The stored values have to survive more than the page that wrote them: a real transport interruption in the
       middle of that page (no reload inside the window), then a fresh document, then a fresh process. */
    /* The window the two forms above ran in closes here, so the interruption below gets a stage of its own. */
    assertLiveTransport("afterPluginShippedForm");
    assertNoStageErrors("afterPluginShippedForm", true);

    const pluginDocUrl = String(await cdp.eval("String(location.href)"));
    const pluginPreReconnect = cdp.liveConnections();
    discontinue("forced offline on the plugin page");
    let pluginOfflineApplied = true;
    try { await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
    catch (error) { pluginOfflineApplied = false; probeEvidence.offlineError = String(error); }
    check("the harness can really take the plugin page offline through CDP", pluginOfflineApplied === true && pluginPreReconnect.length > 0, JSON.stringify({ applied: pluginOfflineApplied, connections: pluginPreReconnect }));
    await sleep(4000);
    const pluginTransportWhileOffline = await cdp.eval(transportProbe).catch((error) => "eval-failed:" + String(error));
    probeEvidence.transportWhileOffline = pluginTransportWhileOffline;
    check("while offline the plugin page's own settings transport fails at the network layer", /^(failed|closed)$/.test(String(pluginTransportWhileOffline)), String(pluginTransportWhileOffline));
    const pluginReachWhileOffline = await cdp.eval(reachProbe).catch((error) => "eval-failed:" + String(error));
    probeEvidence.reachWhileOffline = pluginReachWhileOffline;
    check("while offline the plugin page's own transport request genuinely fails", /^rejected:/.test(String(pluginReachWhileOffline)), String(pluginReachWhileOffline).slice(0, 160));
    try { await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
    catch (error) { probeEvidence.onlineError = String(error); }
    await sleep(8000);
    const pluginReachAfterOnline = await cdp.eval(reachProbe).catch((error) => "eval-failed:" + String(error));
    probeEvidence.reachAfterOnline = pluginReachAfterOnline;
    check("after the network returns the SAME document reaches the instance again, on a new streaming connection", /^status:/.test(String(pluginReachAfterOnline)), String(pluginReachAfterOnline).slice(0, 160));
    /* What the interruption left behind on that very document: it never reloaded, so the form it was showing has
       to still be mounted and still be showing a value. What the instance stores is read back further down. */
    const pluginFormAfterReconnect = await pageFields([SHIPPED_MAX_USES_FIELD]);
    const pluginSaveAfterReconnect = await pageSave();
    probeEvidence.reconnectForm = { fields: pluginFormAfterReconnect, save: pluginSaveAfterReconnect };
    check("the form that was open when the network went away is still mounted on the same document", fieldOf(pluginFormAfterReconnect, SHIPPED_MAX_USES_FIELD).present === true && fieldOf(pluginFormAfterReconnect, SHIPPED_MAX_USES_FIELD).value !== null && pluginSaveAfterReconnect.present === true, JSON.stringify({ fields: pluginFormAfterReconnect, save: pluginSaveAfterReconnect }));
    assertLiveTransport("afterPluginReconnect");
    assertNoStageErrors("afterPluginReconnect", true, pluginDocUrl, true);

    /* A fresh document, on the same instance: both forms have to show what the instance stores, not drafts. */
    await navigate(remoteUrl4);
    await openPluginPage("after the interruption", true);
    const probeHostAfterReload = await servedProbe();
    const probeFieldsAfterReload = await probeFields();
    check("a fresh document still shows the plugin's stored value after the interruption", probeHostAfterReload !== null && fieldOf(probeFieldsAfterReload, PROBE_LABEL_FIELD).value === probeHostAfterReload.value.label && probeHostAfterReload.value.label === hostBeforeSwitches.value.label, JSON.stringify({ host: probeHostAfterReload, fields: probeFieldsAfterReload }));
    await navigate(remoteUrl4);
    await openItemPage("after the interruption", SHIPPED_ITEM, SHIPPED_ENDPOINT_FIELD);
    const shippedHostAfterReload = await servedNamespace(SHIPPED_NS);
    const shippedFieldsAfterReload = await pageFields([SHIPPED_MAX_USES_FIELD]);
    check("the deployment's own form shows the stored value again after the interruption, not the refused draft", fieldOf(shippedFieldsAfterReload, SHIPPED_MAX_USES_FIELD).value === String(SHIPPED_OTHER_END_MAX_USES) && shippedHostAfterReload.value.maxUses === SHIPPED_OTHER_END_MAX_USES, JSON.stringify({ host: shippedHostAfterReload, fields: shippedFieldsAfterReload }));

    /* And a fresh process: the bundle list and every stored value are read again from disk. */
    discontinue("instance restart after the plugin page");
    instance.child.kill("SIGTERM");
    await sleep(3000);
    instance = await startInstance(home, PROFILE);
    remoteRpc = rpcFor(instance.url);
    const afterProbeRestart = new URL(instance.url);
    const remoteUrl5 = "http://" + TEST_HOST + ":" + afterProbeRestart.port + "/" + afterProbeRestart.search;
    evidence.urls.remoteWithProbePluginAfterRestart = remoteUrl5;
    await navigate(remoteUrl5);
    await openPluginPage("after the instance restarted", true);
    const probeHostAfterRestart = await servedProbe();
    const probeFieldsAfterRestart = await probeFields();
    const probePatchAfterRestart = await readPatch();
    check("the plugin's stored value survives a restart of the instance, in the instance and in the profile", probeHostAfterRestart !== null && fieldOf(probeFieldsAfterRestart, PROBE_LABEL_FIELD).value === probeHostAfterRestart.value.label && probeHostAfterRestart.value.label === hostBeforeSwitches.value.label && patchRow(probePatchAfterRestart, PROBE_NS).indexOf(probeHostAfterRestart.value.label) !== -1, JSON.stringify({ host: probeHostAfterRestart, fields: probeFieldsAfterRestart, patchRow: patchRow(probePatchAfterRestart, PROBE_NS) }));
    await navigate(remoteUrl5);
    await openItemPage("after the instance restarted", SHIPPED_ITEM, SHIPPED_ENDPOINT_FIELD);
    const shippedHostAfterRestart = await servedNamespace(SHIPPED_NS);
    const shippedFieldsAfterRestart = await pageFields([SHIPPED_MAX_USES_FIELD]);
    const shippedPatchAfterRestart = await readPatch();
    probeEvidence.restart = { probe: { host: probeHostAfterRestart, fields: probeFieldsAfterRestart }, shipped: { host: shippedHostAfterRestart, fields: shippedFieldsAfterRestart } };
    check("the deployment's own form reads its stored value back after a restart of the instance", fieldOf(shippedFieldsAfterRestart, SHIPPED_MAX_USES_FIELD).value === String(SHIPPED_OTHER_END_MAX_USES) && shippedHostAfterRestart.value.maxUses === SHIPPED_OTHER_END_MAX_USES && /maxUses:\s*6(\s|$)/.test(patchRow(shippedPatchAfterRestart, SHIPPED_NS)), JSON.stringify({ host: shippedHostAfterRestart, fields: shippedFieldsAfterRestart, patchRow: patchRow(shippedPatchAfterRestart, SHIPPED_NS) }));
    await sleep(1500);

    /* The offline window was accounted for by its own stage above. What this window holds is the harness
       navigating and restarting the instance, so a teardown is accepted only as the harness's own doing. */
    assertLiveTransport("afterPluginPage");
    assertNoStageErrors("afterPluginPage", true);
  } else {
    /* CONTROL: the same plugin, installed the same way, on the same remote origin. The ORIGINAL composition
       keeps its settings state in the page, so it never reads a namespace from the instance and no
       configuration form is registered for the bundle at all. The bundle itself is still listed and still
       manageable; what is missing is the form - and the instance does serve the namespace to anyone who asks
       through the public RPC, which is what shows the difference is the replacement and not the fixture. */
    const hostInControl = await servedProbe();
    const shippedHostInControl = await servedNamespace(SHIPPED_NS);
    /* Before the fixture's own card is opened, the LIST itself is read, because opening a card replaces it: in
       the original composition the pages the deployment ships are missing from the list as well, even while the
       instance still serves the namespace behind them. */
    await settlePage("control list");
    const controlNav = await cdp.eval("window.__e2ePlugins.openPlugins()");
    await sleep(2500);
    const itemsInControl = JSON.parse(await cdp.eval("JSON.stringify(window.__e2ePlugins.items())"));
    const controlShippedOpen = await cdp.eval("window.__e2ePlugins.openItem(" + JSON.stringify(SHIPPED_ITEM) + ")");
    const controlShippedFields = await pageFields([SHIPPED_KEY_FIELD, SHIPPED_ENDPOINT_FIELD, SHIPPED_MAX_USES_FIELD]);
    const openedInControl = await openPluginPage("control open", false);
    const fieldsInControl = await probeFields();
    probeEvidence.control = { host: hostInControl, shippedHost: shippedHostInControl, items: itemsInControl, shippedOpen: controlShippedOpen, shippedFields: controlShippedFields, cards: openedInControl.cards, detail: openedInControl.detail, fields: fieldsInControl };
    check("CONTROL: the instance serves the third-party plugin's namespace all the same", hostInControl !== null && hostInControl.value.label === PROBE_DEFAULT_LABEL && hostInControl.value.attempts === PROBE_DEFAULT_ATTEMPTS, JSON.stringify(hostInControl));
    check("CONTROL: the page lists the installed third-party bundle", openedInControl.cards.some((card) => card.pkg === PROBE_PACKAGE) && openedInControl.detail.detailCount === 1, JSON.stringify({ cards: openedInControl.cards, detailCount: openedInControl.detail.detailCount }));
    check("CONTROL: the original composition mounts no configuration form for the plugin on a remote origin", openedInControl.detail.slotPresent === false && openedInControl.detail.configCount === 0 && openedInControl.detail.fieldIds.length === 0 && fieldsInControl.every((field) => field.present === false), JSON.stringify({ slotPresent: openedInControl.detail.slotPresent, configCount: openedInControl.detail.configCount, fieldIds: openedInControl.detail.fieldIds }));
    check("CONTROL: the original composition mounts none of the deployment's own plugin forms on a remote origin either", controlNav === "clicked" && itemsInControl.every((text) => text.indexOf(SHIPPED_ITEM) === -1) && controlShippedOpen === "no-card" && controlShippedFields.every((field) => field.present === false) && shippedHostInControl !== null && shippedHostInControl.value.maxUses === 5, JSON.stringify({ items: itemsInControl, shippedOpen: controlShippedOpen, shippedFields: controlShippedFields, shippedHost: shippedHostInControl }));
    await cdp.screenshot(join(EVIDENCE_DIR, MODE + "-15-plugin-page.png"));
    assertLiveTransport("afterPluginPage");
    assertNoStageErrors("afterPluginPage", true);
  }

  /* -------------------------------------------------------------------------------------------------------
     INSTANCE PREFERENCES (issue #6). The General section of the standard page carries two rows that save
     INSTANTLY: the appearance row (three aria-pressed cubes) and the language row (a menu button). Neither of
     them has a Save button or a draft, so one click is one settings write through whichever settings provider
     the page booted with - and with the replacement in place that provider is the instance. That makes these
     two rows the place where "an interface preference is stored on the instance, not in this browser" becomes
     observable: the page that clicked, a SECOND access end, a document rebuilt from scratch, and a restarted
     instance all read the same stored value, and the value is in the profile's own patch file.

     The explicit-save half of the same contract is the plugin stage above (its forms stage a draft and write on
     Save); this stage is the instant half, and it is deliberately not turned into a uniform save flow.

     The module layer refuses to replace or remove a bootstrap entry in place ("replacing bootstrap module <id>
     requires a page reload"), so a document rebuilt from scratch - exactly one settings provider module in
     __DSH_BOOT__ and exactly one ui-settings row across the loaded bundles - IS the release-and-replace evidence
     for the component. The queue and the in-flight write at the moment of release are checked on the rapid
     clicks below, against the contract the replaced provider implements: writes are serialized behind one
     another, a disposed form issues no further write, and an interrupted write never becomes the stored value.
     ------------------------------------------------------------------------------------------------------- */
  const PREFS_PANEL = "(Array.from(document.querySelectorAll('[role=dialog]')).some(function (d) { return d.getClientRects().length > 0 && /Appearance|外观/.test(d.innerText || ''); }))";
  /* The page-side helpers below are written without backslash escapes on purpose: they are string literals in
     this file AND source text for the browser, so every pattern here is spelled with character classes of
     literal characters only. */
  const PREFS_HELPERS = [
    "var visible = function (e) { return !!e && e.getClientRects().length > 0; };",
    "var list = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };",
    "var flatten = function (v) { return v.split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(9)).join(' '); };",
    "var text = function (e) { return flatten(String((e && e.innerText) || '')).replace(/ +/g, ' ').trim(); };",
    "var panel = list('[role=dialog]').filter(visible).pop() || document.body;",
    "var cubes = function () { return list('button', panel).filter(visible).filter(function (b) { return b.hasAttribute('aria-pressed'); }); };",
    "var languageRow = function () { return list('button', panel).filter(visible).filter(function (b) { return b.getAttribute('aria-haspopup') === 'menu'; }).filter(function (b) { return /language|语言/i.test(text(b.parentElement.parentElement)); })[0]; };",
    "var instantRows = function () { return cubes().concat(languageRow() ? [languageRow()] : []).map(function (b) { return b.parentElement.parentElement; }); };",
    "var saveButtons = function () { return instantRows().map(function (r) { return list('button', r).filter(visible).filter(function (b) { return /^(save|save changes|保存|保存更改)$/i.test(text(b)); }); }).reduce(function (a, b) { return a.concat(b); }, []); };"
  ].join(" ");
  const PREFS_INVENTORY = "(() => { " + PREFS_HELPERS + " var pressed = cubes().filter(function (b) { return b.getAttribute('aria-pressed') === 'true'; }); return JSON.stringify({ cubes: cubes().map(function (b) { return text(b).slice(0, 24); }), pressed: pressed.length === 1 ? text(pressed[0]).slice(0, 24) : null, language: languageRow() ? text(languageRow()).slice(0, 24) : null, saveButtons: saveButtons().map(function (b) { return text(b).slice(0, 24); }), scheme: String(getComputedStyle(document.documentElement).colorScheme || ''), background: getComputedStyle(document.body).backgroundColor }); })()";
  const prefsClickCube = (pattern) => "(() => { " + PREFS_HELPERS + " var cube = cubes().filter(function (b) { return " + pattern + ".test(text(b)); })[0]; if (!cube) return 'MISS ' + cubes().map(function (b) { return text(b); }).join('/'); cube.click(); return 'CLICKED ' + text(cube).slice(0, 24); })()";
  const PREFS_CLICK_DARK = prefsClickCube("/dark|深色/i");
  const PREFS_CLICK_LIGHT = prefsClickCube("/light|浅色/i");
  const PREFS_OPEN_LANGUAGE = "(() => { " + PREFS_HELPERS + " var row = languageRow(); if (!row) return 'MISS'; row.click(); return 'OPENED ' + text(row).slice(0, 24); })()";
  const PREFS_MENU = "(() => { " + PREFS_HELPERS + " return JSON.stringify(list('[role=menuitem],[role=option]').filter(visible).map(function (e) { return { label: text(e).slice(0, 24), selected: String(e.className).indexOf('_selected_') !== -1 }; })); })()";
  const prefsPickLanguage = (label) => "(() => { " + PREFS_HELPERS + " var items = list('[role=menuitem],[role=option]').filter(visible); var item = items.filter(function (e) { return text(e) === " + JSON.stringify(label) + "; })[0]; if (!item) return 'MISS ' + items.map(function (e) { return text(e); }).join('/'); item.click(); return 'CLICKED ' + text(item); })()";

  const preferencesUrl = "http://" + TEST_HOST + ":" + new URL(instance.url).port + "/" + new URL(instance.url).search;
  evidence.urls.remoteWithInstancePreferences = preferencesUrl;
  /* Re-derived after the restart below: a fresh instance listens on a fresh port. */
  let preferencesRpc = rpcFor(instance.url);
  const prefsMarkOf = (client) => (client.requests.length === 0 ? 0 : client.requests[client.requests.length - 1].seq);
  /* Every RPC a client sent since a mark, parsed from its own request bodies - the same shape the plugin stage
     reads off the page, here also for the SECOND access end, which has a browser of its own. */
  const prefsCallsSince = (client, sinceSeq) => client.requests
    .filter((request) => request.seq > sinceSeq && request.method === "POST")
    .map((request) => { let body = null; try { body = JSON.parse(request.postData); } catch (error) { body = null; } return body === null || body.method === undefined ? null : { seq: request.seq, method: body.method, args: body.payload ? body.payload.args : undefined }; })
    .filter((call) => call !== null);
  const prefsWritesSince = (client, sinceSeq, ns) => prefsCallsSince(client, sinceSeq).filter((call) => call.method === "settings/mutate" && call.args !== undefined && (ns === undefined || call.args.ns === ns));
  /* The two namespaces this stage owns: a fresh document may write namespaces of its own in the same window
     (the onboarding notice, for one), and those belong to no stage. */
  const prefsInterfaceWrites = (client, sinceSeq) => prefsWritesSince(client, sinceSeq, undefined).filter((call) => call.args.ns === "ui-theme" || call.args.ns === "locale");
  const preferencesOf = async () => {
    const described = await preferencesRpc("settings/describe", {});
    if (described.ok !== true) throw new Error("the instance refused settings/describe: " + JSON.stringify(described).slice(0, 300));
    const pick = (ns) => {
      const entry = described.value.namespaces.filter((item) => item.ns === ns)[0];
      return entry === undefined ? null : { ns: entry.ns, revision: entry.revision, value: entry.value, user: entry.user };
    };
    return { appearance: pick("ui-theme"), language: pick("locale"), writable: described.value.writable === true };
  };
  /* The panel is recognised by the appearance row it holds, so this opener works on the English page and on the
     Chinese page the language row switches the whole interface to - the stock opener's panel probe only knows
     the English copy. */
  const PREFS_TRIGGER_READY = "(Array.from(document.querySelectorAll(\"button\")).some((e) => /^(settings|设置)/i.test((e.getAttribute(\"aria-label\") || e.innerText || \"\").trim())))";
  /* Only evaluated when an attempt fails: it reports what the document actually offered, so a failure here is
     debuggable from the run log instead of by guesswork. */
  const PREFS_DIAG = "(() => { const txt = (e) => ((e && e.innerText) || \"\").replace(/ +/g, \" \").trim().slice(0, 100); const root = document.getElementById(\"root\"); return JSON.stringify({ dialogs: Array.from(document.querySelectorAll(\"[role=dialog]\")).map((d) => ({ shown: d.offsetParent !== null, text: txt(d) })), buttons: Array.from(document.querySelectorAll(\"button\")).map(txt).filter((s) => s.length > 0).slice(0, 24), rootInert: !!(root && root.inert), body: txt(document.body) }); })()";
  /* The stock opener presses the page's own settings entry once and trusts the first shell render. This one
     waits for that entry to be there and retries the press, because a document whose app is still mounting can
     accept the click without opening anything (and the stage drives the page right after a navigation). */
  const openPreferences = async (client, shot) => {
    const attempts = 4;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await waitFor(client, PREFS_TRIGGER_READY, "the page's own settings entry", 60000);
      if ((await client.eval(PREFS_PANEL)) === true) break;
      const dialogsBefore = await client.eval("document.querySelectorAll('[role=dialog]').length");
      await client.eval(SETTINGS_TRIGGER);
      try {
        await waitFor(client, "document.querySelectorAll('[role=dialog]').length > " + String(dialogsBefore) + " || " + PREFS_PANEL, "the settings panel behind the page's own settings entry", 15000);
        break;
      } catch (error) {
        console.log("PREFS OPEN ATTEMPT " + String(attempt) + " FAILED: " + error.message + " :: " + (await client.eval(PREFS_DIAG)));
        if (attempt === attempts) throw error;
        await sleep(2500);
      }
    }
    await client.eval(SETTINGS_GENERAL);
    await sleep(1500);
    if (shot !== undefined) await client.screenshot(shot);
  };
  /* The composition layers the profile loads RIGHT NOW: after an enable the own composition has replaced the
     upstream roster, so the row count has to be taken over the current list, not over the seeded one. */
  const prefsBundles = (await readJson(join(profileDir, "package.json"))).dsh.profile.bundles;
  const prefsExpectedProvider = MODE === "overlay" ? FORK_PACKAGE : "@deepseek-ai/dsh-client-ui-settings";
  const preferencesEvidence = {};

  /* A. The page this run already drives reaches its own General section and reads what the instance stores. */
  await navigate(preferencesUrl);
  await openPreferences(cdp, undefined);
  const prefsStart = JSON.parse(await cdp.eval(PREFS_INVENTORY));
  const prefsStoredStart = await preferencesOf();
  const prefsPatchStart = await readPatch();
  preferencesEvidence.start = { page: prefsStart, stored: prefsStoredStart, themeRow: patchRow(prefsPatchStart, "ui-theme"), localeRow: patchRow(prefsPatchStart, "locale") };
  check("the page the instance serves carries its own appearance and language rows, and neither of them has a save button",
    prefsStart.cubes.length === 3 && prefsStart.pressed === "System" && prefsStart.scheme.indexOf("light") !== -1 && prefsStart.language === "English" && prefsStart.saveButtons.length === 0 &&
    prefsStoredStart.appearance !== null && prefsStoredStart.appearance.value.preference === "system" && JSON.stringify(prefsStoredStart.appearance.user) === "{}" && prefsStoredStart.appearance.revision === 0 &&
    prefsStoredStart.language !== null && prefsStoredStart.language.revision === 0 && JSON.stringify(prefsStoredStart.language.value) === "{}" &&
    patchRow(prefsPatchStart, "ui-theme") === "" && patchRow(prefsPatchStart, "locale") === "",
    JSON.stringify({ page: prefsStart, appearance: prefsStoredStart.appearance, language: prefsStoredStart.language }));

  /* B. The instant click on the appearance row. */
  const prefsMarkClick = prefsMarkOf(cdp);
  const prefsClickDark = await cdp.eval(PREFS_CLICK_DARK);
  await sleep(2500);
  const prefsAfterClick = JSON.parse(await cdp.eval(PREFS_INVENTORY));
  const prefsWritesClick = prefsWritesSince(cdp, prefsMarkClick, "ui-theme");
  const prefsStoredAfterClick = await preferencesOf();
  const prefsPatchAfterClick = await readPatch();
  const prefsThemeRowAfterClick = patchRow(prefsPatchAfterClick, "ui-theme");
  preferencesEvidence.instantAppearance = { click: prefsClickDark, page: prefsAfterClick, writes: prefsWritesClick, stored: prefsStoredAfterClick.appearance, themeRow: prefsThemeRowAfterClick };
  if (MODE === "overlay") {
    check("the appearance cube is an instant save: one click is one standard settings write to the instance, with no save step in between",
      prefsClickDark === "CLICKED Dark" && prefsWritesClick.length === 1 && prefsWritesClick[0].args.ns === "ui-theme" && prefsWritesClick[0].args.ops.length === 1 && prefsWritesClick[0].args.ops[0].op === "set" && prefsWritesClick[0].args.ops[0].path.join(".") === "preference" && prefsWritesClick[0].args.ops[0].value === "dark" && prefsWritesClick[0].args.expectedRevision === prefsStoredStart.appearance.revision,
      JSON.stringify(prefsWritesClick));
    check("the clicked preference is the instance's: it is the stored value, the profile's own patch row for the appearance package, and the page's own rendering",
      prefsAfterClick.pressed === "Dark" && prefsAfterClick.scheme.indexOf("dark") !== -1 && prefsAfterClick.background !== prefsStart.background &&
      prefsStoredAfterClick.appearance.value.preference === "dark" && prefsStoredAfterClick.appearance.user.preference === "dark" && prefsStoredAfterClick.appearance.revision === prefsStoredStart.appearance.revision + 1 &&
      prefsThemeRowAfterClick.indexOf("- id: ui-theme") !== -1 && prefsThemeRowAfterClick.indexOf("@deepseek-ai/dsh-client-ui-theme") !== -1 && prefsThemeRowAfterClick.indexOf("preference: dark") !== -1,
      JSON.stringify({ page: prefsAfterClick, stored: prefsStoredAfterClick.appearance, themeRow: prefsThemeRowAfterClick }));
  } else {
    check("CONTROL: the same appearance click stays in the page - the page changes, no settings write leaves it, and the instance keeps its own value",
      prefsClickDark === "CLICKED Dark" && prefsAfterClick.pressed === "Dark" && prefsAfterClick.background !== prefsStart.background &&
      prefsInterfaceWrites(cdp, prefsMarkClick).length === 0 && prefsStoredAfterClick.appearance.value.preference === "system" && prefsStoredAfterClick.appearance.revision === prefsStoredStart.appearance.revision && prefsThemeRowAfterClick === "",
      JSON.stringify({ page: prefsAfterClick, writes: prefsInterfaceWrites(cdp, prefsMarkClick), stored: prefsStoredAfterClick.appearance }));
  }

  /* C. A SECOND access end: a browser of its own, its own profile directory, the same instance. It has to read
     the instance's value, and merely reading it must not write anything. */
  const secondClient = await startChromium(join(root, "chromium-b"));
  const cdpSecond = secondClient.cdp;
  const prefsMarkSecond = prefsMarkOf(cdpSecond);
  await cdpSecond.send("Page.navigate", { url: preferencesUrl }).catch(() => {});
  await openPreferences(cdpSecond, join(EVIDENCE_DIR, MODE + "-17-preferences-second-client.png"));
  const prefsSecond = JSON.parse(await cdpSecond.eval(PREFS_INVENTORY));
  const prefsStoredSecond = await preferencesOf();
  const prefsWritesSecond = prefsInterfaceWrites(cdpSecond, prefsMarkSecond);
  preferencesEvidence.secondEnd = { page: prefsSecond, stored: prefsStoredSecond, writes: prefsWritesSecond };
  if (MODE === "overlay") {
    check("a second access end reads the preference out of the instance instead of out of its own memory, and writes nothing while doing it",
      prefsSecond.pressed === "Dark" && prefsSecond.scheme.indexOf("dark") !== -1 && prefsSecond.language === "English" && prefsWritesSecond.length === 0 && prefsStoredSecond.appearance.value.preference === "dark" && prefsStoredSecond.appearance.revision === prefsStoredAfterClick.appearance.revision,
      JSON.stringify({ page: prefsSecond, stored: prefsStoredSecond.appearance, writes: prefsWritesSecond }));
  } else {
    check("CONTROL: a second access end sees the untouched instance value while the first one only changed its own page",
      prefsSecond.pressed === "System" && prefsSecond.language === "English" && prefsWritesSecond.length === 0 && prefsStoredSecond.appearance.value.preference === "system" && prefsStoredSecond.appearance.revision === 0,
      JSON.stringify({ page: prefsSecond, stored: prefsStoredSecond.appearance, writes: prefsWritesSecond }));
  }

  /* D. The release half of the module contract, on the page that clicked: the document is rebuilt from scratch,
     and the fresh document must mount exactly one settings provider and read the stored value back. */
  const prefsMarkReload = prefsMarkOf(cdp);
  await reload();
  await sleep(2500);
  await openPreferences(cdp, undefined);
  const prefsAfterReload = JSON.parse(await cdp.eval(PREFS_INVENTORY));
  const prefsModulesAfterReload = JSON.parse(await cdp.eval(MODULE_PROBE));
  const prefsProvidersAfterReload = loadedProviders(prefsModulesAfterReload);
  const prefsRowsAfterReload = await loadedSettingsRows(profileDir, prefsBundles);
  const prefsWritesAfterReload = prefsInterfaceWrites(cdp, prefsMarkReload);
  const prefsStoredAfterReload = await preferencesOf();
  preferencesEvidence.reload = { page: prefsAfterReload, providers: prefsProvidersAfterReload, rows: prefsRowsAfterReload, writes: prefsWritesAfterReload, stored: prefsStoredAfterReload };
  check("the reloaded document loads exactly one settings provider module and the loaded bundles hold exactly one ui-settings row, so the release left no duplicate behind",
    prefsProvidersAfterReload.length === 1 && prefsProvidersAfterReload[0] === prefsExpectedProvider && prefsRowsAfterReload.length === 1 && prefsRowsAfterReload[0].provider === prefsExpectedProvider,
    JSON.stringify({ providers: prefsProvidersAfterReload, rows: prefsRowsAfterReload }));
  if (MODE === "overlay") {
    check("a document rebuilt from scratch reads the instance's stored preference back, and the page writes nothing for it while doing so",
      prefsAfterReload.pressed === "Dark" && prefsAfterReload.scheme.indexOf("dark") !== -1 && prefsWritesAfterReload.length === 0 && prefsStoredAfterReload.appearance.value.preference === "dark" && prefsStoredAfterReload.appearance.revision === prefsStoredAfterClick.appearance.revision,
      JSON.stringify({ page: prefsAfterReload, writes: prefsWritesAfterReload, stored: prefsStoredAfterReload.appearance }));
  } else {
    check("CONTROL: the rebuilt document shows the instance's value again, so the browser-local change went away with the document",
      prefsAfterReload.pressed === "System" && prefsWritesAfterReload.length === 0 && prefsStoredAfterReload.appearance.revision === 0,
      JSON.stringify({ page: prefsAfterReload, writes: prefsWritesAfterReload }));
  }

  /* E. Queued and in-flight writes, on the same instant row. Two clicks 120 ms apart are two writes, serialized
     behind each other and carrying the revision the previous one produced; a click that is still on the wire
     when the document is released writes at most once and never replays into a second value. */
  const prefsMarkQueue = prefsMarkOf(cdp);
  const prefsQueueFirst = await cdp.eval(PREFS_CLICK_LIGHT);
  await sleep(120);
  const prefsQueueSecond = await cdp.eval(PREFS_CLICK_DARK);
  await sleep(3000);
  const prefsWritesQueue = prefsWritesSince(cdp, prefsMarkQueue, "ui-theme");
  const prefsStoredQueue = await preferencesOf();
  const prefsPatchQueue = await readPatch();
  preferencesEvidence.queue = { first: prefsQueueFirst, second: prefsQueueSecond, writes: prefsWritesQueue, stored: prefsStoredQueue.appearance, themeRow: patchRow(prefsPatchQueue, "ui-theme") };
  if (MODE === "overlay") {
    check("two rapid clicks are two serialized writes, and the second one carries the revision the first produced",
      prefsQueueFirst === "CLICKED Light" && prefsQueueSecond === "CLICKED Dark" && prefsWritesQueue.length === 2 &&
      prefsWritesQueue[0].args.ops[0].value === "light" && prefsWritesQueue[1].args.ops[0].value === "dark" &&
      prefsWritesQueue[0].args.expectedRevision === prefsStoredAfterReload.appearance.revision && prefsWritesQueue[1].args.expectedRevision === prefsStoredAfterReload.appearance.revision + 1 &&
      prefsStoredQueue.appearance.value.preference === "dark" && prefsStoredQueue.appearance.revision === prefsStoredAfterReload.appearance.revision + 2 && patchRow(prefsPatchQueue, "ui-theme").indexOf("preference: dark") !== -1,
      JSON.stringify({ writes: prefsWritesQueue, stored: prefsStoredQueue.appearance, themeRow: patchRow(prefsPatchQueue, "ui-theme") }));
    /* The in-flight write at the moment the document goes away: either it reached the instance or it did not,
       but it may not become a second value later, and the fresh document has to agree with what is stored. */
    const prefsMarkInFlight = prefsMarkOf(cdp);
    const prefsStoredBeforeInFlight = await preferencesOf();
    const prefsClickInFlight = await cdp.eval(PREFS_CLICK_LIGHT);
    await reload();
    await sleep(4000);
    await openPreferences(cdp, undefined);
    const prefsAfterInFlight = JSON.parse(await cdp.eval(PREFS_INVENTORY));
    const prefsWritesInFlight = prefsWritesSince(cdp, prefsMarkInFlight, "ui-theme");
    const prefsStoredAfterInFlight = await preferencesOf();
    await sleep(2500);
    const prefsStoredSettled = await preferencesOf();
    const inFlightStored = prefsStoredAfterInFlight.appearance.value.preference;
    preferencesEvidence.inFlightRelease = { click: prefsClickInFlight, writes: prefsWritesInFlight, storedBefore: prefsStoredBeforeInFlight.appearance, storedAfter: prefsStoredAfterInFlight.appearance, settled: prefsStoredSettled.appearance, page: prefsAfterInFlight, themeRow: patchRow(await readPatch(), "ui-theme") };
    check("a click still on the wire when the document is released writes at most once, leaves either the old value or the clicked one, and never replays afterwards",
      prefsClickInFlight === "CLICKED Light" && prefsWritesInFlight.length <= 1 &&
      (inFlightStored === prefsStoredBeforeInFlight.appearance.value.preference || inFlightStored === "light") &&
      prefsStoredAfterInFlight.appearance.revision <= prefsStoredBeforeInFlight.appearance.revision + 1 &&
      prefsStoredSettled.appearance.revision === prefsStoredAfterInFlight.appearance.revision && prefsStoredSettled.appearance.value.preference === inFlightStored &&
      prefsAfterInFlight.pressed === (inFlightStored === "light" ? "Light" : "Dark"),
      JSON.stringify({ click: prefsClickInFlight, writes: prefsWritesInFlight, before: prefsStoredBeforeInFlight.appearance, after: prefsStoredAfterInFlight.appearance, settled: prefsStoredSettled.appearance, page: prefsAfterInFlight }));
  } else {
    check("CONTROL: two rapid clicks on the instant row are two page-local changes and no settings write at all",
      prefsQueueFirst === "CLICKED Light" && prefsQueueSecond === "CLICKED Dark" && prefsWritesQueue.length === 0 && prefsStoredQueue.appearance.value.preference === "system" && prefsStoredQueue.appearance.revision === 0 && patchRow(prefsPatchQueue, "ui-theme") === "",
      JSON.stringify({ writes: prefsWritesQueue, stored: prefsStoredQueue.appearance, themeRow: patchRow(prefsPatchQueue, "ui-theme") }));
  }

  /* F. The language row: the same instant contract, on the other preference the standard page owns. */
  const prefsStoredBeforeLanguage = await preferencesOf();
  const prefsMarkLanguage = prefsMarkOf(cdp);
  const prefsOpenLanguage = await cdp.eval(PREFS_OPEN_LANGUAGE);
  await sleep(900);
  const prefsLanguageMenu = JSON.parse(await cdp.eval(PREFS_MENU));
  const prefsLanguagePicked = await cdp.eval(prefsPickLanguage("中文"));
  await sleep(2500);
  const prefsAfterLanguage = JSON.parse(await cdp.eval(PREFS_INVENTORY));
  const prefsWritesLanguage = prefsWritesSince(cdp, prefsMarkLanguage, "locale");
  const prefsWritesLanguageAny = prefsInterfaceWrites(cdp, prefsMarkLanguage);
  const prefsStoredAfterLanguage = await preferencesOf();
  const prefsLocaleRowAfterLanguage = patchRow(await readPatch(), "locale");
  await cdp.screenshot(join(EVIDENCE_DIR, MODE + "-18-preferences-language.png"));
  preferencesEvidence.instantLanguage = { opened: prefsOpenLanguage, menu: prefsLanguageMenu, picked: prefsLanguagePicked, page: prefsAfterLanguage, writes: prefsWritesLanguage, stored: prefsStoredAfterLanguage.language, localeRow: prefsLocaleRowAfterLanguage };
  if (MODE === "overlay") {
    check("the language row's menu offers the instance's language list, and picking one is one instant settings write",
      prefsOpenLanguage === "OPENED English" && prefsLanguageMenu.some((item) => item.label === "中文") && prefsLanguageMenu.filter((item) => item.selected).map((item) => item.label).join("/") === "English" &&
      prefsLanguagePicked === "CLICKED 中文" && prefsWritesLanguage.length === 1 && prefsWritesLanguage[0].args.ns === "locale" && prefsWritesLanguage[0].args.ops[0].value === "zh" && prefsWritesLanguage[0].args.expectedRevision === prefsStoredBeforeLanguage.language.revision,
      JSON.stringify({ opened: prefsOpenLanguage, menu: prefsLanguageMenu, writes: prefsWritesLanguage }));
    check("the chosen language belongs to the instance: the page switches to it, the instance stores it, and the profile's patch file keeps it",
      prefsAfterLanguage.cubes.length === 3 && prefsAfterLanguage.cubes.some((cube) => cube.indexOf("浅色") !== -1) && prefsAfterLanguage.language === "中文" && prefsAfterLanguage.saveButtons.length === 0 &&
      prefsStoredAfterLanguage.language.value.preference === "zh" && prefsStoredAfterLanguage.language.user.preference === "zh" && prefsStoredAfterLanguage.language.revision === prefsStoredBeforeLanguage.language.revision + 1 &&
      prefsStoredAfterLanguage.appearance.revision === prefsStoredBeforeLanguage.appearance.revision &&
      prefsLocaleRowAfterLanguage.indexOf("- id: locale") !== -1 && prefsLocaleRowAfterLanguage.indexOf("@deepseek-ai/dsh-client-locale") !== -1 && prefsLocaleRowAfterLanguage.indexOf("preference: zh") !== -1,
      JSON.stringify({ page: prefsAfterLanguage, stored: prefsStoredAfterLanguage, localeRow: prefsLocaleRowAfterLanguage }));
  } else {
    check("CONTROL: the same language choice changes only the page's own rendering, and the instance keeps its own state",
      prefsLanguagePicked === "CLICKED 中文" && prefsAfterLanguage.cubes.some((cube) => cube.indexOf("浅色") !== -1) && prefsAfterLanguage.language === "中文" && prefsWritesLanguageAny.length === 0 && prefsStoredAfterLanguage.language.revision === prefsStoredBeforeLanguage.language.revision && prefsStoredAfterLanguage.appearance.revision === prefsStoredBeforeLanguage.appearance.revision && prefsLocaleRowAfterLanguage === "",
      JSON.stringify({ picked: prefsLanguagePicked, page: prefsAfterLanguage, writes: prefsWritesLanguageAny, stored: prefsStoredAfterLanguage.language }));
  }

  /* G. A fresh process: the bundle list and every stored value are read from disk again, and a document opened
     on the new instance has to read the same preferences back. */
  const prefsStoredBeforeRestart = await preferencesOf();
  discontinue("instance restart after the instance preferences");
  instance.child.kill("SIGTERM");
  await sleep(3000);
  instance = await startInstance(home, PROFILE);
  preferencesRpc = rpcFor(instance.url);
  const afterPreferencesRestart = new URL(instance.url);
  const preferencesUrlAfterRestart = "http://" + TEST_HOST + ":" + afterPreferencesRestart.port + "/" + afterPreferencesRestart.search;
  evidence.urls.remoteWithInstancePreferencesAfterRestart = preferencesUrlAfterRestart;
  const prefsStoredAfterRestart = await preferencesOf();
  const prefsPatchAfterRestart = await readPatch();
  await navigate(preferencesUrlAfterRestart);
  await openPreferences(cdp, join(EVIDENCE_DIR, MODE + "-19-preferences-after-restart.png"));
  const prefsPageAfterRestart = JSON.parse(await cdp.eval(PREFS_INVENTORY));
  const prefsStoredAfterRestartPage = await preferencesOf();
  /* A restarted instance keeps the stored values but counts revisions from zero again, so this stage compares
     the values (and the profile's patch rows), never the revision numbers across the restart. */
  preferencesEvidence.restart = { before: prefsStoredBeforeRestart, page: prefsPageAfterRestart, stored: prefsStoredAfterRestart, pageRead: prefsStoredAfterRestartPage, themeRow: patchRow(prefsPatchAfterRestart, "ui-theme"), localeRow: patchRow(prefsPatchAfterRestart, "locale") };
  if (MODE === "overlay") {
    check("the instance still holds both preferences its last document saved after a restart - the stored values and the profile's patch rows carry over, while the revision counters start over with the new instance",
      prefsStoredAfterRestart.appearance.value.preference === prefsStoredBeforeRestart.appearance.value.preference && JSON.stringify(prefsStoredAfterRestart.appearance.user) === JSON.stringify(prefsStoredBeforeRestart.appearance.user) &&
      prefsStoredAfterRestart.language.value.preference === "zh" && JSON.stringify(prefsStoredAfterRestart.language.user) === JSON.stringify(prefsStoredBeforeRestart.language.user) &&
      prefsStoredAfterRestart.appearance.revision === 0 && prefsStoredAfterRestart.language.revision === 0 &&
      patchRow(prefsPatchAfterRestart, "ui-theme").indexOf("preference: " + prefsStoredAfterRestart.appearance.value.preference) !== -1 && patchRow(prefsPatchAfterRestart, "locale").indexOf("preference: zh") !== -1,
      JSON.stringify({ stored: prefsStoredAfterRestart, themeRow: patchRow(prefsPatchAfterRestart, "ui-theme"), localeRow: patchRow(prefsPatchAfterRestart, "locale") }));
    check("a document opened after the restart reads both preferences back out of the instance",
      prefsPageAfterRestart.cubes.length === 3 && prefsPageAfterRestart.saveButtons.length === 0 && prefsPageAfterRestart.language === "中文" && prefsPageAfterRestart.pressed === (prefsStoredAfterRestart.appearance.value.preference === "dark" ? "深色" : "浅色") && prefsStoredAfterRestartPage.appearance.revision === prefsStoredAfterRestart.appearance.revision,
      JSON.stringify({ page: prefsPageAfterRestart, stored: prefsStoredAfterRestart.appearance }));
  } else {
    check("CONTROL: the restarted instance still holds no interface preference, and a fresh document starts from the defaults again",
      prefsStoredAfterRestart.appearance.value.preference === "system" && prefsStoredAfterRestart.appearance.revision === 0 && prefsStoredAfterRestart.language.revision === prefsStoredBeforeLanguage.language.revision && prefsPatchAfterRestart.indexOf("- id: ui-theme") === -1 && prefsPatchAfterRestart.indexOf("- id: locale") === -1 && prefsPageAfterRestart.pressed === "System" && prefsPageAfterRestart.language === "English",
      JSON.stringify({ page: prefsPageAfterRestart, stored: prefsStoredAfterRestart, patch: prefsPatchAfterRestart.slice(0, 300) }));
  }
  /* The second access end, read once more on the restarted instance: both ends have to agree on the same value. */
  await cdpSecond.send("Page.navigate", { url: preferencesUrlAfterRestart }).catch(() => {});
  await openPreferences(cdpSecond, undefined);
  const prefsSecondAfterRestart = JSON.parse(await cdpSecond.eval(PREFS_INVENTORY));
  preferencesEvidence.secondEndAfterRestart = prefsSecondAfterRestart;
  check(MODE === "overlay" ? "the second access end reads the restarted instance's own values back, on a document of its own" : "CONTROL: the second access end still reads the defaults from the restarted instance",
    MODE === "overlay"
      ? prefsSecondAfterRestart.language === "中文" && prefsSecondAfterRestart.pressed === prefsPageAfterRestart.pressed && prefsSecondAfterRestart.cubes.length === 3
      : prefsSecondAfterRestart.language === "English" && prefsSecondAfterRestart.pressed === "System",
    JSON.stringify(prefsSecondAfterRestart));
  secondClient.chrome.kill("SIGKILL");

  /* H. The whole stage ran through five documents, four of them rebuilt from scratch, and one instance restart:
     the module layer must still hold exactly one settings provider. */
  const prefsModulesAtEnd = JSON.parse(await cdp.eval(MODULE_PROBE));
  const prefsProvidersAtEnd = loadedProviders(prefsModulesAtEnd);
  const prefsRowsAtEnd = await loadedSettingsRows(profileDir, prefsBundles);
  const prefsPatchAtEnd = await readPatch();
  preferencesEvidence.moduleAtEnd = { modules: prefsModulesAtEnd, providers: prefsProvidersAtEnd, rows: prefsRowsAtEnd, uiSettingsRowsInProfilePatch: prefsPatchAtEnd.split("\n").filter((line) => line.trim() === "- id: ui-settings").length, uiSettingsRowsAnyPrefix: prefsPatchAtEnd.split("- id: ui-settings").length - 1, uiSettingsRowInProfilePatch: patchRow(prefsPatchAtEnd, "ui-settings") };
  check(MODE === "overlay" ? "after every reload, restart and second access end the page still loads exactly one settings provider, and the profile's patch file still holds exactly one ui-settings row" : "CONTROL: after every reload, restart and second access end the page still loads exactly one settings provider, the upstream package",
    prefsProvidersAtEnd.length === 1 && prefsProvidersAtEnd[0] === prefsExpectedProvider && prefsRowsAtEnd.length === 1 && prefsRowsAtEnd[0].provider === prefsExpectedProvider &&
    /* The profile's own patch file carries the override row the run is built on, and it has to stay a single row:
       `- id: ui-settings-general` and its siblings are separate rows, so the count matches row headers exactly.
       The row also has to name the provider this mode is supposed to load - the replacement itself is what changed. */
    preferencesEvidence.moduleAtEnd.uiSettingsRowsInProfilePatch === 1 && preferencesEvidence.moduleAtEnd.uiSettingsRowInProfilePatch.indexOf(prefsExpectedProvider) !== -1,
    JSON.stringify(preferencesEvidence.moduleAtEnd));
  evidence.preferences = preferencesEvidence;
  assertLiveTransport("afterInstancePreferences");
  assertNoStageErrors("afterInstancePreferences", true);

  /* The instance-preference stage above resets its own accounting before it finishes, so nothing disruptive is
     left between the last stage and this point: the final stage tolerates nothing. */
  assertLiveTransport("atEnd");
  assertNoStageErrors("atEnd", false);
  evidence.consoleFullTail = cdp.errors().slice(-8);
  evidence.consoleEventCount = cdp.errors().length;
  evidence.settingsDialogText = await cdp.eval("Array.from(document.querySelectorAll(\"[role=dialog]\")).map((d) => d.innerText).join(\"\\n===\\n\").slice(0, 2500)");

  chrome.kill("SIGKILL");
  instance.child.kill("SIGTERM");
  await sleep(1500);
  /* The hard-link copies of the installation are temporary scaffolding this harness created; they never hold
     anything the run needs afterwards, so they are removed even when the evidence is kept. */
  await rm(COPY_BASE, { recursive: true, force: true });
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

main().catch(async (error) => {
  console.error("HARNESS ERROR:", error);
  console.error(JSON.stringify(evidence, null, 2).slice(0, 2000));
  /* A harness error still leaves the observations behind: without them the failing stage cannot be read. */
  try {
    evidence.harnessError = String(error && error.stack ? error.stack : error);
    await writeFile(join(EVIDENCE_DIR, MODE + "-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.error("partial evidence: " + join(EVIDENCE_DIR, MODE + "-evidence.json"));
  } catch (writeError) { console.error("could not write partial evidence:", writeError.message); }
  process.exit(2);
});
