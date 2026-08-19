// Verifies the Supabase session token on every /api/* request and attaches
// req.userId. Every data-access function downstream (stats, leads, run
// history, seen-domains, last-run cache) takes that userId and scopes its
// query to it — this middleware is the single place that decides who's who.

const { supabaseAuth } = require('./supabaseAdmin');

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing session — log in again.' });
  }
  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data || !data.user) {
    return res.status(401).json({ error: 'Session expired — log in again.' });
  }
  req.userId = data.user.id;
  next();
}

module.exports = { requireAuth };
