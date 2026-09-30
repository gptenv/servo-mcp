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
- `servo_http_request`, plus `servo_http_get`, `servo_http_post`, `servo_http_put`,
  `servo_http_patch`, `servo_http_delete`, `servo_http_head`, and `servo_http_options`
- `servo_click`, `servo_type_text`, `servo_press_key`, `servo_scroll`, `servo_wait`
- `servo_screenshot`, `servo_register_font`
- `servo_recording_start`, `servo_recording_stop`, `servo_recording_status`,
  `servo_recording_download`

The HTTP request tools call public HTTP(S) endpoints directly. The general tool
accepts any valid Fetch API method (including extension methods), request
headers and a UTF-8 body; convenience tools provide common verbs. Results
include the HTTP status, final URL, response headers, bounded response body
(base64 for binary content), and a `results` array with title, URL, snippet,
and readable page content. Redirect destinations are checked against the
public-network policy, cross-origin redirects discard credentials, and the
request duration and response size are capped. The HTTP tools can still cause
remote side effects, so use POST/PUT/PATCH/DELETE only when intended.

`servo_navigate` and `servo_inspect` also include this same citation-style
`results` entry for rendered pages, while retaining their existing `page`
summary for compatibility.

For example, create several tabs with `servo_session_create` using
`{ "sessions": [{ "url": "https://example.com" }, { "url": "https://example.org" }] }`.
Then inspect them together with
`{ "sessions": [{ "sessionId": "…" }, { "sessionId": "…" }] }`, or
navigate them with per-tab URLs using
`{ "sessions": [{ "sessionId": "…", "url": "https://example.net" }] }`.
Keep each returned `sessionId` mapped to its tab; there is no session-list tool.
Use `servo_session_close` with a `sessionIds` array when those tabs are done.

Screen recording is an asynchronous start/stop/status/download flow. Start a
recording for a tab, continue browsing it, stop the recording, poll its status
while the Worker encodes H.264 MP4, then request the direct download link. The
recording captures video only, at up to 960×540 and 3 fps; the default is 2 fps
for up to 30 seconds, with a 60-second maximum. The Durable Object stays active
while capturing frames, so recording time adds duration charges. Completed files
and download links are retained for up to 24 hours, with up to three completed
recordings per tab. The direct download URL is a bearer link; do not share it.
The H.264 encoder is compiled from `h264-mp4-encoder` v1.0.12 with Emscripten's
ahead-of-time Embind bindings and dynamic code generation disabled, so it runs
under the Worker runtime's code-generation restrictions. Its generated module,
WASM, source revision, and applicable upstream licenses are in `src/vendor/`.

Each session is one tab routed to its own SQLite-backed Durable Object, which
serializes operations and stores a chunked restore snapshot. Each completed
browser-tool call checkpoints every `localStorage` and `sessionStorage` entry,
the complete cookie jar (including `HttpOnly` cookies), and each visited
origin's IndexedDB database schema and records. Storage keys and values are not
truncated, and the snapshot has no app-level byte ceiling. Browser storage
quotas, Durable Object storage capacity, and Worker runtime resources still
apply. Cache Storage remains runtime-local and incomplete in this Servo build.

The live Servo WASM runtime has no application-level idle hold. When a browser
tool call and its snapshot writes finish, the Durable Object is eligible for
Cloudflare-managed hibernation; a later call automatically restores the saved
tab state and reloads the current page. Cloudflare currently hibernates eligible
objects after about 10 seconds, but controls the exact timing. The checkpoint
preserves URL, viewport, scroll position, common form values, registered fonts,
and the source for inline HTML pages. It does not preserve the JavaScript heap,
browser history, arbitrary DOM mutations, or application state held only in
memory. Restoring never replays prior tool actions. Sessions are deleted after
30 days without use or when closed; closing explicitly also deletes the
snapshot and saved assets. Letting the Durable Object hibernate avoids billing
for an application timer that holds it awake; restoring Servo still uses Worker
CPU time. See [Cloudflare's Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

`servo_evaluate` runs JavaScript in the page realm and awaits a returned
promise within the call's time budget. It can inspect Servo's DOM, CSS, canvas
and browser APIs. Results are WebDriver-style JSON clones.
Servo reports supported, partial, unsupported and unverified features through
`servo_get_capabilities`. This describes the Cloudflare WASM Worker port, not
every feature implemented by Servo's native builds; `unsupportedReasons`
explains known port-specific constraints.

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
builds Servo and asks Wrangler to calculate the bundle without deploying. The
screen-recording source currently dry-runs at 51,850.93 KiB (15,787.40 KiB
gzip), below Cloudflare's 64 MiB Worker bundle ceiling.

## Test deployment

Deployed on 2026-09-30 to the authenticated Cloudflare account. The live Worker
uses Durable Object-backed browser sessions. The screen-recording tools above
are source changes and are not live until a later deployment.

- MCP endpoint: <https://servo-mcp.defcronyke.workers.dev/mcp>
- Health: <https://servo-mcp.defcronyke.workers.dev/health>
- Deployed Worker version: `50cd14f7-3bc4-4903-8dca-c0eb0209aa38` (servo-wasm `c032c2791`, ABI 11)

The `/health` endpoint and MCP `tools/list` response were verified against the
live Worker. The endpoint currently has no authentication and is public for
testing. Before broader publication, decide the access
policy; add OAuth and consent before private or user-scoped use. Measure CPU
and total isolate memory on the intended Workers plan and review Cloudflare and
ChatGPT submission requirements before publication. The deployed bundle was
49,987.34 KiB (15,274.21 KiB gzip) in Wrangler's dry run, below the 64 MiB Worker limit.

The MCP handler validates localhost and `workers.dev` Host/Origin defaults;
custom domains should also be protected by Cloudflare routing and deployment
policy.

## License

MIT for Servo MCP code in this repository. The Servo WASM submodule and all
third-party packages remain under their own license terms.
