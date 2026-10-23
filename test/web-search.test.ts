import { describe, expect, it, vi } from 'vitest';
import { dedupeResults, parseBraveHtml, parseBingRss, parseDuckDuckGoHtml, parseGoogleHtml, parseYandexHtml, searchWeb } from '../src/web-search';

describe('search parsers', () => {
  it('parses Brave result cards and strips HTML from snippets', () => {
    const html = '<div class="snippet svelte-x" data-pos="0"><div class="result-content">' +
      '<a href="https://example.com/servo" target="_self"><div class="title search-snippet-title line-clamp-1" title="Servo &amp; WASM">Servo &amp; WASM</div></a>' +
      '<div class="generic-snippet"><div class="content desktop-default">A <strong>browser</strong> engine.</div></div>' +
      '</div></div>';
    expect(parseBraveHtml(html)).toEqual([
      { title: 'Servo & WASM', url: 'https://example.com/servo', snippet: 'A browser engine.', provider: 'brave' },
    ]);
  });

  it('parses Bing RSS and decodes XML entities', () => {
    const xml = '<rss><channel><item><title><![CDATA[Servo &amp; WASM]]></title><link>https://example.com/a?x=1&amp;y=2</link><description>A &lt;b&gt;browser&lt;/b&gt; &#39;result&#39;</description></item></channel></rss>';
    expect(parseBingRss(xml)).toEqual([
      { title: 'Servo & WASM', url: 'https://example.com/a?x=1&y=2', snippet: "A browser 'result'", provider: 'bing' },
    ]);
  });

  it('parses Google result links', () => {
    const html = '<a href="/url?q=https%3A%2F%2Fexample.com%2Fservo&sa=x"><h3>Servo</h3></a>';
    expect(parseGoogleHtml(html)).toEqual([{ title: 'Servo', url: 'https://example.com/servo', snippet: '', provider: 'google' }]);
  });

  it('parses DuckDuckGo results and snippets', () => {
    const html = '<a class="result__a" href="https://example.com/servo">Servo</a><div class="result__snippet">A browser engine.</div>';
    expect(parseDuckDuckGoHtml(html)).toEqual([{ title: 'Servo', url: 'https://example.com/servo', snippet: 'A browser engine.', provider: 'duckduckgo' }]);
  });

  it('parses Yandex result links', () => {
    const html = '<a href="https://example.com/servo">Servo</a>';
    expect(parseYandexHtml(html)).toEqual([{ title: 'Servo', url: 'https://example.com/servo', snippet: '', provider: 'yandex' }]);
  });

  it('deduplicates URLs while preserving result order', () => {
    const results = [
      { title: 'A', url: 'https://example.com/', snippet: '', provider: 'google' as const },
      { title: 'B', url: 'https://example.com', snippet: '', provider: 'bing' as const },
      { title: 'C', url: 'https://other.example', snippet: '', provider: 'yandex' as const },
    ];
    expect(dedupeResults(results, 10)).toHaveLength(2);
    expect(dedupeResults(results, 10)[0].title).toBe('A');
  });
});

describe('searchWeb', () => {
  it('validates the query before making a request', async () => {
    await expect(searchWeb('   ')).rejects.toThrow('must not be empty');
    await expect(searchWeb('x'.repeat(513))).rejects.toThrow('exceeds 512');
  });

  it('queries all providers in auto mode and tolerates individual failures', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.hostname === 'search.brave.com') {
        return new Response('<div class="snippet"><a href="https://brave.example"><div class="title search-snippet-title" title="Brave result">Brave result</div></a><div class="content">Brave</div></div>', { status: 200 });
      }
      if (url.hostname === 'www.google.com') {
        return new Response('<html><a href="/url?q=https%3A%2F%2Fexample.com%2Fgoogle-result"><h3>Google result</h3></a></html>', { status: 200 });
      }
      if (url.hostname === 'www.bing.com') {
        return new Response('<rss><channel><item><title>Bing result</title><link>https://bing.example</link><description>Bing</description></item></channel></rss>', { status: 200 });
      }
      if (url.hostname === 'html.duckduckgo.com') {
        return new Response('<a class="result__a" href="https://ddg.example">DDG result</a><div class="result__snippet">DDG</div>', { status: 200 });
      }
      return new Response('nope', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchWeb('servo wasm', 8, 'auto');
    expect(result.results.map((item) => item.provider)).toEqual(['brave', 'google', 'bing', 'duckduckgo']);
    expect(result.providers).toEqual(['brave', 'google', 'bing', 'duckduckgo']);
    expect(result.failedProviders).toEqual(['yandex']);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    vi.unstubAllGlobals();
  });

  it('can target one provider', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '<rss><channel><item><title>Example</title><link>https://example.com</link><description>Example result</description></item></channel></rss>',
      { status: 200 },
    )));
    const result = await searchWeb('servo', 2, 'bing');
    expect(result.results).toEqual([{ title: 'Example', url: 'https://example.com', snippet: 'Example result', provider: 'bing' }]);
    vi.unstubAllGlobals();
  });

  it('returns an empty result set when providers respond but yield no parseable results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>blocked</html>', { status: 200 })));
    await expect(searchWeb('servo', 8, 'duckduckgo')).resolves.toEqual({
      results: [], providers: ['duckduckgo'], failedProviders: [],
    });
    vi.unstubAllGlobals();
  });

  it('throws when every selected provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    await expect(searchWeb('servo', 8, 'all')).rejects.toThrow('All selected web search providers failed');
    vi.unstubAllGlobals();
  });
});
