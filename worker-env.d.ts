/// <reference path="./servo-wasm/ports/servo-js-wasm/cloudflare-worker/src/assets.d.ts" />
/// <reference types="@cloudflare/workers-types" />

import type { ServoBrowserSession } from './servo-wasm/ports/servo-js-wasm/cloudflare-worker/src/browser-session';

declare global {
  interface Env {
    BROWSER_SESSIONS: DurableObjectNamespace<ServoBrowserSession>;
  }
}
