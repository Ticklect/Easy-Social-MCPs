import fs from "node:fs";
import { withProfileLease, noteYouTubeResponse } from "../src/coordination.js";

const [mode, root, activityFile] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === "profile") {
  const result = await withProfileLease(root, async () => {
    const start = Date.now();
    fs.appendFileSync(activityFile, `entered:${start}\n`);
    await sleep(120);
    return { start, end: Date.now() };
  }, { pacingMs: 200, leaseMs: 500, waitMs: 6_000 });
  process.stdout.write(JSON.stringify(result));
} else if (mode === "throttle") {
  const result = noteYouTubeResponse(root, {
    type: "XHR",
    response: { status: 429, url: "https://studio.youtube.com/youtubei/v1/content", headers: { "retry-after": "4" } },
  });
  process.stdout.write(JSON.stringify(result));
} else if (mode === "blocked" || mode === "allowed") {
  try {
    const result = await withProfileLease(root, async () => {
      fs.appendFileSync(activityFile, `entered:${Date.now()}\n`);
      return "allowed";
    }, { pacingMs: 0, leaseMs: 500, waitMs: 6_000 });
    process.stdout.write(JSON.stringify({ status: result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: "blocked", code: error.code, message: error.message }));
  }
} else {
  throw new Error(`Unrecognized worker mode: ${mode}`);
}
