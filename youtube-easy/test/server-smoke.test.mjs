import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDefaultHandlers, handleMessage } from "../src/server.js";
import { TOOL_NAMES } from "../src/catalog.js";

const entry = fileURLToPath(new URL("../src/server.js", import.meta.url));

function smoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server smoke timed out; stderr=${stderr}`));
    }, 5_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code && !stdout) return reject(new Error(`server exited ${code}; stderr=${stderr}`));
      resolve(stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
    });
    child.stdin.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      "",
    ].join("\n"));
  });
}

test("MCP initialize and tools/list expose all required YouTube Easy tools", async () => {
  const responses = await smoke();
  const init = responses.find((r) => r.id === 1);
  const listed = responses.find((r) => r.id === 2);
  assert.equal(init.result.serverInfo.name, "youtube-easy");
  assert.equal(init.result.serverInfo.version, "0.1.0");

  const names = listed.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "delete_video", "get_channel", "get_comments", "get_my_videos", "get_transcript",
    "get_upload_status", "get_video", "reply_to_comment", "schedule_video", "search_youtube",
    "set_thumbnail", "update_video", "upload_short", "upload_video", "youtube_forget_session",
    "youtube_login", "youtube_status",
  ]);
});

test("default runtime wires every declared tool without starting the browser", () => {
  const handlers = createDefaultHandlers({
    browser: {
      stateDir: "C:/youtube-easy-test-state",
      profileDir: "C:/youtube-easy-test-state/browser-profile",
    },
  });
  assert.deepEqual(Object.keys(handlers).sort(), [...TOOL_NAMES].sort());
  for (const name of TOOL_NAMES) assert.equal(typeof handlers[name], "function", name);
});

test("preserved draft outcomes are returned as structured MCP errors", async () => {
  const error = new Error("Stopped before publication");
  error.outcome = { status: "draft_preserved", result: { videoId: "abc123xyz89" }, message: error.message };
  const response = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "upload_short", arguments: {} } }, {
    upload_short: async () => { throw error; },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /draft_preserved/);
  assert.match(response.result.content[0].text, /abc123xyz89/);
});
