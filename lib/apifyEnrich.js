// Ported from the working Apify calling pattern (apify_run() in
// ig_lead_qualifier.py): start the actor run, poll actor-runs until a
// terminal status, then read the dataset. Note the actor-name separator is
// "~" in the URL, not "/". A non-SUCCEEDED terminal status is not treated as
// fatal — whatever landed in the dataset is still read and used.

const APIFY_BASE = 'https://api.apify.com/v2';
const DEFAULT_ACTOR = 'apify~instagram-profile-scraper';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

async function testApifyToken(token) {
  const res = await fetch(`${APIFY_BASE}/users/me?token=${encodeURIComponent(token)}`);
  if (res.status === 401) return { ok: false, error: 'Apify rejected this token.' };
  if (!res.ok) return { ok: false, error: `Apify returned ${res.status}.` };
  const data = await res.json();
  return { ok: true, username: data?.data?.username || null };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts an actor run, polls it to completion, returns the dataset items.
 * @param {(msg: string) => void} onProgress optional progress callback
 */
async function apifyRun(token, actor, payload, onProgress) {
  const startRes = await fetch(`${APIFY_BASE}/acts/${actor}/runs?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (startRes.status === 401) throw new Error('Apify rejected the token (401).');
  if (startRes.status === 404) throw new Error(`Apify actor "${actor}" not found (404) — it may have been renamed.`);
  if (!startRes.ok) throw new Error(`Apify run failed to start (${startRes.status}).`);

  const startBody = await startRes.json();
  const { id: runId, defaultDatasetId: datasetId } = startBody.data;
  if (onProgress) onProgress(`run ${runId} started`);

  let status = 'READY';
  const deadline = Date.now() + 5 * 60 * 1000; // 5 minute safety ceiling
  while (!TERMINAL.has(status) && Date.now() < deadline) {
    await sleep(3000);
    const statusRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    const statusBody = await statusRes.json();
    status = statusBody.data.status;
    if (onProgress) onProgress(status);
  }
  if (status !== 'SUCCEEDED' && onProgress) {
    onProgress(`ended as ${status} — using whatever landed in the dataset`);
  }

  const itemsRes = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&format=json`);
  if (!itemsRes.ok) throw new Error(`Could not read Apify dataset (${itemsRes.status}).`);
  return itemsRes.json();
}

/**
 * @returns {Promise<Record<string, {followers: number|null, isPrivate: boolean, lastPostAt: Date|null}>>}
 */
async function enrichProfiles(token, handles, actorId, onProgress) {
  const result = {};
  if (!handles.length) return result;
  const items = await apifyRun(token, actorId || DEFAULT_ACTOR, { usernames: handles }, onProgress);

  for (const item of items) {
    const username = (item.username || '').toLowerCase();
    if (!username) continue;
    result[username] = {
      followers: typeof item.followersCount === 'number' ? item.followersCount : null,
      isPrivate: !!item.isPrivate,
      lastPostAt: lastPostDate(item),
    };
  }
  return result;
}

function lastPostDate(profile) {
  const stamps = [];
  for (const post of profile.latestPosts || []) {
    const raw = post.takenAtTimestamp ?? post.timestamp;
    const d = toDate(raw);
    if (d) stamps.push(d);
  }
  if (!stamps.length) return null;
  return new Date(Math.max(...stamps.map((d) => d.getTime())));
}

function toDate(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number' && ts > 0) {
    // Apify actors return either seconds or already-ms epoch; treat < 1e12
    // as seconds (anything below that can't be a plausible ms timestamp).
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof ts === 'string' && ts.trim()) {
    const d = new Date(ts.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

module.exports = { testApifyToken, enrichProfiles, apifyRun };
