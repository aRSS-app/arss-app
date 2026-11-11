import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const DB_PATH = resolve(process.env.ARSS_DB || new URL('../data/arss.db', import.meta.url).pathname);

export function openDb(path = DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      title TEXT,
      site_url TEXT,
      interval_minutes INTEGER NOT NULL DEFAULT 1440,
      last_fetched_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY,
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT,
      link TEXT,
      author TEXT,
      summary TEXT,
      content TEXT,
      published_at INTEGER,
      fetched_at INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      UNIQUE (feed_id, guid)
    );
    CREATE INDEX IF NOT EXISTS items_published ON items(published_at DESC);
  `);
  // Columns added after the first release.
  const addColumn = (table, col) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
  };
  addColumn('feeds', 'icon_url');
  addColumn('items', 'image');
  return db;
}

export const INTERVAL_PRESETS = { hourly: 60, daily: 1440, weekly: 10080 };

export function parseInterval(v) {
  if (typeof v === 'string' && INTERVAL_PRESETS[v]) return INTERVAL_PRESETS[v];
  const n = Number(v);
  if (!Number.isInteger(n) || n < 5) throw new Error('interval must be hourly/daily/weekly or a whole number of minutes (min 5)');
  return n;
}

export function listFeeds(db) {
  return db.prepare(`
    SELECT f.*, (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id) AS item_count,
           (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND i.read = 0) AS unread_count
    FROM feeds f ORDER BY COALESCE(f.title, f.url) COLLATE NOCASE`).all();
}

export function listItems(db, { feedId, unread, search, since, limit = 50, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (feedId) { where.push('i.feed_id = ?'); args.push(feedId); }
  if (unread) where.push('i.read = 0');
  if (since) { where.push('COALESCE(i.published_at, i.fetched_at) >= ?'); args.push(since); }
  if (search) {
    where.push(`(i.title LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\')`);
    const like = `%${String(search).replace(/[\\%_]/g, '\\$&')}%`;
    args.push(like, like, like);
  }
  const sql = `
    SELECT i.id, i.feed_id, f.title AS feed_title, i.title, i.link, i.author, i.summary, i.content, i.image,
           f.icon_url AS feed_icon, f.site_url AS feed_site_url, f.url AS feed_url,
           i.published_at, i.fetched_at, i.read
    FROM items i JOIN feeds f ON f.id = i.feed_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(i.published_at, i.fetched_at) DESC, i.id DESC
    LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 500), Number(offset) || 0);
}
