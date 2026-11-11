import { readFileSync } from 'node:fs';
import { openDb, parseInterval } from './db.js';

export function seed(db, feeds, now = Date.now()) {
  const insert = db.prepare('INSERT OR IGNORE INTO feeds (url, title, interval_minutes, created_at) VALUES (?, ?, ?, ?)');
  let added = 0;
  for (const f of feeds) added += Number(insert.run(new URL(f.url).toString(), f.name ?? null, parseInterval(f.interval ?? 'daily'), now).changes);
  return added;
}

// `npm run seed` - adds the example feeds (skips any already subscribed).
// They have no last_fetched_at, so the running server fetches them on its next tick.
if (import.meta.url === `file://${process.argv[1]}`) {
  const feeds = JSON.parse(readFileSync(new URL('../seed/feeds.json', import.meta.url), 'utf8'));
  console.log(`Added ${seed(openDb(), feeds)} of ${feeds.length} example feeds.`);
}
