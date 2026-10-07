const SEARCH_ENDPOINT = 'https://www.bing.com/search';
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 10;
const MAX_QUERY_LENGTH = 512;
const SEARCH_TIMEOUT_MS = 8_000;

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function tagValue(item: string, tag: string): string {
  const match = item.match(new RegExp('<' + tag + '[^>]*>([\s\S]*?)</' + tag + '>', 'i'));
  return decodeXml(match?.[1] ?? '').trim();
}

export function parseBingRss(xml: string, limit = DEFAULT_LIMIT): WebSearchResult[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  return items.slice(0, limit).map((item) => ({
    title: tagValue(item, 'title'),
    url: tagValue(item, 'link'),
    snippet: tagValue(item, 'description'),
  })).filter((result) => result.title && result.url);
}

export async function searchWeb(query: string, limit = DEFAULT_LIMIT): Promise<WebSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new TypeError('Search query must not be empty.');
  if (trimmed.length > MAX_QUERY_LENGTH) throw new RangeError('Search query exceeds ' + MAX_QUERY_LENGTH + ' characters.');

  const count = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('format', 'rss');
  url.searchParams.set('count', String(count));
  url.searchParams.set('setlang', 'en-us');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'User-Agent': 'Servo-MCP/0.4 (+https://github.com/gptenv/servo-mcp)',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Web search returned HTTP ' + response.status + '.');
    return parseBingRss(await response.text(), count);
  } finally {
    clearTimeout(timeout);
  }
}
