import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pluginManifests = [
  "manifest.json",
  "x-easy/manifest.json",
  "tiktok-easy/manifest.json",
  "youtube-easy/manifest.json",
];

test("all manifest-declared Easy Social MCP tool names are unique", () => {
  const owners = new Map();
  for (const manifestPath of pluginManifests) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), "utf8"));
    // TikTok currently derives its catalog at runtime instead of declaring
    // entries in its package manifest.
    for (const { name } of manifest.tools ?? []) {
      assert.ok(!owners.has(name), `MCP tool "${name}" collides between ${owners.get(name)} and ${manifestPath}`);
      owners.set(name, manifestPath);
    }
  }

  assert.equal(owners.get("reddit_create_post"), "manifest.json");
  assert.equal(owners.get("x_create_post"), "x-easy/manifest.json");
  assert.equal(owners.get("reddit_reply_to_post"), "manifest.json");
  assert.equal(owners.get("x_reply_to_post"), "x-easy/manifest.json");
});
