/**
 * Shared Vite plugin that lets Vitest (which parses imports before `vi.mock`
 * can intercept them) load the Worker source files that import generated or non-JS assets:
 *  - `src/browser-widget.html`  -> exported as a plain string module
 *  - `*.wasm`                   -> exported as an empty object module
 * The real behaviour of those modules is irrelevant to unit tests; the code
 * under test receives fakes through `vi.mock` on the same resolved ids.
 */

import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function assetShimPlugin(): Plugin {
  return {
    name: 'servo-test-asset-shim',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('/vendor/servo-worker/worker-adapter.mjs')) {
        return path.resolve(process.cwd(), 'test/helpers/servo-worker-adapter.ts');
      }
      if (source.endsWith('.html') || source.endsWith('.wasm')) {
        return '\0servo-shim:' + source;
      }
      return null;
    },
    load(id) {
      if (!id.startsWith('\0servo-shim:')) return null;
      const source = id.slice('\0servo-shim:'.length);
      if (source.endsWith('.html')) {
        // Serve the real widget HTML so tests can assert its contents.
        const file = path.resolve(process.cwd(), "src", source.split("/").pop()!);
        try {
          const html = readFileSync(file, 'utf8');
          return `export default ${JSON.stringify(html)};`;
        } catch {
          return 'export default "";';
        }
      }
      return 'export default {};';
    },
  };
}
