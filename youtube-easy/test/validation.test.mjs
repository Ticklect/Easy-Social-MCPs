import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseGoogleYoutubeUrl,
  validateDebuggerWs,
  validateUploadInput,
  validateShortMetadata,
} from "../src/validation.js";

test("accepts only strict HTTPS Google and YouTube hosts", () => {
  for (const url of [
    "https://youtube.com/watch?v=abc",
    "https://studio.youtube.com/channel/UC123",
    "https://youtu.be/abc",
    "https://accounts.google.com/signin",
    "https://ssl.gstatic.com/",
    "https://lh3.googleusercontent.com/a/photo",
  ]) {
    assert.equal(parseGoogleYoutubeUrl(url).protocol, "https:");
  }

  for (const url of [
    "http://youtube.com/watch?v=abc",
    "https://studio.youtube.com.evil.test/",
    "https://evilyoutube.com/",
    "https://google.com.evil.test/",
    "file:///tmp/video.mp4",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => parseGoogleYoutubeUrl(url), /HTTPS Google\/YouTube URL/);
  }
});

test("accepts only an exact loopback debugger port", () => {
  assert.equal(validateDebuggerWs("ws://127.0.0.1:43117/devtools/page/1", 43117), "ws://127.0.0.1:43117/devtools/page/1");
  assert.equal(validateDebuggerWs("ws://localhost:43117/devtools/page/1", 43117), "ws://localhost:43117/devtools/page/1");
  assert.throws(() => validateDebuggerWs("ws://192.168.1.3:43117/devtools/page/1", 43117), /non-local/);
  assert.throws(() => validateDebuggerWs("ws://127.0.0.1:9222/devtools/page/1", 43117), /port/);
  assert.throws(() => validateDebuggerWs("https://127.0.0.1:43117/", 43117), /WebSocket/);
});

test("normalizes a valid upload request and requires explicit safety fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-input-"));
  const video = path.join(root, "clip.mp4");
  const thumbnail = path.join(root, "thumb.png");
  fs.writeFileSync(video, Buffer.from("video bytes"));
  fs.writeFileSync(thumbnail, Buffer.from("image bytes"));

  const result = validateUploadInput({
    file_path: video,
    title: "A safe title",
    description: "Description",
    visibility: "unlisted",
    made_for_kids: false,
    thumbnail_path: thumbnail,
    playlist: "Uploads",
    tags: ["one", "two"],
  }, fs);

  assert.equal(result.filePath, fs.realpathSync(video));
  assert.equal(result.fileSize, 11);
  assert.equal(result.title, "A safe title");
  assert.equal(result.visibility, "unlisted");
  assert.equal(result.madeForKids, false);
  assert.deepEqual(result.tags, ["one", "two"]);

  assert.throws(() => validateUploadInput({ file_path: video, title: "x", visibility: "private" }, fs), /made_for_kids/);
  assert.throws(() => validateUploadInput({ file_path: video, title: "x", visibility: "friends", made_for_kids: false }, fs), /visibility/);
  assert.throws(() => validateUploadInput({ file_path: video, title: "x".repeat(101), visibility: "private", made_for_kids: false }, fs), /100/);
  assert.throws(() => validateUploadInput({ file_path: video, title: "x", description: "x".repeat(5001), visibility: "private", made_for_kids: false }, fs), /5,000/);
});

test("requires an explicit offset for scheduled public uploads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-schedule-"));
  const video = path.join(root, "clip.mp4");
  fs.writeFileSync(video, "x");
  const base = { file_path: video, title: "Scheduled", visibility: "public", made_for_kids: false };

  assert.equal(validateUploadInput({ ...base, publish_at: "2030-06-07T14:30:00+02:00" }, fs).publishAt, "2030-06-07T14:30:00+02:00");
  assert.equal(validateUploadInput({ ...base, publish_at: "2030-06-07T12:30:00Z" }, fs).publishAt, "2030-06-07T12:30:00Z");
  assert.throws(() => validateUploadInput({ ...base, publish_at: "2030-06-07T14:30:00" }, fs), /UTC offset/);
  assert.throws(() => validateUploadInput({ ...base, visibility: "unlisted", publish_at: "2030-06-07T14:30:00+02:00" }, fs), /public/);
});

test("Short validation rejects ambiguous, long, and landscape media", () => {
  assert.deepEqual(validateShortMetadata({ duration: 179.9, width: 1080, height: 1920 }), { duration: 179.9, width: 1080, height: 1920 });
  assert.deepEqual(validateShortMetadata({ duration: 180, width: 1080, height: 1080 }), { duration: 180, width: 1080, height: 1080 });
  assert.throws(() => validateShortMetadata({ duration: 181, width: 1080, height: 1920 }), /180 seconds/);
  assert.throws(() => validateShortMetadata({ duration: 60, width: 1920, height: 1080 }), /square or vertical/);
  assert.throws(() => validateShortMetadata({ duration: 0, width: 0, height: 0 }), /could not be verified/);
});
