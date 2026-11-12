// Google results page -> structured data, with Cheerio.
//
// Google's class names rotate every few weeks, so the parser leans on signals that have stayed stable
// for years: an organic result is a link that wraps an <h3>; result blocks are the children of #rso;
// SERP features are recognised by their visible section heading (use hl=en for best results) plus a
// few long-lived ids/attributes (#tads, #rhs, data-attrid, data-q, #result-stats, #pnnext).
import * as cheerio from 'cheerio';
import { cleanResultUrl, hostOf, isGoogleUrl } from '../util/url.js';

const FEATURE_HEADINGS = [
  ['ai_overview', /^(ai overview|aperçu ia|übersicht mit ki|vista creada con ia|resumen de ia|panoramica ai)\b/i],
  ['people_also_ask', /^(people also ask|autres questions posées|ähnliche fragen|más preguntas|otras preguntas)/i],
  ['top_stories', /^(top stories|news|à la une|schlagzeilen|noticias destacadas|principali notizie)$/i],
  ['videos', /^(videos?|vidéos|short videos|vídeos)$/i],
  ['images', /^(images|bilder|imágenes|immagini)$/i],
  ['local_pack', /^(places|businesses|local results|locations|lieux|orte|sitios|luoghi|resultados locales)$/i],
  ['shopping', /^(popular products|products|sponsored products|shop|shopping|produits|produkte|productos)$/i],
  ['related_searches', /^(related searches|people also search for|recherches associées|ähnliche suchanfragen|búsquedas relacionadas)/i],
  ['discussions', /^(discussions and forums|forums|what people are saying)/i],
  ['things_to_know', /^things to know/i],
];

const BLOCK_PATTERNS = {
  captcha: /id="captcha-form"|g-recaptcha|unusual traffic from your computer|our systems have detected unusual traffic|\/sorry\/index/i,
  consent: /consent\.google\.[a-z.]+|before you continue to google|avant d'accéder à google|bevor sie zu google weitergehen/i,
  js_required: /httpservice\/retry\/enablejs|turn on javascript to keep searching|please click here if you are not redirected within a few seconds|enablejs\?sei=/i,
};

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function detectBlock(html) {
  for (const [kind, re] of Object.entries(BLOCK_PATTERNS)) if (re.test(html)) return kind;
  return null;
}

/**
 * @param {string} html Google results page (JS-rendered DOM from a browser / render API, or basic HTML).
 * @param {{page?: number, baseUrl?: string}} opts
 */
export function parseGoogleSerp(html, opts = {}) {
  const $ = cheerio.load(html || '');
  const base = opts.baseUrl || 'https://www.google.com';
  const root = ['#rso', '#search', '#main', 'body'].map((s) => $(s).first()).find((r) => r.length) || $.root();
  const rootEl = root.get(0);
  const stopEls = new Set(['#search', '#center_col', '#rcnt', '#main', 'body', 'html'].map((s) => $(s).get(0)).filter(Boolean));

  // Top-level block of an element: the ancestor whose parent is the results root.
  const blockOf = (el) => {
    let cur = el;
    for (let i = 0; i < 25 && cur; i++) {
      const parent = cur.parent;
      if (!parent || parent === rootEl || stopEls.has(parent) || parent.type === 'root') return cur;
      cur = parent;
    }
    return cur;
  };

  // ---- SERP features by heading -----------------------------------------------------------
  const zones = new Map(); // block element -> feature name
  const featureBlocks = {}; // feature -> [block elements]
  const scope = ['#rcnt', '#center_col', '#main'].map((s) => $(s).first()).find((r) => r.length) || root;
  const navSel = '[role="navigation"], #hdtb, #top_nav, #appbar, header, #searchform, #foot, footer';
  scope.find('h1, h2, h3, h4, [role="heading"], span, div').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 3) return; // only small heading-like nodes
    if ($el.closest(navSel).length) return;
    const text = clean($el.text());
    if (!text || text.length > 40) return;
    for (const [name, re] of FEATURE_HEADINGS) {
      if (!re.test(text)) continue;
      // An organic result title that happens to read "Videos" is not a section heading.
      if (el.tagName === 'h3' && $el.closest('a[href]').length) return;
      const block = blockOf(el);
      if (!block || block === rootEl) return;
      if (!zones.has(block)) zones.set(block, name);
      (featureBlocks[name] ||= []).includes(block) || featureBlocks[name].push(block);
      return;
    }
  });

  const adsSel = '#tads, #tadsb, #bottomads, [data-text-ad], .commercial-unit-desktop-top, .commercial-unit-desktop-rhs, .cu-container';
  const inAds = ($el) => $el.closest(adsSel).length > 0;
  const zoneOf = (el) => {
    for (let cur = el; cur && cur !== rootEl; cur = cur.parent) if (zones.has(cur)) return zones.get(cur);
    return null;
  };

  // Featured snippet: Google labels it "About featured snippets" / "Featured snippet from the web".
  let featuredBlock = null;
  $('a, span, div').each((_, el) => {
    if (featuredBlock) return;
    const t = clean($(el).text());
    if (t.length < 60 && /^(about featured snippets|featured snippet from the web)/i.test(t)) featuredBlock = blockOf(el);
  });
  if (!featuredBlock) {
    const fs = $('block-component, .xpdopen .ifM9O, [data-attrid="wa:/description"]').first();
    if (fs.length && fs.find('a h3').length) featuredBlock = blockOf(fs.get(0));
  }

  // ---- Organic results --------------------------------------------------------------------
  const organic = [];
  const seen = new Set();
  root.find('a[href]').each((_, a) => {
    const $a = $(a);
    const $h3 = $a.find('h3').first();
    if (!$h3.length) return;
    if (inAds($a) || $a.closest('#rhs').length) return;
    const zone = zoneOf(a);
    if (zone && zone !== 'discussions' && zone !== 'things_to_know') return;
    if ($a.closest('.related-question-pair, [data-q], g-scrolling-carousel, g-inner-card').length) return;
    const url = cleanResultUrl($a.attr('href'), base);
    if (!url || isGoogleUrl(url)) return;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) return;
    seen.add(key);

    const $c = $a.closest('.MjjYud, .g, [data-hveid], .Gx5Zad, .xpd').first();
    const container = $c.length ? $c : $a.parent().parent().parent();
    const title = clean($h3.text());
    const displayedUrl = clean(container.find('cite').first().text());
    let snippet = clean(
      container.find('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"], .BNeawe.s3v9rd, .s3v9rd').first().text(),
    );
    if (!snippet) {
      snippet = clean(container.text()).replace(title, '').replace(displayedUrl, '').trim();
    }
    snippet = snippet.slice(0, 320);
    const date = (snippet.match(/^([A-Z][a-z]{2} \d{1,2}, \d{4}|\d+ (?:days?|hours?|weeks?) ago)\s*[—–-]/) || [])[1] || null;
    const host = hostOf(url);
    const sitelinks = new Set();
    container.find('a[href]').each((_, s) => {
      const u = cleanResultUrl($(s).attr('href'), base);
      if (u && u.replace(/#.*$/, '') !== key && hostOf(u) === host && !$(s).find('h3').length && clean($(s).text())) sitelinks.add(u);
    });
    organic.push({
      rank: organic.length + 1,
      title,
      url,
      domain: host,
      displayedUrl,
      snippet,
      date,
      sitelinks: sitelinks.size,
      featured: !!featuredBlock && (featuredBlock === a || $(featuredBlock).find(a).length > 0),
    });
  });

  // ---- Feature details --------------------------------------------------------------------
  const externalLinks = (blocks) => {
    const out = [];
    const s = new Set();
    for (const b of blocks || []) {
      $(b).find('a[href]').each((_, a) => {
        const u = cleanResultUrl($(a).attr('href'), base);
        if (!u || isGoogleUrl(u)) return;
        const k = u.replace(/#.*$/, '');
        if (s.has(k)) return;
        s.add(k);
        out.push({ url: k, domain: hostOf(k), text: clean($(a).text()).slice(0, 120) });
      });
    }
    return out;
  };

  const questions = new Set();
  $('[data-q]').each((_, el) => questions.add(clean($(el).attr('data-q'))));
  for (const b of questions.size ? [] : featureBlocks.people_also_ask || []) {
    $(b).find('span, div[role="button"]').each((_, el) => {
      if ($(el).children().length > 2 || $(el).closest('a, h3').length) return;
      const t = clean($(el).text());
      if (t.endsWith('?') && t.length > 8 && t.length < 160) questions.add(t);
    });
  }

  const related = new Set();
  for (const b of featureBlocks.related_searches || []) {
    $(b).find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!/[?&]q=/.test(href)) return;
      try {
        const q = new URL(href, base).searchParams.get('q');
        if (q) related.add(clean(q));
      } catch {}
    });
  }

  // Local pack: place names + "Website" links.
  const localBlocks = [...(featureBlocks.local_pack || [])];
  const mapPack = $('[data-local-attribute], #lu_map, g-map, .VkpGBb').first();
  if (mapPack.length && !localBlocks.length) localBlocks.push(blockOf(mapPack.get(0)));
  const places = [];
  for (const b of localBlocks) {
    $(b).find('.VkpGBb, [data-cid], .rllt__details, [jscontroller][data-hveid]').each((_, el) => {
      const name = clean($(el).find('[role="heading"], .dbg0pd, .OSrXXb').first().text());
      if (!name || places.some((p) => p.name === name)) return;
      const site = $(el).find('a[href]').filter((_, a) => /website|site web|webseite|sitio web/i.test($(a).text())).first();
      const url = site.length ? cleanResultUrl(site.attr('href'), base) : '';
      places.push({ name, url, domain: hostOf(url) });
    });
  }

  // Ads (top and bottom) with their advertiser domains.
  const ads = [];
  $('#tads, #tadsb, #bottomads').each((_, zone) => {
    const position = $(zone).is('#bottomads') ? 'bottom' : 'top';
    const units = $(zone).find('[data-text-ad], .uEierd');
    (units.length ? units : $(zone).children()).each((_, u) => {
      const link = $(u).find('a[data-pcu], a[href^="http"], a[href^="/aclk"]').first();
      const pcu = (link.attr('data-pcu') || '').split(',')[0];
      const href = pcu || cleanResultUrl(link.attr('href'), base);
      const shown = clean($(u).find('.x2VHCd, [role="text"], cite').first().text());
      const domain = hostOf(href && !isGoogleUrl(href) ? href : shown.split(/\s|›/)[0]);
      if (domain || link.length) ads.push({ position, domain, title: clean($(u).find('[role="heading"], h3').first().text()).slice(0, 120) });
    });
  });

  const rhs = $('#rhs');
  const kpTitle = clean($('[data-attrid="title"]').first().text()) || clean(rhs.find('h2[data-attrid], .kp-header h2').first().text());
  const knowledgePanel = rhs.find('.kp-wholepage, [data-attrid], .kp-blk').length || kpTitle ? { title: kpTitle || null } : null;

  const featuredLink = organic.find((r) => r.featured);
  const aiBlocks = featureBlocks.ai_overview || [];
  const features = {
    featured_snippet: featuredBlock ? { url: featuredLink?.url || externalLinks([featuredBlock])[0]?.url || null } : null,
    ai_overview: aiBlocks.length ? { cited: externalLinks(aiBlocks).map(({ url, domain }) => ({ url, domain })) } : null,
    people_also_ask: questions.size || featureBlocks.people_also_ask ? [...questions].slice(0, 10) : null,
    local_pack: localBlocks.length ? { places: places.slice(0, 10) } : null,
    top_stories: featureBlocks.top_stories ? { items: externalLinks(featureBlocks.top_stories).slice(0, 10) } : null,
    videos: featureBlocks.videos ? { items: externalLinks(featureBlocks.videos).slice(0, 10) } : null,
    images: featureBlocks.images || $('#iur, #imagebox_bigimages').length ? true : null,
    shopping: featureBlocks.shopping || $('.commercial-unit-desktop-top, .cu-container, .pla-unit').length ? true : null,
    knowledge_panel: knowledgePanel,
    discussions: featureBlocks.discussions ? { items: externalLinks(featureBlocks.discussions).slice(0, 10) } : null,
    ads: ads.length ? ads : null,
    related_searches: related.size ? [...related].slice(0, 10) : null,
  };
  for (const k of Object.keys(features)) if (features[k] === null) delete features[k];

  const statsText = clean($('#result-stats').text());
  const totalMatch = statsText.replace(/[.,   ](?=\d{3})/g, '').match(/(\d{2,})/);
  const hasNextPage = $('#pnnext, a[aria-label="Next page"], a[aria-label="Next"]').length > 0 ||
    $('a').filter((_, a) => /^(next|next >|suivant|weiter|siguiente)$/i.test(clean($(a).text()))).length > 0;
  const noResults = /did not match any documents|aucun document ne correspond|keine übereinstimmenden dokumente/i.test(html);

  let status = 'ok';
  let blockReason = null;
  if (!organic.length) {
    const block = detectBlock(html);
    if (block) {
      status = 'blocked';
      blockReason = block;
    } else if (noResults) status = 'no_results';
    else if (!root.find('a[href]').length) status = 'empty';
    else status = 'no_results';
  }

  return {
    status,
    blockReason,
    page: opts.page ?? 1,
    organic,
    features: opts.page && opts.page > 1 ? {} : features,
    totalResults: totalMatch ? Number(totalMatch[1]) : null,
    hasNextPage,
  };
}
