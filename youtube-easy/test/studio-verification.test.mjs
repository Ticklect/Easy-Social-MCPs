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
