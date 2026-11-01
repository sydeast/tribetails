import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
/**
 * #1287: the portal's CSP shipped without any Mapbox origin, so on the live
 * site the style request was blocked, RouteMap fell back to the bare polyline
 * and the Visit Replay card showed a route on blank. Every header block in
 * mytribe/firebase.json must let mapbox-gl reach api.mapbox.com (style, tiles,
 * glyphs, sprites over fetch; sprite and raster images) and events.mapbox.com
 * (telemetry), and must keep blob: workers for the GL worker.
 */
interface HeaderBlock {
  source: string;
  headers: { key: string; value: string }[];
}
const config = JSON.parse(readFileSync(resolve(__dirname, '../../../firebase.json'), 'utf8')) as {
  hosting: HeaderBlock[] | HeaderBlock;
};
function cspValues(): { source: string; csp: string }[] {
  const out: { source: string; csp: string }[] = [];
  const hostings = Array.isArray(config.hosting) ? config.hosting : [config.hosting];
  for (const h of hostings as unknown as { headers?: HeaderBlock[] }[]) {
    for (const block of h.headers ?? []) {
      const csp = block.headers.find((x) => x.key === 'Content-Security-Policy');
      if (csp) out.push({ source: block.source, csp: csp.value });
    }
  }
  return out;
}
function directive(csp: string, name: string): string[] {
  const part = csp.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${name} `));
  return part ? part.split(/\s+/).slice(1) : [];
}
describe('mytribe/firebase.json CSP allows the Mapbox basemap', () => {
  const policies = cspValues();
  it('finds at least one policy to check', () => {
    expect(policies.length).toBeGreaterThan(0);
  });
  it.each(policies.map((p) => [p.source, p.csp] as const))('%s', (_source, csp) => {
    expect(directive(csp, 'connect-src')).toEqual(expect.arrayContaining(['https://api.mapbox.com', 'https://events.mapbox.com']));
    expect(directive(csp, 'img-src')).toEqual(expect.arrayContaining(['https://api.mapbox.com', 'blob:']));
    expect(directive(csp, 'worker-src')).toContain('blob:');
  });
});
