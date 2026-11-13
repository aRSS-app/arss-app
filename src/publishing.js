// Where your replies and reposts get published. One publisher is connected at a time, and its
// settings (including the access token) live in the local database.
import { getSetting, setSetting } from './db.js';
import { publishers } from './publishers/index.js';

const KEY = 'publisher';
const path = (v) => String(v ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const need = (ok, msg) => { if (!ok) throw new Error(msg); };

export const getPublisher = (db) => getSetting(db, KEY);
export const removePublisher = (db) => setSetting(db, KEY, null);
export const adapter = (config) => publishers[config.type];

// Never send the token back out: the web UI has no login.
export function publicConfig(config) {
  if (!config) return null;
  const { token, ...rest } = config;
  return { ...rest, hasToken: !!token };
}

export function normalise(body = {}, existing = null) {
  const type = body.type || 'github';
  need(publishers[type], `Unknown publisher: ${type}`);
  const repo = String(body.repo ?? '').trim().replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  need(/^[\w.-]+\/[\w.-]+$/.test(repo), 'Repository should look like owner/name');
  // A saved token is only reused for the repository it was saved against.
  const token = String(body.token ?? '').trim() || (existing?.repo === repo ? existing.token : '');
  need(token, 'An access token is needed');
  let site;
  try { site = new URL(String(body.siteUrl ?? '').trim()); } catch { need(false, 'Site address should be a full URL, like https://example.com'); }
  need(/^https?:$/.test(site.protocol), 'Site address should start with http:// or https://');
  const folder = path(body.folder), includes = path(body.includes);
  for (const p of [folder, includes]) need(!p.split('/').includes('..'), 'Folders cannot contain ..');
  const urlPath = path(body.urlPath);
  return {
    type, repo, token,
    branch: String(body.branch ?? '').trim() || 'main',
    siteUrl: (site.origin + site.pathname).replace(/\/+$/, ''),
    author: String(body.author ?? '').trim(),
    baseLayout: String(body.baseLayout ?? '').trim(),
    folder, includes,
    urlPath: urlPath ? `/${urlPath}/` : '',
  };
}

// Save the settings, test the connection and fill in any folders left blank from the site's own config.
export async function savePublisher(db, body) {
  const config = normalise(body, getPublisher(db));
  const result = await adapter(config).check(config);
  let found = null;
  if (result.ok && (!config.folder || !config.includes)) {
    found = await adapter(config).detect(config).catch(() => null);
    if (found?.eleventy) result.checks.push({ name: 'Site layout', ok: true, detail: `Read ${found.configFile}: content lives in ${found.input || 'the repository root'}.` });
  }
  if (result.ok) { // until the connection works, blanks stay blank so they can still be worked out
    config.includes ||= found?.includes || '_includes';
    config.folder ||= [found?.input, 'replies'].filter(Boolean).join('/');
    config.urlPath ||= `/${config.folder.split('/').pop()}/`;
  }
  config.connected = result.ok;
  setSetting(db, KEY, config);
  return { config, ...result };
}

export const view = (config) => ({
  config: publicConfig(config),
  publishers: Object.fromEntries(Object.entries(publishers).map(([k, p]) => [k, p.label])),
  files: config?.connected ? adapter(config).templateFiles(config) : [],
});
