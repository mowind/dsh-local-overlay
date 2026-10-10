#!/usr/bin/env node
/**
 * Verify the repository record against an installed DSH build.
 *
 * This used to hold the checks; they now live in tools/lib/preflight.mjs, which both this CLI and
 * tools/overlay.mjs call, so the preflight an operator runs by hand and the preflight "enable" runs
 * before it touches a profile are literally the same code.
 *
 * Usage: node tools/verify-artifacts.mjs [--install DIR] [--provenance FILE] [--quiet]
 *   --install     the DSH installation to compare with (default: $DSH_INSTALL or the dsh on PATH)
 *   --provenance  the record to verify against (default: the repository's provenance.json)
 *   --quiet       print only the verdict line
 * Exit code: 0 when every check passes, 1 when any check fails.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { passLine, reportLines, resolveInstallDir, runPreflight } from "./lib/preflight.mjs";

const argv = process.argv.slice(2);
const argValue = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const QUIET = argv.includes("--quiet");
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROVENANCE = resolve(argValue("--provenance") ?? join(ROOT, "provenance.json"));
const install = resolveInstallDir({ install: argValue("--install") });

const report = await runPreflight({ root: ROOT, provenancePath: PROVENANCE, install });
if (!QUIET) for (const line of reportLines(report)) console.log(line);
if (report.problems.length > 0) {
	console.error("");
	console.error("provenance verification FAILED (" + report.problems.length + " problem(s)):");
	for (const problem of report.problems) console.error("  - " + problem);
	process.exit(1);
}
console.log("");
console.log(passLine(report));
