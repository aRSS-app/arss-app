import express from 'express';
import { openDb, listFeeds, listItems, parseInterval } from './db.js';
import { fetchFeed, runDue } from './fetcher.js';
import { mountMcp } from './mcp-http.js';

const db = openDb();
const app = express();
app.use(express.json());
app.use(express.static(new URL('../public', import.meta.url).pathname));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const getFeed = (id) => db.prepare('SELECT * FROM feeds WHERE id = ?').get(id);

app.get('/api/feeds', (req, res) => res.json(listFeeds(db)));

app.post('/api/feeds', wrap(async (req, res) => {
  const url = new URL(req.body.url).toString();
  const interval = parseInterval(req.body.interval ?? 'daily');
  const r = db.prepare('INSERT INTO feeds (url, interval_minutes, created_at) VALUES (?, ?, ?)').run(url, interval, Date.now());
  const feed = getFeed(r.lastInsertRowid);
  const result = await fetchFeed(db, feed);
  res.status(201).json({ feed: getFeed(feed.id), result });
}));

app.patch('/api/feeds/:id', wrap((req, res) => {
  if (!getFeed(req.params.id)) return res.status(404).json({ error: 'not found' });
  if (req.body.interval !== undefined)
    db.prepare('UPDATE feeds SET interval_minutes = ? WHERE id = ?').run(parseInterval(req.body.interval), req.params.id);
  if (req.body.title !== undefined)
    db.prepare('UPDATE feeds SET title = ? WHERE id = ?').run(String(req.body.title), req.params.id);
  res.json(getFeed(req.params.id));
}));

app.delete('/api/feeds/:id', (req, res) => {
  db.prepare('DELETE FROM feeds WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.post('/api/feeds/:id/refresh', wrap(async (req, res) => {
  const feed = getFeed(req.params.id);
  if (!feed) return res.status(404).json({ error: 'not found' });
  res.json(await fetchFeed(db, feed));
}));

app.post('/api/refresh', wrap(async (req, res) => {
  const out = [];
  for (const f of db.prepare('SELECT * FROM feeds').all()) out.push({ id: f.id, ...(await fetchFeed(db, f)) });
  res.json(out);
}));

app.get('/api/items', (req, res) => {
  const q = req.query;
  res.json(listItems(db, {
    feedId: q.feed ? Number(q.feed) : undefined,
    unread: q.unread === '1',
    search: q.q || undefined,
    afterId: q.after ? Number(q.after) : undefined,
    limit: q.limit,
    offset: q.offset,
  }));
});

// Highest item id so far. The UI remembers it, then asks for items `after` it to spot new posts.
app.get('/api/latest', (req, res) => res.json({ id: db.prepare('SELECT MAX(id) AS id FROM items').get().id ?? 0 }));

app.post('/api/items/:id/read', (req, res) => {
  db.prepare('UPDATE items SET read = ? WHERE id = ?').run(req.body?.read === false ? 0 : 1, req.params.id);
  res.status(204).end();
});

app.post('/api/feeds/:id/read-all', (req, res) => {
  db.prepare('UPDATE items SET read = 1 WHERE feed_id = ?').run(req.params.id);
  res.status(204).end();
});

// Scheduler: check once a minute for feeds whose own interval has elapsed.
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const r = await runDue(db);
    if (r.length) console.log(new Date().toISOString(), 'fetched', r);
  } finally { running = false; }
}
setInterval(tick, 60_000).unref?.();
tick();

const port = Number(process.env.PORT || 3333);
const host = process.env.HOST || '127.0.0.1';
const token = process.env.ARSS_TOKEN;
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!loopback && !token) console.warn('WARNING: listening beyond localhost with no ARSS_TOKEN; /mcp is disabled (the web UI and API are still open).');
else mountMcp(app, db, token);
app.listen(port, host, () => console.log(`aRSS running at http://${host}:${port}`));
