// See who has an account and how much they've actually used the pipeline.
// Sorted by most recently active first.
//
// Usage:
//   node scripts/list-customers.js

require('dotenv').config();
const { supabaseAdmin } = require('../lib/supabaseAdmin');

function fmtDate(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

(async () => {
  const { data: usersData, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (usersError) { console.error(usersError.message); process.exit(1); }

  const { data: profiles } = await supabaseAdmin.from('profiles').select('*');
  const { data: stats } = await supabaseAdmin.from('stats').select('*');

  const profileByUser = Object.fromEntries((profiles || []).map((p) => [p.user_id, p]));
  const statsByUser = Object.fromEntries((stats || []).map((s) => [s.user_id, s]));

  const rows = usersData.users.map((u) => {
    const profile = profileByUser[u.id];
    const stat = statsByUser[u.id];
    const banned = u.banned_until && new Date(u.banned_until) > new Date();
    return {
      email: u.email,
      plan: profile ? profile.plan : '—',
      status: banned ? 'BANNED' : 'active',
      created: u.created_at,
      lastLogin: u.last_sign_in_at,
      runs: stat ? stat.runs_completed : 0,
      crawled: stat ? stat.domains_crawled : 0,
      qualified: stat ? stat.leads_qualified : 0,
      pushed: stat ? stat.leads_pushed : 0,
    };
  });

  // Most recently active first; accounts that never logged in go last.
  rows.sort((a, b) => new Date(b.lastLogin || 0) - new Date(a.lastLogin || 0));

  console.log(
    'EMAIL'.padEnd(32), 'PLAN'.padEnd(8), 'STATUS'.padEnd(8),
    'RUNS'.padEnd(6), 'CRAWLED'.padEnd(9), 'QUALIFIED'.padEnd(11), 'PUSHED'.padEnd(8),
    'LAST LOGIN'.padEnd(20), 'CREATED'
  );
  console.log('-'.repeat(140));
  for (const r of rows) {
    console.log(
      r.email.padEnd(32), r.plan.padEnd(8), r.status.padEnd(8),
      String(r.runs).padEnd(6), String(r.crawled).padEnd(9), String(r.qualified).padEnd(11), String(r.pushed).padEnd(8),
      fmtDate(r.lastLogin).padEnd(20), fmtDate(r.created)
    );
  }
  console.log(`\n${rows.length} account(s) total.`);
})();
