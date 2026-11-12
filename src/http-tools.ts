import { z } from 'zod';
import { assertPublicHttpUrl } from './security';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = typeof HTTP_METHODS[number];

export const MAX_HTTP_REQUEST_BYTES = 1 * 1024 * 1024;
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
  // Session options mirror the focused browser-action tools.
  sessionID: z.union([z.string().uuid(), z.literal(null), z.literal(false), z.literal(0), z.literal('')]).optional(),
  width: z.number().int().min(320).max(1920).optional(),
  height: z.number().int().min(240).max(1600).optional(),
  url: z.string().url().max(2048),
  method: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/).default('GET'),
  headers: headersSchema.optional(),
  body: z.string().max(MAX_HTTP_REQUEST_BYTES).optional(),
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

/** An HTTP response produced by fetch() inside the Servo page context. */
export type ServoHttpResponse = {
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  headers: Record<string, string>;
  bodyBase64: string;
  bodyBytes: number;
  truncated: boolean;
};

/**
 * Format a bounded browser response for MCP. Network access is deliberately
 * absent here: ServoBrowserSession.requestHttp owns the actual request.
 */
export function requestHttp(input: HttpRequest, response: ServoHttpResponse) {
  const bodyBytes = Uint8Array.from(atob(response.bodyBase64), (char) => char.charCodeAt(0));
  const contentType = response.headers['content-type'] ?? '';
  const textual = /^(text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml|javascript|x-www-form-urlencoded))/i.test(contentType);
  const decoded = textual ? new TextDecoder().decode(bodyBytes) : undefined;
  const extracted = decoded && /html/i.test(contentType) ? textFromHtml(decoded) : undefined;
  const content = extracted?.text ?? decoded;
  const title = extracted?.title || response.headers['x-page-title'] || new URL(input.url).hostname;
  return {
    request: { method: input.method.toUpperCase(), url: input.url },
    response: {
      status: response.status,
      statusText: response.statusText,
      ok: response.status >= 200 && response.status < 300,
      url: response.url,
      redirected: response.redirected,
      headers: response.headers,
      contentType: contentType || null,
      bodyBytes: response.bodyBytes,
      truncated: response.truncated,
    },
    results: content === undefined ? [] : [{
      title,
      url: response.url,
      snippet: content.slice(0, 500),
      content: content.slice(0, 20_000),
    }],
    body: decoded ?? null,
    bodyBase64: content === undefined ? response.bodyBase64 : null,
  };
}

// The preview renderer receives only the completed response. It has no network access.
export function httpPreviewHtml(result: Awaited<ReturnType<typeof requestHttp>>): string {
  const type = result.response.contentType?.split(';')[0].trim().toLowerCase() ?? '';
  if (type === 'text/html' && result.body) return result.body;
  if (result.bodyBase64 && /^image\/(png|jpeg|gif|webp)$/.test(type)) {
    return `<!doctype html><img style="max-width:100%" src="data:${type};base64,${result.bodyBase64}">`;
  }
  const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const preview = result.body || (result.response.bodyBytes ? `Binary response (${result.response.bodyBytes} bytes)` : 'No response body.');
  return `<!doctype html><meta charset="utf-8"><h2>${escape(result.request.method)} ${result.response.status}</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(preview)}</pre>`;
}
