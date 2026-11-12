/// <reference types="@cloudflare/workers-types" />

import type { ServoBrowserSession } from './src/browser-session';

declare global {
  interface Env {
    BROWSER_SESSIONS: DurableObjectNamespace<ServoBrowserSession>;
    /** Cloudflare Mesh VPC network binding (cf1:network) for all Servo egress. */
    MESH: Fetcher;
  }
}
