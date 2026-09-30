import { z } from 'zod';
import { assertPublicHttpUrl } from './security';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = typeof HTTP_METHODS[number];

const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_HEADERS = 64;

function decodeCodePoint(decimal: string, radix = 10): string {
  const value = parseInt(decimal, radix);
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : '\uFFFD';
}

const headersSchema = z.record(z.string().min(1).max(256), z.string().max(8192))
  .refine((headers) => Object.keys(headers).length <= MAX_HEADERS, `At most ${MAX_HEADERS} headers are allowed.`);

export const httpRequestSchema = z.object({
  url: z.string().url().max(2048),
  method: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/).default('GET'),
  headers: headersSchema.optional(),
  body: z.string().max(MAX_REQUEST_BYTES).optional(),
  followRedirects: z.boolean().default(true),
  maxResponseBytes: z.number().int().min(1).max(MAX_RESPONSE_BYTES).default(512 * 1024),
  maxDurationMs: z.number().int().min(100).max(15_000).default(10_000),
});

export const httpVerbRequestSchema = httpRequestSchema.omit({ method: true });
export type HttpRequest = z.infer<typeof httpRequestSchema>;

function textFromHtml(source: string): { title: string; text: string } {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)?.[1] ?? '';
  const text = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, ' ')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6]|article|section|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value: string) => decodeCodePoint(value))
    .replace(/&#x([\da-f]+);/gi, (_, value: string) => decodeCodePoint(value, 16))
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title: title.replace(/<[^>]*>/g, '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim().slice(0, 512),
    text,
  };
}

async function readBody(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        size += Math.max(remaining, 0);
        truncated = true;
        await reader.cancel('Response body limit reached.');
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Fetches public HTTP(S) endpoints without allowing redirects to bypass URL policy. */
export async function requestHttp(input: HttpRequest) {
  const method = input.method.toUpperCase();
  if (/^(?:CONNECT|TRACE|TRACK)$/.test(method)) throw new TypeError(`${method} is forbidden by the Fetch API.`);
  if (input.body !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw new TypeError(`${method} requests cannot include a body.`);
  }
  const encodedBody = input.body === undefined ? undefined : new TextEncoder().encode(input.body);
  if (encodedBody && encodedBody.byteLength > MAX_REQUEST_BYTES) throw new RangeError('Request body exceeds 1 MiB.');

  let url = assertPublicHttpUrl(input.url);
  let currentMethod = method;
  let body = encodedBody;
  let headers = new Headers({ Accept: '*/*' });
  for (const [name, value] of Object.entries(input.headers ?? {})) headers.set(name, value);
  let response: Response | undefined;
  let redirected = false;
  const maxRedirects = 5;
  const signal = AbortSignal.timeout(input.maxDurationMs);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    response = await fetch(url, {
      method: currentMethod,
      headers,
      body: body as BodyInit | undefined,
      redirect: 'manual',
      signal,
    });
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location || !input.followRedirects) break;
    if (hop === maxRedirects) throw new Error('HTTP redirect limit exceeded.');
    const next = assertPublicHttpUrl(new URL(location, url).href);
    if (next.origin !== url.origin) {
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
    }
    if ((response.status === 303 && currentMethod !== 'HEAD') || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
      currentMethod = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    await response.body?.cancel();
    url = next;
    redirected = true;
  }
  if (!response) throw new Error('HTTP request did not produce a response.');

  const { bytes, truncated } = await readBody(response, method === 'HEAD' ? 0 : input.maxResponseBytes);
  const contentType = response.headers.get('content-type') ?? '';
  const textual = /^(text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml|javascript|x-www-form-urlencoded))/i.test(contentType);
  const decoded = textual ? new TextDecoder().decode(bytes) : undefined;
  const extracted = decoded && /html/i.test(contentType) ? textFromHtml(decoded) : undefined;
  const content = extracted?.text ?? decoded;
  const title = extracted?.title || response.headers.get('x-page-title') || url.hostname;
  const responseHeaders = Object.fromEntries(response.headers.entries());
  return {
    request: { method, url: input.url },
    response: {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      url: response.url || url.href,
      redirected,
      headers: responseHeaders,
      contentType: contentType || null,
      bodyBytes: bytes.byteLength,
      truncated,
    },
    // Web-search-style result fields make fetched pages easy to cite and scan;
    // body preserves the actual response for API clients and binary content.
    results: content === undefined ? [] : [{
      title,
      url: response.url || url.href,
      snippet: content.slice(0, 500),
      content: content.slice(0, 20_000),
    }],
    body: decoded ?? null,
    bodyBase64: content === undefined ? base64(bytes) : null,
  };
}
