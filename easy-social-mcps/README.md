# Easy Social MCPs — All-in-One

This archive contains the Easy MCP Installer and all four ready-to-use bundles:

- Reddit Easy v0.3.1
- X Easy v0.1.0
- TikTok Easy v0.1.0
- YouTube Easy v0.1.0

It requires Node.js 22 or newer. It does not run `npm install`.

## Install everything

Extract the ZIP, open a terminal in the extracted directory, and run one command:

```text
node install-easy-mcp.mjs --host codex reddit-easy-v0.3.1.mcpb x-easy-v0.1.0.mcpb tiktok-easy-v0.1.0.mcpb youtube-easy-v0.1.0.mcpb
node install-easy-mcp.mjs --host claude reddit-easy-v0.3.1.mcpb x-easy-v0.1.0.mcpb tiktok-easy-v0.1.0.mcpb youtube-easy-v0.1.0.mcpb
node install-easy-mcp.mjs --host both reddit-easy-v0.3.1.mcpb x-easy-v0.1.0.mcpb tiktok-easy-v0.1.0.mcpb youtube-easy-v0.1.0.mcpb
```

Use `--host codex`, `--host claude`, or `--host both`. Restart the selected client after installation. Then prompts such as “Start Reddit login” or “Start YouTube login” work in a new chat.

To install only some services, remove the unwanted `.mcpb` filenames from the command. `SHA256SUMS.txt` contains checksums for the installer and all four bundles.

Each included component retains its own license and security documentation inside its MCPB. The all-in-one packaging files are licensed under the repository's `LICENSE`.
