# Easy MCP Installer

Installs Reddit Easy, YouTube Easy, X Easy, or TikTok Easy into Codex and Claude Code without editing MCP configuration files or running `npm install`.

[Download the latest installer release](../../../releases/tag/easy-mcp-installer-v0.1.0)

## Requirements

- Node.js 22 or newer
- Codex CLI, Claude Code, or both, available on `PATH`
- One or more downloaded Easy MCP `.mcpb` files

## Install

Extract this installer ZIP into the directory containing the downloaded bundles, open a terminal there, and run one command:

```text
node install-easy-mcp.mjs --host codex youtube-easy-v0.1.0.mcpb
node install-easy-mcp.mjs --host claude reddit-easy-v0.3.1.mcpb
node install-easy-mcp.mjs --host both reddit-easy-v0.3.1.mcpb x-easy-v0.1.0.mcpb tiktok-easy-v0.1.0.mcpb youtube-easy-v0.1.0.mcpb
```

The installer safely extracts each bundle to a stable per-user application-data directory and registers its bundled Node entry point at user scope. Re-running the same installation is harmless. An existing registration that was not created by this installer is left unchanged; pass `--replace` only when you deliberately want to replace it.

Restart Codex or Claude Code after installation. Then ordinary prompts work:

```text
Start Reddit login.
Start YouTube login.
Check whether I am logged into X Easy.
Connect TikTok Easy.
```

The MCP tool catalog is rediscovered in each new chat. A fresh agent should check the matching status tool first and call the login tool only when the saved session is missing or expired.

## Login persistence

Each Easy MCP keeps its dedicated browser profile in the operating system's per-user application-data directory, independently of Codex or Claude chat history. Closing a chat, starting a new chat, or restarting the MCP process does not erase that profile. A site may still expire its own login, and the explicit `*_forget_session` tools erase the corresponding local profile when requested.

Passwords are entered only on the real service website in the dedicated browser. The installer does not read, copy, move, or expose browser cookies or session tokens.

## Safety

- ZIP paths are validated before extraction; absolute paths, traversal paths, duplicate paths, symlinks, encrypted entries, and oversized archives are rejected.
- Existing install directories are never silently overwritten.
- Existing MCP registrations are never silently replaced.
- Codex registration uses `codex mcp add`.
- Claude Code registration uses `claude mcp add --scope user --transport stdio`.

This installer is for local Codex and Claude Code sessions. Cloud-only agents cannot drive a browser profile on your computer.
