/**
 * The settings surface an instance really exposes, and the writes a run really made to it.
 *
 * Issue #7 asks for an inventory of every standard setting that is active under the pinned build and
 * configuration - not a handful of representative cases - plus an honest list of what the run did not
 * cover. Both halves need ONE implementation, so this module is that implementation:
 *
 *   - tools/e2e-remote-settings.mjs drives the original page through the probes below and records
 *     what it observed into the evidence file;
 *   - tools/settings-report.mjs renders that record into docs/compatibility-report.md.
 *
 * A report that could describe a surface the acceptance run never checked would be worth nothing, and a
 * second copy of the RPC parser would be a second answer to "was this namespace written?".
 */

/* ---------------------------------------------------------------------------------------------------------
   Transport shape. The page's own RPC reaches the Host as POST /api/<service>/<method> carrying a
   { type: "client-request", rpcId, method, payload: { args } } envelope, so every claim about what the page
   sent is made on that parsed shape and never on a stringified blob.
   --------------------------------------------------------------------------------------------------------- */

export const pathnameOf = (url) => { try { return new URL(url).pathname; } catch (error) { return ""; } };
export const authorityOf = (url) => { try { return new URL(url).host; } catch (error) { return ""; } };

/* One client RPC the browser sent, or null when the request is not one. */
function parseClientRpc(request) {
	if (request === undefined || request === null) return null;
	if (request.method !== "POST") return null;
	if (!/^\/api\/[^/]+\/[^/]+$/.test(pathnameOf(request.url))) return null;
	let body = null;
	try { body = JSON.parse(request.postData); } catch (error) { return null; }
	if (body === null || typeof body !== "object" || typeof body.method !== "string") return null;
	const args = body.payload === undefined ? undefined : body.payload.args;
	/* `url` is the PATHNAME (all the settings routes this repository compares are named by path), and
	   `authority` is the Host header the browser actually used: which END a write came from is the whole
	   point of the 本机/远程 comparison, and it cannot be read off a pathname. */
	return { seq: request.seq, rpcId: body.rpcId === undefined ? null : body.rpcId, method: body.method, args: args, url: pathnameOf(request.url), authority: authorityOf(request.url) };
}

/* Every client RPC the browser sent after a sequence mark. */
export function clientRpcCalls(requests, sinceSeq = 0) {
	return requests
		.filter((request) => request.seq > sinceSeq)
		.map(parseClientRpc)
		.filter((call) => call !== null);
}

/* Every settings write the PAGE itself made after a mark, keyed by namespace. The harness's own Node-side
   calls never appear here, because this reads the browser's network log: a namespace that appears in this
   list was written through the page, which is exactly the claim the compatibility report makes. */
export function settingsMutates(requests, sinceSeq = 0) {
	return clientRpcCalls(requests, sinceSeq)
		.filter((call) => call.method === "settings/mutate" && call.args !== undefined && typeof call.args.ns === "string" && Array.isArray(call.args.ops))
		.map((call) => ({ seq: call.seq, rpcId: call.rpcId, ns: call.args.ns, expectedRevision: call.args.expectedRevision === undefined ? null : call.args.expectedRevision, ops: call.args.ops, url: call.url, authority: call.authority }));
}

/* What the instance says it serves: one row per settings namespace, as settings/describe reports it. */
export function namespaceFacts(describe) {
	if (describe === undefined || describe === null || describe.ok !== true || describe.value === undefined) return [];
	return (describe.value.namespaces || []).map((entry) => ({
		ns: entry.ns,
		applies: entry.applies === undefined ? null : entry.applies,
		revision: entry.revision === undefined ? null : entry.revision,
		value: entry.value,
		user: entry.user,
		secrets: Array.isArray(entry.secrets) ? entry.secrets.length : 0,
	}));
}

export const namespaceOf = (facts, ns) => facts.filter((fact) => fact.ns === ns)[0] || null;
export const namespaceSummary = (facts) => facts.map((fact) => fact.ns + "=" + JSON.stringify(fact.value) + "@" + fact.revision);

/* ---------------------------------------------------------------------------------------------------------
   The surface itself: the rows the pinned build's settings panel renders, the configuration pages the
   deployment ships, and the namespaces this run deliberately does NOT drive. The acceptance run and the
   report generator read the SAME tables from here, so the run cannot check one surface while the report
   prints another - and the run asserts that its own computed not-driven set equals exactly the gap list,
   so a namespace that a later build adds (or one that stops being covered) fails the suite instead of
   quietly leaving the inventory.
   --------------------------------------------------------------------------------------------------------- */

/* Every row of the standard settings panel, with the namespace and the single path the row writes. `coveredBy`
   is a NOTE for the report ("an earlier stage drives this one too"), never a licence to skip it: this stage
   drives every row with a namespace on BOTH origins, and the earlier stages stay as they are. `writes: false` is
   a FINDING: using that row sends no settings call at all, so the value never reaches the instance and the
   report says so instead of implying the setting is stored. */
export const SURFACE_ROWS = [
	{ label: "Permission", kind: "menu", ns: "permission", path: "defaultPreset", coveredBy: null },
	{ label: "Language", kind: "menu", ns: "locale", path: "preference", coveredBy: "实例偏好阶段" },
	{ label: "Appearance", kind: "cubes", ns: "ui-theme", path: "preference", coveredBy: "实例偏好阶段" },
	{ label: "Font size", kind: "stepper", ns: "ui-theme", path: "fontSize", coveredBy: null },
	{ label: "Work details", kind: "menu", ns: "ui-chat", path: "transcriptView", coveredBy: null },
	{ label: "When to Collapse Work Details", kind: "menu", ns: null, coveredBy: null, writes: false, reason: "点它不发任何设置写（两种模式、两个来源都一样）：页面把这个选择留在自己的状态里" },
	{ label: "Show coding view", kind: "switch", ns: "ui-settings", path: "enabled", coveredBy: "开关与重连阶段" },
	{ label: "Keyboard shortcuts", kind: "action", ns: null, coveredBy: null, writes: false, reason: "用它（打开快捷键编辑器）不发任何设置写，实例服务的设置命名空间里也没有快捷键这一类；编辑器内部改键位的行为本轮没有驱动" },
	{ label: "Send behavior while busy", kind: "menu", ns: "ui-conversation", path: "busyEnter", coveredBy: null },
	{ label: "Performance & usage", kind: "menu", ns: "ui-chat", path: "performanceUsage", coveredBy: null },
	{ label: "Upload Session Log when using the official model API", kind: "switch", ns: "session-log-deepseek", path: "enabled", coveredBy: null },
];

/* The deployment's own pages in the plugin manager: they register their configuration forms through the same
   standard slot a third-party bundle uses (issue #5 proves that mechanism with the test bundle). Each page
   writes the namespace schema it is registered for, through the fields it names here - EVERY field its form
   offers, with the ones this run does not drive named in `notDriven` rather than quietly left out. */
export const SURFACE_PLUGIN_PAGES = [
	{ title: "Shell", ns: "bash-sandbox", coveredBy: null, fields: [
		{ label: "timeoutMs", path: "timeoutMs", fieldId: "plugin-config-shell-timeout" },
		{ label: "maxOutputBytes", path: "maxOutputBytes", fieldId: "plugin-config-shell-output" },
	] },
	{ title: "Agent loop", ns: "agent-loop", coveredBy: null, fields: [
		{ label: "maxParallelToolCalls", path: "maxParallelToolCalls", fieldId: "plugin-config-agent-loop-parallel" },
	] },
	{ title: "Subagent", ns: "subagent", coveredBy: null, fields: [
		{ label: "maxActiveSubagents", path: "maxActiveSubagents", fieldId: "plugin-config-subagent-capacity" },
		{ label: "maxDepth", path: "maxDepth", fieldId: "plugin-config-subagent-depth" },
	] },
	/* This page reports three fields. Its credential-source and endpoint fields are inventoried and NOT driven:
	   an acceptance run writes neither a credential source nor an endpoint anywhere, and the report names them
	   instead of borrowing the write of another field. */
	{ title: "Web search", ns: "web-search-deepseek", coveredBy: "插件阶段", fields: [
		{ label: "maxUses", path: "maxUses", fieldId: "plugin-config-web-search-max-uses" },
	], notDriven: [
		{ label: "apiKey", fieldId: "plugin-config-web-search-key" },
		{ label: "endpoint", fieldId: "plugin-config-web-search-endpoint" },
	] },
];

/* One flat list of the fields this run drives, each carrying its page and namespace: the live stage drives it and
   the report renders it, so neither keeps a second copy of the table. */
export const SURFACE_PLUGIN_FIELDS = SURFACE_PLUGIN_PAGES.flatMap((page) => page.fields.map((field) => Object.assign({ page: page.title, ns: page.ns, coveredBy: page.coveredBy }, field)));

/* The Agent presets section, which writes through settings/update (a patch) instead of settings/mutate (ops). */
export const SURFACE_PRESET_NS = "agent-preset-registry";

export const SURFACE_GAPS = [
	{ ns: "agent-default-model", reason: "新会话用哪个模型是在输入框里当场选的；这个构建的设置面板没有任何控件会写这个命名空间" },
	{ ns: "llm-deepseek", reason: "由内置的 DeepSeek provider 卡片承载（设置面板的 Models 页）：卡片里的字段是官方 provider 自己的配置——其中一部分（base URL、模型列表等）并不需要账号登录，另一部分是与账号绑定的密钥。本轮没有驱动其中任何字段，理由**不是**「它们都在账号面之外」，而是 provider 编辑器不在本轮的矩阵范围内（provider 的增删与凭据往返由更早的阶段在非 loopback 来源上驱动核对，见兼容性报告 §2）" },
	{ ns: "llm-deepseek-account", reason: "账号级命名空间，只能经 DeepSeek 登录流程到达；issue #1 把它划在范围外，本轮也不拿真实账号去碰它" },
	{ ns: "ui-settings-account", reason: "账号级（登录账号自己的设置页）；按 issue #1 属于范围外，本轮驱动的页面也从不写它" },
	{ ns: "subagent-model-selection-settings", reason: "Host 提供它，但这个构建在这个配置下没有任何页面为它渲染表单，因此没有可记录的「由页面发起」的写入" },
];

/* The panel's own chrome, as SURFACE_ROWS_PROBE reports it next to the rows: the section navigation, the close
   button, and the inline controls a row renders (the theme options, the stepper's own number). Anything else
   the panel renders is UNRECORDED - which is what makes the inventory two-sided: a build that adds a row this
   table does not know fails the run instead of quietly widening the surface the report describes. */
export const SURFACE_PANEL_CHROME = [/^General\b.*\bModels\b/, /^Close$/, /^Light Dark System$/, /^\d+ px$/, /^\d+$/, /^Loading the provider directory failed\b/, /^Retry$/];

/* Splits what the panel rendered into the recorded rows, the panel's own chrome, and anything unrecorded. A
   row that renders twice is reported too: exactly-once is part of "the panel this report describes". */
export function surfaceRenderedInventory(rendered) {
	const rows = [];
	const chrome = [];
	const unknown = [];
	for (const text of rendered) {
		const match = SURFACE_ROWS.filter((spec) => text.indexOf(spec.label) === 0);
		if (match.length > 0) rows.push({ label: match[0].label, text });
		else if (SURFACE_PANEL_CHROME.some((pattern) => pattern.test(text))) chrome.push(text);
		else unknown.push(text);
	}
	return {
		rows: rows,
		duplicated: rows.map((entry) => entry.label).filter((label, index, all) => all.indexOf(label) !== index),
		chrome: chrome,
		unknown: unknown,
	};
}

/* ---------------------------------------------------------------------------------------------------------
   The shape of one settings write, in ONE place. The live run and the report generator both have to answer
   "did this row really write its namespace?", and a second implementation of that answer would be a second
   answer. These helpers work on either shape the code holds a write in: the parsed call (an ops array or a
   patch) and the record committed to the evidence file (a path and a value).
   --------------------------------------------------------------------------------------------------------- */
export const writePathOf = (write) => {
	if (Array.isArray(write.path)) return write.path;
	if (write.kind === "mutate") return Array.isArray(write.ops) && write.ops.length === 1 ? write.ops[0].path : null;
	if (write.kind === "update") return ["selectedDefault"];
	return null;
};
export const writeValueOf = (write) => {
	if (write.value !== undefined) return write.value;
	if (write.kind === "mutate") return Array.isArray(write.ops) && write.ops.length === 1 ? write.ops[0].value : null;
	if (write.kind === "update") return write.patch === undefined ? null : write.patch.selectedDefault;
	return null;
};
export const writeRecordOf = (write) => ({
	seq: write.seq === undefined ? null : write.seq,
	kind: write.kind,
	ns: write.ns,
	origin: write.origin === undefined ? null : write.origin,
	expectedRevision: write.expectedRevision === undefined ? null : write.expectedRevision,
	path: writePathOf(write),
	value: writeValueOf(write),
});

/* What has to be true of one drive: exactly one call, of the expected kind, on the expected namespace and path,
   through the origin that leg stands for, carrying the revision the page had read, and leaving the Host holding
   what was sent, one revision further along. Findings are named and never thrown, so a caller can say WHICH part
   failed instead of "the evidence looks wrong". */
export function verifySettingsWrite(record, expect) {
	const findings = { record: false, single: false, shape: false, origin: false, revision: false, stored: false, changed: false, moved: false, write: null, others: [], notes: [], problems: [] };
	if (record === undefined || record === null) {
		findings.problems.push("no record of this drive");
		return findings;
	}
	findings.record = true;
	const all = Array.isArray(record.writes) ? record.writes : [];
	/* The drive is about ITS namespace: a click can have an effect of its own elsewhere (switching the coding
	   view on the loopback origin also stores the preset that view starts with), and that is a fact to record,
	   not a failure - the ledger counts every namespace the page wrote, this check counts the row's own. */
	const writes = all.filter((write) => write.ns === expect.ns);
	findings.others = all.filter((write) => write.ns !== expect.ns);
	if (writes.length !== 1) {
		findings.problems.push("expected exactly one settings call on " + expect.ns + ", saw " + JSON.stringify(writes) + (findings.others.length === 0 ? "" : " (plus " + findings.others.length + " on other namespaces)"));
		return findings;
	}
	findings.single = true;
	const write = writes[0];
	if (findings.others.length !== 0) findings.notes.push("the same click also wrote " + JSON.stringify(findings.others.map((entry) => entry.ns)));
	findings.write = write;
	findings.shape = write.kind === expect.kind && write.ns === expect.ns && JSON.stringify(writePathOf(write)) === JSON.stringify(expect.path);
	if (findings.shape === false) findings.problems.push("wrote " + String(write.kind) + " on " + String(write.ns) + " " + JSON.stringify(writePathOf(write)) + ", not " + expect.kind + " on " + expect.ns + " " + JSON.stringify(expect.path));
	findings.origin = write.origin === expect.origin;
	if (findings.origin === false) findings.problems.push("wrote through the " + String(write.origin) + " origin, not " + expect.origin);
	if (record.before === undefined || record.before === null || record.after === undefined || record.after === null) {
		findings.problems.push("no Host reading before or after the click");
		return findings;
	}
	const sent = writeValueOf(write);
	findings.stored = JSON.stringify(record.after.value[expect.path[0]]) === JSON.stringify(sent);
	if (findings.stored === false) findings.problems.push("the Host holds " + JSON.stringify(record.after.value[expect.path[0]]) + ", not what was sent (" + JSON.stringify(sent) + ")");
	findings.changed = JSON.stringify(record.before.value[expect.path[0]]) !== JSON.stringify(sent);
	if (findings.changed === false) findings.problems.push("the value sent is the one the Host already had");
	findings.moved = record.after.revision === record.before.revision + 1;
	if (findings.moved === false) findings.problems.push("the Host moved from revision " + JSON.stringify(record.before.revision) + " to " + JSON.stringify(record.after.revision));
	findings.revision = write.kind === "mutate" ? write.expectedRevision === record.before.revision : true;
	if (findings.revision === false) findings.problems.push("wrote with expectedRevision " + JSON.stringify(write.expectedRevision) + " while the Host was at revision " + JSON.stringify(record.before.revision));
	return findings;
}

/* ---------------------------------------------------------------------------------------------------------
   The original settings panel, read and driven through its own DOM.
   Every expression below is evaluated in the page and uses double-quoted JS strings and unquoted CSS
   identifiers only, exactly like the rest of this repository's page-side code. The panel is the LAST visible
   dialog (the first-run notice is a dialog of its own), and a row is the SMALLEST visible block that starts
   with the row's own label and holds a control - the page renders its copy inside that block.
   --------------------------------------------------------------------------------------------------------- */

const SURFACE_HELPERS = [
	"var vis = function (e) { return !!e && e.offsetParent !== null; };",
	"var txt = function (e) { return (e.innerText || e.textContent || \"\").replace(/\\s+/g, \" \").trim(); };",
	"var panel = function () { var d = Array.prototype.slice.call(document.querySelectorAll(\"[role=dialog]\")).filter(vis); return d.length === 0 ? null : d[d.length - 1]; };",
	"var rowOf = function (label) { var p = panel(); if (p === null) return null; var c = Array.prototype.slice.call(p.querySelectorAll(\"div\")).filter(vis).filter(function (d) { return txt(d).indexOf(label) === 0 && d.querySelector(\"button,[role=switch]\") !== null; }); c.sort(function (a, b) { return txt(a).length - txt(b).length; }); return c.length === 0 ? null : c[0]; };",
	"var buttonIn = function (label, aria) { var r = rowOf(label); if (r === null) return null; var b = Array.prototype.slice.call(r.querySelectorAll(\"button\")).filter(vis); if (aria !== undefined) return b.filter(function (x) { return x.getAttribute(\"aria-label\") === aria; })[0] || null; return b.length === 0 ? null : b[b.length - 1]; };",
	"var switchIn = function (label) { var r = rowOf(label); return r === null ? null : r.querySelector(\"[role=switch]\"); };",
	"var menuOptions = function () { return Array.prototype.slice.call(document.querySelectorAll(\"[role=menuitem],[role=option]\")).filter(vis); };",
].join(" ");

/* How many row blocks the panel renders for one label: the candidates are the divs whose text starts with the
   label and which own a control, and a candidate that CONTAINS another candidate is that row read again at a
   wider scope, so only the INNERMOST ones count (a candidate with no candidate inside it). Two sibling blocks
   with the same copy are two blocks - which is how "the panel renders this row exactly once" is measurable. */
export const surfaceRowCountExpression = (label) => "(function () { " + SURFACE_HELPERS + " var p = panel(); if (p === null) return -1; var c = Array.prototype.slice.call(p.querySelectorAll(\"div\")).filter(vis).filter(function (d) { return txt(d).indexOf(" + JSON.stringify(label) + ") === 0 && d.querySelector(\"button,[role=switch]\") !== null; }); var blocks = c.filter(function (d) { return c.every(function (o) { return o === d || !d.contains(o); }); }); return blocks.length; })()";

/* Every row the settings panel renders: the smallest labelled block that owns a control. */
export const SURFACE_ROWS_PROBE = "(function () { " + SURFACE_HELPERS + " var p = panel(); if (p === null) return \"closed\"; var out = Array.prototype.slice.call(p.querySelectorAll(\"div\")).filter(vis).filter(function (d) { return d.querySelector(\"button,[role=switch]\") !== null; }).map(function (d) { return txt(d); }).filter(function (t) { return t.length < 160; }); var seen = {}; return JSON.stringify(out.filter(function (t) { if (seen[t]) return false; seen[t] = true; return true; })); })()";

/* Two ways to see that pressing a control DID something: how many dialogs are visible, and the copy the last
   visible one renders. A negative claim ("using this control writes nothing") is only worth reading next to a
   measurement that the interaction itself happened, so both are read around the click. */

/* Whether the interaction recorded for a row the page keeps to itself really happened - RECOMPUTED from the
   measured fields, never read off the flag the run derived from them, so the report checks the premise instead of
   trusting its own conclusion. `expectedOffered` is what the rendered inventory says about that leg (true/false,
   or null when the caller has no independent source); it is cross-checked so an "unoffered" record cannot hide a
   row the panel does render. Returns the interaction the measurements support, and why they do not support it. */
export const verifyNoWriteInteraction = (record, expectedOffered) => {
	const problems = [];
	const offered = record.offered === true;
	if (expectedOffered === true || expectedOffered === false) {
		if (offered !== expectedOffered) problems.push("recorded as " + (offered ? "offered" : "not offered") + ", but the rendered inventory says " + (expectedOffered ? "it is rendered" : "it is not rendered"));
	}
	let interaction = "not-effective";
	if (offered === false) {
		interaction = "row-not-offered";
		if (record.action !== "NO-ROW") problems.push("recorded as not offered, but the run recorded the interaction " + JSON.stringify(record.action));
		if (JSON.stringify(record.effectBefore) !== JSON.stringify(record.effectAfter)) problems.push("recorded as not offered, but the page changed around the click anyway");
	} else if (record.kind === "action") {
		const before = record.effectBefore || {};
		const after = record.effectAfter || {};
		const changed = after.dialogs > before.dialogs || after.panel !== before.panel || after.docLength !== before.docLength || after.docTail !== before.docTail;
		if (record.action === "PRESSED" && changed) interaction = "clicked";
		else problems.push("the button was not shown to have done anything: the run recorded " + JSON.stringify(record.action) + " and the page " + (changed ? "did change" : "did not change"));
	} else {
		const detail = record.detail || {};
		const options = Array.isArray(detail.options) ? detail.options : [];
		const moved = record.rowTextAfter !== record.rowTextBefore;
		if (record.action === "OPENED" && options.length > 0 && detail.action === "PICKED" && moved) interaction = "clicked";
		else problems.push("the menu was not shown to have done anything: the run recorded " + JSON.stringify(record.action) + ", " + options.length + " option(s), picking " + JSON.stringify(detail.action) + ", and the row copy " + (moved ? "moved" : "did not move"));
	}
	/* The run stores the flag after the measurements; the checker recomputes it from those measurements and
	   compares only when a flag is there to compare with. */
	if (Object.prototype.hasOwnProperty.call(record, "interaction") && record.interaction !== interaction) problems.push("the record says the interaction was " + JSON.stringify(record.interaction) + ", but the measured fields say " + JSON.stringify(interaction));
	return { interaction: interaction, ok: problems.length === 0 && interaction !== "not-effective", problems: problems };
};
export const SURFACE_EFFECT_PROBE = "(function () { " + SURFACE_HELPERS + " var d = Array.prototype.slice.call(document.querySelectorAll(\"[role=dialog]\")).filter(vis); var doc = (document.body.innerText || document.body.textContent || \"\").replace(/\\s+/g, \" \").trim(); return JSON.stringify({ dialogs: d.length, panel: d.length === 0 ? \"\" : txt(d[d.length - 1]).slice(0, 240), docLength: doc.length, docTail: doc.slice(-120) }); })()";

/* The row's own words, so a drive can name the option it has to move away from. */
export const surfaceRowTextExpression = (label) => "(function () { " + SURFACE_HELPERS + " var r = rowOf(" + JSON.stringify(label) + "); return r === null ? \"NO-ROW\" : txt(r).slice(0, 200); })()";

/* Opens the row's control (the page's menu rows open a menu, its switches flip, its steppers step). */
export const surfaceOpenExpression = (label) => "(function () { " + SURFACE_HELPERS + " var b = buttonIn(" + JSON.stringify(label) + "); if (b === null) return \"NO-ROW\"; b.click(); return \"OPENED\"; })()";
export const surfaceAriaPressExpression = (label, aria) => "(function () { " + SURFACE_HELPERS + " var b = buttonIn(" + JSON.stringify(label) + ", " + JSON.stringify(aria) + "); if (b === null) return \"NO-BUTTON\"; b.click(); return \"PRESSED\"; })()";
export const surfaceSwitchExpression = (label) => "(function () { " + SURFACE_HELPERS + " var s = switchIn(" + JSON.stringify(label) + "); if (s === null) return \"NO-SWITCH\"; var was = s.getAttribute(\"aria-checked\"); s.click(); return \"CLICKED-\" + was; })()";
export const SURFACE_MENU_PROBE = "(function () { " + SURFACE_HELPERS + " return JSON.stringify(menuOptions().map(function (e) { return txt(e).slice(0, 40); })); })()";
export const surfacePickExpression = (option) => "(function () { " + SURFACE_HELPERS + " var hit = menuOptions().filter(function (e) { return txt(e) === " + JSON.stringify(option) + "; })[0]; if (!hit) return \"NO-OPTION\"; hit.click(); return \"PICKED\"; })()";
/* The rows whose control is a set of pressed cubes (the appearance row): clicking the first cube that is not
   already pressed is what a person does, and the row's own text then names the cube that was chosen. */
export const surfaceCubeExpression = (label) => "(function () { " + SURFACE_HELPERS + " var r = rowOf(" + JSON.stringify(label) + "); if (r === null) return \"NO-ROW\"; var cubes = Array.prototype.slice.call(r.querySelectorAll(\"button\")).filter(vis).filter(function (b) { return b.hasAttribute(\"aria-pressed\"); }); var hit = cubes.filter(function (b) { return b.getAttribute(\"aria-pressed\") !== \"true\"; })[0]; if (!hit) return cubes.length === 0 ? \"NO-CUBE\" : \"NO-OTHER-CUBE\"; hit.click(); return \"CLICKED \" + txt(hit); })()";

/* Which cube a row holds pressed, read back by its own text: the row's whole text always names all three, so
   the pressed one is the only honest reading of "where this row stands". */
export const surfaceCubeStateExpression = (label) => "(function () { " + SURFACE_HELPERS + " var r = rowOf(" + JSON.stringify(label) + "); if (r === null) return \"NO-ROW\"; var cubes = Array.prototype.slice.call(r.querySelectorAll(\"button\")).filter(vis).filter(function (b) { return b.hasAttribute(\"aria-pressed\"); }); var pressed = cubes.filter(function (b) { return b.getAttribute(\"aria-pressed\") === \"true\"; })[0]; if (pressed) return txt(pressed); return cubes.length === 0 ? \"NO-CUBE\" : \"NO-PRESSED-CUBE\"; })()";

/* The switch a row owns, read back by its own aria state. */
export const surfaceSwitchStateExpression = (label) => "(function () { " + SURFACE_HELPERS + " var s = switchIn(" + JSON.stringify(label) + "); return s === null ? \"NO-SWITCH\" : String(s.getAttribute(\"aria-checked\")); })()";

/* The page's other write: settings/update patches a namespace instead of applying ops (the Agent presets
   section sets the new-task default that way). A coverage claim that only watched settings/mutate would
   miss it, so both are collected here and both count as "this namespace was written through the page". */
function settingsUpdates(requests, sinceSeq = 0) {
	return clientRpcCalls(requests, sinceSeq)
		.filter((call) => call.method === "settings/update" && call.args !== undefined && typeof call.args.ns === "string")
		.map((call) => ({ seq: call.seq, rpcId: call.rpcId, kind: "update", ns: call.args.ns, patch: call.args.patch, ops: null, expectedRevision: call.args.expectedRevision === undefined ? null : call.args.expectedRevision, url: call.url, authority: call.authority }));
}

/* Every settings write the page itself made after a mark, of either kind, in the order they left the page. */
export function pageSettingsWrites(requests, sinceSeq = 0) {
	const mutates = settingsMutates(requests, sinceSeq).map((write) => ({ ...write, kind: "mutate", patch: null }));
	return [...mutates, ...settingsUpdates(requests, sinceSeq)].sort((left, right) => left.seq - right.seq);
}

/* The namespaces those writes named, in order. */
export const writtenNamespaces = (writes) => [...new Set(writes.map((write) => write.ns))];

/* A visible button in the settings panel whose own text is exactly this string - the row controls the page
   renders show their CURRENT value, which is how a document can be normalised to one language without
   knowing the label that language gives the row. */
export const surfaceExactClickExpression = (text) => "(function () { " + SURFACE_HELPERS + " var p = panel(); if (p === null) return \"no-panel\"; var hit = Array.prototype.slice.call(p.querySelectorAll(\"button\")).filter(vis).filter(function (b) { return txt(b) === " + JSON.stringify(text) + "; })[0]; if (!hit) return \"no-control\"; hit.click(); return \"clicked\"; })()";

/* Is the panel rendering its English copy? Read off the panel's own section navigation, which is the one
   string this stage has to be sure about before it addresses rows by their English labels. */
export const SURFACE_PANEL_ENGLISH_PROBE = "(function () { " + SURFACE_HELPERS + " var p = panel(); if (p === null) return \"no-panel\"; return Array.prototype.slice.call(p.querySelectorAll(\"button\")).filter(vis).some(function (b) { return txt(b) === \"General\"; }) ? \"english\" : \"other\"; })()";
