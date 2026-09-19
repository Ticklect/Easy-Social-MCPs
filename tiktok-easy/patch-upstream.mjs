import fs from "node:fs";

function replaceOnce(s, from, to, label) {
  if (!s.includes(from)) throw new Error("Missing patch target: " + label);
  return s.replace(from, to);
}

{
  const p = "src/runtime/social-runtime.ts";
  let s = fs.readFileSync(p, "utf8");
  s = replaceOnce(
    s,
    'candidates.push(\n      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),',
    'candidates.push(\n      join(programFiles, "imput", "Helium", "Application", "chrome.exe"),\n      join(programFiles, "Helium", "Application", "chrome.exe"),\n      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),',
    "Windows Program Files browser list"
  );
  s = replaceOnce(
    s,
    'if (local) candidates.push(\n      join(local, "Google", "Chrome", "Application", "chrome.exe"),',
    'if (local) candidates.push(\n      join(local, "imput", "Helium", "Application", "chrome.exe"),\n      join(local, "Programs", "Helium", "Application", "chrome.exe"),\n      join(local, "Helium", "Application", "chrome.exe"),\n      join(local, "Google", "Chrome", "Application", "chrome.exe"),',
    "Windows LocalAppData browser list"
  );
  s = replaceOnce(
    s,
    'candidates.push(\n      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",',
    'candidates.push(\n      "/Applications/Helium.app/Contents/MacOS/Helium",\n      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",',
    "macOS browser list"
  );
  s = replaceOnce(
    s,
    'candidates.push(\n      "/usr/bin/google-chrome",',
    'candidates.push(\n      "/usr/bin/helium", "/usr/local/bin/helium",\n      "/usr/bin/google-chrome",',
    "Linux browser list"
  );
  s = s.replaceAll("Chrome/Edge/Brave.", "Helium/Chrome/Edge/Brave.");
  fs.writeFileSync(p, s);
}

{
  const p = "src/server.ts";
  let s = fs.readFileSync(p, "utf8");
  const marker = '  addTool(server, "tiktok_connect_status", {';
  const at = s.indexOf(marker);
  if (at < 0) throw new Error("Missing tiktok_connect_status marker");
  const alias = [
    '  addTool(server, "tiktok_login", {',
    '    title: "Log into TikTok",',
    '    description: "Easy default-account QR login. No TikTok API keys are required.",',
    '    inputSchema: {',
    '      country: z.string().length(2).optional(),',
    '      timeout_seconds: z.number().int().min(30).max(900).optional(),',
    '    },',
    '  }, (args) => runtime.connect({',
    '    account_id: "default",',
    '    country: args.country,',
    '    timeout_seconds: args.timeout_seconds,',
    '  }));',
    '',
    ''
  ].join("\n");
  s = s.slice(0, at) + alias + s.slice(at);
  s = replaceOnce(
    s,
    '{ name: "ai.palmyr/tiktok", title: "TikTok MCP", version: "0.3.1" }',
    '{ name: "tiktok-easy", title: "TikTok Easy", version: "0.1.0" }',
    "server identity"
  );
  fs.writeFileSync(p, s);
}
