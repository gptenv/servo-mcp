import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function assetShimPlugin(): Plugin {
  return {
    name: 'servo-test-widget-assets',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.endsWith('.html') && importer) {
        return '\0servo-test-html:' + path.resolve(path.dirname(importer), source);
      }
      return null;
    },
    load(id) {
      const prefix = '\0servo-test-html:';
      if (!id.startsWith(prefix)) return null;
      return 'export default ' + JSON.stringify(readFileSync(id.slice(prefix.length), 'utf8')) + ';';
    },
  };
}
