# Easy Social Browser Companion

Use an existing **signed-in browser window** for Reddit Easy, X Easy and YouTube Easy. It uses a Chromium extension and a local loopback bridge, without copying cookies between browser profiles, creating a separate browser profile, or changing the browser's launch flags. The companion accepts TikTok tabs as well, but TikTok Easy's packaged runtime does not yet connect to this bridge.

## Supported browsers

The same Manifest V3 extension is intended for **Helium**, Chrome, Edge, Brave, Chromium, Vivaldi and Opera when their build exposes the standard `chrome.debugger` API. Helium officially supports Chromium extensions. Browser vendors and managed installations can restrict the debugger or unpacked extensions, so compatibility must be checked in each actual browser. Firefox and Safari use different extension/debugging APIs and **are not supported by this companion**.

## Setup

1. Install Node.js 22 or newer. On Windows, double-click `start-windows.cmd` in the extracted `browser-companion` folder; it installs missing dependencies and starts the local bridge. On macOS/Linux run `npm ci` followed by `npm start`. Leave the local server running while using the MCPs.
2. In your normal Helium browser, open `helium://extensions` (if unavailable, try `chrome://extensions`). Turn on **Developer mode**, choose **Load unpacked**, and select the `browser-companion/extension` folder. For Chrome, Edge, Brave and other Chromium browsers, use their extensions page and load the same folder.
3. Click the **Easy Social Browser Companion** extension icon and paste the pairing code printed in the bridge window. The popup should report **Connected to Easy Social**. The code is stored in the local account's browser extension storage, so pairing survives restarting the bridge.
4. Start Reddit Easy, X Easy or YouTube Easy in Chat On Steroids and use their normal login/status tools. The MCPs automatically discover the paired companion and use the same browser profile. The bridge also exposes all existing approved social-site tabs, but each plugin must explicitly choose an existing tab and verify its login state; older plugin builds may still open their own new social tab. Set `EASY_SOCIAL_BROWSER_MODE=existing` in their MCP environment if you want to forbid the separate-profile fallback when the companion has never been paired.

Once paired, the extension retries automatically at startup and every 30 seconds if the local bridge is temporarily unavailable. The popup also has a **Retry connection** button; no new pairing code is needed. To have the bridge start automatically whenever you sign in to **Windows**, enable the optional, per-user Startup shortcut once from PowerShell while in `browser-companion`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\configure-startup-windows.ps1 -Action Enable
```

To disable that Windows sign-in shortcut:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\configure-startup-windows.ps1 -Action Disable
```

This does not install a browser extension or start a service from a website. Browser extensions cannot independently launch a local Node.js process. Windows Startup begins the local companion when you sign in; an already-paired extension will then reconnect automatically. Initial manual pairing and browser extension approval remain necessary. If you move the `browser-companion` folder, enable Startup again from its new location.

If multiple browsers are paired and connected at once, the bridge refuses commands until only the intended browser remains connected. Disconnect the companion in the other browser using its extension popup. This prevents posting from the wrong account.

The bridge binds to `127.0.0.1:19411`, requires a randomly generated pairing key for HTTP and WebSocket requests, rejects web-page Origins, and limits newly opened tabs to Reddit, X/Twitter, Google/YouTube and TikTok HTTPS hosts. Browser debugger access is detached if an attached tab navigates outside those hosts. Each MCP remembers its own browser tab. Your other tabs and browser profile stay untouched. Browser-native debugger permission indicators are expected.

The authenticated bridge endpoints `GET /json/list` and `GET /json/candidates?site=reddit|x|youtube|tiktok` return existing allowed-site tabs (active tab first). They do not change the tab, navigate it or inspect credentials. Every returned candidate has `existing: true` and `loginStatus: "unchecked"`. The plugin can inspect the existing page using the returned debugger URL and its normal first-party, read-only login check; the bridge makes no assumption that an open tab is logged in. Multiple paired browser profiles still require choosing one browser explicitly by disconnecting extras.

The pairing key is stored at:

- Windows: `%LOCALAPPDATA%\ChatOnSteroids\EasySocialBrowserBridge\pairing-key`
- macOS: `~/Library/Application Support/ChatOnSteroids/EasySocialBrowserBridge/pairing-key`
- Linux: `~/.local/share/ChatOnSteroids/EasySocialBrowserBridge/pairing-key` (or `$XDG_DATA_HOME`)

Treat it as a local credential. Do not share the pairing code. If another program can read your account's files it may be able to control the paired browser. Keep the bridge and extension installed only from a trusted source. The attached site's script and debugger interface can still inspect its own cookies or page state. TikTok Easy currently uses its separate Playwright profile; adding TikTok to the companion's permitted sites alone does not enable TikTok Easy integration.

## Tests

`npm test` exercises an HTTP/WebSocket bridge with a simulated browser companion: pairing, allowed tabs, forwarding events, Origin rejection, missing browser and multi-browser fail-closed behavior. These tests do not prove that an actual Helium or other browser installation grants `chrome.debugger` access; that needs a live browser test.
