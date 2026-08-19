// Learns "time per domain crawled" and "time per handle enriched" from past
// runs, so a new run can show a live estimated-time-remaining instead of a
// blind spinner. Falls back to sane defaults until there's real history to
// learn from. Retries are excluded — they skip crawl/enrich entirely, so
// their near-zero duration would badly skew the average.

const { loadRunHistory } = require('./runHistory');

const DEFAULT_MS_PER_DOMAIN = 1200;
const DEFAULT_MS_PER_HANDLE = 2500;
const DEFAULT_HANDLE_YIELD = 0.6; // fraction of crawled domains that yield an Instagram handle

function average(nums) {
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

async function estimateRates(userId) {
  const history = (await loadRunHistory(userId)).filter((h) => !h.isRetry);

  const crawlRates = history
    .filter((h) => h.crawlMs && h.crawlSuccessful)
    .map((h) => h.crawlMs / h.crawlSuccessful);
  const enrichRates = history
    .filter((h) => h.enrichMs && h.handlesFound)
    .map((h) => h.enrichMs / h.handlesFound);
  const yieldRates = history
    .filter((h) => h.crawlSuccessful && typeof h.handlesFound === 'number')
    .map((h) => h.handlesFound / h.crawlSuccessful);

  return {
    msPerDomain: crawlRates.length ? average(crawlRates) : DEFAULT_MS_PER_DOMAIN,
    msPerHandle: enrichRates.length ? average(enrichRates) : DEFAULT_MS_PER_HANDLE,
    handleYield: yieldRates.length ? average(yieldRates) : DEFAULT_HANDLE_YIELD,
  };
}

module.exports = { estimateRates };
