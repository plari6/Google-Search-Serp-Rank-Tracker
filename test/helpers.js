import { normalizeProject } from '../src/config.js';
import { openDb } from '../src/db.js';

export function makeProject(over = {}) {
  return normalizeProject({
    name: 'acme',
    brand: { name: 'Acme', domains: ['acme.com'] },
    competitors: [{ name: 'Rival', domains: ['rival.com'] }, { name: 'Other', domains: ['other.io'] }],
    keywords: [
      { keyword: 'crm software', volume: 5000, priority: true, group: 'Core' },
      { keyword: 'best crm', volume: 2000, group: 'Core' },
      { keyword: 'crm pricing', volume: 500, group: 'Pricing', targetUrl: 'https://acme.com/pricing' },
      { keyword: 'what is crm', volume: 8000, group: 'Guides' },
    ],
    depth: 30,
    ...over,
  });
}

/** 30 organic results where `place` maps position -> url; everything else is filler. */
export function serp(place = {}, features = {}) {
  const organic = Array.from({ length: 30 }, (_, i) => {
    const url = place[i + 1] || `https://filler${i + 1}.net/page`;
    return { rank: (i % 10) + 1, title: `r${i + 1}`, url, domain: new URL(url).hostname.replace(/^www\./, ''), snippet: '', sitelinks: 0, featured: false };
  });
  return { organic, features };
}

/** Provider that serves pages from a map keyword -> serp(), 10 per page, counting requests. */
export function fakeProvider(map, extra = {}) {
  const p = {
    name: 'fake', concurrency: 2, delayMs: [0, 0], requests: 0,
    async fetchPage({ keyword, page }) {
      p.requests++;
      const s = typeof map === 'function' ? await map(keyword, page) : map[keyword];
      if (!s) return { status: 'no_results', organic: [], features: {}, hasNextPage: false };
      if (s.status && s.status !== 'ok') return s;
      const slice = s.organic.slice(page * 10, page * 10 + 10);
      return { status: slice.length ? 'ok' : 'no_results', organic: slice, features: page === 0 ? s.features : {}, hasNextPage: page < 2, totalResults: 1000 };
    },
    ...extra,
  };
  return p;
}

export const memDb = () => openDb(':memory:');
export const day = (iso) => new Date(iso + 'T07:00:00Z');
