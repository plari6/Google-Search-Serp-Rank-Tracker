// Tiny built-in scheduler (no cron dependency): weekly report day + time, optional daily alert checks.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseDay(d) {
  const i = DAYS.indexOf(String(d || 'mon').slice(0, 3).toLowerCase());
  if (i === -1) throw new Error(`unknown day "${d}" (use mon..sun)`);
  return i;
}

export function parseTime(t) {
  const m = String(t || '07:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`bad time "${t}" (use HH:MM, 24h)`);
  return [Number(m[1]), Number(m[2])];
}

/** Next local Date at HH:MM, on weekday `day` (0-6) or any day when day is null. */
export function nextOccurrence(from, { day = null, at = '07:00' } = {}) {
  const [h, m] = parseTime(at);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(h, m);
  if (d <= from) d.setDate(d.getDate() + 1);
  if (day !== null) while (d.getDay() !== day) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Loop forever: weekly job on `day` at `at`; if `daily` is set, an alerts-only job every other day.
 * @param {{day: string, at: string, daily: boolean, weekly: () => Promise<void>, dailyJob?: () => Promise<void>, log: Function, signal?: AbortSignal}} o
 */
export async function runSchedule(o) {
  const day = parseDay(o.day);
  for (;;) {
    const now = new Date();
    const nextWeekly = nextOccurrence(now, { day, at: o.at });
    const nextDaily = o.daily ? nextOccurrence(now, { day: null, at: o.at }) : null;
    const isWeekly = !nextDaily || nextWeekly.getTime() === nextDaily.getTime();
    const when = isWeekly ? nextWeekly : nextDaily;
    o.log(`Next ${isWeekly ? 'weekly report' : 'daily alert check'}: ${when.toString()}`);
    await waitUntil(when, o.signal);
    try {
      await (isWeekly ? o.weekly() : o.dailyJob());
    } catch (err) {
      o.log(`Scheduled job failed: ${err.message}`);
    }
  }
}

function waitUntil(date, signal) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const ms = date.getTime() - Date.now();
      if (ms <= 0) return resolve();
      timer = setTimeout(tick, Math.min(ms, 60 * 60 * 1000)); // re-check hourly (sleep / clock changes)
    };
    let timer;
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
    tick();
  });
}
