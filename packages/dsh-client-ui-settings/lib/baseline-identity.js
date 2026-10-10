/**
 * Build identity of the DSH installation this replacement is bound to.
 *
 * A version string alone cannot decide whether a copy may serve: an installation
 * can keep @deepseek-ai/dsh@0.2.1-alpha.2 while the content of the packages the
 * replacement rides on changes. This module pins that content as a single digest
 * and is shared by the terminal entry (tools/overlay.mjs, tools/verify-artifacts.mjs)
 * and by the runtime guard in lib/index.js, so the preflight and the running
 * instance compare exactly the same thing.
 *
 * Algorithm: read every file of every recorded package recursively, excluding
 * node_modules directories and symbolic links; sort them by their path relative to
 * the installation root (posix separators); the digest is the sha256 of the
 * concatenation of "<path>\\0<sha256(content)>\\n" over that order.
 *
 * The record lives in baseline.buildIdentity of the shipped provenance.json; a
 * mismatch refuses to serve instead of silently running an unverified build.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const IDENTITY_ALGORITHM = "sha256 of the sorted '<path>\\0<sha256(content)>\\n' lines of every file of every recorded package, node_modules and symbolic links excluded";

/**
 * The packages whose content decides whether this replacement may serve: the DSH
 * CLI itself ("."), the Web composition layer that gets patched, the settings
 * provider that gets replaced, the settings and credentials contract the page
 * talks to, and the loader that applies the patch. Nested node_modules are
 * excluded, so a package entry covers only the files that package ships.
 */
export const IDENTITY_PACKAGES = [
	".",
	"node_modules/@deepseek-ai/dsh-base",
	"node_modules/@deepseek-ai/dsh-web-app",
	"node_modules/@deepseek-ai/dsh-client-ui-settings",
	"node_modules/@deepseek-ai/dsh-client-ui-settings-general",
	"node_modules/@deepseek-ai/dsh-client-ui-settings-models",
	"node_modules/@deepseek-ai/dsh-client-ui-settings-account",
	"node_modules/@deepseek-ai/dsh-client-modules",
	"node_modules/@deepseek-ai/dsh-client-connection",
	"node_modules/@deepseek-ai/dsh-api-settings-controller",
	"node_modules/@deepseek-ai/dsh-api-remotes",
	"node_modules/@deepseek-ai/dsh-credentials",
	"node_modules/@deepseek-ai/dsh-credentials-local",
	"node_modules/@deepseek-ai/cordis",
	"node_modules/@deepseek-ai/cordis-plugin-loader",
	"node_modules/@deepseek-ai/cordis-plugin-include",
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const toPosix = (path) => path.split(sep).join("/");

/** Every file a package ships, recursively, without node_modules and without symbolic links. */
export function listPackageFiles(dir) {
	const found = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const child = join(current, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (entry.name === "node_modules") continue;
				walk(child);
			} else if (entry.isFile()) found.push(child);
		}
	};
	walk(dir);
	return found;
}

/**
 * The recorded build identity of an installation: which packages were read, how
 * many files and bytes they hold, and the digest over their content.
 */
export function computeBuildIdentity(installDir, packages = IDENTITY_PACKAGES) {
	const files = [];
	const missing = [];
	for (const pkg of packages) {
		const dir = join(installDir, pkg);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) { missing.push(pkg); continue; }
		for (const file of listPackageFiles(dir)) files.push([toPosix(file.slice(installDir.length + 1)), file]);
	}
	files.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
	const digest = createHash("sha256");
	let bytes = 0;
	for (const [path, file] of files) {
		const content = readFileSync(file);
		bytes += content.length;
		digest.update(path + "\\0" + sha256(content) + "\\n");
	}
	return { algorithm: IDENTITY_ALGORITHM, packages: [...packages], files: files.length, bytes, missing, digest: digest.digest("hex") };
}

/**
 * Locate the installation to check. The running instance is started from
 * <install>/lib/bin.js, so the script this process runs is the strongest anchor
 * and is tried first: nothing - least of all an environment variable - may point
 * the gate at a *different* directory and so hide the code that is executing.
 * DSH_INSTALL is only a fallback for launchers whose argv[1] is not a dsh entry,
 * followed by the directories above the running script.
 */
export function discoverInstallRoot(baseline, { env = process.env, argv1 = process.argv[1] } = {}) {
	const problems = [];
	const candidates = [];
	if (argv1) {
		let script = resolve(argv1);
		try { script = realpathSync(script); } catch {}
		if (script.endsWith(sep + "lib" + sep + "bin.js")) candidates.push(["the script this process runs", dirname(dirname(script))]);
	}
	if (env.DSH_INSTALL) candidates.push(["DSH_INSTALL", resolve(env.DSH_INSTALL)]);
	if (argv1) {
		let script = resolve(argv1);
		try { script = realpathSync(script); } catch {}
		let current = dirname(script);
		for (let level = 0; level < 3; level++) {
			candidates.push(["the directory above the running script", current]);
			current = dirname(current);
		}
	}
	for (const [source, dir] of candidates) {
		const manifest = join(dir, "package.json");
		if (!existsSync(manifest)) continue;
		try {
			const parsed = JSON.parse(readFileSync(manifest, "utf8"));
			if (parsed.name === baseline.package) return { dir, source, problems };
			problems.push(source + " (" + dir + ") holds " + parsed.name + ", not " + baseline.package);
		} catch (error) {
			problems.push(source + " (" + dir + "): package.json cannot be parsed (" + error.message + ")");
		}
	}
	problems.push("cannot locate the installation of " + baseline.package + "; set DSH_INSTALL to the directory that holds lib/bin.js");
	return { dir: null, source: null, problems };
}

/**
 * Compare an installation against the recorded build identity. Returns problems
 * instead of throwing so the terminal entry can print all of them at once.
 */
export function verifyBuildIdentity({ install, baseline, packages }) {
	const problems = [];
	const expected = baseline.buildIdentity;
	if (expected === undefined) return { identity: null, problems: ["the record carries no build identity to compare against"] };
	if (packages !== undefined && JSON.stringify([...packages]) !== JSON.stringify([...expected.packages])) {
		problems.push("the recorded package list differs from the one this build compares against");
	}
	let manifest;
	try { manifest = JSON.parse(readFileSync(join(install, "package.json"), "utf8")); }
	catch (error) { return { identity: null, problems: ["cannot read " + join(install, "package.json") + " (" + error.message + ")"] }; }
	if (manifest.name !== baseline.package) problems.push("installed package is " + manifest.name + ", recorded " + baseline.package);
	if (manifest.version !== baseline.version) problems.push("installed version is " + manifest.version + ", recorded " + baseline.version + " (an installation the replacement was never verified against)");
	const identity = computeBuildIdentity(install, expected.packages);
	for (const pkg of identity.missing) problems.push("the recorded package " + pkg + " is not installed under " + install);
	if (identity.digest !== expected.digest) {
		problems.push("the installed build differs from the recorded build identity: recorded " + expected.digest + " over " + expected.files + " files/" + expected.bytes + " bytes, found " + identity.digest + " over " + identity.files + " files/" + identity.bytes + " bytes");
	}
	return { identity, problems };
}

/** The provenance record shipped next to this package. */
export function readShippedProvenance(relativeTo = import.meta.url) {
	return JSON.parse(readFileSync(new URL("../provenance.json", relativeTo), "utf8"));
}

/**
 * The runtime guard: refuse to serve when the installation is not the recorded
 * build. There is no compatibility exemption and no environment switch that
 * bypasses it (only DSH_INSTALL chooses which installation is inspected).
 */
export function assertBaselineIdentity({ provenance, install, log = console.error } = {}) {
	const record = provenance ?? readShippedProvenance();
	const baseline = record.baseline;
	let dir = install;
	let source = install === undefined ? null : "the installation given to the check";
	if (dir === undefined) {
		const discovered = discoverInstallRoot(baseline);
		dir = discovered.dir;
		source = discovered.source;
		if (dir === null) throw refusal(discovered.problems.join("; "), record);
	}
	const { identity, problems } = verifyBuildIdentity({ install: dir, baseline, packages: IDENTITY_PACKAGES });
	if (problems.length > 0) throw refusal(problems.join("; "), record, { install: dir, source, identity });
	log("[dsh-local-overlay] build identity verified against " + baseline.package + "@" + baseline.version + " (" + (identity?.files ?? "?") + " files, " + (identity?.digest ?? "?").slice(0, 12) + "..., from " + source + ")");
	return { install: dir, source, identity };
}

function refusal(reason, record, extra = {}) {
	const lines = [
		"[dsh-local-overlay] refusing to serve the settings provider: " + reason,
		"[dsh-local-overlay] this installation is not the build this replacement was verified against, so it will not run unverified.",
		"[dsh-local-overlay] recorded build: " + record.baseline.package + "@" + record.baseline.version + " (baseline commit " + record.baseline.commit + ", identity " + record.baseline.buildIdentity?.digest + ")",
	];
	if (extra.install) lines.push("[dsh-local-overlay] inspected installation: " + extra.install + (extra.source ? " (" + extra.source + ")" : ""));
	lines.push("[dsh-local-overlay] recover from the terminal: node tools/overlay.mjs diagnose --home <DSH_HOME> --profile <profile>, then roll back with node tools/overlay.mjs rollback --home <DSH_HOME> --profile <profile>, and re-record after an intentional upgrade with node tools/overlay.mjs record.");
	return new Error(lines.join("\n"));
}
