# Easy Social MCPs — All-in-One

This archive contains the Easy MCP Installer and all four ready-to-use bundles:

- Reddit Easy v0.3.2
- X Easy v0.1.1
- TikTok Easy v0.1.2
- YouTube Easy v0.1.1

It requires Node.js 22 or newer. It does not run `npm install`.

## Install everything

Extract the ZIP, open a terminal in the extracted directory, and run one command:

```text
node install-easy-mcp.mjs --host codex reddit-easy-v0.3.2.mcpb x-easy-v0.1.1.mcpb tiktok-easy-v0.1.2.mcpb youtube-easy-v0.1.1.mcpb
node install-easy-mcp.mjs --host claude reddit-easy-v0.3.2.mcpb x-easy-v0.1.1.mcpb tiktok-easy-v0.1.2.mcpb youtube-easy-v0.1.1.mcpb
node install-easy-mcp.mjs --host both reddit-easy-v0.3.2.mcpb x-easy-v0.1.1.mcpb tiktok-easy-v0.1.2.mcpb youtube-easy-v0.1.1.mcpb
```

Use `--host codex`, `--host claude`, or `--host both`. Restart the selected client after installation. Then prompts such as “Start Reddit login” or “Start YouTube login” work in a new chat.

To install only some services, remove the unwanted `.mcpb` filenames from the command. `SHA256SUMS.txt` contains checksums for the installer and all four bundles.

Each included component retains its own license and security documentation inside its MCPB. The all-in-one packaging files are licensed under the repository's `LICENSE`.

All four components now include additional request-safety checks. Their shared and/or local pacing and cooldown limits are deliberately conservative. These browser-session integrations are unofficial; they do not bypass site policies, guarantee uninterrupted access, or prevent account enforcement. In particular, X's automation rules prohibit scripting its website; users seeking authorised automated access should use the official API.
