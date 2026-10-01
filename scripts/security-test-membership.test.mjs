import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(root, "scripts/security-test-membership.json"), "utf8"),
);
const sourceRoots = ["backend/src", "frontend/src", "word-addin/src", "e2e", "word-addin/e2e", "scripts"];
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
]);
const testName = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function repositoryPath(group, relativePath) {
  if (group.runner === "backend-vitest") return path.join("backend", relativePath);
  if (group.runner === "frontend-vitest") return path.join("frontend", relativePath);
  if (group.runner === "word-node") return path.join("word-addin", relativePath);
  return relativePath;
}

function isSecurityTestPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  const parts = normalized.toLowerCase().split("/");
  const basename = parts.at(-1) ?? "";
  return (
    parts.some((part) => ["security", "security-tests", "__security_tests__"].includes(part)) ||
    basename.includes(".security.test.") ||
    basename.startsWith("security-")
  );
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else if (entry.isFile() && testName.test(entry.name)) files.push(absolute);
  }
  return files;
}

test("pinned security membership includes every test in the security-test convention", async () => {
  assert.equal(manifest.version, 1);
  assert.ok(Array.isArray(manifest.groups) && manifest.groups.length > 0);

  const listed = manifest.groups.flatMap((group) =>
    group.files.map((relativePath) => repositoryPath(group, relativePath)),
  );
  assert.equal(new Set(listed).size, listed.length, "a test file appears in more than one group");
  for (const group of manifest.groups) {
    for (const relativePath of group.files) {
      const fullPath = repositoryPath(group, relativePath);
      assert.equal(path.isAbsolute(fullPath), false, `absolute path in manifest: ${relativePath}`);
      assert.equal(fullPath.split(/[\\/]/).includes(".."), false, `path traversal in manifest: ${relativePath}`);
      assert.equal(await stat(path.join(root, fullPath)).then(() => true, () => false), true, `missing pinned test: ${fullPath}`);
    }
  }

  const discovered = [];
  for (const sourceRoot of sourceRoots) {
    const absolute = path.join(root, sourceRoot);
    if (!(await stat(absolute).then(() => true, () => false))) continue;
    for (const file of await walk(absolute)) {
      const relativePath = path.relative(root, file);
      if (isSecurityTestPath(relativePath)) discovered.push(relativePath.split(path.sep).join("/"));
    }
  }

  const missing = discovered.filter((relativePath) => !listed.includes(relativePath));
  assert.deepEqual(missing, [], `security-convention tests missing from the pinned suite: ${missing.join(", ")}`);
});
