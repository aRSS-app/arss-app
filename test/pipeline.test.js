import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb, listItems, parseInterval } from '../src/db.js';
import { fetchFeed, dueFeeds, fixAmpersands } from '../src/fetcher.js';

const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title><link>http://x</link>
<item><guid>a</guid><title>One</title><link>http://x/1</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate><description>hello world</description></item>
<item><guid>b</guid><title>Two</title><link>http://x/2</link><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><description>second</description></item>
</channel></rss>`;

test('fetch, dedupe, schedule, search', async () => {
  const srv = createServer((_, res) => { res.setHeader('content-type', 'application/rss+xml'); res.end(rss); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/feed`;
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO feeds (url, interval_minutes, created_at) VALUES (?, 60, ?)').run(url, now);
  assert.equal(dueFeeds(db, now).length, 1);

  const feed = db.prepare('SELECT * FROM feeds').get();
  assert.deepEqual(await fetchFeed(db, feed, now), { added: 2, total: 2 });
  assert.deepEqual(await fetchFeed(db, feed, now), { added: 0, total: 2 });

  assert.equal(dueFeeds(db, now + 59 * 60000).length, 0);
  assert.equal(dueFeeds(db, now + 61 * 60000).length, 1);

  const items = listItems(db, {});
  assert.equal(items[0].title, 'Two');
  assert.equal(listItems(db, { search: 'hello' }).length, 1);
  srv.close();
});

test('interval parsing', () => {
  assert.equal(parseInterval('weekly'), 10080);
  assert.equal(parseInterval(90), 90);
  assert.throws(() => parseInterval(1));
});

test('seed is idempotent and feeds are due', async () => {
  const { seed } = await import('../src/seed.js');
  const feeds = JSON.parse((await import('node:fs')).readFileSync(new URL('../seed/feeds.json', import.meta.url), 'utf8'));
  const db = openDb(':memory:');
  assert.equal(seed(db, feeds), feeds.length);
  assert.equal(seed(db, feeds), 0);
  assert.equal(dueFeeds(db).length, feeds.length);
});

test('feed with bare ampersands still parses', async () => {
  const bad = rss.replace('<title>One</title>', '<title>Mavens & the Macabre</title>');
  const srv = createServer((_, res) => { res.setHeader('content-type', 'application/rss+xml'); res.end(bad); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const db = openDb(':memory:');
  db.prepare('INSERT INTO feeds (url, interval_minutes, created_at) VALUES (?, 60, ?)').run(`http://127.0.0.1:${srv.address().port}/f`, Date.now());
  assert.deepEqual(await fetchFeed(db, db.prepare('SELECT * FROM feeds').get()), { added: 2, total: 2 });
  assert.ok(listItems(db, {}).some((i) => i.title === 'Mavens & the Macabre'));
  assert.equal(fixAmpersands('a &amp; b & c &#38; d'), 'a &amp; b &amp; c &#38; d');
  srv.close();
});

test('non-2xx feed records an error without crashing', async () => {
  const srv = createServer((_, res) => { res.statusCode = 404; res.end('nope'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const db = openDb(':memory:');
  db.prepare('INSERT INTO feeds (url, interval_minutes, created_at) VALUES (?, 60, ?)').run(`http://127.0.0.1:${srv.address().port}/f`, Date.now());
  const r = await fetchFeed(db, db.prepare('SELECT * FROM feeds').get());
  assert.equal(r.error, 'Status code 404');
  assert.equal(db.prepare('SELECT last_error FROM feeds').get().last_error, 'Status code 404');
  srv.close();
});

test('featured images come from media tags, enclosures or the first real body image', async () => {
  const { extractImage } = await import('../src/fetcher.js');
  assert.equal(extractImage({ enclosure: { url: 'https://a/e.jpg', type: 'image/jpeg' } }), 'https://a/e.jpg');
  assert.equal(extractImage({ enclosure: { url: 'https://a/e.mp3', type: 'audio/mpeg' } }), null);
  assert.equal(extractImage({ mediaGroup: { 'media:thumbnail': [{ $: { url: 'https://a/t.jpg' } }] } }), 'https://a/t.jpg');
  assert.equal(extractImage({ link: 'https://a/post/', content: '<img width="1" height="1" src="/px.gif"><img src="/pic.png?a=1&amp;b=2">' }), 'https://a/pic.png?a=1&b=2');
  assert.equal(extractImage({ itunes: { image: 'https://a/show.jpg' } }, ['https://a/show.jpg']), null);
  assert.equal(extractImage({ content: '<img src="javascript:alert(1)">' }), null);
});

test('images are stored, and backfilled for items fetched before images were captured', async () => {
  const withImg = rss.replace('<description>hello world</description>', '<description>hello world</description><enclosure url="http://x/one.jpg" type="image/jpeg" length="1"/>');
  let body = rss;
  const srv = createServer((req, res) => {
    if (req.url !== '/feed') { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/rss+xml'); res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feeds (url, interval_minutes, created_at, icon_url) VALUES (?, 60, ?, '')").run(`http://127.0.0.1:${srv.address().port}/feed`, Date.now());
  const feed = db.prepare('SELECT * FROM feeds').get();
  await fetchFeed(db, feed);
  assert.equal(listItems(db, {}).find((i) => i.title === 'One').image, null);
  body = withImg;
  assert.deepEqual(await fetchFeed(db, feed), { added: 0, total: 2 });
  assert.equal(listItems(db, {}).find((i) => i.title === 'One').image, 'http://x/one.jpg');
  srv.close();
});
