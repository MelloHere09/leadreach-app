// Lemon Squeezy webhook: order_created provisions an account (reusing the
// exact same logic scripts/create-account.js uses for manual sales),
// order_refunded revokes access. Everything is driven off req.rawBody
// (see server.js's express.json({ verify }) call) because the signature
// is computed over the raw request bytes, not the re-serialized JSON.

const crypto = require('crypto');
const { provisionAccount } = require('./accountProvisioning');
const { supabaseAdmin } = require('./supabaseAdmin');

const RESET_PASSWORD_URL = 'https://leadreaper-website.vercel.app/reset-password.html';

const VARIANT_PLAN = {
  [process.env.LEMONSQUEEZY_STARTER_VARIANT_ID]: 'starter',
  [process.env.LEMONSQUEEZY_GROWTH_VARIANT_ID]: 'growth',
};

function isValidSignature(req) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const signature = req.headers['x-signature'];
  if (!secret || !signature || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function findUserIdByEmail(email) {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`findUserIdByEmail: ${error.message}`);
  const user = data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  return user ? user.id : null;
}

async function handleOrderCreated(order) {
  if (order.status !== 'paid') return; // e.g. still pending/failed — nothing to do yet
  const email = order.user_email;
  const plan = VARIANT_PLAN[String(order.first_order_item?.variant_id)];
  if (!email || !plan) {
    console.error('lemonsqueezy order_created: unrecognized email/variant', {
      email, variantId: order.first_order_item?.variant_id,
    });
    return;
  }

  const { userId } = await provisionAccount(email, RESET_PASSWORD_URL);
  const { error } = await supabaseAdmin
    .from('profiles')
    .upsert({ user_id: userId, plan }, { onConflict: 'user_id' });
  if (error) throw new Error(`handleOrderCreated (profiles upsert): ${error.message}`);
}

async function handleOrderRefunded(order) {
  const email = order.user_email;
  if (!email) return;
  const userId = await findUserIdByEmail(email);
  if (!userId) {
    console.error('lemonsqueezy order_refunded: no account found for', email);
    return;
  }
  // Long ban rather than deleting the account — keeps their data intact
  // in case of a billing dispute or a later manual reinstatement.
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: '87600h' });
  if (error) throw new Error(`handleOrderRefunded (ban): ${error.message}`);
}

async function handleLemonSqueezyWebhook(req, res) {
  if (!isValidSignature(req)) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  try {
    const eventName = req.headers['x-event-name'];
    const order = req.body?.data?.attributes;

    if (eventName === 'order_created') {
      await handleOrderCreated(order);
    } else if (eventName === 'order_refunded') {
      await handleOrderRefunded(order);
    }
    // Any other subscribed event: acknowledge without acting, so Lemon
    // Squeezy doesn't retry something we deliberately ignore.
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('lemonsqueezy webhook error:', err.message);
    // 500 so Lemon Squeezy retries — the failure is our bug/outage, not a
    // reason to silently drop a real payment.
    res.status(500).json({ error: err.message });
  }
}

module.exports = { handleLemonSqueezyWebhook };
