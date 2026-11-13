// Does a published page carry the microformats a webmention receiver looks for?
// Microformats are plain class names, so we only need the set of classes on the page.
const classes = (html) => {
  const set = new Set();
  for (const m of String(html).matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))
    for (const c of (m[1] ?? m[2] ?? m[3]).split(/\s+/)) if (c) set.add(c);
  return set;
};

const RULES = [
  { name: 'Post wrapper', any: ['h-entry'], required: true, fix: 'Wrap the post in an element with class="h-entry".' },
  { name: 'Link to the original post', any: ['u-in-reply-to', 'u-repost-of'], required: true, fix: 'Link to the post you are responding to with class="u-in-reply-to" (a comment) or class="u-repost-of" (a repost).' },
  { name: 'Your words', any: ['e-content', 'p-content', 'p-summary', 'p-name'], required: true, fix: 'Put the text of the post in an element with class="e-content".' },
  { name: 'Author', any: ['p-author', 'h-card'], fix: 'Add your name with class="p-author h-card", so sites can show who replied.' },
  { name: 'Permalink', any: ['u-url'], fix: 'Link to the post itself with class="u-url".' },
  { name: 'Published date', any: ['dt-published'], fix: 'Add <time class="dt-published" datetime="..."> so sites can show when you posted.' },
];

export function checkPage(html) {
  const found = classes(html);
  const checks = RULES.map((r) => {
    const hit = r.any.find((c) => found.has(c));
    return { name: r.name, ok: !!hit, required: !!r.required, detail: hit ? `Found ${hit}.` : r.fix };
  });
  return { ok: checks.every((c) => c.ok || !c.required), checks };
}

export async function checkSite(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('The address must start with http:// or https://');
  const r = await fetch(u, { headers: { 'User-Agent': 'arss-app', Accept: 'text/html' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${u.hostname} answered ${r.status}. Check the address, and that the page has been published.`);
  return checkPage(await r.text());
}
