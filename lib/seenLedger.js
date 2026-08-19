// Persistent domain dedup ledger — once a domain has been successfully
// crawled, it's remembered so re-uploading the same (or an overlapping)
// listing file later skips it by default instead of re-crawling and
// re-spending Apify credits enriching a handle you already have.

const { supabaseAdmin } = require('./supabaseAdmin');

async function loadSeen(userId) {
  const { data, error } = await supabaseAdmin
    .from('seen_domains')
    .select('domain')
    .eq('user_id', userId);
  if (error) throw new Error(`loadSeen: ${error.message}`);
  return new Set((data || []).map((r) => r.domain));
}

/**
 * Splits stores into { unseen, skipped } based on the persistent ledger.
 * When forceRescrape is true, nothing is skipped — the customer explicitly
 * asked to re-scrape domains they've already processed.
 */
async function partitionBySeen(userId, stores, forceRescrape) {
  if (forceRescrape) return { unseen: stores, skipped: [] };
  const seen = await loadSeen(userId);
  const unseen = [];
  const skipped = [];
  for (const s of stores) {
    (seen.has(s.domain) ? skipped : unseen).push(s);
  }
  return { unseen, skipped };
}

/**
 * Marks domains as seen after a crawl — but NOT domains that were merely
 * blocked or unreachable, since those deserve a retry later rather than
 * being written off permanently (same reasoning as the reference pipeline:
 * "blocked" is not "no Instagram").
 */
async function markCrawled(userId, crawledResults) {
  const domains = [...new Set(
    crawledResults.filter((c) => c.outcome === 'fetched').map((c) => c.domain)
  )];
  if (!domains.length) return;
  const rows = domains.map((domain) => ({ user_id: userId, domain }));
  const { error } = await supabaseAdmin
    .from('seen_domains')
    .upsert(rows, { onConflict: 'user_id,domain', ignoreDuplicates: true });
  if (error) throw new Error(`markCrawled: ${error.message}`);
}

module.exports = { loadSeen, partitionBySeen, markCrawled };
