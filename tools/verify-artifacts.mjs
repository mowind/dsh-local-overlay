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
 * It also pins what the two packages would actually publish: npm pack must
 * contain exactly the recorded copies plus the files we authored, and each
 * package must ship a provenance.json identical to the repository one.
 *
 * Usage: node tools/verify-artifacts.mjs [--install <dsh install dir>] [--provenance <file>] [--quiet]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const QUIET = argv.includes("--quiet");
/* Authored files are the only ones allowed to be published without a recorded upstream counterpart. */
const AUTHORED = ["package.json", "NOTICE", "provenance.json"];
const PACKAGES = ["packages/dsh-client-ui-settings", "packages/dsh-web-composition"];

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

/* What npm pack would publish for one package, so an unrecorded extra file cannot slip into a tarball. */
function firstJsonValue(text) {
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
/* npm prints the tarball name around the JSON, and older npm prints an array while newer npm prints an object keyed by package name. */
function listPacked(dir) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--pack-destination", tmpdir()], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(firstJsonValue(out));
  const record = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  return record.files.map((file) => file.path).sort();
}

const problems = [];
const rows = [];
const PROVENANCE = resolve(flag("--provenance") ?? join(ROOT, "provenance.json"));
const provenance = JSON.parse(await readFile(PROVENANCE, "utf8"));
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

for (const dir of PACKAGES) {
  const recorded = provenance.files.filter((entry) => entry.path.startsWith(dir + "/")).map((entry) => entry.path.slice(dir.length + 1));
  const expected = [...recorded, ...AUTHORED].sort();
  const packed = listPacked(join(ROOT, dir));
  const missing = expected.filter((path) => !packed.includes(path));
  const extra = packed.filter((path) => !expected.includes(path));
  if (missing.length > 0) problems.push(dir + ": npm pack would not include the recorded file(s) " + missing.join(", "));
  if (extra.length > 0) problems.push(dir + ": npm pack would include unrecorded file(s) " + extra.join(", "));
  rows.push([missing.length + extra.length === 0 ? "ok" : "FAIL", "packed", dir + " (" + packed.length + " files)"]);
  const shipped = sha256(await readFile(join(ROOT, dir, "provenance.json")));
  if (shipped !== sha256(await readFile(PROVENANCE))) problems.push(dir + "/provenance.json differs from " + relative(ROOT, PROVENANCE));
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
