#!/usr/bin/env node
/* Renders the full settings-surface matrix of issue #7 out of the evidence the acceptance run writes, into the
   marker delimited block of docs/compatibility-report.md. The generator reads the SAME tables the run drives
   (tools/lib/settings-surface.mjs) and the SAME per-leg record shape, and it fails CLOSED: a missing drive, a
   write that did not move the instance, a run with a failing check or a harness error, a namespace set that is
   not exactly the committed gap list - each of those prints what is wrong and exits 1 instead of rendering a
   report that says more than the run measured. Nothing here talks to a live instance. */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACE_GAPS, SURFACE_PLUGIN_FIELDS, SURFACE_PLUGIN_PAGES, SURFACE_PRESET_NS, SURFACE_ROWS, verifySettingsWrite, writePathOf, writeValueOf } from "./lib/settings-surface.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const BEGIN = "<!-- settings-surface:begin -->";
const END = "<!-- settings-surface:end -->";
const PRESET_ROW = "Agent presets: the new-task default";

const problems = [];
const notes = [];
const complain = (message) => { problems.push(message); };
const note = (message) => { notes.push(message); };

const argv = process.argv.slice(2);
const evidenceDir = (() => {
	const index = argv.indexOf("--evidence");
	return index === -1 ? join(REPO, "evidence") : resolve(argv[index + 1]);
})();
const shouldWrite = argv.includes("--write");

/* ---------------------------------------------------------------------------------------------------------
   Loading the two evidence files. A run that did not finish cleanly cannot support a matrix, so a failing
   check or a harness error is a hard stop: this generator never averages a red run into a green table.
   --------------------------------------------------------------------------------------------------------- */
const load = async (mode) => {
	let raw = null;
	try {
		raw = await readFile(join(evidenceDir, mode + "-evidence.json"), "utf8");
	} catch (error) {
		complain("missing evidence file " + mode + "-evidence.json in " + evidenceDir + " (" + String(error.code) + ")");
		return null;
	}
	const parsed = JSON.parse(raw);
	if (parsed.harnessError !== undefined && parsed.harnessError !== null) complain("the " + mode + " evidence carries a harnessError: " + JSON.stringify(parsed.harnessError).slice(0, 300));
	const failed = (parsed.checks || []).filter((entry) => entry.ok !== true);
	for (const entry of failed.slice(0, 5)) complain("the " + mode + " run has a failing check: " + entry.name);
	if (failed.length > 5) complain("the " + mode + " run has " + failed.length + " failing checks in all");
	const surface = parsed.settingsSurface;
	if (surface === undefined) {
		complain("the " + mode + " evidence carries no settingsSurface section: it was written before the settings-surface stage existed, so there is nothing to render");
		return null;
	}
	return { mode: mode, evidence: parsed, surface: surface };
};

const drivesOf = (surface, leg) => {
	const keyed = new Map();
	for (const drive of (surface.drives || {})[leg] || []) keyed.set(drive.row, drive);
	return keyed;
};
const noWritesOf = (surface, leg) => {
	const keyed = new Map();
	for (const record of surface.noWriteRows || []) if (record.leg === leg) keyed.set(record.row, record);
	return keyed;
};

/* The write a drive is ABOUT: the one on its own namespace. A click can have an effect elsewhere as well (the
   coding-view switch also stores the preset that view starts with), and that is recorded separately instead of
   being shown as the row's write. */
const writeOf = (drive, ns) => {
	if (drive === undefined || Array.isArray(drive.writes) === false) return null;
	const mine = drive.writes.filter((write) => ns === undefined || write.ns === ns);
	return mine.length === 1 ? mine[0] : null;
};
const valueOf = writeValueOf;
const pathOf = writePathOf;
const whereOf = (write) => "`" + write.ns + "." + pathOf(write).join(".") + "`";
/* The extra namespaces one click moved, said once in the report's own words. */
const noteOthers = (mode, leg, label, verdict) => {
	if (verdict.others.length === 0) return;
	const clean = String(label).replace(/^the /, "").replace(/ row$/, "");
	note(mode + "/" + leg + "：" + clean + " 这一行按下时另外还写动了 " + verdict.others.map((write) => "`" + write.ns + "`").join("、") + "（该行只记它自己那一笔，台账把两个命名空间都算上了）");
};

/* ---------------------------------------------------------------------------------------------------------
   One validator per shape of write, used for BOTH modes and BOTH legs. It checks the instance, not just the
   traffic: exactly one write, from the origin that leg stands for, on the recorded namespace and path, with the
   revision the page had read, leaving the Host holding what was sent and one revision further along.
   --------------------------------------------------------------------------------------------------------- */
/* The write's shape is the SHARED validator's business (tools/lib/settings-surface.mjs): the live run checks the
   same thing with the same code, so the report cannot drift from what the run measured. */
const verifyInstanceWrite = (mode, leg, origin, label, expect, drive) => {
	const verdict = verifySettingsWrite(drive, Object.assign({ origin: origin }, expect));
	for (const problem of verdict.problems) complain(mode + "/" + leg + ": " + label + "：" + problem);
	noteOthers(mode, leg, label, verdict);
};

const verifyNoWrite = (mode, leg, row, record) => {
	if (record === undefined) {
		complain(mode + "/" + leg + ": no record for the non-instance row " + row.label);
		return;
	}
	/* "It writes nothing" is only worth reading when the control was actually used: a row whose selector stopped
	   matching would produce the same empty write list, so the interaction is checked first on the legs where the
	   row is offered, and the leg where it is not offered has to say exactly that. */
	if (record.offered === false) {
		if (record.interaction !== "row-not-offered") complain(mode + "/" + leg + ": the " + row.label + " row is recorded as not offered, but the evidence does not say so (" + JSON.stringify(record.interaction) + ", action " + JSON.stringify(record.action) + ")");
	} else if (record.interaction !== "clicked") complain(mode + "/" + leg + ": the " + row.label + " row is recorded as not an instance setting, but using it did not visibly work (" + JSON.stringify(record.interaction) + ", action " + JSON.stringify(record.action) + ") - a control that is no longer found would read the same way");
	if ((record.writes || []).length !== 0) complain(mode + "/" + leg + ": the " + row.label + " row wrote " + JSON.stringify(record.writes) + " although it is recorded as not an instance setting");
	if (record.instanceUnchanged !== true) complain(mode + "/" + leg + ": the " + row.label + " row left the instance changed");
};

/* The preset section writes through settings/update: same shape as a mutate, different accessor for the value. */
const verifyPreset = (mode, leg, origin, drive) => {
	const verdict = verifySettingsWrite(drive, { kind: "update", ns: SURFACE_PRESET_NS, path: ["selectedDefault"], origin: origin });
	for (const problem of verdict.problems) complain(mode + "/" + leg + ": the Agent presets default：" + problem);
	noteOthers(mode, leg, "Agent presets 的默认预设", verdict);
};

/* A leg on which the page must NOT reach the instance: nothing may be written and the Host may not move. The row
   still has to have been driven - a missing record would make "nothing happened" vacuous. */
const verifyPageOnlyLeg = (mode, leg, label, drive) => {
	if (drive === undefined) {
		complain(mode + "/" + leg + ": no record for " + label);
		return;
	}
	if ((drive.writes || []).length !== 0) complain(mode + "/" + leg + ": " + label + " wrote " + JSON.stringify(drive.writes) + " on an origin that must not write");
	if (drive.before !== null && drive.after !== null && JSON.stringify(drive.after) !== JSON.stringify(drive.before)) complain(mode + "/" + leg + ": " + label + " moved the instance on an origin that must not write: " + JSON.stringify({ before: drive.before, after: drive.after }));
};

/* The instance was restarted at the end of the stage. If a value the page wrote did not survive it, the report
   would be describing a page that only appeared to store settings - so the restart read-back is checked here and
   not only inside the run. */
const verifyRestart = (mode, surface) => {
	const restart = surface.restart;
	if (restart === undefined || restart.before === undefined || restart.after === undefined) {
		complain(mode + ": the evidence carries no restart read-back, so whether the stored values survive a restart would be an assumption");
		return;
	}
	const namespaces = Object.keys(restart.before);
	if (namespaces.length === 0) complain(mode + ": the restart read-back covers no namespace at all");
	for (const ns of namespaces) if (JSON.stringify(restart.after[ns]) !== JSON.stringify(restart.before[ns])) complain(mode + ": " + ns + " came back different after the instance restart: " + JSON.stringify({ before: restart.before[ns], after: restart.after[ns] }));
};

const overlay = await load("overlay");
const control = await load("control");
for (const loaded of [overlay, control]) if (loaded !== null) verifyRestart(loaded.mode, loaded.surface);
/* The matrix is a two-sided claim - every cell is a comparison between the replacement and the original - so a
   report with one side missing would have to print "unknown" in half of its columns. Refused, not half-rendered. */
if (overlay === null || control === null) {
	console.error("the report needs BOTH evidence files (overlay and control): run both modes of tools/e2e-remote-settings.mjs first");
	for (const problem of problems) console.error("  - " + problem);
	process.exit(1);
}

/* Every row that writes something, including the ones an earlier stage also drives: this stage measures them
   itself, per leg, so the matrix has no cell that is filled in by assumption. */
const drivenRows = SURFACE_ROWS.filter((row) => row.writes !== false);
const noWriteRowSpecs = SURFACE_ROWS.filter((row) => row.writes === false);
/* Every field this run drives, flattened: the matrix carries one row per FIELD, because "the Shell page is
   covered" is not an answer to "which settings of that page were actually written through it". */
const liveFields = SURFACE_PLUGIN_FIELDS;
const liveFieldNamespaces = Array.from(new Set(liveFields.map((field) => field.ns)));
const fieldDrivesOf = (surface, leg) => (surface.pluginFields || []).filter((entry) => entry.leg === leg);
const fieldDriveOf = (surface, field, leg) => fieldDrivesOf(surface, leg).filter((entry) => entry.fieldId === field.fieldId)[0];
const fieldLabelOf = (field) => "`" + field.page + "` 页的 `" + field.label + "` 字段";

/* ---------------------------------------------------------------------------------------------------------
   Overlay: this run has to reach the instance from BOTH origins, and its ledger has to agree with the drives.
   --------------------------------------------------------------------------------------------------------- */
if (overlay !== null) {
	for (const leg of ["remote", "loopback"]) {
		const drives = drivesOf(overlay.surface, leg);
		for (const row of drivenRows) verifyInstanceWrite("overlay", leg, leg, "the " + row.label + " row", { kind: "mutate", ns: row.ns, path: [row.path] }, drives.get(row.label));
		verifyPreset("overlay", leg, leg, drives.get(PRESET_ROW));
		for (const field of liveFields) verifyInstanceWrite("overlay", leg, leg, fieldLabelOf(field), { kind: "mutate", ns: field.ns, path: [field.path] }, fieldDriveOf(overlay.surface, field, leg));
		for (const row of noWriteRowSpecs) verifyNoWrite("overlay", leg, row, noWritesOf(overlay.surface, leg).get(row.label));
	}

	const coverage = overlay.surface.coverage || {};
	const notWritten = (coverage.notWritten || []).slice().sort();
	const gaps = SURFACE_GAPS.map((gap) => gap.ns).slice().sort();
	if (JSON.stringify(notWritten) !== JSON.stringify(gaps)) complain("overlay: the namespaces this run did not write (" + JSON.stringify(notWritten) + ") are not exactly the committed gap list (" + JSON.stringify(gaps) + ")");
	for (const gap of SURFACE_GAPS) if (typeof gap.reason !== "string" || gap.reason.length === 0) complain("the gap " + gap.ns + " carries no reason");
	const served = coverage.served || [];
	for (const row of SURFACE_ROWS) if (row.ns !== null && served.indexOf(row.ns) === -1) complain("overlay: the row " + row.label + " names " + row.ns + ", which the instance does not serve at all");

	/* The ledger is what the covered rows are rendered from, so it has to carry every namespace this stage drove
	   on BOTH legs - the drive records and the ledger are two independent readings of the same run. */
	const fromRemote = coverage.writtenFromRemote || [];
	const fromLoopback = coverage.writtenFromLoopback || [];
	const mustReachBothEnds = drivenRows.map((row) => row.label + " -> " + row.ns).concat([PRESET_ROW + " -> " + SURFACE_PRESET_NS]).concat(liveFields.map((field) => fieldLabelOf(field) + " -> " + field.ns));
	const bothEnds = drivenRows.map((row) => row.ns).concat([SURFACE_PRESET_NS]).concat(liveFields.map((field) => field.ns));
	for (let index = 0; index < bothEnds.length; index += 1) {
		if (fromRemote.indexOf(bothEnds[index]) === -1) complain("overlay: the ledger does not list " + bothEnds[index] + " among the namespaces written from the remote origin (" + mustReachBothEnds[index] + ")");
		if (fromLoopback.indexOf(bothEnds[index]) === -1) complain("overlay: the ledger does not list " + bothEnds[index] + " among the namespaces written from the loopback origin (" + mustReachBothEnds[index] + ")");
	}

	/* The panel inventory, in both directions: every recorded row rendered exactly once, and nothing rendered
	   that the inventory does not know. */
	const inventory = overlay.surface.renderedInventory || {};
	const inventoryRows = inventory.rows || [];
	if (inventoryRows.length === 0) complain("overlay: the evidence carries no rendered-row inventory");
	if ((inventory.duplicated || []).length !== 0) complain("overlay: the panel rendered the same row more than once: " + JSON.stringify(inventory.duplicated));
	if ((inventory.unknown || []).length !== 0) complain("overlay: the panel rendered entries this inventory does not know: " + JSON.stringify(inventory.unknown));
	const missingRows = SURFACE_ROWS.filter((row) => inventoryRows.every((entry) => entry.label !== row.label)).map((row) => row.label);
	if (missingRows.length !== 0) complain("overlay: the panel did not render " + JSON.stringify(missingRows));
	const listedPages = overlay.surface.pluginPagesListed || [];
	for (const page of SURFACE_PLUGIN_PAGES) if (listedPages.some((text) => String(text).indexOf(page.title) !== -1) === false) complain("overlay: the plugin manager did not list the " + page.title + " page");
	const loopbackListing = overlay.surface.pluginPagesListingLoopback;
	if (loopbackListing === undefined) complain("overlay: no record of the plugin manager list on the loopback origin");
	else {
		for (const page of SURFACE_PLUGIN_PAGES) if (String(loopbackListing.navigated) !== "clicked" && (loopbackListing.listed || []).length === 0) complain("overlay: the plugin manager on the loopback origin was never opened");
	}
}

/* ---------------------------------------------------------------------------------------------------------
   Control: the mirror image. Nothing may reach the instance from the non-loopback origin, and everything the
   inventory drives has to reach it from the loopback origin (that is what makes the loopback leg a
   non-regression comparison rather than a second experiment).
   --------------------------------------------------------------------------------------------------------- */
if (control !== null) {
	const remoteDrives = drivesOf(control.surface, "remote");
	const loopbackDrives = drivesOf(control.surface, "loopback");
	for (const row of drivenRows) verifyPageOnlyLeg("control", "remote", "the " + row.label + " row", remoteDrives.get(row.label));
	/* The preset default is the ONE setting the original composition's non-loopback page does write, through
	   settings/update rather than through the settings provider - so on that leg the expectation is the same as the
	   overlay's, and the control run is what proves the replacement did not change it. */
	verifyInstanceWrite("control", "remote", "remote", "the Agent presets default", { kind: "update", ns: SURFACE_PRESET_NS, path: ["selectedDefault"] }, remoteDrives.get(PRESET_ROW));
	for (const row of drivenRows) verifyInstanceWrite("control", "loopback", "loopback", "the " + row.label + " row", { kind: "mutate", ns: row.ns, path: [row.path] }, loopbackDrives.get(row.label));
	verifyPreset("control", "loopback", "loopback", loopbackDrives.get(PRESET_ROW));
	for (const field of liveFields) verifyInstanceWrite("control", "loopback", "loopback", fieldLabelOf(field), { kind: "mutate", ns: field.ns, path: [field.path] }, fieldDriveOf(control.surface, field, "loopback"));
	for (const leg of ["remote", "loopback"]) for (const row of noWriteRowSpecs) verifyNoWrite("control", leg, row, noWritesOf(control.surface, leg).get(row.label));

	const pluginPages = control.surface.pluginPagesControl;
	if (pluginPages === undefined) complain("control: no record of the plugin manager list");
	else {
		if ((pluginPages.offered || []).length !== 0) complain("control: the original composition offered " + JSON.stringify(pluginPages.offered) + " on the non-loopback origin");
		if ((pluginPages.opens || []).some((entry) => entry.opened !== "no-card")) complain("control: a deployment page could be opened on the non-loopback origin: " + JSON.stringify(pluginPages.opens));
	}
	const controlLoopbackListing = control.surface.pluginPagesListingLoopback;
	if (controlLoopbackListing === undefined) complain("control: no record of the plugin manager list on the loopback origin");
	else {
		const unlisted = SURFACE_PLUGIN_PAGES.map((page) => page.title).filter((title) => (controlLoopbackListing.listed || []).some((text) => String(text).indexOf(title) !== -1) === false);
		if (unlisted.length !== 0) complain("control: the loopback plugin manager did not list " + JSON.stringify(unlisted));
	}

	const coverage = control.surface.coverage || {};
	const controlRemote = (coverage.writtenFromRemote || []).slice().sort();
	if (JSON.stringify(controlRemote) !== JSON.stringify([SURFACE_PRESET_NS])) complain("control: the namespaces written from the non-loopback origin are not exactly the Agent presets default (the one the original composition writes from there): " + JSON.stringify(controlRemote));
	const fromLoopback = coverage.writtenFromLoopback || [];
	for (const ns of drivenRows.map((row) => row.ns).concat([SURFACE_PRESET_NS]).concat(liveFieldNamespaces)) if (fromLoopback.indexOf(ns) === -1) complain("control: the ledger does not list " + ns + " among the namespaces written from the loopback origin");
	const inventory = control.surface.renderedInventory || {};
	if ((inventory.unknown || []).length !== 0) complain("control: the panel rendered entries this inventory does not know: " + JSON.stringify(inventory.unknown));
	if ((control.surface.rowsOfferedRemote || []).length === 0) complain("control: the remote page rendered none of the recorded rows, so the subset the report prints has no measurement behind it");
}

/* ---------------------------------------------------------------------------------------------------------
   The non-regression comparison: the LOOPBACK origin is where the original composition already stores settings
   on the instance, so the replacement has no business changing it. Both modes drove that leg and the two legs
   have to agree item by item - namespace, shape and path (the VALUE may differ, each run starts from its own
   temporary profile).
   --------------------------------------------------------------------------------------------------------- */
if (overlay !== null && control !== null) {
	const overlayLoop = drivesOf(overlay.surface, "loopback");
	const controlLoop = drivesOf(control.surface, "loopback");
	for (const row of drivenRows.concat([{ label: PRESET_ROW, ns: SURFACE_PRESET_NS, path: null }])) {
		const left = writeOf(overlayLoop.get(row.label), row.ns);
		const right = writeOf(controlLoop.get(row.label), row.ns);
		if (left === null || right === null) {
			complain("the loopback leg of " + row.label + " is missing in one of the two modes (overlay " + JSON.stringify(left) + ", control " + JSON.stringify(right) + ")");
			continue;
		}
		if (left.ns !== right.ns || left.kind !== right.kind || JSON.stringify(left.path) !== JSON.stringify(right.path)) complain("the loopback leg differs between the two modes on " + row.label + ": overlay " + JSON.stringify(left) + " vs control " + JSON.stringify(right));
	}
	for (const field of liveFields) {
		const left = writeOf(fieldDriveOf(overlay.surface, field, "loopback"), field.ns);
		const right = writeOf(fieldDriveOf(control.surface, field, "loopback"), field.ns);
		if (left === null || right === null) complain("the loopback leg of " + fieldLabelOf(field) + " is missing in one of the two modes");
		else if (left.ns !== right.ns || left.kind !== right.kind || JSON.stringify(left.path) !== JSON.stringify(right.path)) complain("the loopback leg differs between the two modes on " + fieldLabelOf(field) + + " page: overlay " + JSON.stringify(left) + " vs control " + JSON.stringify(right));
	}
	const overlayOffered = overlay.surface.rowsOfferedRemote || [];
	const controlOffered = control.surface.rowsOfferedRemote || [];
	const notOfferedInControl = overlayOffered.filter((label) => controlOffered.indexOf(label) === -1);
	if (notOfferedInControl.length === 0) complain("the two modes rendered the same rows on the non-loopback origin, so the report would claim a difference the evidence does not show");
}

if (problems.length > 0) {
	console.error("the evidence does not support the report:");
	for (const problem of problems) console.error("  - " + problem);
	process.exit(1);
}

/* ---------------------------------------------------------------------------------------------------------
   Rendering. Every cell comes from the record of one click on one origin; nothing is copied between legs.
   --------------------------------------------------------------------------------------------------------- */
const table = (header, body) => {
	const lines = ["| " + header.join(" | ") + " |", "| " + header.map(() => "---").join(" | ") + " |"];
	for (const row of body) {
		lines.push("| " + row.map((value) => {
			const text = value === undefined || value === null || value === "" ? "-" : String(value);
			return text.split("|").join("\\|");
		}).join(" | ") + " |");
	}
	return lines.join("\n");
};
const counts = (loaded) => ((loaded.evidence.checks || []).length) + " 项检查全部通过（失败 0 项）";
const revisionOf = (drive) => drive.before === null || drive.after === null ? "revision 未知" : "revision " + drive.before.revision + "→" + drive.after.revision;
const writeCell = (drive, ns) => {
	const write = writeOf(drive, ns);
	return write === null ? "证据异常（没有该命名空间上的写入）：" + JSON.stringify(drive.writes) : write.kind + "(" + whereOf(write) + " = " + JSON.stringify(valueOf(write)) + "，" + revisionOf(drive) + ")";
};
const drivenCell = (loaded, leg, row) => {
	if (loaded === null) return "缺证据";
	const drive = drivesOf(loaded.surface, leg).get(row.label);
	if (drive === undefined) return "未驱动（证据里没有这一行）";
	if (drive.writes.length === 0) return drive.offered === false
		? "原组合的远程页面不渲染这一行（无可点的控件）"
		: "页面内存：不写实例（值只留在页面，刷新即回默认）";
	return writeCell(drive, row.ns);
};
const noWriteCell = (loaded, leg, row) => {
	if (loaded === null) return "缺证据";
	const record = noWritesOf(loaded.surface, leg).get(row.label);
	if (record === undefined) return "未驱动（证据里没有这一行）";
	if (record.interaction === "not-effective") return "证据异常：这一行没有被真正用起来（点击没有生效）";
	if ((record.writes || []).length !== 0) return "证据异常：写出 " + JSON.stringify(record.writes);
	return "不写实例（" + (record.offered === false ? "该页面不渲染这一行" : "点击后无任何设置写") + "，实例逐命名空间不变）";
};
const presetCell = (loaded, leg) => {
	if (loaded === null) return "缺证据";
	const drive = drivesOf(loaded.surface, leg).get(PRESET_ROW);
	if (drive === undefined) return "未驱动（证据里没有这一行）";
	return drive.writes.length === 0 ? "页面内存：不写实例（本节在原组合的远程页面上没有可点的预设）" : writeCell(drive, SURFACE_PRESET_NS);
};
const fieldCell = (loaded, mode, leg, field) => {
	if (loaded === null) return "缺证据";
	const drive = fieldDriveOf(loaded.surface, field, leg);
	if (drive === undefined) return mode === "control" && leg === "remote" ? "页面根本不出现（无卡片、无表单）" : "未驱动（证据里没有这个字段）";
	return writeCell(drive, field.ns);
};

const rowTable = () => table(
	["设置项（原设置面板的文案）", "写入的命名空间 / 路径", "overlay：远程（非 loopback）", "overlay：本机（loopback）", "control：远程（非 loopback）", "control：本机（loopback）"],
	SURFACE_ROWS.map((row) => {
		const where = row.ns === null ? "-（不是实例设置）" : "`" + row.ns + "` `" + row.path + "`";
		const label = row.coveredBy === null ? row.label : row.label + "（" + row.coveredBy + "也驱动过）";
		if (row.writes === false) return [label, where, noWriteCell(overlay, "remote", row), noWriteCell(overlay, "loopback", row), noWriteCell(control, "remote", row), noWriteCell(control, "loopback", row)];
		return [label, where, drivenCell(overlay, "remote", row), drivenCell(overlay, "loopback", row), drivenCell(control, "remote", row), drivenCell(control, "loopback", row)];
	}));
const presetTable = () => table(
	["设置项", "写入的命名空间 / 路径", "overlay：远程", "overlay：本机", "control：远程", "control：本机"],
	[["Agent presets：新会话默认预设", "`" + SURFACE_PRESET_NS + "` `selectedDefault`（settings/update 的 patch）", presetCell(overlay, "remote"), presetCell(overlay, "loopback"), presetCell(control, "remote"), presetCell(control, "loopback")]]);
const namespaceTable = () => {
	const coverage = overlay.surface.coverage || {};
	const written = coverage.writtenThroughThePage || [];
	const fromRemote = coverage.writtenFromRemote || [];
	const fromLoopback = coverage.writtenFromLoopback || [];
	const gapOf = (ns) => SURFACE_GAPS.filter((gap) => gap.ns === ns)[0];
	const rowOf = (ns) => SURFACE_ROWS.filter((entry) => entry.ns === ns)[0];
	const pageOf = (ns) => SURFACE_PLUGIN_PAGES.filter((entry) => entry.ns === ns)[0];
	const body = (coverage.served || []).map((ns) => {
		const gap = gapOf(ns);
		const row = rowOf(ns);
		const page = pageOf(ns);
		const via = gap === undefined ? (written.indexOf(ns) === -1 ? "**未出现**" : "是") : "**未由本轮驱动**";
		const note = gap !== undefined ? gap.reason : page !== undefined ? "由插件管理页 `" + page.title + "` 的配置表单写入" : row === undefined ? "由本轮的设置面板写入" : "由「" + row.label + "」行写入";
		return ["`" + ns + "`", via, "远程 " + (fromRemote.indexOf(ns) === -1 ? "-" : "✓") + " / 本机 " + (fromLoopback.indexOf(ns) === -1 ? "-" : "✓"), note];
	});
	return table(["实例服务的设置命名空间", "本轮是否经页面写过", "写过的来源", "说明"], body);
};
/* One row per FIELD: a page with two settings has two rows, and each of them carries its own measurement on
   each leg. "That page is covered" is the sentence this table exists to make impossible. */
const pluginTable = () => table(
	["插件管理页（部署自带）", "字段", "命名空间 / 路径", "overlay：远程", "overlay：本机", "control：远程", "control：本机"],
	liveFields.map((field) => [
		"`" + field.page + "`" + (field.coveredBy === null ? "" : "（" + field.coveredBy + "也驱动过）"),
		"`" + field.label + "`",
		"`" + field.ns + "` `" + field.path + "`",
		fieldCell(overlay, "overlay", "remote", field),
		fieldCell(overlay, "overlay", "loopback", field),
		fieldCell(control, "control", "remote", field),
		fieldCell(control, "control", "loopback", field),
	]));

/* What each page own form reported versus what this run drove through it: the field count is the answer the
   page itself gives, and the fields this run does not drive are named with the reason, not left to a guess. */
const fieldNote = () => {
	const lines = [];
	for (const page of SURFACE_PLUGIN_PAGES) {
		const drive = fieldDrivesOf(overlay.surface, "remote").filter((entry) => entry.page === page.title)[0];
		const reported = drive === undefined ? [] : ((drive.opened || {}).fieldIds || []);
		const driven = page.fields.map((field) => "`" + field.fieldId + "`");
		const rest = (page.notDriven || []).map((field) => "`" + field.fieldId + "`（" + field.label + "）");
		lines.push("- `" + page.title + "`：该页自己报了 " + reported.length + " 个字段（" + reported.map((id) => "`" + id + "`").join("、") + "），本轮逐字段驱动 " + driven.length + " 个（" + driven.join("、") + "）"
			+ (rest.length === 0 ? "——这一页的字段全部驱动过。" : "；" + rest.join("、") + " 只做清单不做驱动，验收跑不往任何地方写凭据来源或端点。"));
	}
	return lines.join("\n");
};

const identity = (() => {
	for (const loaded of [overlay, control]) {
		if (loaded === null) continue;
		const statement = loaded.evidence.provenancePreflight;
		if (statement !== undefined && statement.detail !== undefined) return String(statement.detail);
	}
	return "";
})();
const overlayRendered = (overlay === null ? {} : overlay.surface).rowsRendered || [];
const overlayChrome = ((overlay === null ? {} : overlay.surface).renderedInventory || {}).chrome || [];
const controlOffered = (control === null ? {} : control.surface).rowsOfferedRemote || [];
const controlChrome = ((control === null ? {} : control.surface).renderedInventory || {}).chrome || [];

/* Writing one row can move more than that row's namespace: the run records it, so the report says it, in its
   own small section rather than in a footnote nobody reads. */
const notesSection = notes.length === 0 ? [] : ["", "### 一次点击的多重效果", "", ...notes.map((entry) => "- " + entry), ""];
const notDriven = [
	"- 账号级与模型选择类的命名空间（" + SURFACE_GAPS.map((gap) => "`" + gap.ns + "`").join("、") + "）：逐条理由写在上表里（表源是 `tools/lib/settings-surface.mjs` 的 `SURFACE_GAPS`），验收跑会断言「本轮没写过的命名空间」与那张表**完全一致**，所以新增的命名空间不会被悄悄漏掉。",
	"- 插件配置页里没有驱动的字段：上一节逐页列出（Web search 的凭据来源与端点字段）。验收跑不往任何地方写凭据或端点，所以这两个字段在矩阵里没有格子，也不借用同一个表单里别的字段的写入。",
	"- 设置面板另外两页的控件：**Models 页**的 provider 编辑器与 **Built-in plugins 页**的行不在本节矩阵范围内。它们由更早的阶段在**非 loopback** 来源上驱动并核对（provider 的增删、凭据往返，见 §2 的回归表），但本轮没有为它们画「两个来源 × 两种模式」的格子。",
	"- 快捷键编辑器内部改键位的行为：本轮只测量了「用这一行打开编辑器不写实例」（而且实例服务的命名空间里没有快捷键这一类）；编辑器里改键位本身没有驱动。",
	"- 两个不是实例设置的行（`When to Collapse Work Details`、`Keyboard shortcuts`）：值只活在页面里，实例逐命名空间不变——这一条是在两个来源上分别点出来的测量结果，不是推断。",
	"- 真实部署侧：Cloudflare 边界、跨机器访问、真实账号、既有实例上的 enable/rollback、多访问端并发，见 [release-guide.md](release-guide.md) 第 8 节；本节的全部结论都来自隔离的临时 `DSH_HOME` 与临时 profile。",
].join("\n");

const block = [
	BEGIN,
	"## 5. 全范围清单与能力矩阵",
	"",
	"本节的每一格都来自验收跑 `tools/e2e-remote-settings.mjs` 在**原设置面板**上的一次真实点击（或一次「这一行不在这里」的测量），由本生成器从 `evidence/*-evidence.json` 读回；第一列就是页面自己的文案。生成方式：`node tools/settings-report.mjs --write`（不带 `--write` 只打印）。生成器是 fail-closed 的：某个格子在证据里缺记录、写入没有真的落到实例（值不符或 revision 没动）、某一次跑有 FAIL 或 harness 异常、两个模式在 loopback 来源上的行为不一致——任一情况它都会打印问题并以退出码 1 结束，不会渲染一份跑得比证据更多的报告。",
	"",
	"- overlay 模式：" + (overlay === null ? "缺证据" : counts(overlay)),
	"- control 模式：" + (control === null ? "缺证据" : counts(control)),
	identity === "" ? "- 构建身份：见 `evidence/*-evidence.json` 的 `provenancePreflight`" : "- 构建身份与来源：" + identity,
	"- 非 loopback 页面上的设置列表：overlay 共 " + overlayRendered.length + " 条文本，其中 " + (overlayRendered.length - overlayChrome.length) + " 行是登记表里的设置项、" + overlayChrome.length + " 条是面板自身的控件（导航、关闭、行内控件，以及它自己那句「设置在此不可用」）；control 共 " + (controlOffered.length + controlChrome.length) + " 条，" + controlOffered.length + " 行设置项（" + controlOffered.join("、") + "）、" + controlChrome.length + " 条面板自身控件——原组合的远程页面读不到 Host 的设置，所以它能渲染的行更少。",
	"",
	"「本机（loopback）」= 浏览器 origin 与 Host 头都是 loopback（TCP 也都连本机）；「远程（非 loopback）」= origin 与 Host 头是非 loopback 的可信主机名，TCP 仍连本机。两者都跑在**隔离的临时 home 与临时 profile** 上，不是生产实例；生产侧的 Cloudflare、代理与真实认证没有在本轮改动，也没有被验证。",
	"",
	"本节的**范围**：General 页的每一行（11 行，其中两行根本不是实例设置）、Agent presets 的默认预设、部署自带的 4 个插件配置页里**每一个可编辑字段**（Web search 的凭据来源与端点字段除外）。这个范围之外的东西逐条列在「本轮没有驱动的部分」，不在这里假装覆盖。",
	"",
	...notesSection,
	"### 设置面板逐项",
	"",
	rowTable(),
	"",
	presetTable(),
	"",
	"### 实例服务的设置命名空间",
	"",
	"矩阵的单位是**命名空间**和**面板上的行**：某个命名空间被写过，只说明这一轮有页面写入了它，不说明它下面每个字段都被驱动过（插件配置页那一节逐页给出字段数）。",
	"",
	namespaceTable(),
	"",
	"### 部署自带的插件配置页",
	"",
	pluginTable(),
	"",
	fieldNote(),
	"",
	"### 本轮没有驱动的部分",
	"",
	notDriven,
	END,
].join("\n");

const docPath = join(REPO, "docs", "compatibility-report.md");
if (shouldWrite === false) {
	process.stdout.write(block + "\n");
} else {
	let doc = null;
	try { doc = await readFile(docPath, "utf8"); } catch (error) { complain("cannot read " + docPath + ": " + String(error.code)); }
	if (problems.length > 0) {
		console.error("the report cannot be written:");
		for (const problem of problems) console.error("  - " + problem);
		process.exit(1);
	}
	if (doc.indexOf(BEGIN) === -1 || doc.indexOf(END) === -1) {
		console.error(docPath + " has no " + BEGIN + " ... " + END + " block to replace");
		process.exit(1);
	}
	doc = doc.slice(0, doc.indexOf(BEGIN)) + block + doc.slice(doc.indexOf(END) + END.length);
	await writeFile(docPath, doc);
	console.log("wrote " + docPath + " (" + block.split("\n").length + " lines)");
}

