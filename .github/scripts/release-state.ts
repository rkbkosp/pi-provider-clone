import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type Run = (command: string, args: string[]) => CommandResult;

export function inspectRelease(run: Run, repository: string) {
  const required = (command: string, args: string[]) => {
    const result = run(command, args);
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  };
  const manifestAt = (ref: string) => JSON.parse(required("git", ["show", `${ref}:package.json`])) as { name: string; version: string };
  const { name, version } = manifestAt("HEAD");
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid package name or release version");
  }
  // Dependency edits must not move the release identity. Follow main's history,
  // stopping at the previous version (also handles a deliberately reused version).
  const history = required("git", ["log", "--first-parent", "--format=%H", "--", "package.json"]).split("\n");
  let releaseSha = "";
  for (const sha of history) {
    const manifest = manifestAt(sha);
    if (manifest.version !== version || manifest.name !== name) break;
    releaseSha = sha;
  }
  if (!releaseSha) throw new Error("Cannot find the release version commit");
  const tag = `v${version}`;
  const tagResult = run("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]);
  const tagged = tagResult.status === 0;
  if (!tagged && tagResult.status !== 1) throw new Error(`Cannot inspect ${tag}: ${tagResult.stderr}`);
  if (tagged) {
    const taggedSha = required("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
    if (taggedSha !== releaseSha) throw new Error(`${tag} already exists at ${taggedSha}, expected ${releaseSha}`);
  }

  const npm = run("npm", ["view", `${name}@${version}`, "version", "--json"]);
  let published = false;
  if (npm.status === 0) {
    const value: unknown = JSON.parse(npm.stdout);
    // npm 12 wraps field queries in an array; older npm returns a scalar.
    published = (Array.isArray(value) && value.length === 1 ? value[0] : value) === version;
    if (!published) throw new Error("npm returned an unexpected package version");
  } else {
    let code: unknown;
    try { code = (JSON.parse(npm.stdout) as { error?: { code?: string } }).error?.code; } catch { /* Fail closed below. */ }
    if (code !== "E404") throw new Error(`Cannot determine npm publication state: ${npm.stderr || npm.stdout}`);
  }

  const github = run("gh", ["api", `repos/${repository}/releases/tags/${tag}`]);
  let released = false;
  if (github.status === 0) {
    const release = JSON.parse(github.stdout) as { draft: boolean; tag_name: string };
    if (release.tag_name !== tag || release.draft) throw new Error("Unexpected or draft GitHub release; review it manually");
    released = true;
  } else {
    let status: unknown;
    try { status = (JSON.parse(github.stdout) as { status?: string }).status; } catch { /* Fail closed below. */ }
    if (String(status) !== "404") throw new Error(`Cannot determine GitHub release state: ${github.stderr || github.stdout}`);
  }
  if (released && !tagged) throw new Error("GitHub release exists but its tag is missing");
  const complete = tagged && published && released;
  if (complete) return { version, package: name, tag, release_sha: releaseSha, published, released, complete, notes: "" };
  const changelog = required("git", ["show", `${releaseSha}:CHANGELOG.md`]);
  const marker = `## [${version}]`;
  const section = changelog.split("\n").findIndex(line => line.startsWith(marker));
  const notes = section < 0 ? "" : changelog.split("\n").slice(section + 1).join("\n").split(/^## \[/m)[0]?.trim();
  if (!notes) throw new Error(`CHANGELOG.md has no release notes for ${version}`);
  return { version, package: name, tag, release_sha: releaseSha, published, released, complete, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run: Run = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const state = inspectRelease(run, process.env.GITHUB_REPOSITORY ?? "");
  const output = process.env.GITHUB_OUTPUT;
  const notesPath = process.argv[2];
  if (!output || !notesPath) throw new Error("GITHUB_OUTPUT and release notes path are required");
  const { notes, ...outputs } = state;
  appendFileSync(output, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
  writeFileSync(notesPath, `${notes}\n`);
  process.stdout.write(state.complete ? `${state.tag} is already fully released; skipping.\n` : `Resume ${state.tag} from ${state.release_sha}.\n`);
}
