// Manually grant someone access — for sales made outside the checkout flow
// (friends, comps, support, direct payment). Creates the account if it
// doesn't exist yet, then emails a "set your password" link (the same
// flow a real Lemon Squeezy purchase will trigger later). If the email
// already has an account, it just sends a normal password-reset link
// instead of failing.
//
// Usage:
//   node scripts/create-account.js someone@email.com

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { supabaseAdmin } = require('../lib/supabaseAdmin');

// Where the emailed link lands. Change this if the marketing site's
// domain ever changes.
const RESET_PASSWORD_URL = 'https://leadreaper-website.vercel.app/reset-password.html';

const email = process.argv[2];
if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/create-account.js someone@email.com');
  process.exit(1);
}

const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);

(async () => {
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: RESET_PASSWORD_URL,
  });

  if (!error) {
    console.log(`Account created for ${email} — invite email sent (id: ${data.user.id}).`);
    return;
  }

  const alreadyExists = /already.*registered|already.*exists/i.test(error.message || '');
  if (!alreadyExists) {
    console.error('Could not create account:', error.message);
    process.exit(1);
  }

  console.log(`${email} already has an account — sending a password-reset link instead.`);
  const { error: resetError } = await anon.auth.resetPasswordForEmail(email, {
    redirectTo: RESET_PASSWORD_URL,
  });
  if (resetError) {
    console.error('Could not send reset link:', resetError.message);
    process.exit(1);
  }
  console.log(`Reset link sent to ${email}.`);
})();
