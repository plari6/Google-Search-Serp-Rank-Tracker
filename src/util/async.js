export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

/** Random delay in [min, max] ms. */
export const jitter = (min, max) => Math.round(min + Math.random() * Math.max(0, max - min));

/** Run fn over items with at most `limit` in flight; results keep input order. */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        if (err?.stopPool) stopped = true;
        out[i] = { error: err };
        if (err?.stopPool) throw err;
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  const fatal = results.find((r) => r.status === 'rejected');
  if (fatal) {
    fatal.reason.partial = out;
    throw fatal.reason;
  }
  return out;
}

/** fetch with a hard timeout; returns the Response. */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000, fetchImpl = globalThis.fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  try {
    return await fetchImpl(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw Object.assign(new Error(`timeout after ${timeoutMs} ms: ${url.split('?')[0]}`), { kind: 'timeout' });
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export function hash(str) {
  // FNV-1a 32-bit, enough for cache keys.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
