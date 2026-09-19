const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const string = (description, extras = {}) => ({ type: "string", description, ...extras });
const boolean = (description) => ({ type: "boolean", description });

const uploadProperties = {
  file_path: string("Absolute or host-resolvable local video path."),
  title: string("Video title, at most 100 characters."),
  description: string("Video description, at most 5,000 characters."),
  visibility: string("Final visibility. Scheduling requires public.", { enum: ["private", "unlisted", "public"] }),
  made_for_kids: boolean("Required audience declaration."),
  publish_at: string("Optional ISO-8601 publication time with an explicit UTC offset."),
  thumbnail_path: string("Optional local thumbnail image path."),
  playlist: string("Optional exact existing playlist name."),
  tags: { type: "array", description: "Optional video tags.", items: { type: "string" }, maxItems: 100 },
};

const readOnly = { readOnlyHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export const TOOL_DEFINITIONS = [
  { name: "youtube_login", description: "Open YouTube Studio in the dedicated browser profile for normal Google/YouTube sign-in.", inputSchema: objectSchema(), annotations: readOnly },
  { name: "youtube_status", description: "Check dedicated-browser login and verified channel status without exposing credentials.", inputSchema: objectSchema(), annotations: readOnly },
  { name: "upload_video", description: "Upload a video through YouTube Studio after exact fail-closed field verification.", inputSchema: objectSchema(uploadProperties, ["file_path", "title", "visibility", "made_for_kids"]), annotations: write },
  { name: "upload_short", description: "Upload a square/vertical video no longer than 180 seconds as a Short through Studio.", inputSchema: objectSchema(uploadProperties, ["file_path", "title", "visibility", "made_for_kids"]), annotations: write },
  { name: "get_my_videos", description: "Read the signed-in channel's Studio content list.", inputSchema: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 50 } }), annotations: readOnly },
  { name: "get_upload_status", description: "Read upload and processing status for a verified video ID.", inputSchema: objectSchema({ video_id: string("YouTube video ID.") }, ["video_id"]), annotations: readOnly },
  { name: "update_video", description: "Update supported Studio metadata and save only after requested fields are verified.", inputSchema: objectSchema({ video_id: string("Owned video ID."), title: string("New title."), description: string("New description."), visibility: string("New visibility.", { enum: ["private", "unlisted", "public"] }), made_for_kids: boolean("Audience declaration."), playlist: string("Exact playlist name."), tags: { type: "array", items: { type: "string" } } }, ["video_id"]), annotations: write },
  { name: "set_thumbnail", description: "Set an owned video's thumbnail through Studio and verify before save.", inputSchema: objectSchema({ video_id: string("Owned video ID."), thumbnail_path: string("Local thumbnail path.") }, ["video_id", "thumbnail_path"]), annotations: write },
  { name: "schedule_video", description: "Schedule an owned private video to become public at an explicit-offset ISO-8601 time.", inputSchema: objectSchema({ video_id: string("Owned video ID."), publish_at: string("ISO-8601 timestamp with explicit UTC offset.") }, ["video_id", "publish_at"]), annotations: write },
  { name: "delete_video", description: "Delete an owned video through Studio with cross-process reconciliation.", inputSchema: objectSchema({ video_id: string("Owned video ID."), confirm_title: string("Exact current title used as a safety check.") }, ["video_id", "confirm_title"]), annotations: destructive },
  { name: "get_comments", description: "Read published Studio comments, optionally filtered to a video.", inputSchema: objectSchema({ video_id: string("Optional video ID."), limit: { type: "integer", minimum: 1, maximum: 100 } }), annotations: readOnly },
  { name: "reply_to_comment", description: "Reply to a specific Studio comment with duplicate protection and reconciliation.", inputSchema: objectSchema({ comment_id: string("Studio comment ID."), text: string("Reply text.", { maxLength: 10_000 }) }, ["comment_id", "text"]), annotations: write },
  { name: "get_channel", description: "Read a public channel or the current signed-in channel.", inputSchema: objectSchema({ channel_url: string("Optional HTTPS YouTube channel URL.") }), annotations: readOnly },
  { name: "search_youtube", description: "Search public YouTube and return bounded structured results.", inputSchema: objectSchema({ query: string("Search query."), limit: { type: "integer", minimum: 1, maximum: 25 } }, ["query"]), annotations: readOnly },
  { name: "get_video", description: "Read public metadata for a YouTube watch URL or video ID.", inputSchema: objectSchema({ video: string("YouTube video ID or approved watch URL.") }, ["video"]), annotations: readOnly },
  { name: "get_transcript", description: "Read a transcript when the public watch page exposes one; otherwise report unavailable.", inputSchema: objectSchema({ video: string("YouTube video ID or approved watch URL.") }, ["video"]), annotations: readOnly },
  { name: "youtube_forget_session", description: "Close the dedicated browser and erase only YouTube Easy's local browser profile.", inputSchema: objectSchema(), annotations: destructive },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);
