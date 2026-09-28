/// <reference types="@cloudflare/workers-types" />

import type { ServoBrowserSession } from './src/browser-session';

declare global {
  interface Env {
    BROWSER_SESSIONS: DurableObjectNamespace<ServoBrowserSession>;
  }
}
