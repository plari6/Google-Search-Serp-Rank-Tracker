// Domain normalisation and "does this result belong to that site" matching.

const GOOGLE_HOST = /(^|\.)google\.[a-z.]+$|(^|\.)googleusercontent\.com$|(^|\.)gstatic\.com$/i;

/** "https://www.Example.com/a?b" -> "example.com" ; "example.com/blog" -> "example.com" */
export function hostOf(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  try {
    return new URL(s).hostname.toLowerCase().replace(/^www\d*\./, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

/**
 * A tracked target: "example.com", "shop.example.com", "example.com/blog".
 * Subdomains match unless the pattern starts with "=" (exact host only).
 */
export function parseTarget(pattern) {
  let p = String(pattern).trim().toLowerCase();
  const exact = p.startsWith('=');
  if (exact) p = p.slice(1);
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\d*\./, '');
  const slash = p.indexOf('/');
  const host = (slash === -1 ? p : p.slice(0, slash)).replace(/\.$/, '');
  let path = slash === -1 ? '' : p.slice(slash).replace(/\/+$/, '');
  return { host, path, exact, raw: pattern };
}

export function matchesTarget(url, target) {
  const t = typeof target === 'string' ? parseTarget(target) : target;
  const h = hostOf(url);
  if (!h || !t.host) return false;
  const hostOk = t.exact ? h === t.host : h === t.host || h.endsWith('.' + t.host);
  if (!hostOk) return false;
  if (!t.path) return true;
  let path = '/';
  try {
    path = new URL(/^[a-z]+:\/\//i.test(url) ? url : 'http://' + url).pathname.toLowerCase();
  } catch {}
  return path === t.path || path.startsWith(t.path + '/');
}

export function isGoogleUrl(url) {
  return GOOGLE_HOST.test(hostOf(url));
}

/** Resolve Google redirect links (/url?q=..., /url?url=...) and drop tracking fragments. */
export function cleanResultUrl(href, base = 'https://www.google.com') {
  if (!href) return '';
  let h = String(href).trim();
  if (h.startsWith('/url?') || /google\.[a-z.]+\/url\?/.test(h)) {
    try {
      const u = new URL(h, base);
      h = u.searchParams.get('q') || u.searchParams.get('url') || '';
    } catch {
      return '';
    }
  }
  if (!/^https?:\/\//i.test(h)) return '';
  try {
    const u = new URL(h);
    // Google appends #:~:text= highlight fragments to some results.
    if (u.hash.startsWith('#:~:')) u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

/** Comparable form of a URL for "did the ranking page change" checks. */
export function urlKey(url) {
  try {
    const u = new URL(url);
    return (hostOf(url) + u.pathname.replace(/\/+$/, '') + (u.search || '')).toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

// Google "uule" location parameter (v2, canonical name), e.g. "Austin,Texas,United States".
const UULE_KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function uule(canonicalName) {
  const name = String(canonicalName || '').trim();
  if (!name) return '';
  const len = Buffer.byteLength(name, 'utf8');
  const key = UULE_KEY[len % UULE_KEY.length];
  return 'w+CAIQICI' + key + Buffer.from(name, 'utf8').toString('base64');
}
