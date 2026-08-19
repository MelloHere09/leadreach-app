// Per-run history — unlike stats.js (cumulative totals only), this keeps a
// log of individual runs so the console can show a real "recent runs"
// table, and so etaEstimator.js can learn real crawl/enrich rates.

const { supabaseAdmin } = require('./supabaseAdmin');

const MAX_ENTRIES = 50;

function fromRow(row) {
  return {
    at: row.at,
    niche: row.niche,
    filters: row.filters,
    domainsParsed: row.domains_parsed,
    crawlSuccessful: row.crawl_successful,
    handlesFound: row.handles_found,
    qualified: row.qualified,
    pushed: row.pushed,
    skippedDuplicate: row.skipped_duplicate,
    pushFailed: row.push_failed,
    status: row.status,
    crawlMs: row.crawl_ms == null ? null : Number(row.crawl_ms),
    enrichMs: row.enrich_ms == null ? null : Number(row.enrich_ms),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    isRetry: row.is_retry,
  };
}

async function loadRunHistory(userId) {
  const { data, error } = await supabaseAdmin
    .from('run_history')
    .select('*')
    .eq('user_id', userId)
    .order('at', { ascending: false })
    .limit(MAX_ENTRIES);
  if (error) throw new Error(`loadRunHistory: ${error.message}`);
  return (data || []).map(fromRow);
}

async function recordRunHistory(userId, entry) {
  const { error } = await supabaseAdmin.from('run_history').insert({
    user_id: userId,
    niche: entry.niche ?? null,
    filters: entry.filters ?? null,
    domains_parsed: entry.domainsParsed ?? null,
    crawl_successful: entry.crawlSuccessful ?? null,
    handles_found: entry.handlesFound ?? null,
    qualified: entry.qualified ?? null,
    pushed: entry.pushed ?? null,
    skipped_duplicate: entry.skippedDuplicate ?? null,
    push_failed: entry.pushFailed ?? null,
    status: entry.status ?? null,
    crawl_ms: entry.crawlMs ?? null,
    enrich_ms: entry.enrichMs ?? null,
    duration_ms: entry.durationMs ?? null,
    is_retry: !!entry.isRetry,
  });
  if (error) throw new Error(`recordRunHistory: ${error.message}`);
}

module.exports = { loadRunHistory, recordRunHistory };
