# Servo MCP

Servo MCP is a Cloudflare Worker MCP App for running Servo WASM as an isolated,
headless browser. It exposes the browser engine through Streamable HTTP at
`/mcp` and provides a small MCP Apps UI for loading pages and viewing rendered
screenshots.

The project files in this repository are MIT licensed. `servo-wasm/` is a Git
submodule and keeps its own license and notices; the MIT license here does not
change the license of Servo or its other dependencies.

## What it can do

The `servo_run` tool creates a new browser instance for each call. Provide either
a public URL or inline HTML, then optionally run browser actions:

- Inspect page URL, title and visible text.
- Evaluate synchronous JavaScript in the page realm.
- Click, type, press keys, scroll, traverse history and reload.
- Capture viewport or full-page PNG screenshots.
- Register a font for the current page run.
- Read the runtime's supported, partial and unsupported feature report.

Use an `evaluate` action to access the rest of Servo's DOM, CSS, canvas, timer,
fetch and page APIs. Calls are isolated: no state, storage, cookies or page
globals survive between tool calls. Include the URL/HTML and any needed actions
again on each call. Page-evaluation results are synchronous and serialized;
returned promises are not awaited.

The server limits each call to 20 actions, 15 seconds per pump, a 2 MiB inline
document, 8 MiB response bodies and 50 subrequests. Only public HTTP(S) URLs are
allowed. The host also sets Cloudflare's `global_fetch_strictly_public` flag so
Worker fetches cannot connect to private network targets after DNS resolution.
Do not remove either layer when deploying.

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
resource convention.

Run `npm run typecheck` and `npm test` for the app checks. `npm run deploy:dry-run`
builds Servo and asks Wrangler to calculate the bundle without deploying.
The Servo binary is close to Cloudflare's 64 MiB Worker bundle ceiling, so the
combined Worker bundle must be measured before any deployment.

## Test deployment

Deployed on 2026-09-25 to the authenticated Cloudflare account:

- MCP endpoint: <https://servo-mcp.defcronyke.workers.dev/mcp>
- Health: <https://servo-mcp.defcronyke.workers.dev/health>
- Worker version: `51012c07-bb9d-4dd2-b2a1-82b40328fef7`

The MCP endpoint, `servo_run` tool, and `ui://servo/browser.html` resource were
verified against the live Worker. The endpoint currently has no authentication
and is public for testing. Before broader publication, decide the access
policy; add OAuth and consent before private or user-scoped use. Measure CPU
and total isolate memory on the intended Workers plan and review Cloudflare and
ChatGPT submission requirements before publication. The deployed bundle was
62,172 KiB in Wrangler's dry run, below the 64 MiB Worker limit.

The MCP handler validates localhost and `workers.dev` Host/Origin defaults;
custom domains should also be protected by Cloudflare routing and deployment
policy.

## License

MIT for Servo MCP code in this repository. The Servo WASM submodule and all
third-party packages remain under their own license terms.
