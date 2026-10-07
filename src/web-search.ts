const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 10;
const MAX_QUERY_LENGTH = 512;
const SEARCH_TIMEOUT_MS = 8_000;

export const SEARCH_PROVIDERS = ['auto', 'google', 'bing', 'duckduckgo', 'yandex', 'all'] as const;
export type SearchProvider = typeof SEARCH_PROVIDERS[number];

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  provider: Exclude<SearchProvider, 'auto' | 'all'>;
};

type Provider = Exclude<SearchProvider, 'auto' | 'all'>;

function decodeHtml(value: string): string {
  const text = value.replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, '$1').replace(/<[^>]*>/g, ' ');
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (entity) => ({
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&apos;': "'",
    })[entity] ?? entity)
    .replace(/&#(\\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\\s+/g, ' ')
    .trim();
}
function decodeUrl(value: string): string {
  const decoded = decodeHtml(value);
  try { return decodeURIComponent(decoded); } catch { return decoded; }
}

function parseBingRss(xml: string, limit = DEFAULT_LIMIT): WebSearchResult[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  return items.slice(0, limit).map((item) => ({
    title: decodeHtml((item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')),
    url: decodeUrl(item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? ''),
    snippet: decodeHtml(item.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] ?? ''),
    provider: 'bing' as const,
  })).filter((result) => result.title && /^https?:\/\//i.test(result.url));
}

function parseGoogleHtml(html: string, limit = DEFAULT_LIMIT): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const pattern = /<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const rawUrl = decodeUrl(match[1]);
    const url = rawUrl.startsWith('/url?') ? new URL(rawUrl, 'https://www.google.com').searchParams.get('q') ?? '' : rawUrl;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    let hostname: string;
    try { hostname = new URL(url).hostname; } catch { continue; }
    if (/google\./i.test(hostname)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ title: decodeHtml(match[2]), url, snippet: '', provider: 'google' });
    if (results.length >= limit) break;
  }
  return results;
}

function parseDuckDuckGoHtml(html: string, limit = DEFAULT_LIMIT): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi;
  for (const match of html.matchAll(pattern)) {
    const url = decodeUrl(match[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    let hostname: string;
    try { hostname = new URL(url).hostname; } catch { continue; }
    if (/duckduckgo\./i.test(hostname)) continue;
    results.push({ title: decodeHtml(match[2]), url, snippet: decodeHtml(match[4] ?? match[5] ?? ''), provider: 'duckduckgo' });
    if (results.length >= limit) break;
  }
  return results;
}

function parseYandexHtml(html: string, limit = DEFAULT_LIMIT): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const pattern = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const url = decodeUrl(match[1]);
    const title = decodeHtml(match[2]);
    if (!title || title.length < 2) continue;
    let hostname: string;
    try { hostname = new URL(url).hostname; } catch { continue; }
    if (/yandex\./i.test(hostname)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: '', provider: 'yandex' });
    if (results.length >= limit) break;
  }
  return results;
}

export const parsers: Record<Provider, (body: string, limit?: number) => WebSearchResult[]> = {
  google: parseGoogleHtml,
  bing: parseBingRss,
  duckduckgo: parseDuckDuckGoHtml,
  yandex: parseYandexHtml,
};

const endpoints: Record<Provider, (query: string, limit: number) => URL> = {
  google: (query, limit) => {
    const url = new URL('https://www.google.com/search');
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(limit));
    url.searchParams.set('hl', 'en');
    return url;
  },
  bing: (query, limit) => {
    const url = new URL('https://www.bing.com/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'rss');
    url.searchParams.set('count', String(limit));
    url.searchParams.set('setlang', 'en-us');
    return url;
  },
  duckduckgo: (query) => {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);
    return url;
  },
  yandex: (query) => {
    const url = new URL('https://yandex.com/search/');
    url.searchParams.set('text', query);
    return url;
  },
};

const providerHeaders: Record<Provider, Record<string, string>> = {
  google: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Servo-MCP/0.5' },
  bing: { Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8', 'User-Agent': 'Servo-MCP/0.5' },
  duckduckgo: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Servo-MCP/0.5' },
  yandex: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Servo-MCP/0.5' },
};

export function dedupeResults(results: WebSearchResult[], limit = DEFAULT_LIMIT): WebSearchResult[] {
  const seen = new Set<string>();
  const unique: WebSearchResult[] = [];
  for (const result of results) {
    const key = result.url.replace(/#.*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(result);
    if (unique.length >= limit) break;
  }
  return unique;
}

async function searchProvider(provider: Provider, query: string, limit: number): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(endpoints[provider](query, limit), {
      headers: providerHeaders[provider],
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(provider + ' search returned HTTP ' + response.status + '.');
    return parsers[provider](await response.text(), limit);
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchWeb(
  query: string,
  limit = DEFAULT_LIMIT,
  provider: SearchProvider = 'auto',
): Promise<{ results: WebSearchResult[]; providers: string[]; failedProviders: string[] }> {
  const trimmed = query.trim();
  if (!trimmed) throw new TypeError('Search query must not be empty.');
  if (trimmed.length > MAX_QUERY_LENGTH) throw new RangeError('Search query exceeds ' + MAX_QUERY_LENGTH + ' characters.');

  const count = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
  const selected: Provider[] = provider === 'all' || provider === 'auto'
    ? ['google', 'bing', 'duckduckgo', 'yandex']
    : [provider];

  const settled = await Promise.allSettled(selected.map((name) => searchProvider(name, trimmed, count)));
  const successful: WebSearchResult[] = [];
  const providers: string[] = [];
  const failedProviders: string[] = [];
  settled.forEach((result, index) => {
    const name = selected[index];
    if (result.status === 'fulfilled') {
      providers.push(name);
      successful.push(...result.value);
    } else {
      failedProviders.push(name);
    }
  });

  if (successful.length === 0) {
    throw new Error('All selected web search providers failed: ' + failedProviders.join(', ') + '.');
  }
  return { results: dedupeResults(successful, count), providers, failedProviders };
}

export { parseBingRss, parseGoogleHtml, parseDuckDuckGoHtml, parseYandexHtml };
