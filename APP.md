# aRSS app (code)

Simple self-hosted RSS reader. Node 22.13+, no native dependencies.

- `src/server.js` - web UI + JSON API + per-feed scheduler (port 3333, localhost only)
- `src/mcp.js` - MCP server over stdio (local Claude on the same Mac)
- `POST /mcp` - the same MCP tools over HTTP (Streamable HTTP, stateless), served by `src/server.js`
- Data lives in `data/arss.db` (SQLite). Override with `ARSS_DB=/path/to.db`.

## Run

    npm install
    npm start        # http://127.0.0.1:3333

`npm run seed` adds a few example feeds (see `seed/feeds.json`; safe to re-run). The server fetches them on its next tick.

Each feed has its own frequency (hourly, daily, weekly or custom minutes), set when subscribing and changeable per feed in the sidebar. The scheduler checks once a minute and fetches any feed whose interval has elapsed. "Refresh" forces a fetch.

Keep it running on the Mac mini with launchd (save as `~/Library/LaunchAgents/app.arss.plist`, fix paths, then `launchctl load` it):

    <?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict>
      <key>Label</key><string>app.arss</string>
      <key>WorkingDirectory</key><string>/Users/YOU/arss-web</string>
      <key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>src/server.js</string></array>
      <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
    </dict></plist>

To reach it from other devices, set `HOST=0.0.0.0` (there is no auth, so only do this on a trusted network or behind Tailscale).

## Claude (MCP)

### HTTP (remote clients, e.g. Claude on the web or phone)

Start the server with a token:

    ARSS_TOKEN=$(openssl rand -hex 24) npm start

The endpoint is `http://127.0.0.1:3333/mcp` with header `Authorization: Bearer <token>`. If `ARSS_TOKEN` is set, every request needs it. If you bind beyond localhost (`HOST=0.0.0.0`) without a token, `/mcp` is disabled.

To reach it from outside the Mac mini, put it behind HTTPS, for example Tailscale Funnel or a Cloudflare Tunnel. Note that the web UI and `/api` have no auth, so expose only `/mcp` (route that path alone in the tunnel config), not the whole port.

Claude Code: `claude mcp add --transport http arss https://YOUR-HOST/mcp --header "Authorization: Bearer <token>"`

Claude's web and mobile custom connectors expect OAuth rather than a static bearer header, so those may not accept this as it stands.

### stdio (same machine)

Add to Claude Desktop's `claude_desktop_config.json`:

    { "mcpServers": { "arss": { "command": "/opt/homebrew/bin/node", "args": ["/Users/YOU/arss-web/src/mcp.js"] } } }

Or for Claude Code: `claude mcp add arss -- node /Users/YOU/arss-web/src/mcp.js`

Tools: `list_feeds`, `get_items` (filter by feed, unread, date, search), `get_item`, `mark_read`.
The MCP process reads the same SQLite file as the web app (WAL mode), so it works whether or not the web server is running, though fetching only happens while the server runs.
