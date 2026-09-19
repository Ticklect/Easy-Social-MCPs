import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createReadHandlers, UNTRUSTED_CONTENT_WARNING } from "../src/reads.js";

class FakeStudio {
  async getStatus() { return { loggedIn: true, channelId: `UC${"A".repeat(22)}`, channelName: "My Channel", href: "https://studio.youtube.com/" }; }
  async requireChannel() { return await this.getStatus(); }
  async listContent({ limit }) { return [{ videoId: "vid_test_01", title: "My upload", status: "Private", studioUrl: "https://studio.youtube.com/video/vid_test_01/edit", publicUrl: "https://youtu.be/vid_test_01" }].slice(0, limit); }
  async readVideo(id) { return { videoId: id, title: "My upload", visibility: "private", uploadStatus: "processing", checksStatus: "checking", studioUrl: `https://studio.youtube.com/video/${id}/edit`, publicUrl: `https://youtu.be/${id}` }; }
  async listComments({ limit }) { return [{ commentId: "comment-1", author: "Viewer", text: "Nice video", videoTitle: "My upload" }].slice(0, limit); }
}

class FakeClient {
  constructor() { this.transcriptAvailable = true; }
  async evaluate(expression) {
    if (expression.includes("__youtubeEasyPublicSearch")) return [{ videoId: "abc123xyz89", title: "T".repeat(800), channel: "Creator", url: "https://www.youtube.com/watch?v=abc123xyz89", description: "D".repeat(20_000) }];
    if (expression.includes("__youtubeEasyPublicVideo")) return { videoId: "abc123xyz89", title: "Public video", channel: "Creator", description: "Description", views: "100 views", published: "today", url: "https://www.youtube.com/watch?v=abc123xyz89" };
    if (expression.includes("__youtubeEasyPublicChannel")) return { channelId: `UC${"B".repeat(22)}`, name: "Public Channel", handle: "@public", description: "Channel description", subscribers: "10 subscribers", url: "https://www.youtube.com/@public" };
    if (expression.includes("__youtubeEasyTranscript")) return this.transcriptAvailable
      ? { available: true, segments: [{ timestamp: "0:00", seconds: 0, text: "Hello" }, { timestamp: "0:03", seconds: 3, text: "World" }] }
      : { available: false, reason: "This video does not expose a transcript." };
    throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-reads-"));
  const profileDir = path.join(root, "browser-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "session.bin"), "private browser state");
  fs.writeFileSync(path.join(root, "keep.txt"), "keep");
  const studio = new FakeStudio();
  const client = new FakeClient();
  const browser = {
    stateDir: root,
    profileDir,
    navigated: [],
    closed: 0,
    async navigate(_client, url) { this.navigated.push(url); return url; },
    async closeDedicatedBrowser() { this.closed++; return true; },
  };
  const handlers = createReadHandlers({
    stateDir: root,
    fsApi: fs,
    browser,
    withPage: async (fn) => await fn(client, browser),
    adapterFactory: () => studio,
    leaseOptions: { leaseMs: 300, waitMs: 5_000 },
  });
  return { root, profileDir, studio, client, browser, handlers };
}

test("login opens Studio and status returns only verified channel information", async () => {
  const { handlers, browser } = fixture();
  const login = await handlers.youtube_login({});
  const status = await handlers.youtube_status({});
  assert.match(login.message, /dedicated YouTube Easy browser/);
  assert.equal(status.loggedIn, true);
  assert.equal(status.channelId, `UC${"A".repeat(22)}`);
  assert.equal(browser.navigated.at(-1), "https://studio.youtube.com/");
  assert.equal(JSON.stringify(status).includes("cookie"), false);
});

test("Studio video, processing, and comment reads are bounded and marked untrusted", async () => {
  const { handlers } = fixture();
  const videos = await handlers.get_my_videos({ limit: 1 });
  const status = await handlers.get_upload_status({ video_id: "vid_test_01" });
  const comments = await handlers.get_comments({ limit: 1 });
  assert.equal(videos.videos.length, 1);
  assert.equal(status.video.uploadStatus, "processing");
  assert.equal(comments.comments[0].commentId, "comment-1");
  assert.equal(videos.warning, UNTRUSTED_CONTENT_WARNING);
  assert.equal(comments.warning, UNTRUSTED_CONTENT_WARNING);
});

test("public search and video reads normalize IDs and bound external strings", async () => {
  const { handlers, browser } = fixture();
  const search = await handlers.search_youtube({ query: "launch videos", limit: 5 });
  const byId = await handlers.get_video({ video: "abc123xyz89" });
  const byUrl = await handlers.get_video({ video: "https://youtu.be/abc123xyz89" });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].title.length, 500);
  assert.equal(search.results[0].description.length, 5_000);
  assert.equal(search.warning, UNTRUSTED_CONTENT_WARNING);
  assert.equal(byId.video.videoId, "abc123xyz89");
  assert.equal(byUrl.video.videoId, "abc123xyz89");
  assert.ok(browser.navigated.some((url) => url.includes("results?search_query=launch%20videos")));
  await assert.rejects(() => handlers.get_video({ video: "https://youtube.com.evil.test/watch?v=abc123xyz89" }), /approved YouTube watch URL/);
});

test("get_channel supports current and strict public YouTube channel URLs", async () => {
  const { handlers } = fixture();
  const current = await handlers.get_channel({});
  const publicChannel = await handlers.get_channel({ channel_url: "https://www.youtube.com/@public" });
  assert.equal(current.channel.channelId, `UC${"A".repeat(22)}`);
  assert.equal(publicChannel.channel.name, "Public Channel");
  await assert.rejects(() => handlers.get_channel({ channel_url: "https://evil.test/@public" }), /Google\/YouTube URL/);
});

test("transcript returns segments when exposed and an explicit unavailable result otherwise", async () => {
  const { handlers, client } = fixture();
  const available = await handlers.get_transcript({ video: "abc123xyz89" });
  assert.equal(available.available, true);
  assert.equal(available.segments.length, 2);
  client.transcriptAvailable = false;
  const unavailable = await handlers.get_transcript({ video: "abc123xyz89" });
  assert.deepEqual(unavailable, { available: false, reason: "This video does not expose a transcript.", warning: UNTRUSTED_CONTENT_WARNING });
});

test("forget session closes the dedicated browser and erases only its profile", async () => {
  const { handlers, root, profileDir, browser } = fixture();
  const result = await handlers.youtube_forget_session({});
  assert.equal(browser.closed, 1);
  assert.equal(fs.existsSync(path.join(profileDir, "session.bin")), false);
  assert.equal(fs.existsSync(profileDir), true);
  assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "keep");
  assert.match(result.message, /Forgot the local YouTube Easy browser session/);
});
