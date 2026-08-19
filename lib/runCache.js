// Caches the last run's qualified leads (the expensive-to-produce output —
// everything up through the Apify enrichment call) so a failed or
// misconfigured Airtable push can be retried without re-crawling stores or
// re-paying for Apify enrichment. One row per user, most-recent run only —
// this is a debugging aid, not a job queue.

const { supabaseAdmin } = require('./supabaseAdmin');

async function saveQualifiedLeads(userId, qualifiedLeads, niche) {
  const { error } = await supabaseAdmin.from('last_run_cache').upsert(
    { user_id: userId, saved_at: new Date().toISOString(), niche, qualified_leads: qualifiedLeads },
    { onConflict: 'user_id' }
  );
  if (error) throw new Error(`saveQualifiedLeads: ${error.message}`);
}

async function loadQualifiedLeads(userId) {
  const { data, error } = await supabaseAdmin
    .from('last_run_cache')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`loadQualifiedLeads: ${error.message}`);
  if (!data) return null;
  // lastPostAt round-trips through JSON as a string — restore it to a Date
  // so buildRecordFields()'s .toISOString() call keeps working.
  const qualifiedLeads = (data.qualified_leads || []).map((lead) => ({
    ...lead,
    lastPostAt: lead.lastPostAt ? new Date(lead.lastPostAt) : null,
  }));
  return { savedAt: data.saved_at, niche: data.niche, qualifiedLeads };
}

module.exports = { saveQualifiedLeads, loadQualifiedLeads };
