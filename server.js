require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');

const { parseListingHtml } = require('./lib/parseListing');
const { crawlStore } = require('./lib/crawlStore');
const { testApifyToken, enrichProfiles } = require('./lib/apifyEnrich');
const { qualifyLead } = require('./lib/qualify');
const { testAirtableConnection, getTableSchema, mapFields, pushLeadsToAirtable } = require('./lib/airtable');
const { saveQualifiedLeads, loadQualifiedLeads } = require('./lib/runCache');
const { partitionBySeen, markCrawled } = require('./lib/seenLedger');
const { loadStats, recordRun } = require('./lib/stats');
const { loadRunHistory, recordRunHistory } = require('./lib/runHistory');
const { loadLeads, appendLeads } = require('./lib/leadsLog');
const { estimateRates } = require('./lib/etaEstimator');
const { leadsToCsv } = require('./lib/csvExport');
const { requireAuth } = require('./lib/requireAuth');
const { handleLemonSqueezyWebhook } = require('./lib/lemonSqueezyWebhook');
const { handleGumroadPing } = require('./lib/gumroadWebhook');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 200 },
});

// The Lemon Squeezy webhook needs the raw request bytes to verify its
// signature (see lib/lemonSqueezyWebhook.js) — this stashes them on every
// request without changing how every other route reads req.body.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

// Public — Lemon Squeezy's servers call this directly, there's no user
// session, so it must NOT be behind requireAuth. Verifies its own
// signature instead (see lib/lemonSqueezyWebhook.js).
app.post('/webhooks/lemonsqueezy', handleLemonSqueezyWebhook);

// Public, same reasoning as the Lemon Squeezy route above. Gumroad's Ping
// posts x-www-form-urlencoded (not JSON), so this route needs its own body
// parser — it doesn't trust the payload itself, only uses it to trigger an
// authenticated lookup against Gumroad's API (see lib/gumroadWebhook.js).
app.post('/webhooks/gumroad', express.urlencoded({ extended: false }), handleGumroadPing);

// Every /api/* route requires a valid Supabase session from here on — see
// lib/requireAuth.js. It attaches req.userId, which every data-access call
// below is scoped to.
app.use('/api', requireAuth);

// Small crawl concurrency limiter — mirrors MAX_WORKERS=4 in the reference
// pipeline. Most of these stores share Shopify edge IPs, so parallelizing
// too aggressively lands everything in one rate-limit bucket.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

app.get('/api/stats', async (req, res) => {
  res.json(await loadStats(req.userId));
});

app.get('/api/run-history', async (req, res) => {
  res.json(await loadRunHistory(req.userId));
});

app.get('/api/leads', async (req, res) => {
  res.json(await loadLeads(req.userId));
});

// Reads the base's real schema and shows how lead fields would map onto its
// columns — same logic pushLeadsToAirtable uses internally, exposed here so
// the Airtable connection page can show it without doing a real push.
app.post('/api/airtable-field-map', async (req, res) => {
  try {
    const { airtableToken, baseId, tableName } = req.body || {};
    if (!airtableToken || !baseId) {
      return res.status(400).json({ ok: false, error: 'Missing Airtable token or base ID.' });
    }
    const table = await getTableSchema(airtableToken, baseId, tableName || undefined);
    const fieldMap = mapFields(table);
    res.json({ ok: true, tableName: table.name, fieldMap });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Fallback deliverable for anyone who skipped Airtable — the same qualified
// leads from the last run, as a CSV.
app.get('/api/download-csv', async (req, res) => {
  const cached = await loadQualifiedLeads(req.userId);
  if (!cached || !cached.qualifiedLeads.length) {
    return res.status(404).send('No cached leads to download — run the pipeline first.');
  }
  const csv = leadsToCsv(cached.qualifiedLeads, cached.niche);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leadreach-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.post('/api/test-apify', async (req, res) => {
  try {
    const { apifyToken } = req.body || {};
    if (!apifyToken) return res.status(400).json({ ok: false, error: 'Missing Apify token.' });
    res.json(await testApifyToken(apifyToken));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Retries only the Airtable push, from the cached output of the last run —
// no Apify calls, no re-crawling. Use this after fixing a field-mapping or
// base-config issue instead of running the whole pipeline again.
app.post('/api/retry-push', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const log = (message, done) => send('log', { message, done: !!done });
  const runStartedAt = Date.now();

  try {
    const { airtableToken, baseId, tableName } = req.body || {};
    if (!airtableToken || !baseId) {
      send('error', { message: 'Missing Apify or Airtable credentials.' });
      return res.end();
    }
    const cached = await loadQualifiedLeads(req.userId);
    if (!cached || !cached.qualifiedLeads.length) {
      send('error', { message: 'No cached run to retry — run the pipeline at least once first.' });
      return res.end();
    }
    log(`Retrying push for ${cached.qualifiedLeads.length} cached lead(s) from ${cached.savedAt} — no Apify calls made.`);
    const result = await pushLeadsToAirtable(
      airtableToken, baseId, tableName, cached.qualifiedLeads, cached.niche,
      (msg) => log(`airtable: ${msg}`)
    );
    const pushFailed = result.failed || 0;
    log(`complete — ${result.created} leads pushed${result.skippedDuplicate ? `, ${result.skippedDuplicate} already in your base (skipped)` : ''}${pushFailed ? `, ${pushFailed} failed — see errors above` : ''}`, pushFailed === 0);
    const durationMs = Date.now() - runStartedAt;
    const stats = await recordRun(req.userId, { domainsCrawled: 0, leadsQualified: 0, leadsPushed: result.created, durationMs });
    await recordRunHistory(req.userId, {
      niche: cached.niche,
      domainsParsed: null,
      crawlSuccessful: null,
      handlesFound: null,
      durationMs,
      qualified: cached.qualifiedLeads.length,
      pushed: result.created,
      skippedDuplicate: result.skippedDuplicate,
      pushFailed,
      status: pushFailed ? 'push_failed' : 'pushed',
      isRetry: true,
    });
    send('result', { pushed: result.created, skippedDuplicate: result.skippedDuplicate, pushFailed, stats });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

app.post('/api/test-airtable', async (req, res) => {
  try {
    const { airtableToken, baseId } = req.body || {};
    if (!airtableToken || !baseId) {
      return res.status(400).json({ ok: false, error: 'Missing Airtable token or base ID.' });
    }
    res.json(await testAirtableConnection(airtableToken, baseId));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/run', upload.array('listings'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const log = (message, done) => send('log', { message, done: !!done });
  const runStartedAt = Date.now();

  try {
    const {
      apifyToken,
      airtableToken,
      baseId,
      tableName,
      minFollowers,
      maxFollowers,
      activeWithinDays,
      niche,
      apifyActorId,
      forceRescrape,
    } = req.body;
    const rescrapeSeen = forceRescrape === 'true' || forceRescrape === true;

    if (!apifyToken) {
      send('error', { message: 'Missing Apify credentials — Apify is required.' });
      return res.end();
    }
    const hasAirtable = !!(airtableToken && baseId);
    if (!req.files || req.files.length === 0) {
      send('error', { message: 'No listing HTML files uploaded.' });
      return res.end();
    }

    const filters = {
      minFollowers: Number(minFollowers) || 0,
      maxFollowers: Number(maxFollowers) || Infinity,
      activeWithinDays: Number(activeWithinDays) || 30,
    };
    // Infinity doesn't survive JSON — store "no limit" as null for display.
    const filterSnapshot = {
      minFollowers: filters.minFollowers,
      maxFollowers: Number.isFinite(filters.maxFollowers) ? filters.maxFollowers : null,
      activeWithinDays: filters.activeWithinDays,
      niche: niche || '',
    };

    // 1. parse
    log(`Parsing ${req.files.length} listing file(s)…`);
    const seenDomains = new Set();
    let stores = [];
    for (const file of req.files) {
      const rows = parseListingHtml(file.buffer.toString('utf8'));
      for (const r of rows) {
        if (!seenDomains.has(r.domain)) {
          seenDomains.add(r.domain);
          stores.push(r);
        }
      }
    }
    log(`domains_parsed … ${stores.length}`, true);
    if (!stores.length) {
      send('error', { message: 'No store rows found in the uploaded HTML. Make sure it was saved as "Webpage, HTML Only", not reader mode.' });
      return res.end();
    }

    // 1b. skip anything already processed in a previous run, unless the
    // customer explicitly opted to re-scrape.
    const { unseen, skipped } = await partitionBySeen(req.userId, stores, rescrapeSeen);
    if (skipped.length) {
      log(rescrapeSeen
        ? `${skipped.length} of these were already processed before, but re-scraping anyway as requested.`
        : `${skipped.length} of these were already processed in a previous run — skipped, no charge. ${unseen.length} new domain(s) to crawl. (Check "re-scrape" to force these again.)`,
        true);
    }
    if (!unseen.length) {
      await recordRunHistory(req.userId, { niche, filters: filterSnapshot, domainsParsed: stores.length, crawlSuccessful: 0, handlesFound: 0, qualified: 0, pushed: 0, status: 'all_skipped', durationMs: Date.now() - runStartedAt });
      send('result', { domainsParsed: stores.length, crawlSuccessful: 0, handlesFound: 0, qualified: 0, pushed: 0, skippedSeen: skipped.length, stats: await loadStats(req.userId) });
      return res.end();
    }

    // 2. crawl — estimate the total time up front from past runs' actual
    // crawl/enrich rates, so the console can show a live countdown instead
    // of a blind spinner. Refined once the real handle count is known.
    const rates = await estimateRates(req.userId);
    const estHandles = Math.max(1, Math.round(unseen.length * rates.handleYield));
    send('eta', { totalSeconds: Math.round((unseen.length * rates.msPerDomain + estHandles * rates.msPerHandle) / 1000) });

    log(`Crawling ${unseen.length} store website(s) for Instagram handles and contact info…`);
    const crawlStartedAt = Date.now();
    const crawled = (await mapWithConcurrency(unseen, 4, (s) => crawlStore(s).catch(() => null))).filter(Boolean);
    const crawlMs = Date.now() - crawlStartedAt;
    log(`crawl_successful … ${crawled.length}`, true);
    await markCrawled(req.userId, crawled);

    const withHandles = crawled.filter((c) => c.instagramHandle);
    log(`handles_found … ${withHandles.length}`, true);
    if (!withHandles.length) {
      const stats = await recordRun(req.userId, { domainsCrawled: crawled.length, leadsQualified: 0, leadsPushed: 0, durationMs: Date.now() - runStartedAt });
      await recordRunHistory(req.userId, { niche, filters: filterSnapshot, domainsParsed: stores.length, crawlSuccessful: crawled.length, handlesFound: 0, qualified: 0, pushed: 0, status: 'no_handles', crawlMs, durationMs: Date.now() - runStartedAt });
      send('result', { domainsParsed: stores.length, crawlSuccessful: crawled.length, handlesFound: 0, qualified: 0, pushed: 0, skippedSeen: skipped.length, stats });
      return res.end();
    }

    // Real handle count is known now — refine the estimate for the
    // enrichment phase specifically, which is usually the slow part.
    send('eta', { totalSeconds: Math.round((withHandles.length * rates.msPerHandle) / 1000) });

    // 3. enrich
    log('Enriching handles via Apify — this can take a minute…');
    const enrichStartedAt = Date.now();
    const uniqueHandles = [...new Set(withHandles.map((c) => c.instagramHandle))];
    const profiles = await enrichProfiles(apifyToken, uniqueHandles, apifyActorId, (msg) => log(`apify: ${msg}`));
    const enrichMs = Date.now() - enrichStartedAt;
    log(`profiles_returned … ${Object.keys(profiles).length}`, true);

    // 4. qualify
    log('Applying filters…');
    const qualified = [];
    for (const c of withHandles) {
      const profile = profiles[c.instagramHandle];
      if (!profile) continue;
      const { qualified: passes } = qualifyLead(profile, filters);
      if (passes) qualified.push({ ...c, followers: profile.followers, lastPostAt: profile.lastPostAt });
    }
    log(`qualified … ${qualified.length}`, true);

    // Cache now, before the push attempt — this is the expensive-to-produce
    // output (real Apify spend already happened above). If the push fails,
    // /api/retry-push replays it without touching Apify again.
    if (qualified.length) {
      await saveQualifiedLeads(req.userId, qualified, niche);
      log(`cached ${qualified.length} qualified lead(s) locally — a failed push can be retried without re-crawling or re-spending on Apify`);
    }

    // 5. push (or, with no Airtable connected, leave it ready for CSV download)
    let pushed = 0;
    let skippedDuplicate = 0;
    let pushFailed = 0;
    let downloadReady = false;
    if (qualified.length && hasAirtable) {
      log('Pushing to Airtable…');
      const result = await pushLeadsToAirtable(airtableToken, baseId, tableName, qualified, niche, (msg) => log(`airtable: ${msg}`));
      pushed = result.created;
      skippedDuplicate = result.skippedDuplicate;
      pushFailed = result.failed || 0;
      const suffix = [
        skippedDuplicate ? `${skippedDuplicate} already in your base (skipped)` : null,
        pushFailed ? `${pushFailed} failed to push — see errors above` : null,
      ].filter(Boolean).join(', ');
      log(`complete — ${pushed} leads pushed${suffix ? `, ${suffix}` : ''}`, pushFailed === 0);
    } else if (qualified.length) {
      downloadReady = true;
      log(`No Airtable connected — ${qualified.length} qualified lead(s) ready to download as a CSV.`, true);
    } else {
      log('Nothing qualified on this batch.', true);
    }

    if (qualified.length) {
      await appendLeads(req.userId, qualified, niche, hasAirtable ? 'pushed' : 'csv_only');
    }

    const durationMs = Date.now() - runStartedAt;
    const stats = await recordRun(req.userId, { domainsCrawled: crawled.length, leadsQualified: qualified.length, leadsPushed: pushed, durationMs });

    let runStatus;
    if (pushFailed) runStatus = 'push_failed';
    else if (pushed > 0) runStatus = 'pushed';
    else if (downloadReady) runStatus = 'csv_ready';
    else if (qualified.length === 0) runStatus = 'no_leads';
    else runStatus = 'done';
    await recordRunHistory(req.userId, {
      niche,
      filters: filterSnapshot,
      domainsParsed: stores.length,
      crawlSuccessful: crawled.length,
      handlesFound: withHandles.length,
      qualified: qualified.length,
      pushed,
      skippedDuplicate,
      pushFailed,
      status: runStatus,
      crawlMs,
      enrichMs,
      durationMs,
    });

    send('result', {
      domainsParsed: stores.length,
      crawlSuccessful: crawled.length,
      handlesFound: withHandles.length,
      qualified: qualified.length,
      pushed,
      skippedDuplicate,
      pushFailed,
      skippedSeen: skipped.length,
      downloadReady,
      durationMs,
      stats,
    });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LeadReach console running at http://localhost:${PORT}`));
