// Offline demo provider: renders Google-like result pages (fed through the real Cheerio parser) for a
// fictional brand, with a storyline over the weeks: steady SEO gains, a competitor surge, a sudden drop
// on two money keywords in the final week, a featured snippet won and AI Overview citations.
import { parseGoogleSerp } from '../parser/google.js';

const WEEK = 7 * 24 * 3600 * 1000;

function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLERS = [
  'g2.com', 'capterra.com', 'reddit.com', 'en.wikipedia.org', 'youtube.com', 'forbes.com', 'techradar.com',
  'zapier.com', 'getapp.com', 'softwareadvice.com', 'trustradius.com', 'medium.com', 'quora.com', 'pcmag.com',
  'hubspot.com', 'atlassian.com', 'gartner.com', 'investopedia.com', 'linkedin.com', 'businessnewsdaily.com',
  'nerdwallet.com', 'shopify.com', 'indeed.com', 'helpscout.com', 'tech.co', 'zdnet.com', 'cnet.com',
  'producthunt.com', 'github.com', 'stackoverflow.com', 'ycombinator.com', 'theverge.com', 'wired.com',
  'businessinsider.com', 'smartsheet.com', 'monday.com', 'notion.so', 'clickup.com', 'slack.com', 'nytimes.com',
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * @param {{brand: string, competitors: string[], endDate?: Date|string|number, story?: object}} opts
 */
export function createDemoProvider(opts = {}) {
  const brand = opts.brand || 'quillmesh.com';
  const competitors = opts.competitors?.length ? opts.competitors : ['tandorra.com', 'supportlyx.com', 'ticketgrove.com'];
  const end = new Date(opts.endDate || Date.now()).getTime();
  const dropKeywords = new Set((opts.dropKeywords || ['help desk software', 'ticketing system']).map((k) => k.toLowerCase()));
  const snippetKeyword = (opts.snippetKeyword || 'what is a help desk').toLowerCase();

  // t = weeks relative to the final demo week (0 = latest, -7 = first).
  const weekOf = (now) => Math.round((new Date(now || end).getTime() - end) / WEEK);

  function positions(keyword, t) {
    const k = keyword.toLowerCase();
    const r0 = rng('base:' + k);
    const noise = rng(`noise:${k}:${t}`);
    const out = new Map();
    // Brand: starts somewhere 3..60 (some keywords not ranking), trends upward ~1.2 pos/week on 70% of keywords.
    const start = r0() < 0.12 ? 140 : 3 + Math.floor(r0() * 58);
    const improving = r0() < 0.7;
    const trend = improving ? 0.6 + r0() * 1.6 : -(r0() * 0.9);
    let brandPos = start - trend * (t + 7) + (noise() - 0.5) * 3;
    if (start > 100 && t >= -2 && r0() < 0.5) brandPos = 18 + noise() * 10; // new rankings
    if (dropKeywords.has(k)) brandPos = t === 0 ? 15 + noise() * 4 : 9 - 0.6 * (t + 7) + noise(); // page 1, then a sudden drop
    if (k.includes(brand.split('.')[0])) brandPos = k === brand.split('.')[0] ? 1 : 1 + Math.floor(r0() * 2); // brand terms
    if (k === snippetKeyword) brandPos = t >= 0 ? 1 : 4 + noise() * 2; // wins the featured snippet this week
    out.set(brand, Math.max(1, Math.round(brandPos)));
    competitors.forEach((c, i) => {
      const rc = rng(`comp:${c}:${k}`);
      const base = rc() < 0.15 ? 130 : 1 + Math.floor(rc() * 30);
      const surge = i === 0 ? 0.55 * (t + 7) : 0; // first competitor gains steadily
      out.set(c, Math.max(1, Math.round(base - surge + (noise() - 0.5) * 4)));
    });
    return out;
  }

  function buildResults(keyword, t) {
    const k = keyword.toLowerCase();
    const want = [...positions(keyword, t).entries()].filter(([, p]) => p <= 100).sort((a, b) => a[1] - b[1]);
    const slots = new Array(100).fill(null);
    for (const [domain, p] of want) {
      let i = p - 1;
      while (i < 100 && slots[i]) i++;
      if (i < 100) slots[i] = domain;
    }
    const rf = rng('fill:' + k);
    const pool = [...FILLERS].sort(() => rf() - 0.5);
    let fi = 0;
    const results = slots.map((d) => d || pool[fi++ % pool.length] + (fi > pool.length ? `/p${fi}` : ''));
    return results.map((d, i) => {
      const [host, extra] = d.split('/');
      const isTracked = host === brand || competitors.includes(host);
      let p = isTracked ? `/${slug(keyword)}` : `/${slug(keyword)}${extra ? '-' + extra : ''}`;
      // Cannibalisation: on one keyword the brand blog competes with the product page.
      if (host === brand && k === 'help desk ticketing system' && t >= -1) p = '/blog/what-is-a-ticketing-system';
      if (host === brand && /pricing|cost/.test(k)) p = '/pricing';
      if (host === brand && k === brand.split('.')[0]) p = '/';
      return { url: `https://www.${host}${p}`, host, title: `${keyword.replace(/\b\w/g, (c) => c.toUpperCase())} | ${host.split('.')[0]} ${i + 1}` };
    });
  }

  function renderPage(keyword, page, t) {
    const k = keyword.toLowerCase();
    const all = buildResults(keyword, t);
    if (k === 'help desk ticketing system' && t >= -1) {
      // second brand URL lower down
      all.splice(24, 0, { url: `https://www.${brand}/features/ticketing`, host: brand, title: 'Ticketing features | Quillmesh' });
    }
    const items = all.slice(page * 10, page * 10 + 10);
    const rf = rng(`feat:${k}:${t}`);
    const parts = [];
    if (page === 0) {
      const commercial = /software|tool|platform|pricing|best|system|app/.test(k);
      if (commercial && rf() < 0.6) {
        const advertiser = rf() < 0.5 ? competitors[0] : competitors[1];
        parts.push(`<div id="tads"><div data-text-ad="1"><a href="https://www.googleadservices.com/aclk?x" data-pcu="https://www.${advertiser}/"><div role="heading">${esc(keyword)} - Try ${advertiser} free</div></a><span class="x2VHCd">${advertiser}</span></div></div>`);
      }
      if (/^(what|how|why)\b/.test(k) || rf() < 0.35) {
        const cites = [all[1], all[3], all[6]].map((r) => `<a href="${r.url}">${esc(r.host)}</a>`).join('');
        const brandCite = t >= -3 && rng('aio:' + k)() < 0.5 ? `<a href="https://www.${brand}/guides/${slug(keyword)}">${brand}</a>` : '';
        parts.push(`<div class="MjjYud"><div><h1 role="heading">AI Overview</h1><div>${esc(keyword)} explained in short...</div>${cites}${brandCite}</div></div>`);
      }
    }
    items.forEach((r, i) => {
      const featured = page === 0 && i === 0 && (k === snippetKeyword ? t >= -2 : /^(what|how)\b/.test(k));
      const body = `<div class="g" data-hveid="CA${i}"><div><a href="${r.url}"><h3>${esc(r.title)}</h3><div><cite>https://www.${r.host} › ${esc(slug(keyword))}</cite></div></a></div><div class="VwiC3b">Mar 3, 2026 — Learn about ${esc(keyword)} with ${esc(r.host)}. Compare features, pricing and reviews.</div></div>`;
      parts.push(featured
        ? `<div class="MjjYud"><block-component>${body}<a href="https://support.google.com/websearch/answer/9351707">About featured snippets</a></block-component></div>`
        : `<div class="MjjYud">${body}</div>`);
      if (page === 0 && i === 2 && rf() < 0.7) {
        parts.push(`<div class="MjjYud"><div><h2 role="heading">People also ask</h2>${[`What is the best ${k}?`, `Is ${k} free?`, `How much does ${k} cost?`].map((q) => `<div class="related-question-pair" data-q="${esc(q)}"><span>${esc(q)}</span></div>`).join('')}</div></div>`);
      }
      if (page === 0 && i === 4 && /near me|local|in \w+$/.test(k)) {
        parts.push(`<div class="MjjYud"><div><h2 role="heading">Places</h2><div class="VkpGBb"><span class="OSrXXb">Quillmesh HQ</span><a href="https://www.${brand}/">Website</a></div><div class="VkpGBb"><span class="OSrXXb">Desk Partners</span></div></div></div>`);
      }
      if (page === 0 && i === 6 && rf() < 0.3) {
        parts.push(`<div class="MjjYud"><div><h3 role="heading">Videos</h3><g-scrolling-carousel><a href="https://www.youtube.com/watch?v=${slug(k)}"><div role="heading">${esc(keyword)} tutorial</div></a></g-scrolling-carousel></div></div>`);
      }
    });
    const related = page === 0
      ? `<div id="botstuff"><div><h2 role="heading">Related searches</h2>${['free', 'for small business', 'open source'].map((s) => `<a href="/search?q=${encodeURIComponent(k + ' ' + s)}">${esc(k + ' ' + s)}</a>`).join('')}</div></div>`
      : '';
    const next = page < 9 ? `<a id="pnnext" href="/search?q=${encodeURIComponent(k)}&start=${(page + 1) * 10}">Next</a>` : '';
    return `<!doctype html><html><head><title>${esc(keyword)} - Google Search</title></head><body><div id="rcnt"><div id="center_col"><div id="result-stats">About ${(12000 + (k.length * 7919) % 900000).toLocaleString('en-US')} results (0.41 seconds)</div><div id="search"><div id="rso">${parts.join('')}</div></div>${related}${next}</div></div></body></html>`;
  }

  return {
    name: 'demo',
    concurrency: 8,
    delayMs: [0, 0],
    weekOf,
    renderPage: (keyword, page, now) => renderPage(keyword, page, weekOf(now)),
    async fetchPage({ keyword, page, now }) {
      const html = renderPage(keyword, page, weekOf(now));
      return { ...parseGoogleSerp(html, { page: page + 1 }), html };
    },
  };
}
