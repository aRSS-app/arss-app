import Parser from 'rss-parser';

const UA = 'aRSS/0.1 (+personal feed reader)';

const parser = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': UA },
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['media:group', 'mediaGroup'],
    ],
  },
});

const httpUrl = (u, base) => {
  try {
    const url = new URL(String(u).replace(/&amp;/g, '&'), base || undefined);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
};
const attrOf = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find((v) => v !== undefined);

// The featured image for a post: an explicit media/enclosure image if the feed gives one,
// otherwise the first real image in the body. `skip` holds feed-level artwork to ignore
// (podcasts repeat the show cover on every episode).
export function extractImage(it, skip = []) {
  const media = (list) => (list || []).map((m) => m?.$).filter(Boolean);
  const isImage = (m) => m.url && (m.medium === 'image' || /^image\//.test(m.type || '') || (!m.medium && !m.type && /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(m.url)));
  const group = it.mediaGroup || {};
  const candidates = [
    it.enclosure && /^image\//.test(it.enclosure.type || '') ? it.enclosure.url : null,
    ...media(it.mediaContent).filter(isImage).map((m) => m.url),
    ...media(group['media:content']).filter(isImage).map((m) => m.url),
    ...media(it.mediaThumbnail).map((m) => m.url),
    ...media(group['media:thumbnail']).map((m) => m.url),
    it.itunes?.image,
  ];
  const html = String(it.contentEncoded || it.content || '');
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    if (/\b(width|height)\s*=\s*["']?[01]\b/i.test(tag)) continue; // tracking pixels
    const src = attrOf(tag, 'src');
    if (!src || /\/emoji\/|gravatar\.com|\/smilies\//i.test(src)) continue;
    candidates.push(src);
    break;
  }
  for (const c of candidates) {
    const url = c && httpUrl(c, it.link);
    if (url && !skip.includes(url)) return url;
  }
  return null;
}

// Find a site's favicon: the best <link rel="icon"> on the page (or, failing that, on the
// site's home page), else /favicon.ico.
export async function discoverIcon(siteUrl) {
  const opts = { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10000) };
  const fromPage = async (pageUrl) => {
    const res = await fetch(pageUrl, opts);
    const html = res.ok ? (await res.text()).slice(0, 300000) : (await res.arrayBuffer().catch(() => {}), '');
    const icons = [...html.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => ({
      rel: (attrOf(tag, 'rel') || '').toLowerCase(), href: attrOf(tag, 'href'), size: parseInt(attrOf(tag, 'sizes') || '0', 10) || 0,
    })).filter((l) => l.href && /(^|\s)(shortcut icon|icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(l.rel));
    // Prefer something big enough to look sharp in an avatar.
    const weight = (l) => (l.rel.includes('apple') ? 180 : l.size);
    icons.sort((x, y) => weight(y) - weight(x));
    for (const l of icons) { const u = httpUrl(l.href, res.url || pageUrl); if (u) return u; }
    return null;
  };
  try {
    const home = new URL('/', siteUrl).href;
    const found = (await fromPage(siteUrl).catch(() => null)) || (home !== siteUrl ? await fromPage(home).catch(() => null) : null);
    if (found) return found;
    const ico = new URL('/favicon.ico', siteUrl).href;
    const r = await fetch(ico, opts);
    await r.arrayBuffer().catch(() => {});
    if (r.ok && /^image\//.test(r.headers.get('content-type') || '')) return ico;
  } catch { /* no icon; the UI falls back to an initial */ }
  return null;
}

// Some real feeds contain bare ampersands outside CDATA, which is invalid XML.
export const fixAmpersands = (xml) => xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');

async function parseFeedUrl(url) {
  // Use fetch rather than rss-parser's own HTTP client: that client does not drain
  // non-2xx responses, and the resulting socket ECONNRESET is unhandled and kills the process.
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  }).catch((e) => { throw new Error(e.cause?.message ? `${e.message}: ${e.cause.message}` : e.message); });
  if (!res.ok) { await res.arrayBuffer().catch(() => {}); throw new Error('Status code ' + res.status); }
  const xml = await res.text();
  try { return await parser.parseString(xml); }
  catch (e) { return await parser.parseString(fixAmpersands(xml)); }
}

const toMs = (d) => {
  const t = d ? Date.parse(d) : NaN;
  return Number.isNaN(t) ? null : t;
};

export async function fetchFeed(db, feed, now = Date.now()) {
  try {
    const parsed = await parseFeedUrl(feed.url);
    db.prepare('UPDATE feeds SET title = COALESCE(?, title), site_url = COALESCE(?, site_url), last_fetched_at = ?, last_error = NULL WHERE id = ?')
      .run(parsed.title || null, parsed.link || null, now, feed.id);
    const artwork = [parsed.image?.url, parsed.itunes?.image].map((u) => u && httpUrl(u)).filter(Boolean);
    if (feed.icon_url == null) {
      // Looked up once per feed; '' records "tried, none found" so we don't ask the site every fetch.
      const site = httpUrl(parsed.link) || httpUrl(feed.site_url) || new URL(feed.url).origin;
      const icon = (await discoverIcon(site)) || artwork[0] || '';
      db.prepare('UPDATE feeds SET icon_url = ? WHERE id = ?').run(icon, feed.id);
    }
    const insert = db.prepare(`
      INSERT OR IGNORE INTO items (feed_id, guid, title, link, author, summary, content, image, published_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // Items stored before images were captured get theirs filled in on the next fetch.
    const backfill = db.prepare('UPDATE items SET image = ? WHERE feed_id = ? AND guid = ? AND image IS NULL');
    let added = 0;
    db.exec('BEGIN');
    try {
      for (const it of parsed.items) {
        const guid = it.guid || it.id || it.link || it.title;
        if (!guid) continue;
        const image = extractImage(it, artwork);
        const r = insert.run(feed.id, String(guid), it.title || null, it.link || null,
          it.creator || it.author || null, it.contentSnippet || it.summary || null,
          it.contentEncoded || it.content || null, image, toMs(it.isoDate || it.pubDate), now);
        added += Number(r.changes);
        if (!r.changes && image) backfill.run(image, feed.id, String(guid));
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
