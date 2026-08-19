// Two Supabase clients, deliberately kept separate:
//
// - supabaseAdmin uses the secret/service-role key, which bypasses row-level
//   security entirely. It's used for every data read/write in this app —
//   every call site is responsible for filtering by user_id itself (see
//   the other lib/*.js files). Row-level security in supabase/schema.sql is
//   still enabled as defense-in-depth for any future code path that queries
//   Supabase directly from the browser.
// - supabaseAuth uses the publishable key and is used only to verify a
//   customer's session token (auth.getUser) — never for data access.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error(
    'Missing Supabase env vars — set SUPABASE_URL, SUPABASE_SECRET_KEY, and ' +
    'SUPABASE_PUBLISHABLE_KEY in .env (see .env.example).'
  );
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { supabaseAdmin, supabaseAuth };
