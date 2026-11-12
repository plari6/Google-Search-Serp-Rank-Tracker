// Executive summary + action plan for the weekly report.
// AI (multi-model fallback router) writes it from pre-computed facts only; every number and keyword it
// mentions must exist in those facts, otherwise the next model is tried. Rules are the last resort.
import { hash } from './util/async.js';

export const PROMPT_VERSION = 'insights-v3';

const SYSTEM = `You are a senior SEO strategist writing the weekly rank-tracking summary an agency sends to its client.
Use ONLY the facts in the JSON you receive. Never invent numbers, keywords, competitors or causes; when you suggest a cause, phrase it as a hypothesis ("likely", "worth checking").
Do not compute new numbers; quote the numbers exactly as given. Plain business English, no jargon walls, no emojis, no markdown.
Return JSON only:
{"headline": "max 14 words, the single most important thing this week",
 "summary": "2-3 sentences for a busy client: overall direction, the biggest win, the biggest risk",
 "wins": ["max 4 short bullets"],
 "risks": ["max 4 short bullets"],
 "actions": [{"title": "imperative, max 10 words", "detail": "1-2 sentences, concrete next step", "keyword": "exact keyword from the facts or null"}]}
Give 3 to 5 actions ordered by expected impact (protect what is slipping on money keywords first, then striking-distance opportunities, then features such as featured snippets / AI Overviews, then competitor moves).`;

export function factsFor(report) {
  const k = report.kpis;
  const pick = (x) => ({ keyword: x.keyword, position: x.position, previous: x.prevPosition, change: x.change, volume: x.volume, priority: x.priority || undefined });
  return {
    client: report.project.client,
    brand: report.project.brand.name,
    period: { current: report.run.date.slice(0, 10), previous: report.compare?.date?.slice(0, 10) || null },
    kpis: {
      keywords: k.keywords, ranking: k.ranking, top3: k.top3, top10: k.top10, average_position: k.avgPosition,
      visibility_score: k.visibility, estimated_monthly_clicks: k.estClicks, improved: k.improved, declined: k.declined,
      new_rankings: k.newRankings, lost_rankings: k.lostRankings, featured_snippets_owned: k.featuredSnippets,
      ai_overview_citations: k.aiOverviewCitations, keywords_with_ai_overview: k.aiOverviewKeywords, serp_volatility_pct: k.volatility,
      previous: k.prev || null,
    },
    winners: report.winners.slice(0, 6).map(pick),
    losers: report.losers.slice(0, 6).map(pick),
    left_page_one: report.leftTop10.slice(0, 6).map(pick),
    entered_page_one: report.enteredTop10.slice(0, 6).map(pick),
    opportunities: report.opportunities.slice(0, 6).map((o) => ({ keyword: o.keyword, position: o.position, volume: o.volume, extra_clicks_if_top3: o.gainClicks, top_result: o.leader })),
    competitors: report.competitors.map((c) => ({ name: c.name, share_of_voice_pct: c.sov, previous_share_of_voice_pct: c.prevSov, top10: c.top10, outranks_brand_on: c.outranksBrand })),
    overtakes: report.overtakes.slice(0, 6),
    url_changes: report.urlChanges.slice(0, 4),
    cannibalization: report.cannibalization.slice(0, 4).map((c) => ({ keyword: c.keyword, urls: c.urls.length })),
    competitor_ads: report.advertisers.filter((a) => a.competitor).slice(0, 4),
    alerts: report.alerts.filter((a) => a.severity !== 'good').slice(0, 8).map((a) => a.text),
  };
}

/** Reject output that quotes numbers or keywords that are not in the facts. */
export function validateInsights(obj, facts) {
  if (!obj || typeof obj !== 'object') throw new Error('not an object');
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const out = {
    headline: str(obj.headline),
    summary: str(obj.summary),
    wins: (Array.isArray(obj.wins) ? obj.wins : []).map(str).filter(Boolean).slice(0, 4),
    risks: (Array.isArray(obj.risks) ? obj.risks : []).map(str).filter(Boolean).slice(0, 4),
    actions: (Array.isArray(obj.actions) ? obj.actions : []).map((a) => ({
      title: str(a?.title), detail: str(a?.detail), keyword: str(a?.keyword) && str(a.keyword) !== 'null' ? str(a.keyword) : null,
    })).filter((a) => a.title).slice(0, 5),
  };
  if (!out.headline || !out.summary || out.actions.length < 2) throw new Error('missing headline/summary/actions');
  const factsText = JSON.stringify(facts).toLowerCase();
  const known = new Set((factsText.match(/-?\d+(?:\.\d+)?/g) || []).flatMap((n) => [n, String(Math.abs(Number(n))), String(Math.round(Math.abs(Number(n))))]));
  const allText = [out.headline, out.summary, ...out.wins, ...out.risks, ...out.actions.flatMap((a) => [a.title, a.detail])].join(' ');
  const nums = (allText.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) || []).filter((n) => Number(n) > 10 && ![20, 30, 50, 100].includes(Number(n)) && !/^20\d\d$/.test(n));
  const bad = nums.filter((n) => !known.has(n) && !known.has(String(Math.round(Number(n)))));
  if (bad.length) throw new Error(`ungrounded numbers: ${bad.slice(0, 5).join(', ')}`);
  for (const a of out.actions) {
    if (a.keyword && !factsText.includes(a.keyword.toLowerCase())) a.keyword = null;
  }
  return out;
}

// ---- Rule-based fallback (no AI) ---------------------------------------------------------------
export function ruleInsights(report) {
  const k = report.kpis;
  const p = k.prev;
  const visDelta = p ? Math.round((k.visibility - p.visibility) * 100) / 100 : null;
  const dir = visDelta === null ? 'baseline' : visDelta > 0.05 ? 'up' : visDelta < -0.05 ? 'down' : 'flat';
  const brand = report.project.brand.name;
  const topWin = report.winners[0];
  const topLoss = report.losers[0];
  const opp = report.opportunities[0];
  const lead = report.competitors.filter((c) => !c.isBrand).sort((a, b) => b.sov - a.sov)[0];
  const me = report.competitors.find((c) => c.isBrand);

  const headline = dir === 'baseline'
    ? `${brand} ranks on page 1 for ${k.top10} of ${k.keywords} tracked keywords`
    : dir === 'up' ? `Visibility up to ${k.visibility} with ${k.improved} keywords improving`
      : dir === 'down' ? `Visibility slipped to ${k.visibility}; ${k.declined} keywords declined`
        : `Rankings stable: ${k.top10} keywords on page 1`;
  const parts = [];
  parts.push(p
    ? `${brand} has ${k.top10} keywords in the top 10 (previously ${p.top10}) and an average position of ${k.avgPosition ?? 'n/a'} (previously ${p.avgPosition ?? 'n/a'}).`
    : `First report: ${k.ranking} of ${k.keywords} keywords rank in the top ${report.project.depth}, ${k.top10} on page 1, average position ${k.avgPosition ?? 'n/a'}.`);
  if (topWin?.change) parts.push(`Biggest gain: "${topWin.keyword}" moved up ${topWin.change} to #${topWin.position}.`);
  if (topLoss?.change) parts.push(`Biggest drop: "${topLoss.keyword}" fell ${-topLoss.change} to #${topLoss.position}.`);
  else if (topLoss?.isLost) parts.push(`"${topLoss.keyword}" dropped out of the tracked depth.`);

  const wins = [];
  if (k.newRankings) wins.push(`${k.newRankings} new keywords started ranking`);
  for (const w of report.enteredTop10.slice(0, 2)) wins.push(`"${w.keyword}" reached page 1 at #${w.position}`);
  if (k.featuredSnippets) wins.push(`Owns ${k.featuredSnippets} featured snippet${k.featuredSnippets === 1 ? '' : 's'}`);
  if (k.aiOverviewCitations) wins.push(`Cited in ${k.aiOverviewCitations} AI Overview${k.aiOverviewCitations === 1 ? '' : 's'}`);
  const risks = [];
  for (const l of report.leftTop10.slice(0, 2)) risks.push(`"${l.keyword}" fell off page 1 (#${l.prevPosition} → ${l.position ? '#' + l.position : 'not ranking'})`);
  if (k.lostRankings) risks.push(`${k.lostRankings} keywords stopped ranking`);
  for (const o of report.overtakes.slice(0, 1)) risks.push(`${o.competitor} overtook ${brand} on "${o.keyword}"`);
  if (lead && me && lead.sov > me.sov) risks.push(`${lead.name} leads share of voice (${lead.sov}% vs ${me.sov}%)`);

  const actions = [];
  for (const l of [...report.leftTop10, ...report.losers.filter((x) => x.priority)].slice(0, 2)) {
    actions.push({ title: `Recover "${l.keyword}"`, detail: `Compare the ranking page with the current top results (${l.leader?.domain || 'top 3'}), refresh content, and check internal links and indexing.`, keyword: l.keyword });
  }
  const planned = new Set(actions.map((a) => a.keyword));
  for (const o of report.opportunities.filter((x) => !planned.has(x.keyword)).slice(0, 2)) {
    actions.push({ title: `Push "${o.keyword}" into the top 3`, detail: `Currently #${o.position}${o.gainClicks ? `; the top 3 is worth about ${o.gainClicks} extra clicks a month` : ''}. Expand the page, add FAQ schema and internal links from strong pages.`, keyword: o.keyword });
  }
  if (report.cannibalization[0]) actions.push({ title: 'Fix keyword cannibalisation', detail: `"${report.cannibalization[0].keyword}" has ${report.cannibalization[0].urls.length} of your pages competing; merge or canonicalise them.`, keyword: report.cannibalization[0].keyword });
  const snippetKw = report.keywords.find((x) => x.position && x.position <= 5 && x.features.includes('featured_snippet') && !x.owns.featured);
  if (snippetKw) actions.push({ title: 'Target a featured snippet', detail: `"${snippetKw.keyword}" shows a featured snippet you do not own while you rank #${snippetKw.position}; add a 40-50 word direct answer under a question heading.`, keyword: snippetKw.keyword });
  if (actions.length < 2) actions.push({ title: 'Expand content on page 2 keywords', detail: 'Keywords at positions 11-20 are the cheapest wins; strengthen those pages first.', keyword: null });
  if (actions.length < 2) actions.push({ title: 'Keep tracking weekly', detail: 'Trends need at least 3-4 weekly runs before acting on small moves.', keyword: null });
  return { headline, summary: parts.join(' '), wins: wins.slice(0, 4), risks: risks.slice(0, 4), actions: actions.slice(0, 5) };
}

/**
 * @param report from buildReport
 * @param {{ai?: object|null, db?: object, log?: Function, noCache?: boolean}} opts
 * @returns {{...insights, source: 'ai'|'cache'|'rules', model?: string}}
 */
export async function generateInsights(report, { ai, db, log = () => {}, noCache = false } = {}) {
  const facts = factsFor(report);
  const key = `${PROMPT_VERSION}:${hash(JSON.stringify(facts))}`;
  if (db && !noCache) {
    const hit = db.cacheGet(key);
    if (hit) return { ...hit, source: 'cache' };
  }
  if (ai && ai.enabledCount > 0) {
    try {
      const r = await ai.generate({
        system: SYSTEM,
        messages: [{ role: 'user', content: `Facts (JSON):\n${JSON.stringify(facts)}` }],
        json: true,
        temperature: 0.3,
        maxTokens: 2048,
        parse: (t) => validateInsights(JSON.parse(t.replace(/^\s*```(?:json)?|```\s*$/g, '')), facts),
      });
      const out = { ...r.data, model: r.target };
      db?.cacheSet(key, out);
      return { ...out, source: 'ai' };
    } catch (err) {
      log(`AI insights unavailable (${err.attempts?.map((a) => `${a.target}: ${a.kind}`).join(', ') || err.message}) - using rule-based summary`);
    }
  }
  return { ...ruleInsights(report), source: 'rules' };
}
