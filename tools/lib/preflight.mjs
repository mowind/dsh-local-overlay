/**
 * Shared preflight for the version-bound settings replacement.
 *
 * It answers one question before anything is switched: is this installation the
 * approved build this overlay was taken from and verified against? Two kinds of
 * evidence are checked together, because neither is sufficient alone:
 *
 *  - Per-file provenance: every copy hashes to the recorded value, every modified
 *    file still differs from its upstream counterpart by exactly the recorded diff,
 *    and each package publishes exactly the recorded files (npm pack) with a
 *    manifest whose identity-bearing fields still match the record.
 *  - Build identity: the installation carries the same version AND the same content
 *    for the packages the replacement rides on (see baseline.buildIdentity). A
 *    version string alone cannot catch an installation that keeps
 *    @deepseek-ai/dsh@0.2.1-alpha.2 while a file inside it changed.
 *
 * tools/verify-artifacts.mjs and tools/overlay.mjs both call this module, so the
 * preflight the operator runs and the preflight "enable" runs are the same check.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { IDENTITY_ALGORITHM, IDENTITY_PACKAGES, computeBuildIdentity, discoverInstallRoot, verifyBuildIdentity } from "../../packages/dsh-client-ui-settings/lib/baseline-identity.js";

export { IDENTITY_ALGORITHM, IDENTITY_PACKAGES, computeBuildIdentity, discoverInstallRoot, verifyBuildIdentity };

/* provenance.json cannot hash itself: it is generated, and the pack check allows it by name. */
export const GENERATED = "provenance.json";
export const PACKAGES = ["packages/dsh-client-ui-settings", "packages/dsh-web-composition"];

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
export const cropToHunks = (text) => { const i = text.indexOf("@@"); return i === -1 ? "" : text.slice(i); };

export function unifiedDiff(upstreamPath, localPath) {
	try { return execFileSync("diff", ["-u", upstreamPath, localPath], { encoding: "utf8" }); }
	catch (error) { return typeof error.stdout === "string" ? error.stdout : ""; }
}

/* npm prints the tarball name around the JSON, and older npm prints an array while newer npm prints an object keyed by package name. */
export function firstJsonValue(text) {
	const start = Math.min(...["{", "["].map((token) => { const i = text.indexOf(token); return i === -1 ? Number.POSITIVE_INFINITY : i; }));
	const stack = []; let inString = false; let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === "\"") inString = false; continue; }
		if (ch === "\"") inString = true;
		else if (ch === "{" || ch === "[") stack.push(ch);
		else if (ch === "}" || ch === "]") { stack.pop(); if (stack.length === 0) return text.slice(start, i + 1); }
	}
	throw new Error("npm pack --dry-run --json did not print JSON");
}

/* What npm pack would publish for one package, so an unrecorded extra file cannot slip into a tarball. */
export function listPacked(dir) {
	const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--pack-destination", tmpdir()], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const parsed = JSON.parse(firstJsonValue(out));
	const record = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	return record.files.map((file) => file.path).sort();
}

/** The installation to verify: --install, DSH_INSTALL, or the one the dsh on PATH runs from. */
export function resolveInstallDir({ install, dshBin } = {}) {
	const explicit = install ?? process.env.DSH_INSTALL;
	if (explicit !== undefined) return resolve(explicit);
	const bin = dshBin ?? execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
	const real = execFileSync("readlink", ["-f", bin], { encoding: "utf8" }).trim();
	const marker = "/lib/bin.js";
	if (!real.endsWith(marker)) throw new Error("cannot derive the DSH installation from " + real);
	return real.slice(0, -marker.length);
}

export const readProvenance = async (path) => JSON.parse(await readFile(path, "utf8"));

/**
 * Verify the repository record against an installation.
 * @param options.root - repository root holding the recorded copies.
 * @param options.provenancePath - the record to verify against.
 * @param options.install - the DSH installation to compare with.
 * @param options.pack - also check what npm pack would publish (needs npm).
 * @returns the record, the installation, one row per checked item, and every problem found.
 */
export async function runPreflight({ root, provenancePath, install, pack = true }) {
	const problems = [];
	const rows = [];
	const provenance = await readProvenance(provenancePath);
	const installed = JSON.parse(await readFile(join(install, "package.json"), "utf8"));
	if (installed.version !== provenance.baseline.version) problems.push("baseline version mismatch: installed " + installed.name + "@" + installed.version + ", recorded " + provenance.baseline.version);
	if (installed.name !== provenance.baseline.package) problems.push("baseline package mismatch: " + installed.name + " (recorded " + provenance.baseline.package + ")");

	for (const entry of provenance.files) {
		const localPath = join(root, entry.path);
		const upstreamPath = join(install, entry.upstream);
		let local; let upstream;
		try { local = await readFile(localPath); upstream = await readFile(upstreamPath); }
		catch (error) { problems.push(entry.path + ": cannot read (" + error.code + ")"); rows.push([entry.kind, entry.path, "unreadable"]); continue; }
		const localHash = sha256(local);
		const upstreamHash = sha256(upstream);
		const issues = [];
		if (localHash !== entry.sha256) issues.push("local file changed since it was recorded");
		if (upstreamHash !== entry.upstreamSha256) issues.push("installed baseline file differs from the recorded baseline build");
		if (entry.kind === "modified") {
			const actual = cropToHunks(unifiedDiff(upstreamPath, localPath));
			if (actual !== entry.expectedDiff) issues.push("the recorded diff no longer describes the difference against the baseline");
		} else if (localHash !== upstreamHash) issues.push("file is not byte-identical to the baseline copy");
		if (issues.length > 0) problems.push(entry.path + ": " + issues.join("; "));
		rows.push([entry.kind, entry.path, issues.length === 0 ? "ok" : "FAIL"]);
	}

	/* The authored files carry the identity of the packages: their content is pinned, and so is
	   every manifest field the replacement depends on (the patch sequence decides which composition
	   layer wins, and the baseline commit is what makes the copy version-bound). */
	const packages = provenance.packages ?? [];
	if (packages.length !== PACKAGES.length) problems.push("provenance does not pin the authored metadata of every package (recorded " + packages.length + " of " + PACKAGES.length + ")");
	for (const pkg of packages) {
		const dir = join(root, pkg.dir);
		const issues = [];
		for (const [name, hash] of Object.entries(pkg.authored ?? {})) {
			try { if (sha256(await readFile(join(dir, name))) !== hash) issues.push(name + " changed since it was recorded"); }
			catch (error) { issues.push(name + ": cannot read (" + error.code + ")"); }
		}
		const pin = pkg.manifest ?? {};
		let manifest;
		try { manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")); }
		catch (error) { issues.push("package.json: cannot be parsed (" + error.code + ")"); }
		if (manifest !== undefined) {
			if (manifest.name !== pin.name) issues.push("manifest name is " + manifest.name + " (recorded " + pin.name + ")");
			if (manifest.version !== pin.version) issues.push("manifest version is " + manifest.version + " (recorded " + pin.version + ")");
			const overlay = manifest.overlay ?? {};
			if (overlay.baselineCommit !== pin.baselineCommit) issues.push("manifest baseline commit is " + overlay.baselineCommit + " (recorded " + pin.baselineCommit + ")");
			if (pin.baselineCommit !== provenance.baseline.commit) issues.push("the recorded baseline commit of the package differs from the baseline commit of the provenance record");
			if (overlay.baselinePackage !== pin.baselinePackage) issues.push("manifest baseline package is " + overlay.baselinePackage + " (recorded " + pin.baselinePackage + ")");
			const files = Array.isArray(manifest.files) ? [...manifest.files].sort() : [];
			if (JSON.stringify(files) !== JSON.stringify([...(pin.files ?? [])].sort())) issues.push("the published files list differs from the recorded list");
			const platform = (manifest.dsh?.client?.platform) ?? null;
			if (platform !== pin.clientPlatform) issues.push("dsh.client.platform is " + platform + " (recorded " + pin.clientPlatform + ")");
			if (pin.clientEntry !== null && !files.includes(pin.clientEntry)) issues.push("the client entry " + pin.clientEntry + " is not in the published files list");
			const patch = (manifest.dsh?.bundle?.patch) ?? null;
			if (JSON.stringify(patch) !== JSON.stringify(pin.bundlePatch)) issues.push("the dsh.bundle.patch sequence differs from the recorded one (order included)");
			if (Array.isArray(patch) && new Set(patch).size !== patch.length) issues.push("dsh.bundle.patch repeats a patch file");
		}
		if (issues.length > 0) problems.push(pkg.dir + ": " + issues.join("; "));
		rows.push([issues.length === 0 ? "ok" : "FAIL", "manifest", pkg.dir]);
	}

	if (pack) {
		for (const dir of PACKAGES) {
			const recorded = provenance.files.filter((entry) => entry.path.startsWith(dir + "/")).map((entry) => entry.path.slice(dir.length + 1));
			/* The published set is what the record pins: the recorded copies, the authored files it hashes, and the generated record itself. */
			const authored = Object.keys((provenance.packages ?? []).find((pkg) => pkg.dir === dir)?.authored ?? {});
			const expected = [...recorded, ...authored, GENERATED].sort();
			const packed = listPacked(join(root, dir));
			const missing = expected.filter((path) => !packed.includes(path));
			const extra = packed.filter((path) => !expected.includes(path));
			if (missing.length > 0) problems.push(dir + ": npm pack would not include the recorded file(s) " + missing.join(", "));
			if (extra.length > 0) problems.push(dir + ": npm pack would include unrecorded file(s) " + extra.join(", "));
			rows.push([missing.length + extra.length === 0 ? "ok" : "FAIL", "packed", dir + " (" + packed.length + " files)"]);
			const shipped = sha256(await readFile(join(root, dir, "provenance.json")));
			if (shipped !== sha256(await readFile(provenancePath))) problems.push(dir + "/provenance.json differs from " + relative(root, provenancePath));
		}
	}

	/* Version plus build identity: the runtime guard in the replacement compares the same two
	   things against the same record, so a build the runtime would refuse cannot pass here. */
	const recorded = provenance.baseline.buildIdentity;
	if (recorded === undefined) problems.push("the record carries no build identity (re-record it with tools/overlay.mjs record)");
	else {
		if (JSON.stringify(recorded.packages) !== JSON.stringify(IDENTITY_PACKAGES)) problems.push("the package list this build compares against differs from the recorded one (re-record it with tools/overlay.mjs record)");
		const { identity, problems: identityProblems } = verifyBuildIdentity({ install, baseline: provenance.baseline, packages: recorded.packages });
		for (const problem of identityProblems) problems.push(problem);
		rows.push([identityProblems.length === 0 ? "ok" : "FAIL", "identity", identity === null ? "unreadable" : identity.files + " files, " + identity.digest.slice(0, 16) + "..."]);
	}

	return { provenance, provenancePath, install, rows, problems };
}

/** The report the terminal prints, without the verdict lines. */
export function reportLines({ provenance, install, rows }) {
	const lines = [];
	lines.push("baseline: " + provenance.baseline.package + "@" + provenance.baseline.version + " (commit " + provenance.baseline.commit + ", " + provenance.baseline.license + ")");
	lines.push("installation: " + install);
	for (const [kind, path, status] of rows) lines.push("  " + status.padEnd(5) + " " + kind.padEnd(9) + path);
	return lines;
}

/** The one-line summary printed after a passing preflight. */
export function passLine({ provenance }) {
	const modified = provenance.files.filter((entry) => entry.kind === "modified").length;
	const identity = provenance.baseline.buildIdentity;
	return "provenance verification PASSED: " + provenance.files.length + " recorded files (" + modified + " deliberately modified, " + (provenance.files.length - modified) + " byte-identical), " + (provenance.packages ?? []).length + " pinned package manifests and the build identity " + String(identity?.digest).slice(0, 16) + "... (" + identity?.files + " files) match the installed baseline " + provenance.baseline.package + "@" + provenance.baseline.version;
}
