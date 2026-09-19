# Reddit Easy

**Post to Reddit from an MCP host without making a Reddit developer app, copying API keys, or putting your Reddit password into plugin settings.**

Reddit Easy uses a dedicated local Chromium browser profile. You sign in to Reddit normally once, and the MCP reuses that local session for Reddit actions.

## Why this exists

Most Reddit integrations make you create an OAuth app, find a client ID and secret, configure redirect URLs, and paste credentials into environment variables.

Reddit Easy is deliberately simpler:

**Import → log in → post.**

No Reddit developer portal. No client ID. No client secret. No Reddit password field in the plugin.

## 30-second setup

1. Download [`reddit-easy.mcpb`](./reddit-easy.mcpb).
2. In Chat On Steroids, choose **Add a plugin → Import MCPB bundle**.
3. Import `reddit-easy.mcpb`.
4. Ask the agent to run `reddit_login`.
5. Sign in to Reddit in the dedicated browser window that opens.
6. Run `reddit_status` once to confirm the account.
7. Done.

After that, prompts can be as simple as:

```text
Post this to r/opensource with the Open Source flair: ...
```

```text
Check the rules and available flairs for r/programming before posting.
```

```text
Reply to this Reddit post with: ...
```

The MCP exposes the Reddit actions directly, so the host does not need to click around Reddit's UI to publish a post.

## What it can do

- Check whether the dedicated Reddit session is logged in
- Read subreddit rules
- List post flairs
- Create text and link posts
- Reply to posts and comments
- Edit your own post/comment text
- Delete your own posts/comments
- Open a Reddit URL for manual review
- Erase the saved Reddit Easy browser session

## Supported browsers

Reddit Easy currently detects:

- **Helium**
- Google Chrome
- Microsoft Edge
- Chromium

Helium support includes the common Windows installs under `%LOCALAPPDATA%\imput\Helium\Application\chrome.exe` and `%PROGRAMFILES%\imput\Helium\Application\chrome.exe`.

## Why it does not ask for your Reddit password

Authentication happens inside the real browser window on `reddit.com`. Reddit Easy stores the resulting session only in its dedicated local browser profile. The MCP configuration itself does not accept your Reddit username, password, client ID, or client secret.

Use `reddit_forget_session` if you want the plugin to close the dedicated browser and remove that local profile.

## Security

This is local software with access to an authenticated Reddit session, so it is intentionally narrow:

- Browser debugging is bound to `127.0.0.1` only.
- The browser chooses an unpredictable ephemeral debugging port.
- Reddit URLs are restricted to HTTPS on `reddit.com` and real Reddit subdomains.
- Lookalike hosts such as `evilreddit.com` are rejected.
- Link posts accept only `http://` and `https://` URLs.
- No third-party runtime packages are required; the MCP uses Node.js built-ins only.
- Identical successful writes are blocked for 10 minutes.
- Concurrent duplicate writes are blocked.
- Writes are spaced by at least 3.5 seconds.
- Reddit-returned text is treated as untrusted external content.
- Cookies, passwords, session tokens, post bodies, and comments are not intentionally logged.

See [SECURITY.md](./SECURITY.md) for the remaining local-session caveat and reporting guidance.

## Requirements

- Node.js 22+
- Helium, Chrome, Edge, or Chromium
- A Reddit account
- An MCPB-compatible host such as Chat On Steroids

## Files

- `reddit-easy.mcpb` — ready-to-import plugin bundle
- `src/index.js` — source
- `dist/index.js` — packaged MCP entry point
- `manifest.json` — MCPB manifest
- `SECURITY.md` — security notes
- `reddit-easy.mcpb.sha256` — bundle checksum

## Verify the download

The release bundle has a SHA-256 checksum in [`reddit-easy.mcpb.sha256`](./reddit-easy.mcpb.sha256).

On PowerShell:

```powershell
Get-FileHash .\reddit-easy.mcpb -Algorithm SHA256
```

## Development

```bash
npm install
npm run check
npm start
```

There are currently no third-party runtime dependencies.

## Important limitation

Reddit Easy uses an authenticated browser session plus Reddit web/API endpoints. Reddit can change those interfaces at any time, so a future Reddit change may require an update.

## License

MIT. See [LICENSE](./LICENSE).
