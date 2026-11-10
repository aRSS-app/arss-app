# aRSS app (code)

Simple self-hosted RSS reader. Node 22.13+, no native dependencies.

- `src/server.js` - web UI + JSON API + per-feed scheduler (port 3333, localhost only)
- `src/mcp.js` - MCP server (stdio) so Claude can read the same data
- Data lives in `data/arss.db` (SQLite). Override with `ARSS_DB=/path/to.db`.

## Run

    npm install
    npm start        # http://127.0.0.1:3333

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

Add to Claude Desktop's `claude_desktop_config.json`:

    { "mcpServers": { "arss": { "command": "/opt/homebrew/bin/node", "args": ["/Users/YOU/arss-web/src/mcp.js"] } } }

Or for Claude Code: `claude mcp add arss -- node /Users/YOU/arss-web/src/mcp.js`

Tools: `list_feeds`, `get_items` (filter by feed, unread, date, search), `get_item`, `mark_read`.
The MCP process reads the same SQLite file as the web app (WAL mode), so it works whether or not the web server is running, though fetching only happens while the server runs.
