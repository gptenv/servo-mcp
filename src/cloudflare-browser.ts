import { createServoWorkerRuntime } from './vendor/servo-worker/worker-adapter.mjs';
import { applyChromeRequestDefaults } from './chrome-request-profile';

/**
 * Cloudflare-specific Servo browser factory.
 *
 * Provides MESH-backed egress (cf1:network) for all browser network activity
 * without requiring the vendor adapter to export the higher-level helper.
 * Preserves the required public-network policy and onNetworkResult callback.
 */
export async function createCloudflareServoBrowser(
  wasmModule: WebAssembly.Module,
  env: { MESH?: { fetch: typeof fetch } },
  options: Record<string, unknown> & { onNetworkResult?: (url: string, status: number | null, error: unknown) => void } = {},
) {
  const { onNetworkResult, ...browserOptions } = options;
  const transport = createCloudflareTransport(env, onNetworkResult);
  const runtime = await createServoWorkerRuntime(wasmModule, { ...browserOptions, onNetworkResult, ...transport });

  // Polyfill requestHttp if the current adapter/WASM does not provide it.
  // The real implementation lives in Servo-WASM; this keeps HTTP tools functional
  // until the upstream adapter exports the method.
  if (typeof (runtime as any).requestHttp !== 'function') {
    (runtime as any).requestHttp = async (input: any) => {
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Only HTTP(S) requests are supported');
      if (url.username || url.password) throw new TypeError('URL credentials are prohibited');
      const method = String(input.method || 'GET').toUpperCase();
      if (/^(?:CONNECT|TRACE|TRACK)$/.test(method)) throw new TypeError(method + ' is forbidden by the Fetch API.');
      if (input.body !== undefined && (method === 'GET' || method === 'HEAD')) throw new TypeError(method + ' cannot carry a body');
      const current = await (runtime as any).evaluate('location.href');
      const pageUrl = typeof current?.Ok?.String === 'string' ? current.Ok.String : null;
      if (pageUrl === null || new URL(pageUrl).origin !== url.origin) {
        throw new Error('Servo HTTP origin mismatch. Navigate to the destination origin first.');
      }
      const requestPayload = JSON.stringify({
        url: url.href,
        method,
        headers: input.headers || {},
        body: input.body,
        followRedirects: input.followRedirects !== false,
        maxResponseBytes: input.maxResponseBytes || 512 * 1024,
        maxDurationMs: input.maxDurationMs || 10000,
      });
      const script = `(async () => {
        const request = ${requestPayload};
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), request.maxDurationMs);
        try {
          const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            ...(request.body === undefined ? {} : { body: request.body }),
            redirect: request.followRedirects ? 'follow' : 'manual',
            signal: controller.signal,
          });
          const headers = Object.fromEntries(response.headers.entries());
          let bodyBase64 = '';
          let bodyBytes = 0;
          let truncated = false;
          if (request.method !== 'HEAD' && response.body) {
            const reader = response.body.getReader();
            const chunks = [];
            const max = request.maxResponseBytes;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (bodyBytes + value.byteLength > max) {
                const remaining = max - bodyBytes;
                if (remaining > 0) chunks.push(value.slice(0, remaining));
                bodyBytes += Math.max(remaining, 0);
                truncated = true;
                await reader.cancel();
                break;
              }
              chunks.push(value);
              bodyBytes += value.byteLength;
            }
            const bytes = new Uint8Array(bodyBytes);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            // Encode in bounded chunks to avoid argument/string size limits.
            // Keep every non-final chunk on a 3-byte boundary so the base64
            // padding from intermediate chunks cannot corrupt the final value.
            for (let start = 0; start < bytes.length; start += 0x7ffe) {
              bodyBase64 += btoa(String.fromCharCode(...bytes.subarray(start, start + 0x7ffe)));
            }
          }
          return JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            headers,
            url: response.url,
            bodyBase64,
            bodyBytes,
            truncated,
            redirected: response.redirected,
          });
        } finally {
          clearTimeout(timer);
        }
      })()`;
      const result = await (runtime as any).evaluate(script);
      const parsed = typeof result?.Ok?.String === 'string' ? JSON.parse(result.Ok.String) : result;
      return parsed;
    };
  }

  return runtime;
}

function createCloudflareTransport(
  env: { MESH?: { fetch: typeof fetch } },
  onNetworkResult: ((url: string, status: number | null, error: unknown) => void) | undefined = () => {},
) {
  if (!env?.MESH || typeof env.MESH.fetch !== 'function') {
    throw new Error('Servo-WASM requires a Cloudflare MESH binding for browser egress.');
  }
  const mesh = env.MESH;
  const ensureAllowed = (value: string, socket = false) => {
    const url = new URL(value);
    if (!(socket ? ['ws:', 'wss:'].includes(url.protocol) : ['http:', 'https:'].includes(url.protocol))) {
      throw new TypeError('Unsupported browser network URL protocol');
    }
    if (url.username || url.password) throw new TypeError('Credentials in URLs are prohibited');
    const h = url.hostname.toLowerCase().replace(/^[\[]|[\]]$/g, '');
    if (h === 'localhost' || /\.(?:localhost|local|internal|test|invalid)$/.test(h) ||
        h === 'metadata.google.internal' || h === '::' || h === '::1' ||
        /^::ffff:/i.test(h) || /^[fc][0-9a-f]/i.test(h) || /^fe[89ab]/i.test(h) ||
        /^(?:0|10|127|169\.254|192\.168|224|240)\./.test(h) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(h) ||
        /^100\.(?:6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\./.test(h) ||
        /^198\.(?:18|19)\./.test(h) || /^192\.0\.0\./.test(h)) {
      throw new TypeError('Private, local or metadata network destination blocked');
    }
    return url;
  };
  const fetchImpl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
    requestContext?: { destination?: unknown; preflight?: boolean },
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    ensureAllowed(url);
    try {
      const request = new Request(input, { ...init, redirect: 'manual' });
      const response = await mesh.fetch(applyChromeRequestDefaults(request, requestContext));
      onNetworkResult?.(url, response.status, null);
      return response;
    } catch (error) {
      onNetworkResult?.(url, null, error);
      throw error;
    }
  };
  const webSocketFactory = (url: string, protocols?: string | string[]) => {
    const verified = ensureAllowed(url, true);
    const pair = new WebSocketPair();
    const [client, bridge] = Object.values(pair);
    client.accept();
    bridge.accept();
    const closeBoth = (code = 1011, reason = 'Mesh WebSocket bridge closed') => {
      for (const socket of [client, bridge]) {
        try { socket.close(code, reason.slice(0, 100)); } catch {}
      }
    };
    void (async () => {
      const target = verified.href.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
      const headers = new Headers({ Upgrade: 'websocket' });
      if (protocols) headers.set('Sec-WebSocket-Protocol', Array.isArray(protocols) ? protocols.join(', ') : protocols);
      const response = await mesh.fetch(target, { headers });
      const remote = response.webSocket;
      if (response.status !== 101 || !remote) throw new Error('Mesh refused WebSocket upgrade');
      remote.accept();
      bridge.addEventListener('message', event => { try { remote.send(event.data); } catch { closeBoth(); } });
      remote.addEventListener('message', event => { try { bridge.send(event.data); } catch { closeBoth(); } });
      bridge.addEventListener('close', event => { try { remote.close(event.code || 1000, event.reason); } catch {} });
      remote.addEventListener('close', event => closeBoth(event.code || 1000, event.reason));
      remote.addEventListener('error', () => closeBoth());
    })().catch(error => { onNetworkResult?.(verified.href, null, error); closeBoth(); });
    return client;
  };
  return { fetchImpl, webSocketFactory };
}
