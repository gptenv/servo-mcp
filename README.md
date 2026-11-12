# Servo MCP

Servo MCP is a Cloudflare Worker MCP App for running Servo WASM as an isolated,
headless browser. It exposes the browser engine through Streamable HTTP at
`/mcp` and provides a small MCP Apps UI for loading pages and viewing rendered
screenshots.

The project files in this repository are MIT licensed. `servo-wasm/` is a Git
submodule and keeps its own license and notices; the MIT license here does not
change the license of Servo or its other dependencies.

## MCP tools

The server exposes focused tools. The browser UI is a ChatGPT MCP App resource, and the same app is advertised with a global sidebar entrypoint; browser tools are linked to that shared UI. The search tool has a dedicated search view within the app. Browser and HTTP tools accept an `actions` array of
objects; each browser action carries an optional `sessionID` alongside its
arguments. Omit `sessionID` or set it to a falsy value (`null`, `false`, `0`, or
`""`) to create a new tab and perform the action. A truthy ID must identify an
existing session: active tabs are reused and sleeping tabs are restored
automatically. Unknown IDs return `SESSION_NOT_FOUND` with status 404 and an
MCP error response, without creating replacement tabs. Malformed truthy IDs are
rejected during input validation.

Every tool returns an ordered top-level `responses` array with one response
object per action. Each object includes `actionIndex`, its resolved `sessionID`
when applicable, and either the action response or its error. A top-level
`metadata` object reports aggregate response, success, and failure counts.
Status checks use the same action shape with empty action objects (`{}`). A new
session created by a status action returns its status; an existing session
reports runtime availability without forcing a page reload. HTTP tools now
create real Servo sessions by default and return their IDs.

- `servo_web_search`
- `servo_session_status`
- `servo_navigate`, `servo_reload`, `servo_history`
- `servo_inspect`, `servo_evaluate`, `servo_get_capabilities`
- `servo_http_request`, plus `servo_http_get`, `servo_http_post`, `servo_http_put`,
  `servo_http_patch`, `servo_http_delete`, `servo_http_head`, and `servo_http_options`
- `servo_click`, `servo_type_text`, `servo_press_key`, `servo_scroll`, `servo_wait`
- `servo_screenshot`, `servo_register_font`
- `servo_recording_start`, `servo_recording_stop`, `servo_recording_status`,
  `servo_recording_download`

The `servo_web_search` tool supports `auto`, `all`, `brave`, `google`, `bing`, `duckduckgo`, and `yandex` providers. It navigates actual Servo WASM browser sessions to search pages and parses their DOM markup. Searches accept an `actions` array with one `query`, `provider`, and optional `sessionID` per action. Each search action uses one tab and visits its providers sequentially. Distinct actions run concurrently in their own sessions; the result maps each action index to its resulting session ID. New browser sessions can be more CPU- and memory-intensive than the old Worker-only request adapters. Search engines can change their markup, require JavaScript, or block automated browsing; results are best-effort.

For example, to run two searches in separate browsers, creating a new one
for the first action and reusing an existing browser for the second:

```json
{
  "actions": [
    {"sessionID": null, "query": "Servo WASM", "provider": "brave"},
    {"sessionID": "00000000-0000-4000-8000-000000000001", "query": "MCP sessions", "provider": "bing"}
  ]
}
```

Each action's session ID is paired with that same action's arguments, not placed
in a separate positional array. The response preserves action order and reports
`actionIndex` and `sessionID` for each operation. `null`, `false`, `0`, `""`, or an omitted `sessionID` creates an independent session.

The HTTP tools send requests via **Servo's in-page `fetch()`**, not Cloudflare's Worker-global `fetch()`. Each HTTP action may contain `sessionID`, `width`, and `height`; omit the ID to create a new Servo browser, or supply an existing one to preserve its cookies and origin. Each result includes the session ID for reuse. New sessions first navigate with GET to the destination **origin root** (for example, `https://api.example.com/`), then invoke the requested method in that browsing context. This bootstrap GET is a real network request. Existing sessions perform the request from their current page origin without navigation.

**Compatibility change:** browser requests use Servo-WASM's privileged Cloudflare Worker transport, which deliberately bypasses browser CORS checks in the Worker-targeted fork. Forbidden-header and cookie semantics may still be enforced by other engine layers; redirects remain handled by Servo-WASM. A request from a tab on a different origin might fail where the old Worker-level HTTP client succeeded. Manual redirects may yield opaque responses with no exposed status or headers. The Cloudflare Mesh egress policy and browser-network adapter are implemented in Servo-WASM, not Servo MCP. Use only public HTTP(S) destinations. Upload bodies must be UTF-8 text; response bodies and execution times remain bounded. Mutating requests are never replayed automatically.


All HTTP tools share a generic request widget that opens with the original
request, response, and available screenshot already populated. Edit the URL,
method (including custom methods), JSON headers, and request body, then press
**Send request** to make another request through `servo_http_request`. Batches
show **Send N requests** and send the displayed actions together. Original
redirect, timeout, and response-size options are preserved. Opening the widget
never sends a request; host layout updates do not replay results or reload images.
The browser, HTTP, and search widgets report only intrinsic content height,
coalesce resize notifications, and stop observing size on teardown.

Each completed HTTP action also gets an 800 × 600 Servo screenshot of the returned content.
A temporary offline renderer uses the captured body, with scripts and external
resources blocked. Opening the widget does not repeat the request. Hosted PNGs
expire after 24 hours. If capture fails, the HTTP response is still available.

`servo_navigate` and `servo_inspect` also include this same citation-style
`results` entry for rendered pages, while retaining their existing `page`
summary for compatibility.

For example, open several pages with `servo_navigate`:

```json
{
  "actions": [{ "url": "https://example.com" }, { "url": "https://example.org" }]
}
```

Then inspect those tabs with `servo_inspect`:

```json
{
  "actions": [{ "sessionID": "<first returned ID>" }, { "sessionID": "<second returned ID>" }]
}
```

Existing and new tabs can be mixed in one call. Put a session ID directly on each action that targets an existing tab. Non-falsy IDs must be distinct in
one call. Keep each returned `sessionID` mapped to its tab; there is no
session-list, session-start, or session-close tool. Sessions expire after
30 days without use.

New tabs default to 1280 × 720. Optional `width` and `height` in an action
choose the initial viewport and are rejected with an existing ID. Navigation
accepts exactly one of `url` or `html` (up to 1 MiB of UTF-8), so inline test
pages can be loaded directly and restored later. Register a font with
`servo_register_font` and then navigate using its returned ID when needed.

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
30 days without use, which also deletes the snapshot and saved assets. Letting the Durable Object hibernate avoids billing
for an application timer that holds it awake; restoring Servo still uses Worker
CPU time. See [Cloudflare's Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

`servo_evaluate` runs JavaScript in the page realm and awaits a returned
promise within the call's time budget. It can inspect Servo's DOM, CSS, canvas
and browser APIs. Results are WebDriver-style JSON clones.
Servo reports supported, partial, unsupported and unverified features through
`servo_get_capabilities`. This describes the Cloudflare WASM Worker port, not
every feature implemented by Servo's native builds; `unsupportedReasons`
explains known port-specific constraints.

The endpoint currently has no authentication. A `sessionID` is therefore a
bearer capability: anyone who obtains it can use that session. Do not
share it or use this testing endpoint for sensitive browsing.

The server limits a pump to 15 seconds, resumable inline HTML to 1 MiB, response bodies
to 8 MiB and each browser session to 50 subrequests. Only public HTTP(S) URLs
are allowed. The host also sets Cloudflare's `global_fetch_strictly_public` flag
so Worker fetches cannot connect to private network targets after DNS
resolution. Do not remove either layer when deploying.

## Local setup

The app downloads the deployable Servo Worker package from the latest successful
`main` run of the public `gptenv/servo-wasm` Actions workflow. For local use,
create a fine-grained GitHub PAT scoped only to `gptenv/servo-wasm` with
**Actions: Read**, then copy `.env.example` to `.env` and set
`SERVO_WASM_GITHUB_TOKEN`. The token stays in the ignored local `.env` file;
never commit `.env` or put this PAT in GitHub Actions secrets.

```sh
npm ci
npm run typecheck
npm test
npm run dev
```

`npm run engine:fetch` downloads the latest successful, unexpired Servo artifact
through GitHub's official Actions API, verifies its commit and SHA-256 manifest,
and stages the adapter and WASM under the ignored
`src/vendor/servo-worker/` directory. `npm run deploy` and `npm run dev` do
this automatically. The generated package is not committed.

The local health endpoint is `http://127.0.0.1:8788/health`; the MCP endpoint is
`http://127.0.0.1:8788/mcp`. Connect ChatGPT Developer Mode or MCP Inspector to
the HTTPS `/mcp` URL exposed by your development tunnel. The app uses current
Cloudflare `createMcpHandler` with stateless Streamable HTTP and the MCP Apps UI
resource convention. The browser widget completes the `ui/initialize` handshake
before it accepts tool input or calls tools. Viewport screenshots are stored on
the session and returned to the widget in tool-result `_meta` (a Worker URL
plus inline PNG bytes when the capture is at most 96 KiB). Each tab retains its eight
most recent screenshots for up to 24 hours. Closing the browser session revokes its screenshot URLs.
Larger captures are stored as 512 KiB chunks. The browser UI
resource allows that Worker origin in `ui.csp.resourceDomains` and
`openai/widgetCSP.resource_domains`, and the widget falls back from a `data:`
URL to the hosted PNG when a host CSP blocks one of them. Browser-session continuity lives in per-session Durable
Objects, separate from the stateless MCP transport. The `ServoBrowserSession`
SQLite class is declared in `wrangler.jsonc`; apply its migration when
deploying.

Run `npm run typecheck` and `npm test` for the app checks. `npm run
deploy:dry-run` fetches the latest verified artifact and asks Wrangler to
calculate the bundle without deploying. `npm run deploy:staged` deploys an
already staged package and is used by CI after its build job succeeds.

## Continuous deployment

Pull requests run the typecheck and app tests. After those pass on `main`, CI
checks out the public `servo-wasm` `main` source in its temporary runner,
builds and tests the Worker WASM, validates the MCP bundle, and then deploys the
successful build to Cloudflare. CI does not need or receive
`SERVO_WASM_GITHUB_TOKEN`.

Add these repository secrets under **Settings → Secrets and variables →
Actions** to enable production deployment:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token scoped to the target account
  with Workers Scripts:Edit and Account Settings:Read.
- `CLOUDFLARE_ACCOUNT_ID`: the target Cloudflare account ID.

The Cloudflare token is separate from the local GitHub PAT. The GitHub PAT is
only for local artifact retrieval; the CI deployment uses Cloudflare credentials
stored as GitHub Actions secrets.

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

### Cloudflare Mesh egress

The deployed Worker binds `MESH` to the default Cloudflare Mesh virtual network via `cf1:network`. The Servo network adapter uses `env.MESH.fetch()` for all HTTP(S) navigation, document, asset, and in-page network requests. It does not fall back to the Worker-global fetch if Mesh is unavailable. Servo's WebSocket factory requests a WebSocket upgrade through the same Mesh binding, bridges messages and closes the session if the upgrade fails; ordinary WebSockets must never bypass the routing policy. Confirm WebSocket upgrade support in your deployed account and inspect Cloudflare Gateway traffic logs. HTTP previews remain offline. This is Gateway/Mesh routing, not a WARP client process running in the Worker.


### Browser implementation boundary

MCP's `requestHttp` tool delegates validation and page execution to `ServoWorkerRuntime.requestHttp()` in Servo-WASM. MCP retains only tool-level URL admission, session selection, result formatting, and Durable Object orchestration. Browser-origin validation, page-script execution and transport implementation are owned by the Servo-WASM adapter. The new method requires an adapter artifact containing Servo-WASM PR #10; the default artifact-fetch script still selects a successful main-branch build.

## Servo-WASM dependency compatibility

The MCP Worker requires `createCloudflareServoBrowser` from Servo-WASM's
Worker adapter. CI now explicitly checks this export and refuses to build
against incompatible Servo-WASM source. The artifact installer also validates
this public API before staging assets. For testing unmerged Servo-WASM changes,
set `SERVO_WASM_SOURCE_BRANCH` to the corresponding PR branch and optionally
pin `SERVO_WASM_SOURCE_SHA` to a specific commit. Production defaults to
verified `main` artifacts. Merge Servo-WASM's matching API before deploying
Servo-MCP to production.

### Browser document ownership

Page summaries and document HTML extraction are handled by Servo-WASM's
`pageSummary()` and `documentHtml()` runtime APIs. MCP supplies session
routing and response envelopes, not the browser DOM extraction expressions.

Browser state capture, state application, and page storage probes now call the
Servo-WASM runtime APIs instead of constructing browser DOM/IndexedDB scripts
in the MCP session class. Durable Object persistence and recording storage
still require a separate ownership migration.

The MCP wrapper now calls Servo-WASM's `captureWebStorage()` and
`renderOfflineHtmlPreview()` rather than creating browser page scripts or
an independent offline browser runtime. MCP retains the screenshot token and
asset persistence contract.
