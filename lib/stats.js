// All-time cumulative counters across every run — domains crawled, leads
// qualified, leads pushed to Airtable. Purely additive; a single run never
// resets these, only adds to them. One row per user in the `stats` table.

const { supabaseAdmin } = require('./supabaseAdmin');

const DEFAULTS = { domainsCrawled: 0, leadsQualified: 0, leadsPushed: 0, runsCompleted: 0, totalRunMs: 0 };

function fromRow(row) {
  if (!row) return { ...DEFAULTS };
  return {
    domainsCrawled: row.domains_crawled,
    leadsQualified: row.leads_qualified,
    leadsPushed: row.leads_pushed,
    runsCompleted: row.runs_completed,
    totalRunMs: Number(row.total_run_ms),
  };
}

async function loadStats(userId) {
  const { data, error } = await supabaseAdmin
    .from('stats')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`loadStats: ${error.message}`);
  return fromRow(data);
}

// Read-modify-write, scoped to one user's row — safe for one user's runs
// happening one after another. Two runs from the *same* account started at
// the exact same instant could still race here; fine for now since nothing
// in this app lets a single account start concurrent runs anyway.
async function recordRun(userId, { domainsCrawled = 0, leadsQualified = 0, leadsPushed = 0, durationMs = 0 }) {
  const current = await loadStats(userId);
  const next = {
    user_id: userId,
    domains_crawled: current.domainsCrawled + domainsCrawled,
    leads_qualified: current.leadsQualified + leadsQualified,
    leads_pushed: current.leadsPushed + leadsPushed,
    runs_completed: current.runsCompleted + 1,
    total_run_ms: current.totalRunMs + durationMs,
  };
  const { data, error } = await supabaseAdmin
    .from('stats')
    .upsert(next, { onConflict: 'user_id' })
    .select()
    .single();
  if (error) throw new Error(`recordRun: ${error.message}`);
  return fromRow(data);
}

module.exports = { loadStats, recordRun };
