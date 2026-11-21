# aRSS: notes for coding agents

aRSS is a self-hosted RSS reader with a social-media-style timeline. It is one small Node server, a SQLite file and one HTML page. There are no accounts, no build step and no native dependencies. Keep it that way: don't add a framework, bundler or database server without asking.

User-facing docs live in [README.md](README.md) (features, setup) and [APP.md](APP.md) (running it as a service, MCP setup). This file explains how the code fits together.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Web UI, JSON API and scheduler at http://127.0.0.1:3333 |
| `npm test` | `node --test` (tests in `test/`, using in-memory SQLite and a local HTTP server; no network) |
| `npm run seed` | Adds the example feeds in `seed/feeds.json` (safe to re-run) |
| `npm run mcp` | MCP server over stdio |
| `npm run site` / `npm run deploy:site` | Landing page only (see "Landing page" below) |

Node 22.13+ is required because the app uses the built-in `node:sqlite`.

## Configuration

All set with environment variables; there is no config file.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3333` | |
| `HOST` | `127.0.0.1` | The web UI and `/api` have **no auth**. Only bind wider on a trusted network |
| `ARSS_DB` | `data/arss.db` | SQLite path. `data/` is gitignored |
| `ARSS_TOKEN` | unset | Bearer token for `/mcp`. Bound beyond localhost with no token, `/mcp` is switched off |

`.claude/launch.json` has three preview configs:
- `arss`: the real app on port 3333, using `data/arss.db`. This is the owner's real reading data, and it is often already running.
- `arss-demo`: port 3344, using `data/demo.db`. **Use this one for testing and browser checks**, so you don't change real likes, read state or follows.
- `site`: the static landing page on port 4810.

## Layout

```
src/server.js     Express app: static UI, /api routes, once-a-minute scheduler, mounts /mcp
src/db.js         Opens SQLite, creates and migrates the schema, query helpers
src/fetcher.js    Fetching and parsing feeds, feed discovery from a site URL, favicons, images
src/mcp-tools.js  MCP tool definitions (list_feeds, get_items, get_item, mark_read)
src/mcp.js        MCP over stdio
src/mcp-http.js   MCP over Streamable HTTP at /mcp (stateless, bearer token)
src/seed.js       Loads seed/feeds.json
public/index.html The whole UI: one file with inline CSS and vanilla JS
site/             Landing page for arss.app (separate from the app)
brand/            Logo sources
test/             node:test tests
```

## Data model (`src/db.js`)

- `feeds`: one row per subscription. `interval_minutes` is how often it's fetched. `last_error` holds the last fetch failure.
- `items`: posts, unique on `(feed_id, guid)`. `read` is 0/1. Deleting a feed (unfollowing) **cascades and deletes its items**.
- `likes`: liked posts. Each row is a **copy** of the post and its feed (title, link, summary, image, feed name/icon…), so likes survive unfollowing. `item_id` links back to the live item and becomes NULL when the item is deleted (`ON DELETE SET NULL`).

Migrations: `openDb()` runs `CREATE TABLE IF NOT EXISTS` and adds missing columns with the `addColumn` helper. Every change must be additive and safe to run against an existing database on every start. There is no migration framework, so don't introduce one.

The web server and the stdio MCP process can open the same file at once (WAL mode, busy timeout).

## API (`src/server.js`)

JSON under `/api`. Errors come back as `{ error }` with status 400 (or 404).

- Feeds: `GET /feeds`, `POST /feeds {url, interval}` (`url` may be a site address; the feed is discovered from its `<link rel="alternate">`), `PATCH /feeds/:id {interval?, title?}`, `DELETE /feeds/:id`, `POST /feeds/:id/refresh`, `POST /feeds/:id/read-all`, `POST /refresh` (every feed)
- Items: `GET /items?feed=&unread=1&q=&after=&limit=&offset=`, `GET /latest` (highest item id, used to detect new posts), `POST /items/:id/read {read?}`
- Likes: `PUT /items/:id/like`, `DELETE /items/:id/like`, `GET /likes?q=&limit=&offset=`, `DELETE /likes/:id` (by like id, which works even after the item is gone)

`interval` accepts `hourly`/`daily`/`weekly` or a whole number of minutes (minimum 5).

Lists are ordered newest first by `COALESCE(published_at, fetched_at)`, with Home, a feed's posts and Liked all using the same order.

## Scheduler and fetching (`src/fetcher.js`)

`server.js` calls `runDue()` once a minute, which fetches each feed whose `interval_minutes` has passed since `last_fetched_at`. Fetching only happens while the web server runs; the MCP process never fetches. `fetchFeed()` inserts with `INSERT OR IGNORE`, so re-fetching is harmless. It also fixes stray `&` in broken XML (`fixAmpersands`), picks a featured image (`extractImage`) and finds the site's favicon (`discoverIcon`).

## UI (`public/index.html`)

There is no framework or build step. It uses small template-string render functions (`post`, `profile`, `avatar`) and event delegation on containers.

- Hash routes: `#` Home, `#liked`, `#following`, `#feed/<id>`. `route()` sets `view` (and `current` for a feed) and then calls `reload()`, which loads feeds before items because posts need the feed list.
- Sidebar: nav only (Home with the unread count, Liked, Following with the feed count). On narrow screens it's hidden behind the "Menu" button.
- Following: the follow form, then one `profile()` card per feed (frequency, Refresh, Mark read, Unfollow). A feed's own page shows a larger profile card above its posts.
- Posts: the heart button calls `toggleLike()`. On the Liked page, unliking removes the post from the list.
- A "new posts" pill polls every 60s and never moves the timeline by itself. Only Home and feed pages show the pill.
- Always escape user and feed content with `esc()`, and pass URLs through `safe()` (http/https only). Feed content is untrusted.
- Theming uses CSS variables on `:root`, with dark mode via `prefers-color-scheme`. Elements that use `display:grid/flex` still hide correctly thanks to the global `[hidden]` rule.

## MCP

`buildMcpServer(db)` in `src/mcp-tools.js` defines the tools once, and both transports share them. To expose something new to agents, add it there. Likes aren't exposed to MCP yet.

## Landing page

`site/` is a static page deployed to arss.app as a Cloudflare Worker with static assets (`wrangler.jsonc`, worker `arss-landing`). It has nothing to do with the self-hosted app. Because this repo has a Wrangler config, use `wrangler` (not the `cf` CLI) for it.

## Conventions

- ES modules, 2-space indent, single quotes, terse code with short comments explaining *why*.
- British English in UI copy and docs (en-GB dates).
- Add a test in `test/` for any new db or fetcher behaviour, and run `npm test` before finishing.
- Check UI changes in the browser against the `arss-demo` preview, at both desktop and mobile widths.
- Update README.md / APP.md when user-facing behaviour or configuration changes.
