// Manually grant someone access — for sales made outside the checkout flow
// (friends, comps, support, direct payment). See lib/accountProvisioning.js
// for what this actually does; the Lemon Squeezy webhook uses the same
// function for real purchases.
//
// Usage:
//   node scripts/create-account.js someone@email.com

require('dotenv').config();
const { provisionAccount } = require('../lib/accountProvisioning');

// Where the emailed link lands. Change this if the marketing site's
// domain ever changes.
const RESET_PASSWORD_URL = 'https://leadreaper-website.vercel.app/reset-password.html';

const email = process.argv[2];
if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/create-account.js someone@email.com');
  process.exit(1);
}

(async () => {
  try {
    const { created } = await provisionAccount(email, RESET_PASSWORD_URL);
    console.log(created
      ? `Account created for ${email} — invite email sent.`
      : `${email} already had an account — password-reset link sent instead.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
