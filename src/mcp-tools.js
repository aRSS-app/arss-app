import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listFeeds, listItems, setRead, setSaved } from './db.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

const present = (i, full) => ({
  id: i.id, feed: i.feed_title, title: i.title, link: i.link, author: i.author,
  published: iso(i.published_at), read: !!i.read, saved: !!i.saved_at,
  ...(full ? { content: i.content || i.summary } : { summary: (i.summary || '').slice(0, 400) }),
});

export function buildMcpServer(db) {
  const server = new McpServer({ name: 'arss', version: '0.1.0' });
  server.registerTool('list_feeds', {
    description: 'List subscribed RSS feeds with fetch frequency, last fetch time and unread counts.',
  }, async () => text(listFeeds(db).map((f) => ({
    id: f.id, title: f.title, url: f.url, interval_minutes: f.interval_minutes,
    last_fetched: iso(f.last_fetched_at), last_error: f.last_error, items: f.item_count, unread: f.unread_count,
  }))));

  server.registerTool('get_items', {
    description: 'Get recent items across all feeds (newest first). Filter by feed, unread, saved, date or text.',
    inputSchema: {
      feed_id: z.number().int().optional(),
      unread_only: z.boolean().optional(),
      saved_only: z.boolean().optional().describe('Only items the reader has saved (bookmarked)'),
      since: z.string().optional().describe('ISO date; only items published on/after this'),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      include_content: z.boolean().optional().describe('Return full content instead of a short summary'),
    },
  }, async (a) => {
    const since = a.since ? Date.parse(a.since) : undefined;
    if (a.since && Number.isNaN(since)) return { isError: true, ...text({ error: 'invalid since date' }) };
    const items = listItems(db, { feedId: a.feed_id, unread: a.unread_only, saved: a.saved_only, search: a.search, since, limit: a.limit ?? 30 });
    return text(items.map((i) => present(i, a.include_content)));
  });

  server.registerTool('get_item', {
    description: 'Get one item with its full content.',
    inputSchema: { id: z.number().int() },
  }, async ({ id }) => {
    const row = db.prepare(`SELECT i.*, f.title AS feed_title FROM items i JOIN feeds f ON f.id = i.feed_id WHERE i.id = ?`).get(id);
    return row ? text(present(row, true)) : { isError: true, ...text({ error: 'not found' }) };
  });

  server.registerTool('mark_read', {
    description: 'Mark items as read (e.g. after summarising them).',
    inputSchema: { ids: z.array(z.number().int()).min(1).max(500) },
  }, async ({ ids }) => {
    for (const id of ids) setRead(db, id);
    return text({ marked: ids.length });
  });

  server.registerTool('save_items', {
    description: 'Save (bookmark) items so they appear in the Saved view, or pass saved: false to remove them.',
    inputSchema: { ids: z.array(z.number().int()).min(1).max(500), saved: z.boolean().optional() },
  }, async ({ ids, saved = true }) => {
    for (const id of ids) setSaved(db, id, saved);
    return text({ [saved ? 'saved' : 'unsaved']: ids.length });
  });
  return server;
}
