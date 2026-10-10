#!/usr/bin/env node
/**
 * Terminal entry point for the version-bound settings replacement.
 *
 * This is the public terminal face of the overlay: the place where an operator preflights, enables,
 * inspects, diagnoses and rolls back the replacement. Two rules shape every command.
 *
 *  1. Nothing is installed and nothing is switched before the preflight passes. The preflight is the
 *     shared tools/lib/preflight.mjs check, so the gate the operator runs by hand and the gate this
 *     tool runs before it touches a profile are literally the same code.
 *  2. Rollback undoes only what this tool changed: the loaded composition and the provider name of the
 *     saved override. It never restores a configuration snapshot, because the ordinary configuration
 *     and the test credentials an instance accumulates during the replacement belong to the instance.
 *
 * Usage:
 *   node tools/overlay.mjs preflight                                  verify the installation, change nothing
 *   node tools/overlay.mjs status    --home DIR [--profile NAME]      report the profile and the record as they stand
 *   node tools/overlay.mjs diagnose  --home DIR [--profile NAME]      explain why the replacement is or is not serving
 *   node tools/overlay.mjs enable    --home DIR [--profile NAME]      preflight, then install and switch the composition
 *   node tools/overlay.mjs rollback  --home DIR [--profile NAME]      put the composition and the provider name back
 *   node tools/overlay.mjs record    [--adopt PATH]                   refresh the record from this installation
 *
 * Options:
 *   --home DIR        the DSH_HOME of the instance to act on. Required for every profile command:
 *                     this tool never guesses, so it cannot reach a production instance by accident.
 *   --profile NAME    the profile inside that home. Optional when the home holds exactly one profile.
 *   --dsh-bin FILE    the dsh entry point to drive (default: the dsh on PATH).
 *   --install DIR     the DSH installation to verify (default: $DSH_INSTALL, or the one dsh runs from).
 *   --artifacts DIR   where "enable" leaves the packaged tarballs (default: a temporary directory).
 *   --remove-packages with "rollback": also run "dsh plugin remove" for the two own packages.
 *   --adopt PATH      with "record": accept the current content of that recorded file as a deliberate
 *                     modification of the baseline copy instead of refusing the change.
 *   --json            print machine-readable output (status and diagnose).
 *
 * Exit codes: 0 = the command succeeded, 1 = the command refused or found problems, 2 = bad usage.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	GENERATED,
	PACKAGES,
	computeBuildIdentity,
	cropToHunks,
	passLine,
	reportLines,
	resolveInstallDir,
	runPreflight,
	sha256,
	unifiedDiff,
} from "./lib/preflight.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROVENANCE_PATH = join(REPO_ROOT, "provenance.json");
const PATCH_FILE = "cordis.patch.yml";
const MANIFEST_FILE = "package.json";
const STATE_FILE = "dsh-local-overlay.state.json";
const STATE_SCHEMA = "dsh-local-overlay/state@1";
const OVERLAY_SCOPE = "@dsh-local-overlay";
const COMPOSITION_PACKAGE = OVERLAY_SCOPE + "/web-composition";
const FORK_PACKAGE = OVERLAY_SCOPE + "/dsh-client-ui-settings";
const UPSTREAM_PROVIDER = "@deepseek-ai/dsh-client-ui-settings";
const UPSTREAM_ROSTER = "@deepseek-ai/dsh-web-app";
/* The exact name guard the settings page writes into the saved override of the settings row. */
const GUARD = 'name: "' + FORK_PACKAGE + '"';
const UPSTREAM_GUARD = 'name: "' + UPSTREAM_PROVIDER + '"';

class UsageError extends Error {}

const argv = process.argv.slice(2);
const command = argv.length > 0 && !argv[0].startsWith("--") ? argv[0] : "help";
const values = (name) => {
	const found = [];
	for (let i = 1; i < argv.length - 1; i++) if (argv[i] === name) found.push(argv[i + 1]);
	return found;
};
const options = {
	home: values("--home")[0],
	profile: values("--profile")[0],
	dshBin: values("--dsh-bin")[0],
	install: values("--install")[0],
	artifacts: values("--artifacts")[0],
	adopt: values("--adopt"),
	removePackages: argv.includes("--remove-packages"),
	json: argv.includes("--json"),
};

const exists = (path) => existsSync(path);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const bundled = (manifest) => (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];

function setBundles(manifest, bundles) {
	if (manifest.dsh === undefined) manifest.dsh = {};
	if (manifest.dsh.profile === undefined) manifest.dsh.profile = {};
	manifest.dsh.profile.bundles = bundles;
	return manifest;
}

/* The overlay composition replaces the upstream web roster: same layer, same position, our roster. */
function switchedBundles(bundles) {
	const out = [];
	for (const bundle of bundles) {
		const mapped = bundle === UPSTREAM_ROSTER ? COMPOSITION_PACKAGE : bundle;
		if (!out.includes(mapped)) out.push(mapped);
	}
	if (!out.includes(COMPOSITION_PACKAGE)) out.push(COMPOSITION_PACKAGE);
	return out;
}

function restoredBundles(bundles, rosterInstalled) {
	const withoutComposition = bundles.filter((bundle) => bundle !== COMPOSITION_PACKAGE);
	if (!rosterInstalled || withoutComposition.includes(UPSTREAM_ROSTER)) return withoutComposition;
	const position = bundles.indexOf(COMPOSITION_PACKAGE);
	const index = position === -1 || position > withoutComposition.length ? withoutComposition.length : position;
	return [...withoutComposition.slice(0, index), UPSTREAM_ROSTER, ...withoutComposition.slice(index)];
}

function resolveInstall(options_) {
	return resolveInstallDir({ install: options_.install, dshBin: options_.dshBin });
}

function dshEntry(options_) {
	if (options_.dshBin !== undefined) return resolve(options_.dshBin);
	try {
		return execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
	} catch (error) {
		throw new UsageError("cannot find the dsh entry point on PATH; pass --dsh-bin <file>");
	}
}

async function resolveProfile(options_) {
	if (options_.home === undefined) throw new UsageError("--home is required: point it at the DSH_HOME of the instance you mean, so this tool can never act on a production instance by accident");
	const home = resolve(options_.home);
	const profiles = join(home, "profiles");
	if (!exists(profiles)) throw new UsageError("no profiles directory in " + home + " (is --home the DSH_HOME of an instance?)");
	const names = options_.profile === undefined
		? (await readdir(profiles, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
		: [options_.profile];
	if (names.length === 0) throw new UsageError("no profile in " + profiles);
	if (names.length > 1) throw new UsageError("several profiles in " + home + " (" + names.join(", ") + "); choose one with --profile");
	const dir = join(profiles, names[0]);
	if (!exists(join(dir, MANIFEST_FILE))) throw new UsageError(dir + " is not a profile (no " + MANIFEST_FILE + ")");
	return { home, name: names[0], dir, manifestPath: join(dir, MANIFEST_FILE), patchPath: join(dir, PATCH_FILE), statePath: join(dir, STATE_FILE) };
}

async function readPatch(patchPath) {
	try {
		return await readFile(patchPath, "utf8");
	} catch (error) {
		return null;
	}
}

async function readState(statePath) {
	if (!exists(statePath)) return null;
	try {
		return await readJson(statePath);
	} catch (error) {
		return null;
	}
}

/* Rewrites the value of the name guard, and only that value, on the single line that carries it. */
function rewriteGuard(text, from, to) {
	let replaced = 0;
	const lines = text.split("\n").map((line) => {
		const trimmed = line.trim();
		if (trimmed === 'name: "' + from + '"' || trimmed === "name: '" + from + "'") {
			replaced++;
			return line.replace(from, to);
		}
		return line;
	});
	return { text: lines.join("\n"), replaced };
}

/* Only a package.json that publishes its own copies and patch files is a candidate for the pack check. */
function runPlugin(profile, action, target) {
	const entry = dshEntry(options);
	try {
		const output = execFileSync(process.execPath, [entry, "plugin", "--profile", profile.name, action, target], { env: { ...process.env, DSH_HOME: profile.home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, output: String(output).trim() };
	} catch (error) {
		return { ok: false, output: (String(error.stdout || "") + String(error.stderr || "")).trim() };
	}
}

async function packPackages(destination) {
	await mkdir(destination, { recursive: true });
	const packs = [];
	for (const dir of PACKAGES) {
		const output = execFileSync("npm", ["pack", "--pack-destination", destination, "--silent"], { cwd: join(REPO_ROOT, dir), encoding: "utf8" }).trim().split("\n").pop();
		packs.push(join(destination, output));
	}
	return packs;
}

function printProblems(lines, headline) {
	console.error("");
	console.error(headline);
	for (const line of lines) console.error("  - " + line);
}

async function cmdPreflight() {
	const install = resolveInstall(options);
	const report = await runPreflight({ root: REPO_ROOT, provenancePath: PROVENANCE_PATH, install });
	for (const line of reportLines(report)) console.log(line);
	console.log("");
	if (report.problems.length > 0) {
		printProblems(report.problems, "provenance verification FAILED (" + report.problems.length + " problem(s)):");
		return 1;
	}
	console.log(passLine(report));
	console.log("nothing was installed and nothing was switched: this command only reads.");
	return 0;
}

async function profileFacts(profile, install) {
	const manifest = await readJson(profile.manifestPath);
	const bundles = bundled(manifest);
	const patch = await readPatch(profile.patchPath);
	const state = await readState(profile.statePath);
	const record = await readJson(PROVENANCE_PATH);
	const installed = await readJson(join(install, MANIFEST_FILE));
	const shippedPath = join(profile.dir, "node_modules", FORK_PACKAGE, GENERATED);
	const shipped = exists(shippedPath) ? await readJson(shippedPath) : null;
	const installation = computeBuildIdentity(install);
	return {
		profile: profile.name,
		profileDir: profile.dir,
		install,
		installationVersion: installed.version,
		recordedVersion: record.baseline.version,
		recordedIdentity: (record.baseline.buildIdentity || {}).digest || null,
		shippedIdentity: shipped === null ? null : (shipped.baseline.buildIdentity || {}).digest || null,
		installationIdentity: installation.digest,
		installationFiles: installation.files,
		missingPackages: installation.missing,
		bundles,
		compositionLoaded: bundles.includes(COMPOSITION_PACKAGE),
		rosterLoaded: bundles.includes(UPSTREAM_ROSTER),
		forkInstalled: exists(join(profile.dir, "node_modules", FORK_PACKAGE)),
		rowsInProfilePatch: patch === null ? 0 : (patch.match(/id: ui-settings/g) || []).length,
		savedOverrideNamesTheFork: patch !== null && patch.includes(GUARD),
		savedOverrideNamesTheUpstream: patch !== null && patch.includes(UPSTREAM_GUARD),
		swap: state,
	};
}

function factLines(facts) {
	const same = facts.recordedIdentity === facts.installationIdentity && facts.recordedIdentity !== null;
	const guard = facts.savedOverrideNamesTheFork ? "our provider (rollback will rewrite it to the upstream name)" : facts.savedOverrideNamesTheUpstream ? "the upstream provider" : "no saved override row yet";
	const swap = facts.swap === null ? "no swap recorded" : "swapped at " + facts.swap.enabledAt + " (packages " + (facts.swap.packages || []).join(", ") + (facts.swap.rolledBackAt ? ", rolled back at " + facts.swap.rolledBackAt : "") + ")";
	return [
		"profile: " + facts.profile + " (" + facts.profileDir + ")",
		"installation: " + facts.install + " (" + facts.installationVersion + ")",
		"record: version " + facts.recordedVersion + ", build identity " + String(facts.recordedIdentity).slice(0, 16) + "...",
		"installed build: identity " + facts.installationIdentity.slice(0, 16) + "... over " + facts.installationFiles + " files -> " + (same ? "matches the record" : "does NOT match the record") + (facts.missingPackages.length > 0 ? " (missing " + facts.missingPackages.join(", ") + ")" : ""),
		"shipped record inside the profile: identity " + String(facts.shippedIdentity).slice(0, 16) + "...",
		"dsh.profile.bundles: " + JSON.stringify(facts.bundles) + " -> composition " + (facts.compositionLoaded ? "loaded" : "not loaded") + ", upstream roster " + (facts.rosterLoaded ? "loaded" : "not loaded"),
		"own settings package in the profile: " + (facts.forkInstalled ? "installed" : "not installed"),
		"saved settings override (" + facts.rowsInProfilePatch + " row(s) in " + PATCH_FILE + "): " + guard,
		"swap record: " + swap,
	];
}

async function cmdStatus() {
	const profile = await resolveProfile(options);
	const install = resolveInstall(options);
	const facts = await profileFacts(profile, install);
	if (options.json) {
		console.log(JSON.stringify(facts, null, 2));
		return 0;
	}
	for (const line of factLines(facts)) console.log(line);
	return 0;
}

/* The browser downloads the copy installed in the profile, not the copy in the repository, so a damaged
   artifact has to be named here: the runtime guard protects the provider it serves, but a file the page
   loads can be broken (or a browser artifact can be missing) without the server failing to start. */
async function installedCopyFindings(profile, record) {
	const findings = [];
	for (const entry of record.files || []) {
		const parts = entry.path.split("/");
		if (parts[0] !== "packages") continue;
		const target = parts[1] === "dsh-client-ui-settings" ? FORK_PACKAGE : parts[1] === "dsh-web-composition" ? COMPOSITION_PACKAGE : null;
		if (target === null) continue;
		const label = parts.slice(2).join("/");
		const installedPath = join(profile.dir, "node_modules", target, label);
		if (!exists(installedPath)) {
			findings.push(label + " is missing from the installed " + target + ": the packed artifact was tampered with, so reinstall the package");
			continue;
		}
		const hash = sha256(await readFile(installedPath));
		if (hash !== entry.sha256) findings.push(label + " as installed in the profile (" + hash.slice(0, 12) + ") differs from the recorded artifact (" + entry.sha256.slice(0, 12) + "): the browser loads that damaged artifact, so reinstall the package or roll back");
	}
	return findings;
}

async function cmdDiagnose() {
	const profile = await resolveProfile(options);
	const install = resolveInstall(options);
	const facts = await profileFacts(profile, install);
	const record = await readJson(PROVENANCE_PATH);
	const report = await runPreflight({ root: REPO_ROOT, provenancePath: PROVENANCE_PATH, install });
	const findings = [...report.problems];
	if (facts.shippedIdentity === null) findings.push("the own settings package is not installed in " + profile.dir + "/node_modules, so nothing can serve the settings row from there");
	else if (facts.shippedIdentity !== facts.installationIdentity) findings.push("the record shipped inside the profile describes build identity " + facts.shippedIdentity + ", but this installation is " + facts.installationIdentity + ": the runtime guard refuses to serve the settings provider, so that surface is unavailable until the installation is restored or the record is re-recorded");
	if (!facts.compositionLoaded) findings.push("dsh.profile.bundles does not load " + COMPOSITION_PACKAGE + ": the upstream roster serves the settings row, so the remote page cannot persist settings");
	if (facts.compositionLoaded && !facts.forkInstalled) findings.push("the composition is loaded but " + FORK_PACKAGE + " is missing from " + profile.dir + "/node_modules");
	if (facts.forkInstalled) findings.push(...(await installedCopyFindings(profile, record)));
	if (options.json) {
		console.log(JSON.stringify({ facts, findings, checks: report.rows }, null, 2));
	} else {
		for (const line of factLines(facts)) console.log(line);
		console.log("");
		for (const [kind, path, status] of report.rows) console.log("  " + status.padEnd(5) + " " + kind.padEnd(9) + path);
		if (findings.length > 0) {
			printProblems(findings, "diagnosis: the replacement is not in a working state (" + findings.length + " problem(s)):");
			console.log("");
			console.log("to go back to the upstream composition with the saved configuration intact:");
			console.log("  node tools/overlay.mjs rollback --home " + options.home + (options.profile === undefined ? "" : " --profile " + options.profile));
			return 1;
		}
		console.log("");
		console.log("diagnosis: the record describes this installation and the profile loads our composition.");
	}
	return findings.length === 0 ? 0 : 1;
}

async function cmdEnable() {
	const profile = await resolveProfile(options);
	const install = resolveInstall(options);
	console.log("preflight against " + install);
	const report = await runPreflight({ root: REPO_ROOT, provenancePath: PROVENANCE_PATH, install });
	for (const line of reportLines(report)) console.log(line);
	if (report.problems.length > 0) {
		printProblems(report.problems, "refusing to install or switch anything: the record does not describe this installation (" + report.problems.length + " problem(s))");
		console.log("");
		console.log("nothing in " + profile.dir + " was touched. inspect the difference with:");
		console.log("  node tools/overlay.mjs diagnose --home " + options.home);
		return 1;
	}
	console.log("  " + passLine(report));

	const manifest = await readJson(profile.manifestPath);
	const previousBundles = bundled(manifest);
	const artifacts = options.artifacts === undefined ? await mkdtemp(join(tmpdir(), "dsh-local-overlay-")) : resolve(options.artifacts);
	const packs = await packPackages(artifacts);
	for (const pack of packs) {
		const result = runPlugin(profile, "add", pack);
		if (!result.ok) {
			printProblems([result.output], "installing " + pack + " failed; the composition was NOT switched:");
			console.log("");
			console.log("the profile may now carry an installed package. check it with:");
			console.log("  node tools/overlay.mjs status --home " + options.home);
			return 1;
		}
		console.log("installed " + pack.split("/").pop());
	}
	/* The selection is computed from the list that was there before any add: pnpm rewrites dsh.profile.bundles
	   when it installs the composition, and that rewrite must not be able to drop a layer nobody asked us to touch. */
	const afterAdd = await readJson(profile.manifestPath);
	const afterAddBundles = bundled(afterAdd);
	const switched = switchedBundles(previousBundles);
	setBundles(afterAdd, switched);
	await writeJson(profile.manifestPath, afterAdd);
	/* An override saved by the upstream provider has to follow the swap, or the saved value would silently stop
	   applying (the patch engine matches the name guard and skips the whole row when it does not match). */
	let guardRows = 0;
	const patchBeforeEnable = await readPatch(profile.patchPath);
	if (patchBeforeEnable !== null) {
		const result = rewriteGuard(patchBeforeEnable, UPSTREAM_PROVIDER, FORK_PACKAGE);
		if (result.replaced > 0) {
			await writeFile(profile.patchPath, result.text);
			guardRows = result.replaced;
			console.log("the saved settings override in " + profile.patchPath + " now names " + FORK_PACKAGE + " (" + guardRows + " row(s) rewritten); its saved configuration, and every other row, is untouched");
		}
	}
	const identity = computeBuildIdentity(install);
	await writeJson(profile.statePath, {
		schema: STATE_SCHEMA,
		enabledAt: new Date().toISOString(),
		install,
		identity: identity.digest,
		packages: packs.map((pack) => pack.split("/").pop()),
		previousBundles,
		switchedBundles: switched,
		guardRows,
	});
	console.log("switched dsh.profile.bundles: " + JSON.stringify(previousBundles) + " -> " + JSON.stringify(switched) + (JSON.stringify(afterAddBundles) === JSON.stringify(switched) ? "" : " (the install step had written " + JSON.stringify(afterAddBundles) + ")"));
	console.log("recorded the swap in " + profile.statePath + " (bundle list and identity only; no configuration snapshot)");
	console.log("");
	console.log("restart the instance to load the new composition, then reload the settings page:");
	console.log("  restart: stop the running dsh server of this profile and start it again");
	console.log("  verify:  node tools/overlay.mjs status --home " + options.home);
	console.log("  undo:    node tools/overlay.mjs rollback --home " + options.home);
	return 0;
}

async function cmdRollback() {
	const profile = await resolveProfile(options);
	const install = resolveInstall(options);
	const manifest = await readJson(profile.manifestPath);
	const bundlesBefore = bundled(manifest);
	const state = await readState(profile.statePath);
	const recorded = state !== null && Array.isArray(state.previousBundles) ? state.previousBundles : null;
	const dependencies = Object.keys(manifest.dependencies || {});
	/* Surgical undo: take the composition out of the list as it is now, and put the upstream roster back where it
	   was. Anything else in the list (a layer added while the replacement was active, say) is left alone, and no
	   stored snapshot of the list is written back wholesale. */
	const restoreRoster = recorded !== null && recorded.includes(UPSTREAM_ROSTER) || dependencies.includes(UPSTREAM_ROSTER);
	const restored = restoredBundles(bundlesBefore, restoreRoster);
	const steps = [];
	if (JSON.stringify(restored) !== JSON.stringify(bundlesBefore)) {
		setBundles(manifest, restored);
		await writeJson(profile.manifestPath, manifest);
		steps.push("dsh.profile.bundles: " + JSON.stringify(bundlesBefore) + " -> " + JSON.stringify(restored) + " (only the composition this tool added is taken back out; every other layer is kept)");
	}
	const patchBefore = await readPatch(profile.patchPath);
	if (patchBefore !== null) {
		const result = rewriteGuard(patchBefore, FORK_PACKAGE, UPSTREAM_PROVIDER);
		if (result.replaced > 0) {
			await writeFile(profile.patchPath, result.text);
			steps.push("the saved settings override now names " + UPSTREAM_PROVIDER + " (" + result.replaced + " row(s) rewritten); its config, and every other row, is untouched");
		}
	}
	if (options.removePackages) {
		for (const target of [COMPOSITION_PACKAGE, FORK_PACKAGE]) {
			const result = runPlugin(profile, "remove", target);
			steps.push((result.ok ? "removed " : "could not remove ") + target + (result.ok ? "" : ": " + result.output.slice(-200)));
		}
	}
	if (state !== null) {
		state.rolledBackAt = new Date().toISOString();
		await writeJson(profile.statePath, state);
	}
	for (const step of steps) console.log(step);
	if (steps.length === 0) console.log("nothing to undo: the profile already loads the upstream composition and the saved override already names the upstream provider.");
	console.log("");
	console.log("kept as they are: the saved configuration, the ordinary configuration of the instance, and the credentials in " + join(profile.home, ".credentials.yaml"));
	console.log("the installed packages stay installed unless you pass --remove-packages; an unloaded package changes nothing at runtime.");
	console.log("restart the instance to load the upstream composition again.");
	if (exists(join(install, MANIFEST_FILE))) return 0;
	return 0;
}

async function cmdRecord() {
	const install = resolveInstall(options);
	const provenance = await readJson(PROVENANCE_PATH);
	const adopt = new Set(options.adopt);
	const changes = [];
	const problems = [];

	for (const entry of provenance.files) {
		const localPath = join(REPO_ROOT, entry.path);
		const upstreamPath = join(install, entry.upstream);
		let local;
		let upstream;
		try {
			local = await readFile(localPath);
			upstream = await readFile(upstreamPath);
		} catch (error) {
			problems.push(entry.path + ": cannot read (" + error.code + ")");
			continue;
		}
		const localHash = sha256(local);
		const upstreamHash = sha256(upstream);
		if (entry.kind === "verbatim" && localHash !== upstreamHash && adopt.has(entry.path)) {
			entry.kind = "modified";
			changes.push(entry.path + ": adopted as a deliberate modification of the baseline copy");
		}
		if (entry.kind === "verbatim" && localHash !== upstreamHash) {
			problems.push(entry.path + ": recorded as byte-identical to the baseline copy but the content differs; restore it, or accept the change with --adopt " + entry.path);
			continue;
		}
		if (entry.kind === "verbatim" && localHash === upstreamHash && adopt.has(entry.path)) changes.push(entry.path + ": nothing to adopt, it is still byte-identical to the baseline copy");
		if (entry.kind === "modified" && localHash === upstreamHash) problems.push(entry.path + ": recorded as modified but is now byte-identical to the baseline copy");
		if (entry.sha256 !== localHash) changes.push(entry.path + ": sha256 " + entry.sha256.slice(0, 12) + " -> " + localHash.slice(0, 12));
		if (entry.upstreamSha256 !== upstreamHash) changes.push(entry.upstream + ": upstream sha256 " + entry.upstreamSha256.slice(0, 12) + " -> " + upstreamHash.slice(0, 12));
		entry.sha256 = localHash;
		entry.upstreamSha256 = upstreamHash;
		if (entry.kind === "modified") {
			const diff = cropToHunks(unifiedDiff(upstreamPath, localPath));
			if (diff !== entry.expectedDiff) changes.push(entry.path + ": the recorded diff was refreshed");
			entry.expectedDiff = diff;
		}
	}

	for (const pkg of provenance.packages || []) {
		const dir = join(REPO_ROOT, pkg.dir);
		const manifest = await readJson(join(dir, MANIFEST_FILE));
		pkg.authored = pkg.authored || {};
		const recorded = new Set(provenance.files.filter((entry) => entry.path.startsWith(pkg.dir + "/")).map((entry) => entry.path.slice(pkg.dir.length + 1)));
		/* npm always publishes package.json, which does not have to be listed in "files", so the pinned
		   authored set is the published list plus whatever the record already pinned. */
		for (const name of [...(manifest.files || []), ...Object.keys(pkg.authored)]) {
			if (name.includes("*") || recorded.has(name) || name === GENERATED) continue;
			if (!exists(join(dir, name))) {
				problems.push(pkg.dir + ": " + name + " is published but missing from the repository");
				continue;
			}
			const hash = sha256(await readFile(join(dir, name)));
			if (pkg.authored[name] !== hash) changes.push(pkg.dir + "/" + name + ": authored sha256 " + String(pkg.authored[name]).slice(0, 12) + " -> " + hash.slice(0, 12));
			pkg.authored[name] = hash;
		}
		const previous = pkg.manifest || {};
		const clientExport = (manifest.exports || {})["./client"];
		const clientEntry = clientExport === undefined ? previous.clientEntry ?? null : String(clientExport.default || "").replace(/^\.\//, "");
		const next = {
			name: manifest.name,
			version: manifest.version,
			baselinePackage: (manifest.overlay || {}).baselinePackage || null,
			baselineCommit: (manifest.overlay || {}).baselineCommit || null,
			clientPlatform: ((manifest.dsh || {}).client || {}).platform || null,
			clientEntry,
			files: manifest.files || [],
			bundlePatch: ((manifest.dsh || {}).bundle || {}).patch || null,
		};
		for (const key of Object.keys(next)) {
			if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes.push(pkg.dir + ": pinned " + key + " " + JSON.stringify(previous[key]) + " -> " + JSON.stringify(next[key]));
		}
		pkg.manifest = next;
	}

	const identity = computeBuildIdentity(install);
	if (identity.missing.length > 0) problems.push("this installation is missing recorded package(s): " + identity.missing.join(", "));
	const previousIdentity = (provenance.baseline.buildIdentity || {}).digest;
	if (previousIdentity !== identity.digest) changes.push("build identity " + String(previousIdentity).slice(0, 12) + " -> " + identity.digest.slice(0, 12) + " over " + identity.files + " files (" + identity.bytes + " bytes)");
	provenance.baseline.buildIdentity = {
		algorithm: identity.algorithm,
		packages: identity.packages,
		files: identity.files,
		bytes: identity.bytes,
		missing: identity.missing,
		digest: identity.digest,
	};

	if (problems.length > 0) {
		printProblems(problems, "the record was NOT written (" + problems.length + " problem(s)):");
		return 1;
	}
	await writeJson(PROVENANCE_PATH, provenance);
	const written = await readFile(PROVENANCE_PATH);
	for (const dir of PACKAGES) await writeFile(join(REPO_ROOT, dir, GENERATED), written);
	console.log("recorded the installation " + install + " into " + PROVENANCE_PATH + " and copied it into both packages");
	console.log("build identity: " + identity.digest + " (" + identity.algorithm + ", " + identity.files + " files, " + identity.bytes + " bytes)");
	if (changes.length === 0) console.log("nothing changed.");
	else for (const change of changes) console.log("  " + change);
	console.log("");
	const report = await runPreflight({ root: REPO_ROOT, provenancePath: PROVENANCE_PATH, install });
	if (report.problems.length > 0) {
		printProblems(report.problems, "the freshly written record does not verify (" + report.problems.length + " problem(s)):");
		return 1;
	}
	console.log(passLine(report));
	return 0;
}

async function main() {
	const commands = {
		preflight: cmdPreflight,
		status: cmdStatus,
		diagnose: cmdDiagnose,
		enable: cmdEnable,
		rollback: cmdRollback,
		record: cmdRecord,
	};
	if (command === "help" || command === "--help" || command === "-h") {
		const file = await readFile(fileURLToPath(import.meta.url), "utf8");
		console.log(file.split("*/")[0].replace(/^#![^\n]*\n/, "").replace(/^\/\*\*\n?/, "").trim());
		return 0;
	}
	if (commands[command] === undefined) throw new UsageError("unknown command " + command + "; try: preflight, status, diagnose, enable, rollback, record");
	return await commands[command]();
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		if (error instanceof UsageError) {
			console.error("usage: " + error.message);
			process.exit(2);
		}
		console.error("ERROR:", error);
		process.exit(2);
	});
