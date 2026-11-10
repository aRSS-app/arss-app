import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb, listItems, parseInterval } from '../src/db.js';
import { fetchFeed, dueFeeds } from '../src/fetcher.js';

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
