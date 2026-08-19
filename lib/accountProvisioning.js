// Shared by scripts/create-account.js (manual/off-platform sales) and the
// Lemon Squeezy webhook (server.js): creates an account if the email is
// new, or sends a normal password-reset link if it already has one.
// Treating "already exists" as a normal case (not an error) is what makes
// this safe to call twice for the same email — including a retried
// webhook delivery for the same order.

const { createClient } = require('@supabase/supabase-js');
const { supabaseAdmin } = require('./supabaseAdmin');

const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);

/**
 * @returns {Promise<{ userId: string, created: boolean }>}
 */
async function provisionAccount(email, redirectTo) {
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo });

  if (!error) {
    return { userId: data.user.id, created: true };
  }

  const alreadyExists = /already.*registered|already.*exists/i.test(error.message || '');
  if (!alreadyExists) {
    throw new Error(`provisionAccount: ${error.message}`);
  }

  const { error: resetError } = await anon.auth.resetPasswordForEmail(email, { redirectTo });
  if (resetError) {
    throw new Error(`provisionAccount (reset fallback): ${resetError.message}`);
  }

  // Not returned by resetPasswordForEmail, so look the existing user up —
  // callers need the id to also update profiles.plan. listUsers() paginates
  // (perPage caps it); fine at today's scale, would need real pagination
  // or a lookup-by-email if the user base grows past a few hundred.
  const { data: list, error: listError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw new Error(`provisionAccount (lookup): ${listError.message}`);
  const existing = list.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!existing) throw new Error(`provisionAccount: could not find existing user for ${email}`);

  return { userId: existing.id, created: false };
}

module.exports = { provisionAccount };
