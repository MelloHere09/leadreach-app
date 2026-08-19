# LeadReach Console

A real (not simulated) BYOK backend for the Instagram lead pipeline: drop
myip.ms listing pages in, connect your own Apify + Airtable accounts, and it
crawls, enriches, qualifies, and pushes leads directly into your Airtable base.

Ported from the working `IG_LEAD_PIPELINE.md` / `crawl_one.pl` /
`filter_leads.pl` / `push_airtable.pl` pipeline in the parent folder — same
regexes, same Apify actor and calling pattern, same follower/recency
thresholds (1,000–70,000 followers, active within 30 days by default).

## ⚠ Before you do anything else

`../IG_LEAD_PIPELINE.md` has a **live Apify API token hardcoded in
plaintext**. That token is not used anywhere in this app — every run here
uses whatever token the customer types into the form. But if you plan to
hand that markdown file to buyers (the "raw file" distribution option), you
must strip or rotate that token first, or you're mailing out a billing
credential. Rotate at **console.apify.com → Settings → API & Integrations**.

## What's real here vs. what's still rough

| Piece | Status |
|---|---|
| myip.ms listing parser | Ported structurally from `parse_myip_html()` — same "any `<tr>` with a domain cell + IP cell" logic |
| Store crawl (IG handle, gmail, phone, brand) | Ported from `crawl_one.pl`, same precision rules (tel: link → JSON-LD → labeled text only) |
| Apify enrichment | Real 3-step call (start run → poll → read dataset), actor `apify~instagram-profile-scraper` |
| Qualification (followers + recency) | Same thresholds and logic as `filter_leads.pl` |
| Airtable push | Real Metadata-API field discovery + fuzzy mapping, batched writes, de-dup against existing records |
| Story-rescue pass (`datavoyantlab~advanced-instagram-stories-scraper`) | **Not implemented yet** — per project memory this actor currently fails with a "paying users only" error on your Apify plan. Add it later once that's resolved; qualification here relies on the 30-day post window alone |
| Niche selector | Tags qualified leads with the label if your Airtable base has a matching column. It does not change which stores get crawled — myip.ms doesn't support niche filtering on saved-file input, only on live search (see "Different vertical" below) |
| Multi-tenant isolation, rate limiting, auth | Not built — this is a single-operator console, not a hardened public SaaS yet |

I have not been able to run `npm install` / `node server.js` myself — this
sandbox doesn't have Node.js available, so this hasn't been execution-tested.
Sanity-check it locally before relying on it.

## Run it locally

Requires Node.js 18+ (for built-in `fetch`). This machine didn't have Node
installed when this was built — install it first (e.g. via
[nodejs.org](https://nodejs.org) or `brew install node`), or skip straight to
the deploy step below, which builds on the host's own Node install and
doesn't need one locally.

```bash
cd leadreach-app
npm install
npm start
# open http://localhost:3000
```

## Deploy

This is a **long-running Node server**, not a set of serverless functions —
the Apify enrichment step polls for up to a few minutes per run, which is
longer than Vercel's default serverless function timeout. Use a host that
runs a persistent process instead:

- **Render** (recommended, has a free tier): New → Web Service → point at a
  git repo containing this folder → build command `npm install`, start
  command `npm start`. Note the free tier sleeps after inactivity, so the
  first request after idle takes ~30s to wake up.
- **Railway**: similar flow, `npm start` as the run command.
- **Fly.io**: works too, more setup (a `Dockerfile` or `fly.toml`), skip
  unless you already know it.

Push this folder to a GitHub repo first (`git init`, commit, push), then
connect that repo from whichever host you pick — none of them need Node
installed on your own machine.

## How credentials flow

Nothing is read from environment variables at runtime. Every `/api/*` call
takes the Apify/Airtable token from the request body (i.e. what the customer
typed into the form), uses it for that one call, and discards it. There's no
database and no logging of token values. If you later add multi-tenant
accounts, tokens should move into a proper secrets store (encrypted at rest)
rather than being re-typed per run — this version intentionally keeps it
simple.

## Adjusting the filters

Defaults live in `public/index.html` (`value="1000"` / `value="70000"` on the
follower inputs, `30` selected in the recency dropdown) — change them there.
The actual enforcement is in `lib/qualify.js`.

## Different vertical / different source

The crawler works on **any** uploaded HTML shaped like a myip.ms results
page (structural parsing — a table row with a domain cell and an IP cell).
To target a different owner/vertical on myip.ms itself, change the `own/`
ID in the search URL you save pages from (see section 5 of
`../IG_LEAD_PIPELINE.md`). To support an entirely different listing site,
you'll need a new parser function alongside `parseListingHtml()` in
`lib/parseListing.js` — that one is myip.ms-specific by design (the "at the
moment only myip.ms" note on the console UI refers to this).
