import Parser from 'rss-parser';

const parser = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': 'aRSS/0.1 (+personal feed reader)' },
  customFields: { item: [['content:encoded', 'contentEncoded']] },
});

const toMs = (d) => {
  const t = d ? Date.parse(d) : NaN;
  return Number.isNaN(t) ? null : t;
};

export async function fetchFeed(db, feed, now = Date.now()) {
  try {
    const parsed = await parser.parseURL(feed.url);
    db.prepare('UPDATE feeds SET title = COALESCE(?, title), site_url = COALESCE(?, site_url), last_fetched_at = ?, last_error = NULL WHERE id = ?')
      .run(parsed.title || null, parsed.link || null, now, feed.id);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO items (feed_id, guid, title, link, author, summary, content, published_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let added = 0;
    db.exec('BEGIN');
    try {
      for (const it of parsed.items) {
        const guid = it.guid || it.id || it.link || it.title;
        if (!guid) continue;
        const r = insert.run(feed.id, String(guid), it.title || null, it.link || null,
          it.creator || it.author || null, it.contentSnippet || it.summary || null,
          it.contentEncoded || it.content || null, toMs(it.isoDate || it.pubDate), now);
        added += Number(r.changes);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { added, total: parsed.items.length };
  } catch (e) {
    db.prepare('UPDATE feeds SET last_fetched_at = ?, last_error = ? WHERE id = ?').run(now, String(e.message || e), feed.id);
    return { error: String(e.message || e) };
  }
}

export function dueFeeds(db, now = Date.now()) {
  return db.prepare(`SELECT * FROM feeds
    WHERE last_fetched_at IS NULL OR last_fetched_at + interval_minutes * 60000 <= ?`).all(now);
}

export async function runDue(db, now = Date.now()) {
  const results = [];
  for (const f of dueFeeds(db, now)) results.push({ id: f.id, ...(await fetchFeed(db, f, now)) });
  return results;
}
