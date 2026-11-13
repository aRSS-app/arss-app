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

test('afterId returns only items added since', () => {
  const db = openDb(':memory:');
  const feed = db.prepare('INSERT INTO feeds (url, created_at) VALUES (?, ?)').run('https://example.com/feed', 1).lastInsertRowid;
  const add = (n) => db.prepare('INSERT INTO items (feed_id, guid, title, fetched_at) VALUES (?, ?, ?, ?)').run(feed, 'g' + n, 'Post ' + n, n).lastInsertRowid;
  const first = add(1);
  assert.equal(listItems(db, { afterId: first }).length, 0);
  add(2);
  assert.deepEqual(listItems(db, { afterId: first }).map((i) => i.title), ['Post 2']);
});

test('save and mark as read are explicit, per item', async () => {
  const { setRead, setSaved, savedCount } = await import('../src/db.js');
  const db = openDb(':memory:');
  const feed = db.prepare('INSERT INTO feeds (url, created_at) VALUES (?, ?)').run('https://example.com/feed', 1).lastInsertRowid;
  const add = (n) => db.prepare('INSERT INTO items (feed_id, guid, title, fetched_at) VALUES (?, ?, ?, ?)').run(feed, 'g' + n, 'Post ' + n, n).lastInsertRowid;
  const [a, b] = [add(1), add(2)];

  assert.equal(setSaved(db, a, true, 100), true);
  setSaved(db, a, true, 200); // saving again keeps the original time
  assert.equal(listItems(db, {}).find((i) => i.id === a).saved_at, 100);
  assert.deepEqual(listItems(db, { saved: true }).map((i) => i.title), ['Post 1']);
  assert.equal(savedCount(db), 1);
  setSaved(db, a, false);
  assert.equal(savedCount(db), 0);

  setRead(db, b);
  assert.deepEqual(listItems(db, { unread: true }).map((i) => i.title), ['Post 1']);
  setRead(db, b, false);
  assert.equal(listItems(db, { unread: true }).length, 2);
  assert.equal(setSaved(db, 999), false);
});

// A stand-in for the GitHub API: one repo, with a writable or read-only token.
async function fakeGitHub({ writable = true, config = 'export default () => ({ dir: { input: "src", includes: "_layouts" } });' } = {}) {
  const calls = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const path = req.url.replace(/\?.*/, '');
      calls.push({ method: req.method, path, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (status, json) => { res.statusCode = status; res.end(JSON.stringify(json)); };
      if (req.headers.authorization !== 'Bearer good') return send(401, { message: 'Bad credentials' });
      if (!path.startsWith('/repos/me/site')) return send(404, { message: 'Not Found' });
      const rest = path.slice('/repos/me/site'.length);
      if (req.method !== 'GET' && !writable) return send(403, { message: 'Resource not accessible by personal access token' });
      if (rest === '') return send(200, { full_name: 'me/site', default_branch: 'main' });
      if (rest === '/branches/main') return send(200, { name: 'main' });
      if (rest === '/git/blobs') return send(201, { sha: 'b1' });
      if (rest === '/contents/') return send(200, [{ name: 'eleventy.config.js', path: 'eleventy.config.js' }]);
      if (rest === '/contents/eleventy.config.js') return send(200, { content: Buffer.from(config).toString('base64') });
      if (rest === '/git/ref/heads/main') return send(200, { object: { sha: 'abc' } });
      if (rest === '/git/refs') return send(201, {});
      if (req.method === 'PUT' && rest.startsWith('/contents/')) return send(201, {});
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.GITHUB_API = `http://127.0.0.1:${srv.address().port}`;
  return { calls, close: () => { srv.close(); delete process.env.GITHUB_API; } };
}

test('connecting a site checks access, reads the 11ty config and keeps the token private', async () => {
  const { savePublisher, getPublisher, publicConfig, view, adapter } = await import('../src/publishing.js');
  const gh = await fakeGitHub();
  const db = openDb(':memory:');
  const form = { repo: 'https://github.com/me/site.git', token: 'good', siteUrl: 'https://example.com/', author: 'Me' };
  const r = await savePublisher(db, form);
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => c.ok), [true, true, true, true]);
  assert.deepEqual([r.config.repo, r.config.branch, r.config.folder, r.config.includes, r.config.urlPath, r.config.siteUrl],
    ['me/site', 'main', 'src/replies', 'src/_layouts', '/replies/', 'https://example.com']);

  const pub = publicConfig(getPublisher(db));
  assert.equal(pub.token, undefined);
  assert.equal(pub.hasToken, true);
  assert.ok(!JSON.stringify(view(getPublisher(db))).includes('good'));

  // Saving again without retyping the token keeps it, but not if the repository changes.
  assert.equal((await savePublisher(db, { ...form, token: '', baseLayout: 'base.njk' })).ok, true);
  await assert.rejects(savePublisher(db, { ...form, token: '', repo: 'me/other' }), /token is needed/);

  const config = getPublisher(db);
  const files = adapter(config).templateFiles(config);
  assert.deepEqual(files.map((f) => f.path), ['src/_layouts/arss-post.njk', 'src/replies/replies.11tydata.json']);
  assert.match(files[0].content, /^---\nlayout: base\.njk\n---/);
  for (const cls of ['h-entry', 'u-in-reply-to', 'u-repost-of', 'e-content', 'p-author h-card', 'u-url', 'dt-published']) assert.ok(files[0].content.includes(cls), cls);
  assert.equal(JSON.parse(files[1].content).permalink, '/replies/{{ page.fileSlug }}/');

  const done = await adapter(config).installTemplate(config);
  assert.equal(done.url, 'https://github.com/me/site/compare/main...arss-webmentions?expand=1');
  const puts = gh.calls.filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((c) => c.path), files.map((f) => '/repos/me/site/contents/' + f.path));
  assert.ok(puts.every((c) => c.body.branch === 'arss-webmentions')); // never the live branch
  gh.close();
});

test('connection problems are explained, and settings are still saved for a retry', async () => {
  const { savePublisher, getPublisher, normalise } = await import('../src/publishing.js');
  const form = { repo: 'me/site', siteUrl: 'https://example.com' };
  let gh = await fakeGitHub({ writable: false });
  const db = openDb(':memory:');
  const ro = await savePublisher(db, { ...form, token: 'good' });
  assert.equal(ro.ok, false);
  assert.match(ro.checks.at(-1).detail, /Contents: Read and write/);
  assert.equal(getPublisher(db).connected, false);
  assert.equal(getPublisher(db).folder, ''); // not guessed until the site's config can be read
  assert.match((await savePublisher(db, { ...form, token: 'bad' })).checks[0].detail, /rejected the token/);
  assert.match((await savePublisher(db, { ...form, token: 'good', repo: 'me/nope' })).checks[0].detail, /Can't see me\/nope/);
  assert.match((await savePublisher(db, { ...form, token: 'good', repo: 'me/site', branch: 'dev' })).checks[1].detail, /default branch is main/);
  gh.close();

  assert.throws(() => normalise({ ...form, token: 't', repo: 'nope' }), /owner\/name/);
  assert.throws(() => normalise({ ...form, token: 't', siteUrl: 'example' }), /full URL/);
  assert.throws(() => normalise({ ...form, token: 't', folder: '../etc' }), /\.\./);
});

test('microformat check on a published page', async () => {
  const { checkPage } = await import('../src/microformats.js');
  const good = checkPage(`<article class="post h-entry"><a class='u-in-reply-to' href="x">x</a><div class=e-content>hi</div>
    <a class="p-author h-card">Me</a><a class="u-url"><time class="dt-published"></time></a></article>`);
  assert.equal(good.ok, true);
  assert.ok(good.checks.every((c) => c.ok));
  const bare = checkPage('<article class="h-entry-ish"><p class="e-content">hi</p></article>');
  assert.equal(bare.ok, false);
  assert.deepEqual(bare.checks.filter((c) => !c.ok && c.required).map((c) => c.name), ['Post wrapper', 'Link to the original post']);
  const noAuthor = checkPage('<div class="h-entry"><a class="u-repost-of"></a><p class="e-content"></p></div>');
  assert.equal(noAuthor.ok, true); // author, permalink and date are recommended, not required
});
