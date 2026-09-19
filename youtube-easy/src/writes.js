import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { withYouTubePage } from "./browser.js";
import { withProfileLease, coordinatedWrite, KnownNotAppliedError, formatWriteOutcome } from "./coordination.js";
import { StudioAdapter, verifyEditState } from "./studio.js";
import { validateUploadInput, validateShortMetadata, validatePublishAt } from "./validation.js";

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value;
}

function requiredString(args, name, max = 20_000) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required and cannot be blank.`);
  if (Array.from(value).length > max) throw new Error(`${name} cannot exceed ${max} characters.`);
  return value;
}

function optionalString(args, name, max) {
  if (args[name] === undefined) return undefined;
  if (typeof args[name] !== "string") throw new Error(`${name} must be a string.`);
  if (Array.from(args[name]).length > max) throw new Error(`${name} cannot exceed ${max} characters.`);
  return args[name];
}

function videoId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error("video_id is invalid.");
  return id;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function sampledFileHash(file, fsApi = fs) {
  const stat = fsApi.statSync(file);
  if (!stat.isFile()) throw new Error("Upload path must be a regular file.");
  const sampleSize = 64 * 1024;
  const firstLength = Math.min(sampleSize, stat.size);
  const lastLength = Math.min(sampleSize, Math.max(0, stat.size - firstLength));
  const handle = fsApi.openSync(file, "r");
  try {
    const hash = crypto.createHash("sha256");
    hash.update(`${stat.size}:${Number(stat.mtimeMs || 0)}:`);
    if (firstLength) {
      const first = Buffer.alloc(firstLength);
      fsApi.readSync(handle, first, 0, firstLength, 0);
      hash.update(first);
    }
    if (lastLength) {
      const last = Buffer.alloc(lastLength);
      fsApi.readSync(handle, last, 0, lastLength, stat.size - lastLength);
      hash.update(last);
    }
    return hash.digest("hex");
  } finally {
    fsApi.closeSync(handle);
  }
}

export function uploadFingerprint(intent, fsApi = fs) {
  return digest(stable({
    action: "upload",
    filePath: intent.filePath,
    fileSize: intent.fileSize,
    fileMtimeMs: intent.fileMtimeMs,
    sample: sampledFileHash(intent.filePath, fsApi),
    title: intent.title,
    description: intent.description,
    visibility: intent.visibility,
    madeForKids: intent.madeForKids,
    publishAt: intent.publishAt || null,
    thumbnailPath: intent.thumbnailPath || null,
    playlist: intent.playlist || null,
    tags: intent.tags || [],
  }));
}

function publicOutcome(outcome) {
  return { ...outcome, message: formatWriteOutcome(outcome) };
}

function normalizedUpdate(value) {
  const args = asObject(value);
  const update = { videoId: videoId(args.video_id) };
  const title = optionalString(args, "title", 100);
  const description = optionalString(args, "description", 5_000);
  const playlist = optionalString(args, "playlist", 150);
  if (title !== undefined) {
    if (!title.trim()) throw new Error("title cannot be blank.");
    update.title = title;
  }
  if (description !== undefined) update.description = description;
  if (playlist !== undefined) update.playlist = playlist;
  if (args.visibility !== undefined) {
    if (!["private", "unlisted", "public"].includes(args.visibility)) throw new Error("visibility must be private, unlisted, or public.");
    update.visibility = args.visibility;
  }
  if (args.made_for_kids !== undefined) {
    if (typeof args.made_for_kids !== "boolean") throw new Error("made_for_kids must be true or false.");
    update.madeForKids = args.made_for_kids;
  }
  if (args.tags !== undefined) {
    if (!Array.isArray(args.tags) || args.tags.some((tag) => typeof tag !== "string" || !tag.trim())) throw new Error("tags must contain non-blank strings.");
    update.tags = args.tags.map((tag) => tag.trim());
    if (update.tags.join(",").length > 500) throw new Error("tags cannot exceed 500 total characters.");
  }
  if (Object.keys(update).length === 1) throw new Error("At least one supported field must be supplied to update_video.");
  return update;
}

function definitelyMissing(error) {
  return error?.code === "VIDEO_NOT_FOUND" || /not found|does not exist|404/i.test(error?.message || "");
}

function fieldsReadable(expected, actual) {
  return Object.keys(expected).every((key) => key === "videoId" || actual?.[key] !== undefined && actual?.[key] !== null);
}

export function createWriteHandlers({
  stateDir,
  fsApi = fs,
  withPage = withYouTubePage,
  adapterFactory = (client, browser) => new StudioAdapter({ client, browser }),
  leaseOptions = {},
} = {}) {
  if (!stateDir) throw new Error("stateDir is required for write coordination.");

  const withStudio = async (fn, options = {}) => await withProfileLease(stateDir, async () => await withPage(
    async (client, browser) => await fn(adapterFactory(client, browser), client, browser),
    options,
  ), leaseOptions);

  const channel = async () => await withStudio(async (studio) => await studio.requireChannel(), { url: "https://studio.youtube.com/" });
  const coordinate = async (options) => publicOutcome(await coordinatedWrite({
    ...options,
    root: stateDir,
    leaseMs: leaseOptions.leaseMs,
    waitMs: leaseOptions.waitMs,
    writeGapMs: leaseOptions.writeGapMs ?? 3_500,
  }));

  async function reconcileUpload(record, intent) {
    return await withStudio(async (studio) => {
      const partialId = record.partialResult?.videoId;
      if (partialId) {
        try {
          const current = await studio.readVideo(partialId);
          const expected = {
            title: intent.title,
            description: intent.description,
            madeForKids: intent.madeForKids,
            visibility: intent.publishAt ? "scheduled" : intent.visibility,
          };
          if (!fieldsReadable(expected, current)) return { status: "unknown" };
          try {
            verifyEditState(expected, current);
            return { status: "found", result: { message: "Found the existing Studio upload", ...current } };
          } catch {
            return { status: "unknown" };
          }
        } catch (error) {
          if (!definitelyMissing(error)) return { status: "unknown" };
        }
      }
      const found = await studio.findVideoByIntent(intent);
      if (found?.status !== "found") return found || { status: "unknown" };
      const result = found.result || {};
      const expected = { title: intent.title, visibility: intent.publishAt ? "scheduled" : intent.visibility };
      if (!fieldsReadable(expected, result)) return { status: "unknown" };
      return result.title === expected.title && result.visibility === expected.visibility ? found : { status: "unknown" };
    });
  }

  async function upload(args, short) {
    const intent = validateUploadInput(args, fsApi);
    const session = await channel();
    const fingerprint = `${short ? "short" : "video"}:${uploadFingerprint(intent, fsApi)}`;
    return await coordinate({
      account: session.channelId,
      fingerprint,
      intent: { action: short ? "upload_short" : "upload_video", title: intent.title, requestedAt: Date.now(), ...intent, filePath: undefined, thumbnailPath: undefined },
      duplicateWindowMs: 24 * 60 * 60 * 1_000,
      reconcile: (record) => reconcileUpload(record, intent),
      operation: async ({ persist }) => await withStudio(async (studio) => {
        const current = await studio.requireChannel();
        if (current.channelId !== session.channelId) throw new Error("The signed-in YouTube channel changed before upload; no final publish action was sent.");
        await studio.openUploadDialog(session.channelId);
        let captured = {};
        await studio.selectVideoFile(intent.filePath, async (video) => {
          captured = video || {};
          persist({ ...captured, channelId: session.channelId, verified: { phase: "video_id_captured" } });
        });
        const metadata = await studio.readSelectedMediaMetadata();
        const draft = (reason) => ({
          message: `Stopped before publication: ${reason} The uploaded item was left in its existing draft/private Studio state.`,
          ...captured,
          channelId: session.channelId,
          verified: { draftPreserved: true, reason },
        });
        if (metadata.fileName !== path.basename(intent.filePath) || Number(metadata.fileSize) !== Number(intent.fileSize)) {
          return draft("the selected file could not be verified");
        }
        if (short) {
          try { validateShortMetadata(metadata); }
          catch (error) { return draft(error.message); }
        }
        await studio.fillUploadDetails(intent);
        await studio.advanceToVisibility();
        await studio.setUploadVisibility(intent);
        try {
          const result = await studio.commitUpload(intent);
          return { message: short ? "YouTube Short upload completed." : "YouTube video upload completed.", ...captured, ...result, channelId: session.channelId, verified: { ...result?.verified, title: intent.title, visibility: intent.publishAt ? "scheduled" : intent.visibility, madeForKids: intent.madeForKids } };
        } catch (error) {
          if (error?.finalActionNotSent) return draft(error.message);
          throw error;
        }
      }),
    });
  }

  async function updateVideo(args) {
    const edit = normalizedUpdate(args);
    const session = await channel();
    const fingerprint = `update:${digest(stable(edit))}`;
    return await coordinate({
      account: session.channelId,
      fingerprint,
      intent: { action: "update_video", ...edit },
      reconcile: async () => await withStudio(async (studio) => {
        try {
          const actual = await studio.readVideo(edit.videoId);
          if (!fieldsReadable(edit, actual)) return { status: "unknown" };
          try { verifyEditState(edit, actual); return { status: "found", result: { message: "Found requested Studio metadata", ...actual } }; }
          catch { return { status: "not_found" }; }
        } catch (error) { return definitelyMissing(error) ? { status: "not_found" } : { status: "unknown" }; }
      }),
      operation: async () => await withStudio(async (studio) => {
        await studio.openVideo(edit.videoId);
        await studio.applyEdit(edit);
        try {
          const result = await studio.commitEdit(edit);
          return { message: "Video metadata updated in YouTube Studio.", videoId: edit.videoId, studioUrl: `https://studio.youtube.com/video/${edit.videoId}/edit`, publicUrl: `https://youtu.be/${edit.videoId}`, channelId: session.channelId, verified: result };
        } catch (error) {
          if (error?.finalActionNotSent) throw new KnownNotAppliedError(error.message);
          throw error;
        }
      }),
    });
  }

  async function setThumbnail(argsValue) {
    const args = asObject(argsValue);
    const id = videoId(args.video_id);
    const supplied = requiredString(args, "thumbnail_path", 10_000);
    let canonical;
    let stat;
    try { canonical = fsApi.realpathSync(path.resolve(supplied)); stat = fsApi.statSync(canonical); }
    catch { throw new Error("thumbnail_path does not exist or cannot be read."); }
    if (!stat.isFile()) throw new Error("thumbnail_path must be a regular file.");
    const thumbnailFileName = path.basename(canonical);
    const session = await channel();
    return await coordinate({
      account: session.channelId,
      fingerprint: `thumbnail:${digest(stable({ id, canonical, size: stat.size, mtimeMs: stat.mtimeMs, sample: sampledFileHash(canonical, fsApi) }))}`,
      intent: { action: "set_thumbnail", videoId: id, thumbnailFileName },
      reconcile: async () => await withStudio(async (studio) => {
        try {
          const actual = await studio.readVideo(id);
          if (actual.thumbnailFileName === thumbnailFileName) return { status: "found", result: { message: "Found requested thumbnail", ...actual } };
          return actual.thumbnailFileName == null ? { status: "unknown" } : { status: "not_found" };
        } catch (error) { return definitelyMissing(error) ? { status: "not_found" } : { status: "unknown" }; }
      }),
      operation: async () => await withStudio(async (studio) => {
        await studio.openVideo(id);
        await studio.setThumbnailFile(canonical);
        try {
          const result = await studio.commitThumbnail({ thumbnailFileName });
          return { message: "Thumbnail updated in YouTube Studio.", videoId: id, studioUrl: `https://studio.youtube.com/video/${id}/edit`, publicUrl: `https://youtu.be/${id}`, channelId: session.channelId, verified: { thumbnailFileName: result.thumbnailFileName || thumbnailFileName } };
        } catch (error) {
          if (error?.finalActionNotSent) throw new KnownNotAppliedError(error.message);
          throw error;
        }
      }),
    });
  }

  async function scheduleVideo(argsValue) {
    const args = asObject(argsValue);
    const id = videoId(args.video_id);
    const publishAt = validatePublishAt(args.publish_at);
    if (Date.parse(publishAt) <= Date.now()) throw new Error("publish_at must be in the future.");
    const session = await channel();
    return await coordinate({
      account: session.channelId,
      fingerprint: `schedule:${digest(stable({ id, publishAt }))}`,
      intent: { action: "schedule_video", videoId: id, publishAt },
      reconcile: async () => await withStudio(async (studio) => {
        try {
          const actual = await studio.readVideo(id);
          if (!actual.publishAt || !actual.scheduleTimeZone) return { status: "unknown" };
          return actual.visibility === "scheduled" && Date.parse(actual.publishAt) === Date.parse(publishAt)
            ? { status: "found", result: { message: "Found requested schedule", ...actual } }
            : { status: "not_found" };
        } catch (error) { return definitelyMissing(error) ? { status: "not_found" } : { status: "unknown" }; }
      }),
      operation: async () => await withStudio(async (studio) => {
        await studio.openVideo(id);
        await studio.setSchedule(publishAt);
        try {
          const result = await studio.commitSchedule({ publishAt });
          return { message: "Video scheduled in YouTube Studio.", videoId: id, studioUrl: `https://studio.youtube.com/video/${id}/edit`, publicUrl: `https://youtu.be/${id}`, channelId: session.channelId, verified: { publishAt: result.publishAt || publishAt, visibility: "scheduled", scheduleTimeZone: result.scheduleTimeZone } };
        } catch (error) {
          if (error?.finalActionNotSent) throw new KnownNotAppliedError(error.message);
          throw error;
        }
      }),
    });
  }

  async function deleteVideo(argsValue) {
    const args = asObject(argsValue);
    const id = videoId(args.video_id);
    const confirmTitle = requiredString(args, "confirm_title", 100);
    const session = await channel();
    return await coordinate({
      account: session.channelId,
      fingerprint: `delete:${digest(stable({ id, confirmTitle }))}`,
      intent: { action: "delete_video", videoId: id, confirmTitle },
      duplicateWindowMs: 365 * 24 * 60 * 60 * 1_000,
      reconcile: async () => await withStudio(async (studio) => {
        try { await studio.readVideo(id); return { status: "not_found" }; }
        catch (error) {
          return definitelyMissing(error)
            ? { status: "found", result: { message: "Confirmed that the video is absent from YouTube Studio.", videoId: id } }
            : { status: "unknown" };
        }
      }),
      operation: async () => await withStudio(async (studio) => ({ ...(await studio.deleteVideo(id, confirmTitle)), channelId: session.channelId })),
    });
  }

  async function replyToComment(argsValue) {
    const args = asObject(argsValue);
    const commentId = requiredString(args, "comment_id", 500);
    const text = requiredString(args, "text", 10_000);
    const session = await channel();
    return await coordinate({
      account: session.channelId,
      fingerprint: `reply:${digest(stable({ commentId, text }))}`,
      intent: { action: "reply_to_comment", commentId, text },
      duplicateWindowMs: 30 * 24 * 60 * 60 * 1_000,
      reconcile: async () => await withStudio(async (studio) => {
        await studio.listComments({ limit: 100 });
        return await studio.findReply(commentId, text);
      }),
      operation: async () => await withStudio(async (studio) => {
        const comments = await studio.listComments({ limit: 100 });
        if (!comments.some((comment) => comment.commentId === commentId)) throw new KnownNotAppliedError("The target Studio comment could not be found; no reply was sent.");
        return { ...(await studio.replyToComment(commentId, text)), channelId: session.channelId };
      }),
    });
  }

  return {
    upload_video: (args) => upload(args, false),
    upload_short: (args) => upload(args, true),
    update_video: updateVideo,
    set_thumbnail: setThumbnail,
    schedule_video: scheduleVideo,
    delete_video: deleteVideo,
    reply_to_comment: replyToComment,
  };
}
