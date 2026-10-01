import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "scripts/security-test-membership.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const totalFiles = manifest.groups.reduce((sum, group) => sum + group.files.length, 0);

const runners = {
  node: (files) => [process.execPath, ["--test", ...files]],
  "backend-vitest": (files) => [
    "npm",
    ["test", "--prefix", "backend", "--", "--maxWorkers=1", ...files],
  ],
  "frontend-vitest": (files) => [
    "npm",
    ["test", "--prefix", "frontend", "--", "--maxWorkers=1", ...files],
  ],
  "word-node": (files) => [process.execPath, ["--test", ...files]],
};

console.log(`Pinned security suite: ${totalFiles} files in ${manifest.groups.length} groups.`);
for (const group of manifest.groups) {
  const resolveCommand = runners[group.runner];
  if (!resolveCommand) throw new Error(`Unknown pinned suite runner: ${group.runner}`);
  const [command, args] = resolveCommand(group.files);
  const cwd = group.runner === "word-node" ? path.join(root, "word-addin") : root;
  console.log(`\n[${group.name}] ${group.files.length} file(s)`);
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`\nPinned security group failed: ${group.name} (exit ${result.status ?? "unknown"}).`);
    process.exit(result.status ?? 1);
  }
}
console.log(`\nPinned security suite passed: ${totalFiles} files across ${manifest.groups.length} groups.`);
