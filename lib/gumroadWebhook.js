// Gumroad Ping: order_created equivalent, and refund handling.
//
// Unlike the Lemon Squeezy webhook, this does NOT trust the incoming ping
// payload's authenticity directly — Gumroad's Ping documentation and
// signing behavior is inconsistent across sources, so instead the ping is
// used only as a trigger: we take its sale_id and independently confirm
// the sale is real via an authenticated callback to Gumroad's own API.
// Only that authenticated response is ever used to provision an account.

const { provisionAccount } = require('./accountProvisioning');
const { supabaseAdmin } = require('./supabaseAdmin');

const RESET_PASSWORD_URL = 'https://leadreaper-website.vercel.app/reset-password.html';

const PERMALINK_PLAN = {
  [process.env.GUMROAD_STARTER_PERMALINK]: 'starter',
  [process.env.GUMROAD_GROWTH_PERMALINK]: 'growth',
};

async function fetchSale(saleId) {
  const url = `https://api.gumroad.com/v2/sales/${encodeURIComponent(saleId)}?access_token=${process.env.GUMROAD_ACCESS_TOKEN}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.success) throw new Error(`fetchSale: ${data.message || 'Gumroad API rejected the lookup'}`);
  return data.sale;
}

async function handleSale(sale) {
  if (sale.refunded || sale.chargedback) return; // don't provision a reversed sale
  const plan = PERMALINK_PLAN[sale.product_permalink];
  if (!plan) {
    console.error('gumroad sale: unrecognized product', { product_permalink: sale.product_permalink });
    return;
  }

  const { userId } = await provisionAccount(sale.email, RESET_PASSWORD_URL);
  const { error } = await supabaseAdmin
    .from('profiles')
    .upsert({ user_id: userId, plan }, { onConflict: 'user_id' });
  if (error) throw new Error(`handleSale (profiles upsert): ${error.message}`);
}

async function handleRefund(sale) {
  const { data, error: listError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw new Error(`handleRefund: ${listError.message}`);
  const user = data.users.find((u) => u.email.toLowerCase() === sale.email.toLowerCase());
  if (!user) {
    console.error('gumroad refund: no account found for', sale.email);
    return;
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, { ban_duration: '87600h' });
  if (error) throw new Error(`handleRefund (ban): ${error.message}`);
}

async function handleGumroadPing(req, res) {
  try {
    const saleId = req.body && req.body.sale_id;
    if (!saleId) {
      return res.status(400).json({ error: 'Missing sale_id' });
    }

    // The authoritative source of truth — never trust req.body beyond
    // using its sale_id to look this up.
    const sale = await fetchSale(saleId);

    if (sale.refunded || sale.chargedback) {
      await handleRefund(sale);
    } else {
      await handleSale(sale);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('gumroad webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { handleGumroadPing };
