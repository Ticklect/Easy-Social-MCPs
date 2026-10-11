import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

for (const [label, filename] of [
  ["Reddit", "src/index.js"],
  ["X", "x-easy/src/index.js"],
]) {
  test(`${label} defaults to the current browser and requires explicit opt-in for a second profile`, async () => {
    const source = fs.readFileSync(path.join(root, filename), "utf8");
    const begin = source.indexOf("async function connectExistingBrowserPort() {");
    const end = source.indexOf("\nfunction isExternalPort(port)", begin);
    assert.ok(begin > -1 && end > begin);
    const section = source.slice(begin, end);
    const makeConnect = new Function("existingBrowserPort", "process", "fs", "path", "dataRoot", "fetchJson", "validateLocalDebuggerWs", "findAlreadyOpenBrowser", "discoveredExternalPort", `${section}; return connectExistingBrowserPort;`);
    const calls = [];
    const base = [() => null, null, { existsSync: () => false }, path,
      () => "/no-companion", async () => null, () => {}, async () => { calls.push("discovered"); return null; }, null];
    const normal = makeConnect(...base.map((v, i) => i === 1 ? { env: {} } : v));
    await assert.rejects(normal(), /could not access your current signed-in browser/);
    assert.deepEqual(calls, ["discovered"]);
    const separate = makeConnect(...base.map((v, i) => i === 1 ? { env: { EASY_SOCIAL_BROWSER_MODE: "dedicated" } } : v));
    assert.equal(await separate(), null);
    assert.deepEqual(calls, ["discovered"], "Explicit dedicated mode must not inspect an existing profile");
    const explicitPort = makeConnect(...base.map((v, i) => i === 0 ? () => 43111 : i === 1 ? { env: { EASY_SOCIAL_BROWSER_MODE: "dedicated" } } : v));
    assert.equal(await explicitPort(), null, "Explicit dedicated mode overrides a previous debugger setting");
  });
}
