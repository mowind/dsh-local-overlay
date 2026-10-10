#!/usr/bin/env node
/**
 * Preflight for the version-bound settings replacement: verify that the DSH
 * baseline this overlay was copied from is byte-for-byte what the copies were
 * taken from, and that our copies differ only in the recorded way.
 *
 * Runs before the target profile switches to the own Web composition, so an
 * installation that does not match the recorded baseline fails loudly instead
 * of silently serving an unverified copy.
 *
 * Usage: node tools/verify-artifacts.mjs [--install <dsh install dir>] [--quiet]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const QUIET = argv.includes("--quiet");

function resolveInstall() {
  const explicit = flag("--install") ?? process.env.DSH_INSTALL;
  if (explicit !== undefined) return resolve(explicit);
  const bin = execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
  const real = execFileSync("readlink", ["-f", bin], { encoding: "utf8" }).trim();
  const marker = "/lib/bin.js";
  if (!real.endsWith(marker)) throw new Error("cannot derive the DSH installation from " + real);
  return real.slice(0, -marker.length);
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const cropToHunks = (text) => { const i = text.indexOf("@@"); return i === -1 ? "" : text.slice(i); };
function unifiedDiff(upstreamPath, localPath) {
  try { return execFileSync("diff", ["-u", upstreamPath, localPath], { encoding: "utf8" }); }
  catch (error) { return typeof error.stdout === "string" ? error.stdout : ""; }
}

const problems = [];
const rows = [];
const provenance = JSON.parse(await readFile(join(ROOT, "provenance.json"), "utf8"));
const install = resolveInstall();
const installed = JSON.parse(await readFile(join(install, "package.json"), "utf8"));
if (installed.version !== provenance.baseline.version) problems.push("baseline version mismatch: installed " + installed.name + "@" + installed.version + ", recorded " + provenance.baseline.version);
if (installed.name !== provenance.baseline.package) problems.push("baseline package mismatch: " + installed.name + " (recorded " + provenance.baseline.package + ")");

for (const entry of provenance.files) {
  const localPath = join(ROOT, entry.path);
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

if (!QUIET) {
  console.log("baseline: " + provenance.baseline.package + "@" + provenance.baseline.version + " (commit " + provenance.baseline.commit + ", " + provenance.baseline.license + ")");
  console.log("installation: " + install);
  for (const [kind, path, status] of rows) console.log("  " + status.padEnd(5) + " " + kind.padEnd(9) + path);
}
if (problems.length > 0) {
  console.error("");
  console.error("provenance verification FAILED (" + problems.length + " problem(s)):");
  for (const problem of problems) console.error("  - " + problem);
  process.exit(1);
}
const modified = provenance.files.filter((entry) => entry.kind === "modified").length;
console.log("");
console.log("provenance verification PASSED: " + provenance.files.length + " recorded files (" + modified + " deliberately modified, " + (provenance.files.length - modified) + " byte-identical) match the installed baseline " + provenance.baseline.package + "@" + provenance.baseline.version);
