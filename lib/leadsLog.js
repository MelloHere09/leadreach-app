// Persistent all-time leads log — every qualified lead from every run, kept
// around so the Leads page can list them after the run's own cache
// (runCache.js) has been overwritten by a later run.

const { supabaseAdmin } = require('./supabaseAdmin');

const MAX_ENTRIES = 5000;

function fromRow(row) {
  return {
    brandName: row.brand_name,
    instagramHandle: row.instagram_handle,
    website: row.website,
    followers: row.followers,
    lastPostAt: row.last_post_at,
    niche: row.niche,
    status: row.status,
    addedAt: row.created_at,
  };
}

async function loadLeads(userId) {
  const { data, error } = await supabaseAdmin
    .from('leads')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_ENTRIES);
  if (error) throw new Error(`loadLeads: ${error.message}`);
  return (data || []).map(fromRow);
}

/**
 * pushStatus: 'pushed' | 'csv_only'
 */
async function appendLeads(userId, qualifiedLeads, niche, pushStatus) {
  if (!qualifiedLeads || !qualifiedLeads.length) return;
  const rows = qualifiedLeads.map((l) => ({
    user_id: userId,
    brand_name: l.brandName ?? null,
    instagram_handle: l.instagramHandle ?? null,
    website: l.website ?? null,
    followers: l.followers ?? null,
    last_post_at: l.lastPostAt || null,
    niche: niche || '',
    status: pushStatus,
  }));
  const { error } = await supabaseAdmin.from('leads').insert(rows);
  if (error) throw new Error(`appendLeads: ${error.message}`);
}

module.exports = { loadLeads, appendLeads };
