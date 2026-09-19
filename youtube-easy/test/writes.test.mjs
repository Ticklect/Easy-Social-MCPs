import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createWriteHandlers } from "../src/writes.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-writes-"));
  const video = path.join(root, "clip.mp4");
  const thumbnail = path.join(root, "thumb.png");
  fs.writeFileSync(video, Buffer.alloc(4_096, 7));
  fs.writeFileSync(thumbnail, Buffer.alloc(256, 9));
  return { root, video, thumbnail };
}

class FakeStudio {
  constructor() {
    this.events = [];
    this.commitUploads = 0;
    this.videoExists = true;
    this.replySends = 0;
    this.replies = new Set();
    this.media = { duration: 60, width: 1080, height: 1920 };
    this.video = {
      videoId: "vid_test_01",
      title: "Original title",
      description: "",
      madeForKids: false,
      visibility: "private",
      playlist: null,
      tags: [],
      studioUrl: "https://studio.youtube.com/video/vid_test_01/edit",
      publicUrl: "https://youtu.be/vid_test_01",
    };
  }

  async requireChannel() { return { loggedIn: true, channelId: `UC${"A".repeat(22)}`, channelName: "Test channel" }; }
  async openUploadDialog() { this.events.push("open"); }
  async selectVideoFile(_file, onVideoId) {
    this.events.push("file");
    await onVideoId({ videoId: "vid_test_01", studioUrl: this.video.studioUrl, publicUrl: this.video.publicUrl });
    this.events.push("id-persisted");
  }
  async readSelectedMediaMetadata() { return { ...this.media, fileName: "clip.mp4", fileSize: 4_096 }; }
  async fillUploadDetails(intent) { this.events.push("details"); this.pending = intent; }
  async advanceToVisibility() { this.events.push("visibility-page"); }
  async setUploadVisibility() { this.events.push("visibility-set"); }
  async commitUpload(intent) {
    this.commitUploads++;
    this.events.push("commit");
    if (this.verificationFailure) {
      const error = new Error("Verification failed; final action was not clicked");
      error.finalActionNotSent = true;
      throw error;
    }
    this.video = { ...this.video, title: intent.title, description: intent.description, madeForKids: intent.madeForKids, visibility: intent.publishAt ? "scheduled" : intent.visibility, playlist: intent.playlist ?? null, tags: intent.tags };
    return this.video;
  }
  async findVideoByIntent(intent) {
    return this.video?.title === intent.title
      ? { status: "found", result: this.video }
      : { status: "not_found" };
  }
  async readVideo() {
    if (!this.videoExists) { const error = new Error("video not found"); error.code = "VIDEO_NOT_FOUND"; throw error; }
    return { ...this.video };
  }
  async openVideo() { this.events.push("open-video"); }
  async applyEdit(edit) { this.pendingEdit = edit; this.events.push("apply-edit"); }
  async commitEdit(edit) { this.video = { ...this.video, ...edit }; this.events.push("save-edit"); return this.video; }
  async setThumbnailFile(file) { this.thumbnail = path.basename(file); this.events.push("thumbnail-file"); }
  async commitThumbnail(expected) { this.events.push("save-thumbnail"); return { ...this.video, thumbnailFileName: expected.thumbnailFileName }; }
  async setSchedule(publishAt) { this.pendingSchedule = publishAt; this.events.push("set-schedule"); }
  async commitSchedule(expected) { this.video = { ...this.video, visibility: "scheduled", publishAt: expected.publishAt, scheduleTimeZone: "UTC" }; this.events.push("save-schedule"); return this.video; }
  async deleteVideo() {
    this.events.push("delete");
    this.videoExists = false;
    if (this.failAfterDelete) throw new Error("browser disconnected after delete confirmation");
    return { message: "Deleted", videoId: this.video.videoId };
  }
  async listComments() { return [{ commentId: "comment-1", text: "Viewer comment" }]; }
  async replyToComment(commentId, text) {
    this.replySends++;
    this.replies.add(`${commentId}\n${text}`);
    if (this.failAfterReply) throw new Error("browser disconnected after reply");
    return { message: "Replied", commentId };
  }
  async findReply(commentId, text) {
    return this.replies.has(`${commentId}\n${text}`)
      ? { status: "found", result: { message: "Found reply", commentId } }
      : { status: "not_found" };
  }
}

function harness(studio, root) {
  return createWriteHandlers({
    stateDir: root,
    fsApi: fs,
    withPage: async (fn) => await fn({}, {}),
    adapterFactory: () => studio,
    leaseOptions: { leaseMs: 300, waitMs: 5_000, writeGapMs: 0 },
  });
}

function uploadArgs(video, extra = {}) {
  return { file_path: video, title: "New upload", description: "Description", visibility: "private", made_for_kids: false, ...extra };
}

test("upload persists a captured video ID before final verification and returns URLs", async () => {
  const { root, video } = fixture();
  const studio = new FakeStudio();
  const result = await harness(studio, root).upload_video(uploadArgs(video));
  assert.equal(result.status, "success");
  assert.equal(result.result.videoId, "vid_test_01");
  assert.equal(result.result.studioUrl, studio.video.studioUrl);
  assert.ok(studio.events.indexOf("id-persisted") < studio.events.indexOf("commit"));
});

test("invalid Short metadata prevents publish and persists a reusable draft-preserved result", async () => {
  const { root, video } = fixture();
  const studio = new FakeStudio();
  studio.media = { duration: 181, width: 1080, height: 1920 };
  const handlers = harness(studio, root);
  const first = await handlers.upload_short(uploadArgs(video));
  const second = await handlers.upload_short(uploadArgs(video));
  assert.equal(first.status, "success");
  assert.equal(first.result.verified.draftPreserved, true);
  assert.match(first.result.message, /Stopped before publication/);
  assert.equal(second.status, "reused");
  assert.equal(studio.commitUploads, 0);
});

test("upload verification failure prevents final publication and preserves duplicate protection", async () => {
  const { root, video } = fixture();
  const studio = new FakeStudio();
  studio.verificationFailure = true;
  const result = await harness(studio, root).upload_video(uploadArgs(video));
  assert.equal(result.status, "success");
  assert.equal(result.result.verified.draftPreserved, true);
  assert.match(result.result.message, /verification/i);
});

test("update, thumbnail, and schedule handlers save only their verified requested state", async () => {
  const { root, thumbnail } = fixture();
  const studio = new FakeStudio();
  const handlers = harness(studio, root);
  const updated = await handlers.update_video({ video_id: "vid_test_01", title: "Edited", made_for_kids: true });
  const thumb = await handlers.set_thumbnail({ video_id: "vid_test_01", thumbnail_path: thumbnail });
  const scheduled = await handlers.schedule_video({ video_id: "vid_test_01", publish_at: "2030-06-07T12:30:00Z" });
  assert.equal(updated.status, "success");
  assert.equal(thumb.result.verified.thumbnailFileName, "thumb.png");
  assert.equal(scheduled.result.verified.publishAt, "2030-06-07T12:30:00Z");
  assert.deepEqual(studio.events.filter((event) => event.startsWith("save")), ["save-edit", "save-thumbnail", "save-schedule"]);
});

test("delete reconciles a lost response as success and reuses it without deleting twice", async () => {
  const { root } = fixture();
  const studio = new FakeStudio();
  studio.failAfterDelete = true;
  const handlers = harness(studio, root);
  const first = await handlers.delete_video({ video_id: "vid_test_01", confirm_title: "Original title" });
  const second = await handlers.delete_video({ video_id: "vid_test_01", confirm_title: "Original title" });
  assert.equal(first.status, "success");
  assert.equal(first.reconciled, true);
  assert.equal(second.status, "reused");
  assert.equal(studio.events.filter((event) => event === "delete").length, 1);
});

test("reply reconciliation finds the exact existing reply and suppresses duplicates", async () => {
  const { root } = fixture();
  const studio = new FakeStudio();
  studio.failAfterReply = true;
  const handlers = harness(studio, root);
  const first = await handlers.reply_to_comment({ comment_id: "comment-1", text: "Thanks for watching." });
  const second = await handlers.reply_to_comment({ comment_id: "comment-1", text: "Thanks for watching." });
  assert.equal(first.status, "success");
  assert.equal(first.reconciled, true);
  assert.equal(second.status, "reused");
  assert.equal(studio.replySends, 1);
});
