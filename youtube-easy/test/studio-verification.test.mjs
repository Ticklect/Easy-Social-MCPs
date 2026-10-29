import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyUploadState,
  verifyEditState,
  commitOnlyAfterVerification,
  StudioAdapter,
  STUDIO_SELECTORS,
} from "../src/studio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const actual = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "upload-state.json"), "utf8"));
const expected = {
  filePath: "C:\\media\\launch.mp4",
  fileSize: 1234567,
  title: "Launch video",
  description: "A carefully verified description.",
  madeForKids: false,
  visibility: "private",
  thumbnailPath: "C:\\media\\launch-thumb.png",
  playlist: "Product demos",
  tags: ["launch", "demo"],
};

test("exact Studio state passes and returns persisted video identifiers", () => {
  const verified = verifyUploadState(expected, actual);
  assert.equal(verified.videoId, "abc123xyz89");
  assert.equal(verified.studioUrl, "https://studio.youtube.com/video/abc123xyz89/edit");
  assert.equal(verified.publicUrl, "https://youtu.be/abc123xyz89");
});

test("verification errors identify that no final Studio action was sent", () => {
  let error;
  try { verifyUploadState(expected, { ...actual, visibility: null }); }
  catch (caught) { error = caught; }
  assert.equal(error?.finalActionNotSent, true);
});

test("Studio readback failures are marked pre-commit and never invoke the final action", async () => {
  let commits = 0;
  let caught;
  try {
    await commitOnlyAfterVerification({
      readState: async () => { throw new Error("CDP readback failed"); },
      expected,
      commit: async () => { commits++; },
    });
  } catch (error) { caught = error; }
  assert.equal(caught?.finalActionNotSent, true);
  assert.equal(commits, 0);
});

const mismatches = [
  ["selected filename", { fileName: "other.mp4" }],
  ["selected file size", { fileSize: 123 }],
  ["title", { title: "Launch video " }],
  ["description", { description: "different" }],
  ["audience", { madeForKids: true }],
  ["visibility", { visibility: "public" }],
  ["thumbnail", { thumbnailFileName: "other.png" }],
  ["playlist", { playlist: "Other list" }],
  ["tags", { tags: ["launch"] }],
];

for (const [label, mutation] of mismatches) {
  test(`verification failure for ${label} prevents the final publish action`, async () => {
    let commits = 0;
    await assert.rejects(() => commitOnlyAfterVerification({
      readState: async () => ({ ...actual, ...mutation }),
      expected,
      verify: verifyUploadState,
      commit: async () => { commits++; },
    }), /Verification failed/);
    assert.equal(commits, 0);
  });
}

test("scheduled publication requires exact instant and a re-readable time zone", async () => {
  const scheduledExpected = { ...expected, visibility: "public", publishAt: "2030-06-07T14:30:00+02:00" };
  const scheduledActual = {
    ...actual,
    visibility: "scheduled",
    publishAt: "2030-06-07T12:30:00Z",
    scheduleTimeZone: "GMT+02:00",
  };
  assert.equal(verifyUploadState(scheduledExpected, scheduledActual).visibility, "scheduled");

  for (const mutation of [
    { publishAt: "2030-06-07T12:31:00Z" },
    { scheduleTimeZone: null },
    { visibility: "private" },
  ]) {
    let commits = 0;
    await assert.rejects(() => commitOnlyAfterVerification({
      readState: async () => ({ ...scheduledActual, ...mutation }),
      expected: scheduledExpected,
      verify: verifyUploadState,
      commit: async () => { commits++; },
    }), /Verification failed/);
    assert.equal(commits, 0);
  }
});

test("edit verification checks only requested fields but rejects unreadable requested controls", () => {
  assert.deepEqual(verifyEditState({ title: "New title", madeForKids: true }, { title: "New title", madeForKids: true, visibility: "private" }), { title: "New title", madeForKids: true, visibility: "private" });
  assert.throws(() => verifyEditState({ title: "New title" }, { title: null }), /Verification failed/);
  assert.throws(() => verifyEditState({ tags: ["one", "two"] }, { tags: null }), /Verification failed/);
});

test("Studio adapter reads a structured upload state and commits only after verification", async () => {
  let commits = 0;
  const client = {
    async evaluate(expression) {
      if (expression.includes("__youtubeEasyReadUploadState")) return actual;
      if (expression.includes("__youtubeEasyClickFinalUpload")) { commits++; return { clicked: true, label: "Save" }; }
      throw new Error("unexpected expression");
    },
  };
  const adapter = new StudioAdapter({ client, sleepFn: async () => {} });
  const result = await adapter.commitUpload(expected);
  assert.equal(result.videoId, "abc123xyz89");
  assert.equal(commits, 1);
});

test("Studio adapter never clicks a final control when its state reader is ambiguous", async () => {
  let commits = 0;
  const client = {
    async evaluate(expression) {
      if (expression.includes("__youtubeEasyReadUploadState")) return { ...actual, visibility: null };
      if (expression.includes("__youtubeEasyClickFinalUpload")) { commits++; return { clicked: true }; }
      throw new Error("unexpected expression");
    },
  };
  const adapter = new StudioAdapter({ client, sleepFn: async () => {} });
  await assert.rejects(() => adapter.commitUpload(expected), /Verification failed/);
  assert.equal(commits, 0);
});

test("Studio adapter accepts a verified 24-character UC channel ID for the direct upload page", async () => {
  let navigated;
  const client = { async evaluate() { return true; } };
  const browser = { async navigate(_client, url) { navigated = url; return url; } };
  const adapter = new StudioAdapter({ client, browser, sleepFn: async () => {} });
  const channelId = `UC${"A".repeat(22)}`;
  await adapter.openUploadDialog(channelId);
  assert.equal(navigated, `https://studio.youtube.com/channel/${channelId}/videos/upload`);
});

test("upload selector wait observes late DOM readiness and disconnects without redundant CDP requests", async () => {
  let mounted = false;
  let evaluations = 0;
  let checks = 0;
  const observers = new Set();
  const document = {
    documentElement: {},
    querySelector(selector) {
      assert.equal(selector, "#upload-input");
      checks++;
      return mounted ? { type: "file" } : null;
    },
  };
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const client = {
    async evaluate(script) {
      evaluations++;
      return await new Function("document", "MutationObserver", "setTimeout", "clearTimeout", `return (${script})`)(
        document, Observer, setTimeout, clearTimeout);
    },
  };
  const timer = setTimeout(() => {
    mounted = true;
    for (const observer of [...observers]) observer.callback([{ type: "childList" }]);
  }, 45);
  try {
    const result = await new StudioAdapter({ client }).waitFor('Boolean(document.querySelector("#upload-input"))', "upload input");
    assert.equal(result, true);
    assert.equal(evaluations, 1, "one pending CDP evaluation should observe the ready element");
    assert.ok(checks >= 2, "must check both before and after observer subscription");
    assert.equal(observers.size, 0);
  } finally { clearTimeout(timer); }
});

test("selector wait respects its deadline and leaves no pending observer", async () => {
  const observers = new Set();
  const document = { documentElement: {}, querySelector: () => null };
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const client = {
    async evaluate(script) {
      return await new Function("document", "MutationObserver", "setTimeout", "clearTimeout", `return (${script})`)(
        document, Observer, setTimeout, clearTimeout);
    },
  };
  const started = Date.now();
  await assert.rejects(() => new StudioAdapter({ client }).waitFor('Boolean(document.querySelector("#missing"))', "missing", 70), /Timed out waiting for missing/);
  assert.ok(Date.now() - started < 400, "bounded deadline should not stall the browser");
  assert.equal(observers.size, 0);
});

test("selector wait fails promptly on debugger closure or a YouTube cooldown during evaluation", async () => {
  let calls = 0;
  const disconnected = { ws: {}, async evaluate() {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 15));
    this.ws = null;
    throw new Error("Browser debugger connection closed.");
  } };
  await assert.rejects(() => new StudioAdapter({ client: disconnected }).waitFor("Boolean(false)", "input"), /connection closed/);
  assert.equal(calls, 1, "no retry after debugger disconnect");

  const cooldown = new Error("YouTube returned HTTP 429");
  const throttled = { youtubeThrottle: null, async evaluate() {
    this.youtubeThrottle = cooldown;
    return true;
  } };
  await assert.rejects(() => new StudioAdapter({ client: throttled }).waitFor("Boolean(true)", "input"), (error) => error === cooldown);
});

test("a pending DOM selector wait reports a mid-flight 429 and cleans its observer", async () => {
  const observers = new Set();
  const document = { documentElement: {}, querySelector: () => null };
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const throttle = new Error("HTTP 429: shared cooldown");
  const client = {
    youtubeThrottle: null,
    async evaluate(script) {
      return await new Function("document", "MutationObserver", "setTimeout", "clearTimeout", `return (${script})`)(
        document, Observer, setTimeout, clearTimeout);
    },
  };
  const timer = setTimeout(() => { client.youtubeThrottle = throttle; }, 40);
  const started = Date.now();
  try {
    await assert.rejects(() => new StudioAdapter({ client }).waitFor('Boolean(document.querySelector("#upload-input"))', "input"), (error) => error === throttle);
    assert.ok(Date.now() - started < 600, "bounded evaluation must notice cooldown promptly");
    assert.equal(observers.size, 0);
  } finally { clearTimeout(timer); }
});

test("heavy unrelated DOM mutations coalesce selector scans and never mark an absent control ready", async () => {
  let evaluations = 0;
  let checked = 0;
  const observers = new Set();
  const document = { documentElement: {}, querySelector() { checked++; return null; } };
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const client = { async evaluate(script) {
    evaluations++;
    return await new Function("document", "MutationObserver", "setTimeout", "clearTimeout", `return (${script})`)(
      document, Observer, setTimeout, clearTimeout);
  } };
  const changes = setInterval(() => {
    for (let i = 0; i < 30; i++) for (const observer of [...observers]) observer.callback([{ type: "attributes" }]);
  }, 1);
  try {
    await assert.rejects(() => new StudioAdapter({ client }).waitFor('Boolean(document.querySelector("#not-ready"))', "not ready", 90), /Timed out/);
    assert.equal(observers.size, 0);
    assert.ok(checked < 20, `mutation storm must not trigger unbounded selector scans (${checked})`);
    assert.ok(evaluations <= 2, `runtime evaluations should be bounded (${evaluations})`);
  } finally { clearInterval(changes); }
});

test("thumbnail and schedule commits reuse the same fail-closed edit gate", async () => {
  let saves = 0;
  let state = { thumbnailFileName: "thumb.png", visibility: "private" };
  const client = {
    async evaluate(expression) {
      if (expression.includes("__youtubeEasyReadEditState")) return state;
      if (expression.includes("__youtubeEasyClickSemantic")) { saves++; return { clicked: true, label: "Save" }; }
      throw new Error("unexpected expression");
    },
  };
  const adapter = new StudioAdapter({ client, sleepFn: async () => {} });
  assert.equal((await adapter.commitThumbnail({ thumbnailFileName: "thumb.png" })).thumbnailFileName, "thumb.png");
  state = { visibility: "scheduled", publishAt: "2030-06-07T12:30:00Z", scheduleTimeZone: "UTC" };
  assert.equal((await adapter.commitSchedule({ publishAt: "2030-06-07T12:30:00Z" })).visibility, "scheduled");
  assert.equal(saves, 2);
});

test("Studio video reads include bounded processing and checks status", async () => {
  const client = {
    async evaluate(expression) {
      if (expression.includes("__youtubeEasyReadEditState")) return { title: "Upload", visibility: "private" };
      if (expression.includes("__youtubeEasyReadProcessingState")) return { uploadStatus: "Processing 42%", checksStatus: "Checks complete" };
      if (expression.includes("__youtubeEasyVideoPresence")) return { status: "exists" };
      if (expression.includes("document.querySelector")) return true;
      throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
    },
  };
  const browser = { async navigate(_client, url) { return url; } };
  const adapter = new StudioAdapter({ client, browser, sleepFn: async () => {} });
  const result = await adapter.readVideo("abc123xyz89");
  assert.equal(result.uploadStatus, "Processing 42%");
  assert.equal(result.checksStatus, "Checks complete");
});

test("all core Studio extraction scripts compile after template interpolation", async () => {
  const client = {
    async evaluate(expression) {
      assert.doesNotThrow(() => new Function(expression));
      if (expression.includes("__youtubeEasyStatus")) return { loggedIn: false };
      if (expression.includes("__youtubeEasyReadUploadState")) return {};
      if (expression.includes("__youtubeEasyReadEditState")) return {};
      if (expression.includes("__youtubeEasyListContent")) return [];
      return true;
    },
  };
  const browser = { async navigate(_client, url) { return url; } };
  const adapter = new StudioAdapter({ client, browser, sleepFn: async () => {} });
  await adapter.getStatus();
  await adapter.readUploadState();
  await adapter.readEditState();
  await adapter.listContent();
});

test("duplicate visible metadata controls fail closed before upload commit", async () => {
  const node = () => ({
    isContentEditable: true,
    textContent: "",
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    getAttribute: () => "false",
    focus() {}, click() {}, dispatchEvent() {},
  });
  const titleA = node();
  const titleB = node();
  const description = node();
  const audience = node();
  const document = {
    querySelectorAll(selector) {
      if (selector === STUDIO_SELECTORS.title) return [titleA, titleB];
      if (selector === STUDIO_SELECTORS.description) return [description];
      if (selector.includes("VIDEO_MADE_FOR_KIDS_NOT_MFK")) return [audience];
      return [];
    },
  };
  const client = {
    async evaluate(expression) {
      return new Function("document", "getComputedStyle", "InputEvent", "Event", `return ${expression}`)(
        document,
        () => ({ display: "block", visibility: "visible" }),
        class {},
        class {},
      );
    },
  };
  const adapter = new StudioAdapter({ client, sleepFn: async () => {} });
  await assert.rejects(() => adapter.fillUploadDetails({ title: "Title", description: "Description", madeForKids: false, tags: [] }), /unambiguous/);
});

test("delete is not reported successful until Studio confirms absence", async () => {
  const client = {
    async evaluate(expression) {
      assert.doesNotThrow(() => new Function(expression));
      if (expression.includes("__youtubeEasyReadEditState")) return { title: "Original" };
      if (expression.includes("__youtubeEasyClickSemantic")) return { clicked: true };
      if (expression.includes("__youtubeEasyPrepareDelete")) return { ready: true };
      if (expression.includes("__youtubeEasyConfirmDelete")) return { status: "exists" };
      if (expression.includes("__youtubeEasyVideoPresence")) return { status: "exists" };
      if (expression.includes("document.querySelector")) return true;
      throw new Error("unexpected expression");
    },
  };
  const browser = { async navigate(_client, url) { return url; } };
  const adapter = new StudioAdapter({ client, browser, sleepFn: async () => {} });
  await assert.rejects(() => adapter.deleteVideo("abc123xyz89", "Original"), /did not confirm/);
});

test("only an exact Studio error component produces typed VIDEO_NOT_FOUND", async () => {
  let state = "absent";
  const client = { async evaluate(expression) {
    if (expression.includes("__youtubeEasyVideoPresence")) return { status: state };
    throw new Error("unexpected expression");
  } };
  const browser = { async navigate(_client, url) { return url; } };
  const adapter = new StudioAdapter({ client, browser, sleepFn: async () => {} });
  await assert.rejects(() => adapter.readVideo("abc123xyz89"), (error) => error.code === "VIDEO_NOT_FOUND");
  state = "unknown";
  await assert.rejects(() => adapter.readVideo("abc123xyz89"), (error) => error.code !== "VIDEO_NOT_FOUND" && /unambiguous/.test(error.message));
});

test("reply reconciliation requires exact text and the signed-in channel ID", async () => {
  let expression;
  const client = { async evaluate(value) { expression = value; return { status: "not_found" }; } };
  const adapter = new StudioAdapter({ client, sleepFn: async () => {} });
  await adapter.findReply("comment-1", "Thanks", { channelId: `UC${"A".repeat(22)}` });
  assert.doesNotThrow(() => new Function(expression));
  assert.match(expression, /===clean\(wanted\)/);
  assert.match(expression, /links\[0\]===channelId/);
});

test("upload fallback stays uncertain when Studio cannot expose the local file fingerprint", async () => {
  const adapter = new StudioAdapter({ client: { evaluate: async () => [] }, sleepFn: async () => {} });
  const requestedAt = Date.now();
  adapter.listContent = async () => [{
    videoId: "abc123xyz89",
    title: "Launch",
    visibility: "private",
    createdAt: new Date(requestedAt + 1_000).toISOString(),
  }];
  assert.equal((await adapter.findVideoByIntent({ title: "Launch", visibility: "private", requestedAt, fileFingerprint: "abc" })).status, "unknown");
  assert.equal((await adapter.findVideoByIntent({ title: "Launch", visibility: "public", requestedAt })).status, "unknown");
  assert.equal((await adapter.findVideoByIntent({ title: "Launch", visibility: "private" })).status, "unknown");
});

test("duplicate visible schedule inputs fail closed", async () => {
  const element = (label) => ({
    placeholder: "",
    value: "",
    getAttribute: (name) => name === "aria-label" ? label : "false",
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    focus() {}, click() {}, dispatchEvent() {},
  });
  const radio = element("schedule");
  const document = { querySelectorAll: (selector) => selector === "input" ? [element("Date"), element("Date"), element("Time")] : [radio] };
  const client = { async evaluate(expression) {
    return new Function("document", "getComputedStyle", "InputEvent", "Event", `return ${expression}`)(document, () => ({ display: "block", visibility: "visible" }), class {}, class {});
  } };
  const adapter = new StudioAdapter({ client, sleepFn: async () => {} });
  await assert.rejects(() => adapter.setUploadVisibility({ visibility: "public", publishAt: "2030-06-07T12:30:00Z" }), /schedule-inputs/);
});
