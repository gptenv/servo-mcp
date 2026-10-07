import { describe, expect, it, vi } from 'vitest';
import { dedupeResults, parseBingRss, parseDuckDuckGoHtml, parseGoogleHtml, parseYandexHtml, searchWeb } from '../src/web-search';

describe('search parsers', () => {
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<html><a href="/url?q=https%3A%2F%2Fgoogle.example"><h3>Google result</h3></a></html>', { status: 200 }))
      .mockResolvedValueOnce(new Response('<rss><channel><item><title>Bing result</title><link>https://bing.example</link><description>Bing</description></item></channel></rss>', { status: 200 }))
      .mockResolvedValueOnce(new Response('<a class="result__a" href="https://ddg.example">DDG result</a><div class="result__snippet">DDG</div>', { status: 200 }))
      .mockResolvedValueOnce(new Response('nope', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchWeb('servo wasm', 8, 'auto');
    expect(result.results.map((item) => item.provider)).toEqual(['google', 'bing', 'duckduckgo']);
    expect(result.providers).toEqual(['google', 'bing', 'duckduckgo']);
    expect(result.failedProviders).toEqual(['yandex']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

  it('throws when every selected provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    await expect(searchWeb('servo', 8, 'all')).rejects.toThrow('All selected web search providers failed');
    vi.unstubAllGlobals();
  });
});
