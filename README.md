# Servo MCP

Servo MCP is a Cloudflare Worker MCP App for running Servo WASM as an isolated,
headless browser. It exposes the browser engine through Streamable HTTP at
`/mcp` and provides a small MCP Apps UI for loading pages and viewing rendered
screenshots.

The project files in this repository are MIT licensed. `servo-wasm/` is a Git
submodule and keeps its own license and notices; the MIT license here does not
change the license of Servo or its other dependencies.

## MCP tools

The server exposes focused tools. Every browser-action tool accepts a `sessions`
array, so one call can run the same kind of action on up to 20 different tabs,
with different parameters for each. `servo_session_create` also accepts an
array of independent create options; status and close accept `sessionIds`.
Results include a `sessionId` and per-session success or error so one failed tab
does not hide the others.

- `servo_session_create`, `servo_session_status`, `servo_session_close`
- `servo_navigate`, `servo_reload`, `servo_history`
- `servo_inspect`, `servo_evaluate`, `servo_get_capabilities`
- `servo_click`, `servo_type_text`, `servo_press_key`, `servo_scroll`, `servo_wait`
- `servo_screenshot`, `servo_register_font`

For example, create several tabs with `servo_session_create` using
`{ "sessions": [{ "url": "https://example.com" }, { "url": "https://example.org" }] }`.
Then inspect them together with
`{ "sessions": [{ "sessionId": "…" }, { "sessionId": "…" }] }`, or
navigate them with per-tab URLs using
`{ "sessions": [{ "sessionId": "…", "url": "https://example.net" }] }`.
Keep each returned `sessionId` mapped to its tab; there is no session-list tool.
Use `servo_session_close` with a `sessionIds` array when those tabs are done.

Each session is routed to its own SQLite-backed Durable Object, which serializes
operations and stores a serialized restore snapshot. The live Servo WASM
runtime is only cached for 90 seconds after activity; later browser-tool calls
automatically start a fresh runtime and reopen the current tab. The checkpoint
preserves URL, viewport, scroll position, common form values, local/session
storage, script-visible cookies, registered fonts, and the source for inline
HTML pages. It does not preserve the JavaScript heap, HttpOnly cookies, browser
history, arbitrary DOM mutations, or application state held only in memory.
Restoring reloads the page and runs its scripts again; it never replays prior
tool actions. Sessions are deleted after 30 days without use or when closed.
Closing explicitly also deletes the snapshot and saved assets. The 90-second
runtime cache still incurs Durable Object duration while resident, and
Durable Objects do not remove the Worker CPU-time requirements of instantiating
Servo or processing page actions.

`servo_evaluate` runs JavaScript in the page realm and awaits a returned
promise within the call's time budget. It can inspect Servo's DOM, CSS, canvas
and browser APIs. Results are WebDriver-style JSON clones.
Servo reports supported, partial, unsupported and unverified features through
`servo_get_capabilities`.

The endpoint currently has no authentication. A `sessionId` is therefore a
bearer capability: anyone who obtains it can use or close that session. Do not
share it or use this testing endpoint for sensitive browsing.

The server limits a pump to 15 seconds, resumable inline HTML to 1 MiB, response bodies
to 8 MiB and each browser session to 50 subrequests. Only public HTTP(S) URLs
are allowed. The host also sets Cloudflare's `global_fetch_strictly_public` flag
so Worker fetches cannot connect to private network targets after DNS
resolution. Do not remove either layer when deploying.

## Local setup

The `servo-wasm/` submodule is pinned to the engine revision this app targets.
Initialize it, install the Rust target, and build the production artifact
incrementally:

```sh
git submodule update --init --depth 1
rustup target add wasm32-unknown-unknown
npm install
npm run engine:build
npm run dev
```

The local health endpoint is `http://127.0.0.1:8788/health`; the MCP endpoint is
`http://127.0.0.1:8788/mcp`. Connect ChatGPT Developer Mode or MCP Inspector to
the HTTPS `/mcp` URL exposed by your development tunnel. The app uses current
Cloudflare `createMcpHandler` with stateless Streamable HTTP and the MCP Apps UI
resource convention. Browser-session continuity lives in per-session Durable
Objects, separate from the stateless MCP transport. The `ServoBrowserSession`
SQLite class is declared in `wrangler.jsonc`; apply its migration when
deploying.

Run `npm run typecheck` and `npm test` for the app checks. `npm run deploy:dry-run`
builds Servo and asks Wrangler to calculate the bundle without deploying.
The Servo binary is close to Cloudflare's 64 MiB Worker bundle ceiling, so the
combined Worker bundle must be measured before any deployment.

## Test deployment

Deployed on 2026-09-27 to the authenticated Cloudflare account. The live Worker
uses Durable Object-backed browser sessions and the focused multi-session MCP
tools documented above.

- MCP endpoint: <https://servo-mcp.defcronyke.workers.dev/mcp>
- Health: <https://servo-mcp.defcronyke.workers.dev/health>
- Deployed Worker version: `40a51194-dd4c-4639-b546-8661c3096c3e` (servo-wasm `a175271c7`, ABI 10)

The `/health` endpoint and MCP `tools/list` response were verified against the
live Worker. The endpoint currently has no authentication and is public for
testing. Before broader publication, decide the access
policy; add OAuth and consent before private or user-scoped use. Measure CPU
and total isolate memory on the intended Workers plan and review Cloudflare and
ChatGPT submission requirements before publication. The deployed bundle was
49,946 KiB (15,263 KiB gzip) in Wrangler's dry run, below the 64 MiB Worker limit.

The MCP handler validates localhost and `workers.dev` Host/Origin defaults;
custom domains should also be protected by Cloudflare routing and deployment
policy.

## License

MIT for Servo MCP code in this repository. The Servo WASM submodule and all
third-party packages remain under their own license terms.
