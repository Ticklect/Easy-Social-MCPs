# Security

## Sensitive data

Reddit Easy stores an authenticated browser session in a dedicated local Helium/Chrome/Edge/Chromium profile. Treat that profile as sensitive because browser cookies can represent an authenticated Reddit session.

Never upload or commit a browser profile, cookies database, `DevToolsActivePort`, browser history, or copied runtime data.

## Local debugger

The plugin launches its dedicated browser with remote debugging bound to `127.0.0.1` and an OS/browser-assigned ephemeral port. The port remains reachable by other processes running as the same local user while the dedicated browser is open. This is a residual limitation of Chrome DevTools Protocol. Close the dedicated browser when it is not needed, or use `reddit_forget_session` to close it and erase the local profile.

## Reporting

If publishing this repository publicly, use GitHub's private vulnerability reporting feature or another private contact path rather than disclosing an exploitable account-session issue in a public issue first.
