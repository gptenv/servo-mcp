import { describe, expect, it, vi } from 'vitest';
import { parseBingRss, searchWeb } from '../src/web-search';

describe('parseBingRss', () => {
  it('parses RSS items and decodes XML entities', () => {
    const xml = '<?xml version="1.0"?><rss><channel>' +
      '<item><title><![CDATA[Servo &amp; WASM]]></title><link>https://example.com/a?x=1&amp;y=2</link><description>A &lt;b&gt;browser&lt;/b&gt; &#39;result&#39;</description></item>' +
      '<item><title>Second</title><link>https://example.com/b</link><description>Two</description></item>' +
      '</channel></rss>';
    expect(parseBingRss(xml, 1)).toEqual([
      { title: 'Servo & WASM', url: 'https://example.com/a?x=1&y=2', snippet: "A <b>browser</b> 'result'" },
    ]);
  });

  it('ignores malformed items and returns an empty list when there are none', () => {
    expect(parseBingRss('<rss><channel><item><title>Missing URL</title></item></channel></rss>')).toEqual([]);
    expect(parseBingRss('<rss><channel></channel></rss>')).toEqual([]);
  });
});

describe('searchWeb', () => {
  it('validates the query before making a request', async () => {
    await expect(searchWeb('   ')).rejects.toThrow('must not be empty');
    await expect(searchWeb('x'.repeat(513))).rejects.toThrow('exceeds 512');
  });

  it('fetches Bing RSS and returns structured results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      '<rss><channel><item><title>Example</title><link>https://example.com</link><description>Example result</description></item></channel></rss>',
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const results = await searchWeb('servo wasm', 2);
    expect(results).toEqual([{ title: 'Example', url: 'https://example.com', snippet: 'Example result' }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestUrl.searchParams.get('q')).toBe('servo wasm');
    expect(requestUrl.searchParams.get('format')).toBe('rss');
    vi.unstubAllGlobals();
  });

  it('rejects failed search responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    await expect(searchWeb('servo')).rejects.toThrow('HTTP 503');
    vi.unstubAllGlobals();
  });
});
