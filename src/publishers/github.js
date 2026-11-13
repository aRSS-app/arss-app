// Publisher: a static site (11ty first) kept in a GitHub repo. Publishing means committing a file
// and letting the site's own build deploy it. Set GITHUB_API for GitHub Enterprise.
const api = () => (process.env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
export const WORK_BRANCH = 'arss-webmentions';
const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

async function gh(config, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${api()}/repos/${config.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'arss-app',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: leave null */ }
  return { ok: r.ok, status: r.status, json };
}

// Can we see the repo, find the branch and write to it? Each check has a plain-English fix.
export async function check(config) {
  const checks = [];
  const done = () => ({ ok: checks.every((c) => c.ok), checks });
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };
  let repo;
  try { repo = await gh(config, ''); } catch (e) { add('Reach GitHub', false, `Could not reach GitHub: ${e.message}`); return done(); }
  if (repo.status === 401) { add('Token', false, 'GitHub rejected the token. Check it was copied in full and has not expired.'); return done(); }
  if (!add('Find the repository', repo.ok, repo.ok ? `Found ${repo.json.full_name}.`
    : `Can't see ${config.repo}. Check the name, and that the token has been given access to this repository.`)) return done();

  const branch = await gh(config, `/branches/${enc(config.branch)}`);
  add('Find the branch', branch.ok, branch.ok ? `Found the ${config.branch} branch.`
    : `There is no branch called ${config.branch}. The default branch is ${repo.json.default_branch}.`);

  // Creating a blob needs write access but changes nothing anyone can see: it isn't attached to a commit.
  const blob = await gh(config, '/git/blobs', { method: 'POST', body: { content: 'aRSS write check', encoding: 'utf-8' } });
  add('Write access', blob.ok, blob.ok ? 'The token can write to the repository.'
    : 'The token can read the repository but not write to it. Give it the "Contents: Read and write" permission.');
  return done();
}

// Work out where an 11ty site keeps its content and includes, from its config file.
export async function detect(config) {
  const root = await gh(config, `/contents/?ref=${encodeURIComponent(config.branch)}`);
  const file = Array.isArray(root.json) && root.json.find((f) => /^(\.eleventy\.[cm]?js|eleventy\.config\.([cm]?js|ts))$/.test(f.name));
  if (!file) return { eleventy: false, input: '', includes: '_includes' };
  const got = await gh(config, `/contents/${enc(file.path)}?ref=${encodeURIComponent(config.branch)}`);
  const src = got.ok ? Buffer.from(got.json.content || '', 'base64').toString('utf8') : '';
  const dir = (key) => (src.match(new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`)) || [])[1];
  const clean = (p) => String(p || '').replace(/^\.?\/+|\/+$/g, '').replace(/^\.$/, '');
  const input = clean(dir('input'));
  return { eleventy: true, configFile: file.name, input, includes: [input, clean(dir('includes')) || '_includes'].filter(Boolean).join('/') };
}

export const LAYOUT = 'arss-post.njk';

// The files a site needs so posts published by aRSS carry the microformats webmentions rely on.
export function templateFiles(config) {
  const { folder, includes, baseLayout, urlPath, author, siteUrl } = config;
  const layout = `${baseLayout ? `---\nlayout: ${baseLayout}\n---\n` : ''}{# Added by aRSS (https://arss.app). The h-, p-, u-, e- and dt- classes are microformats: keep them if you restyle this. #}
<article class="h-entry">
  {% if repost_of %}
  <p>Reposted <a class="u-repost-of" href="{{ repost_of }}">{{ target_title or repost_of }}</a></p>
  {% endif %}
  {% if in_reply_to %}
  <p>In reply to <a class="u-in-reply-to" href="{{ in_reply_to }}">{{ target_title or in_reply_to }}</a></p>
  {% endif %}
  <div class="e-content">{{ content | safe }}</div>
  <p>
    <a class="p-author h-card" href="{{ author.url }}">{{ author.name }}</a>
    <a class="u-url" href="{{ site_url }}{{ page.url }}"><time class="dt-published" datetime="{{ page.date.toISOString() }}">{{ page.date.toDateString() }}</time></a>
  </p>
</article>
`;
  const data = {
    layout: LAYOUT,
    permalink: `${urlPath}{{ page.fileSlug }}/`,
    site_url: siteUrl,
    author: { name: author || new URL(siteUrl).hostname, url: siteUrl + '/' },
  };
  return [
    { path: `${includes}/${LAYOUT}`, about: 'The layout for replies and reposts, with the microformats in place.', content: layout },
    { path: `${folder}/${folder.split('/').pop()}.11tydata.json`, about: 'Tells 11ty to use that layout, and the URL, for everything in this folder.', content: JSON.stringify(data, null, 2) + '\n' },
  ];
}

// Commit the template files to a side branch, so nothing changes on the live site until it is merged.
export async function installTemplate(config) {
  const fail = (what, r) => { throw new Error(`${what} (GitHub said ${r.status}${r.json?.message ? ': ' + r.json.message : ''})`); };
  const base = await gh(config, `/git/ref/heads/${enc(config.branch)}`);
  if (!base.ok) fail(`Could not read the ${config.branch} branch`, base);
  const made = await gh(config, '/git/refs', { method: 'POST', body: { ref: `refs/heads/${WORK_BRANCH}`, sha: base.json.object.sha } });
  if (!made.ok && made.status !== 422) fail(`Could not create the ${WORK_BRANCH} branch`, made); // 422: it already exists
  const files = templateFiles(config);
  for (const f of files) {
    const existing = await gh(config, `/contents/${enc(f.path)}?ref=${WORK_BRANCH}`);
    const put = await gh(config, `/contents/${enc(f.path)}`, { method: 'PUT', body: {
      message: `Add ${f.path} for aRSS replies and reposts`,
      content: Buffer.from(f.content).toString('base64'),
      branch: WORK_BRANCH,
      ...(existing.ok && { sha: existing.json.sha }),
    } });
    if (!put.ok) fail(`Could not write ${f.path}`, put);
  }
  return { branch: WORK_BRANCH, files: files.map((f) => f.path), url: `https://github.com/${config.repo}/compare/${enc(config.branch)}...${WORK_BRANCH}?expand=1` };
}

export default { label: 'GitHub repo (11ty)', check, detect, templateFiles, installTemplate };
