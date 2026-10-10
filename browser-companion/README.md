# Easy Social Browser Companion

Use an existing **signed-in browser window** for Reddit Easy, X Easy and YouTube Easy. It uses a Chromium extension and a local loopback bridge, without copying cookies, creating a separate browser profile, or changing the browser's launch flags.

## Supported browsers

The same Manifest V3 extension is intended for **Helium**, Chrome, Edge, Brave, Chromium, Vivaldi and Opera when their build exposes the standard `chrome.debugger` API. Helium officially supports Chromium extensions. Browser vendors and managed installations can restrict the debugger or unpacked extensions, so compatibility must be checked in each actual browser. Firefox and Safari use different extension/debugging APIs and **are not supported by this companion**.

## Setup

1. Install Node.js 22 or newer. In the extracted `browser-companion` directory, run `npm ci` and `npm start`. Leave the local server running while using the MCPs.
2. In your normal Helium browser, open `helium://extensions` (if unavailable, try `chrome://extensions`). Turn on **Developer mode**, choose **Load unpacked**, and select the `browser-companion/extension` folder. For Chrome, Edge, Brave and other Chromium browsers, use their extensions page and load the same folder.
3. Click the **Easy Social Browser Companion** extension icon and paste the pairing code printed by `npm start`. The popup should report **Connected to Easy Social**. The key is stored in the local account's browser extension storage, so pairing survives restarting the bridge.
4. Start Reddit Easy, X Easy or YouTube Easy in Chat On Steroids and use their normal login/status tools. The MCPs automatically discover the paired companion and open social-site tabs in **that same signed-in browser**. Set `EASY_SOCIAL_BROWSER_MODE=existing` in their MCP environment if you want to forbid the separate-profile fallback when the companion has never been paired.

If multiple browsers are paired and connected at once, the bridge refuses commands until only the intended browser remains connected. Disconnect the companion in the other browser using its extension popup. This prevents posting from the wrong account.

The bridge binds to `127.0.0.1:19411`, requires a randomly generated pairing key for HTTP and WebSocket requests, rejects web-page Origins, and limits newly opened tabs to Reddit, X/Twitter and Google/YouTube HTTPS hosts. Each MCP remembers its own browser tab. Your other tabs and browser profile stay untouched. Browser-native debugger permission indicators are expected.

The pairing key is stored at:

- Windows: `%LOCALAPPDATA%\ChatOnSteroids\EasySocialBrowserBridge\pairing-key`
- macOS: `~/Library/Application Support/ChatOnSteroids/EasySocialBrowserBridge/pairing-key`
- Linux: `~/.local/share/ChatOnSteroids/EasySocialBrowserBridge/pairing-key` (or `$XDG_DATA_HOME`)

Treat it as a local credential. Do not share the pairing code. If another program can read your account's files it may be able to control the paired browser. Keep the bridge and extension installed only from a trusted source. TikTok Easy currently uses its separate Playwright profile.

## Tests

`npm test` exercises an HTTP/WebSocket bridge with a simulated browser companion: pairing, allowed tabs, forwarding events, Origin rejection, missing browser and multi-browser fail-closed behavior. These tests do not prove that an actual Helium or other browser installation grants `chrome.debugger` access; that needs a live browser test.
