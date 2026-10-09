import fs from "node:fs";
import { coordinatedXWrite } from "../src/coordination.js";

const [root, output, fingerprint = "same", account = "user-123"] = process.argv.slice(2);
try {
  const response = await coordinatedXWrite({
    root, fingerprint, account, minGapMs: 0, jitterMs: 0,
    operation: async (markAttempt) => {
      await markAttempt();
      fs.appendFileSync(output, "clicked\n");
      await new Promise((resolve) => setTimeout(resolve, 120));
      return "posted";
    },
  });
  process.stdout.write(JSON.stringify({ response }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
}
