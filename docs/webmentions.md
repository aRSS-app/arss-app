# Publishing and webmentions

aRSS lets you comment on and repost what you read without handing your words to a platform. Your reply is published on **your own site**, and the original author is told about it with a **webmention**.

This guide covers the one-off setup. It takes about ten minutes.

> **Where this is up to:** connecting your site and preparing it (this guide) is ready. The Repost and Comment buttons that use the connection are being built next.

## How it works

1. You press Comment or Repost on a post in aRSS.
2. aRSS saves a small file to your site's repository.
3. Your site rebuilds and the post appears at its own address.
4. aRSS sends a webmention, a short "this page links to yours" message, to the site you responded to.
5. If that site accepts webmentions, it can show your reply under the original post.

Two things make step 5 work:

- **Webmention** is a [W3C standard](https://www.w3.org/TR/webmention/). Not every site accepts them. When one doesn't, your post still lives on your site, it just isn't shown on theirs.
- **Microformats** are class names in your page's HTML, such as `h-entry` and `u-in-reply-to`. They tell the receiving site which part is your reply, who wrote it and what it responds to. Without them a webmention is only a bare link.

## What you need

- A site built with [Eleventy (11ty)](https://www.11ty.dev/), kept in a GitHub repository, that rebuilds when the repository changes (Netlify, Cloudflare Pages, GitHub Pages and Vercel all do this).
- aRSS running on your own machine.

Other platforms can be added. See [Adding a publisher](#adding-a-publisher).

## 1. Create a GitHub token

The token lets aRSS add files to your site's repository, and nothing else.

1. Go to <https://github.com/settings/personal-access-tokens/new>.
2. Give it a name, such as "aRSS", and pick an expiry.
3. Under **Repository access**, choose **Only select repositories** and pick your site's repository.
4. Under **Permissions > Repository permissions**, set **Contents** to **Read and write**. Leave everything else alone.
5. Press **Generate token** and copy it. GitHub only shows it once.

## 2. Connect your site

In aRSS, open **Publishing** in the sidebar and fill in:

| Field | What to enter |
| --- | --- |
| Repository | `owner/name`, for example `you/your-site` |
| Branch | The branch your site builds from, usually `main` |
| Access token | The token from step 1 |
| Site address | Your site's public address, for example `https://example.com` |
| Your name | Shown as the author of your replies |
| Posts folder | Where replies and reposts are saved. Leave blank and aRSS reads your Eleventy config to work it out (for example `src/replies`) |
| Includes folder | Where your layouts live. Leave blank to have it worked out (for example `src/_includes`) |
| Address on your site | The path your posts appear under, for example `/replies/` |
| Your main layout | Optional. The layout the rest of your site uses, such as `base.njk`, so replies look at home |

Press **Connect**. aRSS checks three things and tells you how to fix any that fail:

- it can find the repository
- the branch exists
- the token can write (this creates nothing visible in your repository)

## 3. Prepare your site

Your site needs two files. aRSS shows both, filled in with your settings.

- `_includes/arss-post.njk` is the layout for replies and reposts, with the microformats in place.
- `replies/replies.11tydata.json` tells Eleventy to use that layout, and which address to give each post.

Add them either way:

- **Copy them yourself.** Open each file in the Publishing screen, press Copy and create the file in your repository.
- **Let aRSS add them.** Press "Add them to a branch for me". aRSS commits both files to a branch called `arss-webmentions` and gives you a link to review and merge it on GitHub. Your live site is untouched until you merge.

You can restyle the layout however you like. Keep the class names that start with `h-`, `p-`, `u-`, `e-` and `dt-`, because those are the microformats.

### What a published post looks like

Each reply or repost is one Markdown file in your posts folder:

    ---
    date: 2026-11-13T20:00:00Z
    in_reply_to: https://example.org/a-post/
    target_title: A post
    ---
    Great post. I had the same experience.

A repost uses `repost_of` in place of `in_reply_to`, and the text is optional.

If your site's own RSS feed or sitemap lists every page, these posts will be included. Exclude the posts folder there if you would rather they weren't.

## 4. Check a published post

Once a post is live, paste its address into "Check a published post". aRSS fetches the page and looks for:

| Check | Microformat | Needed? |
| --- | --- | --- |
| Post wrapper | `h-entry` | Yes |
| Link to the original post | `u-in-reply-to` or `u-repost-of` | Yes |
| Your words | `e-content` | Yes |
| Author | `p-author h-card` | Recommended |
| Permalink | `u-url` | Recommended |
| Published date | `dt-published` | Recommended |

For a second opinion, [webmention.rocks](https://webmention.rocks/) and the [microformats parser](https://microformats.io/) are useful.

## Keeping your token safe

The token is stored in aRSS's local database (`data/arss.db`) and is never sent back to the browser. But the aRSS web UI has no login, so anyone who can open it can publish to your site.

- On the default `127.0.0.1` that is only you.
- If you set `HOST=0.0.0.0`, only do so on a network you trust, or put aRSS behind something like Tailscale.
- Scope the token to the one repository, and revoke it on GitHub if you stop using aRSS.

## Showing replies on your own site

That is the other half: *receiving* webmentions. aRSS only sends them. For a static site, [webmention.io](https://webmention.io/) receives them for you, and [eleventy-plugin-webmentions](https://www.npmjs.com/search?q=eleventy%20webmention) style plugins can display them at build time.

## Adding a publisher

A publisher is a small module in `src/publishers/` that knows how to put a post on one kind of site. `github.js` is the reference. Each one exports:

| Function | What it does |
| --- | --- |
| `label` | The name shown in the "Where is your site kept?" list |
| `check(config)` | Tests the connection. Returns `{ ok, checks: [{ name, ok, detail }] }`, with `detail` written for a non-developer |
| `detect(config)` | Optional guess at the site's folders, used when they are left blank |
| `templateFiles(config)` | The files a site needs for microformats, as `[{ path, about, content }]` |
| `installTemplate(config)` | Adds those files somewhere safe to review. Returns `{ branch, files, url }` |

Register it in `src/publishers/index.js` and it appears in the list. A [Micropub](https://indieweb.org/Micropub) publisher would cover WordPress, Micro.blog and many more in one go, and would be a very welcome contribution.
