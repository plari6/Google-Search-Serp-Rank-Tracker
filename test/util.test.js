import test from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, parseTarget, matchesTarget, cleanResultUrl, urlKey, uule, isGoogleUrl } from '../src/util/url.js';
import { parseCSV, csvToObjects, toCSV } from '../src/util/csv.js';
import { mapPool, hash } from '../src/util/async.js';
import { nextOccurrence, parseDay, parseTime } from '../src/scheduler.js';

test('hostOf normalises hosts', () => {
  assert.equal(hostOf('https://WWW.Example.com/a?b=1'), 'example.com');
  assert.equal(hostOf('www2.example.co.uk/path'), 'example.co.uk');
  assert.equal(hostOf('blog.example.com'), 'blog.example.com');
  assert.equal(hostOf(''), '');
});

test('target matching: subdomains, paths, exact hosts', () => {
  assert.ok(matchesTarget('https://blog.acme.com/x', 'acme.com'));
  assert.ok(!matchesTarget('https://notacme.com/', 'acme.com'));
  assert.ok(!matchesTarget('https://blog.acme.com/', '=acme.com'));
  assert.ok(matchesTarget('https://www.acme.com/', '=acme.com'));
  assert.ok(matchesTarget('https://acme.com/blog/post-1', 'acme.com/blog'));
  assert.ok(matchesTarget('https://acme.com/blog', 'acme.com/blog/'));
  assert.ok(!matchesTarget('https://acme.com/blogger', 'acme.com/blog'));
  assert.deepEqual(parseTarget('https://www.Acme.com/Shop/'), { host: 'acme.com', path: '/shop', exact: false, raw: 'https://www.Acme.com/Shop/' });
});

test('cleanResultUrl resolves Google redirects and rejects non-http', () => {
  assert.equal(cleanResultUrl('/url?q=https://x.com/a%3Fb%3D1&sa=U'), 'https://x.com/a?b=1');
  assert.equal(cleanResultUrl('https://www.google.com/url?url=https://y.org/&ved=1'), 'https://y.org/');
  assert.equal(cleanResultUrl('https://z.com/p#:~:text=hello'), 'https://z.com/p');
  assert.equal(cleanResultUrl('javascript:void(0)'), '');
  assert.equal(cleanResultUrl('/search?q=x'), '');
  assert.ok(isGoogleUrl('https://support.google.com/x'));
  assert.ok(isGoogleUrl('https://www.google.co.uk/maps'));
  assert.ok(!isGoogleUrl('https://googleblog.example.com'));
});

test('urlKey ignores protocol, www and trailing slash', () => {
  assert.equal(urlKey('https://www.a.com/x/'), urlKey('http://a.com/x'));
  assert.notEqual(urlKey('https://a.com/x'), urlKey('https://a.com/y'));
});

test('uule encodes the canonical location name', () => {
  const name = 'Austin,Texas,United States'; // 26 bytes -> key "a"
  const u = uule(name);
  assert.ok(u.startsWith('w+CAIQICIa'));
  assert.equal(Buffer.from(u.slice(10), 'base64').toString(), name);
  assert.equal(uule(''), '');
});

test('CSV: quotes, delimiters, BOM, formula injection guard', () => {
  assert.deepEqual(parseCSV('﻿a;b\n"x;1";"say ""hi"""\n'), [['a', 'b'], ['x;1', 'say "hi"']]);
  assert.deepEqual(csvToObjects('Keyword,Search Volume\nseo,10\r\n'), [{ keyword: 'seo', search_volume: '10' }]);
  const out = toCSV([{ a: '=HYPERLINK("x")', b: -5, c: 'x,y' }]);
  assert.match(out, /'=HYPERLINK/);
  assert.match(out, /,-5,/);
  assert.match(out, /"x,y"/);
});

test('mapPool keeps order and limits concurrency', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapPool([30, 10, 20, 5], 2, async (ms, i) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, ms));
    active--;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3]);
  assert.equal(peak, 2);
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
});

test('scheduler: next weekly / daily occurrence', () => {
  const thu = new Date(2026, 10, 12, 12, 0); // Thu 12 Nov 2026 12:00 local
  const nextMon = nextOccurrence(thu, { day: parseDay('monday'), at: '07:00' });
  assert.equal(nextMon.getDay(), 1);
  assert.equal(nextMon.getDate(), 16);
  assert.equal(nextMon.getHours(), 7);
  const daily = nextOccurrence(thu, { at: '13:30' });
  assert.equal(daily.getDate(), 12);
  assert.equal(nextOccurrence(thu, { at: '11:00' }).getDate(), 13);
  assert.throws(() => parseTime('25:00'));
  assert.throws(() => parseDay('someday'));
});
