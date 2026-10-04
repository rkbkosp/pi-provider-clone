import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectRelease } from "../.github/scripts/release-state.js";
import type { CommandResult, Run } from "../.github/scripts/release-state.js";

const ok = (value: unknown): CommandResult => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
const absentNpm = (): CommandResult => ({ status: 1, stdout: JSON.stringify({ error: { code: "E404" } }), stderr: "Not found" });
const absentRelease = (): CommandResult => ({ status: 1, stdout: JSON.stringify({ status: "404" }), stderr: "Not found" });

describe("release state", () => {
  let dir: string;
  let npm: CommandResult;
  let github: CommandResult;
  let releaseSha: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const commit = (version: string, dependency = "1") => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@example/package", version, devDependencies: { example: dependency } }));
    writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n## [${version}]\n\nNotes for ${version}\n\n## [older]\nOld notes\n`);
    git("add", ".");
    git("commit", "-qm", `Package ${version} dependency ${dependency}`);
    return git("rev-parse", "HEAD");
  };
  const run: Run = (command, args) => {
    if (command === "npm") return npm;
    if (command === "gh") return github;
    const result = spawnSync(command, args, { cwd: dir, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "release-state-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Release test");
    commit("0.1.0");
    releaseSha = commit("0.2.0");
    npm = absentNpm();
    github = absentRelease();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("skips an already released version after dependency-only edits", () => {
    git("tag", "-a", "v0.2.0", "-m", "Release");
    commit("0.2.0", "2");
    npm = ok("0.2.0");
    github = ok({ draft: false, tag_name: "v0.2.0" });
    expect(inspectRelease(run, "example/repo")).toMatchObject({ complete: true, release_sha: releaseSha, notes: "" });
  });
  it("accepts npm's one-element array response", () => {
    npm = ok(["0.2.0"]);
    expect(inspectRelease(run, "example/repo").published).toBe(true);
  });
  it("rejects unexpected npm versions", () => {
    npm = ok("0.3.0");
    expect(() => inspectRelease(run, "example/repo")).toThrow("unexpected package version");
  });
  it("plans a genuine new version without skipping", () => {
    expect(inspectRelease(run, "example/repo")).toMatchObject({ complete: false, published: false, released: false, release_sha: releaseSha });
  });
  it("recovers npm-only publication without republishing", () => {
    commit("0.2.0", "2");
    npm = ok("0.2.0");
    expect(inspectRelease(run, "example/repo")).toMatchObject({ complete: false, published: true, released: false, release_sha: releaseSha });
  });
  it("recovers a tag-only partial release from the original source", () => {
    git("tag", "v0.2.0");
    commit("0.2.0", "2");
    expect(inspectRelease(run, "example/repo")).toMatchObject({ complete: false, published: false, release_sha: releaseSha });
  });
  it("recovers a missing GitHub release after tag and npm publication", () => {
    git("tag", "v0.2.0");
    npm = ok("0.2.0");
    expect(inspectRelease(run, "example/repo")).toMatchObject({ complete: false, published: true, released: false });
  });
  it("rejects a tag moved to a dependency-only commit", () => {
    commit("0.2.0", "2");
    git("tag", "v0.2.0");
    expect(() => inspectRelease(run, "example/repo")).toThrow("already exists");
  });
  it("rejects a tag that does not resolve to a commit", () => {
    const blob = git("rev-parse", "HEAD:package.json");
    git("tag", "v0.2.0", blob);
    expect(() => inspectRelease(run, "example/repo")).toThrow("git rev-parse");
  });
  it("resolves a version introduced by a merge to the mainline merge commit", () => {
    git("checkout", "-qb", "version-update");
    commit("0.3.0");
    git("checkout", "-q", "main");
    git("merge", "--no-ff", "-qm", "Merge version update", "version-update");
    const merged = git("rev-parse", "HEAD");
    commit("0.3.0", "2");
    expect(inspectRelease(run, "example/repo").release_sha).toBe(merged);
  });
  it("stops at an intervening version instead of an old reused version", () => {
    commit("0.3.0");
    const reused = commit("0.2.0", "3");
    expect(inspectRelease(run, "example/repo").release_sha).toBe(reused);
  });
  it("fails closed on npm authentication or network errors", () => {
    npm = { status: 1, stdout: JSON.stringify({ error: { code: "E401" } }), stderr: "Unauthorized" };
    expect(() => inspectRelease(run, "example/repo")).toThrow("Cannot determine npm");
  });
  it("fails closed on GitHub errors other than 404", () => {
    github = { status: 1, stdout: JSON.stringify({ status: "403" }), stderr: "Forbidden" };
    expect(() => inspectRelease(run, "example/repo")).toThrow("Cannot determine GitHub");
  });
  it("never treats a draft as a completed release", () => {
    git("tag", "v0.2.0");
    npm = ok("0.2.0");
    github = ok({ draft: true, tag_name: "v0.2.0" });
    expect(() => inspectRelease(run, "example/repo")).toThrow("draft GitHub release");
  });
  it("rejects a GitHub release without a local tag", () => {
    github = ok({ draft: false, tag_name: "v0.2.0" });
    expect(() => inspectRelease(run, "example/repo")).toThrow("tag is missing");
  });
  it("rejects an unfinished release without original notes", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@example/package", version: "0.3.0" }));
    git("add", "."); git("commit", "-qm", "Version without notes");
    expect(() => inspectRelease(run, "example/repo")).toThrow("no release notes");
  });
  it("reads immutable original notes rather than later edits", () => {
    writeFileSync(join(dir, "CHANGELOG.md"), "# Removed or edited after release\n");
    git("add", "."); git("commit", "-qm", "Later changelog edit");
    expect(inspectRelease(run, "example/repo").notes).toBe("Notes for 0.2.0");
  });
});
