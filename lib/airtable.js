// Dynamic field mapping: reads the base's real table schema via the
// Metadata API and matches your lead data onto whatever columns already
// exist there (fuzzy match by name), instead of assuming a fixed schema.
// The hint vocabulary below is drawn from the columns actually used in
// production (build_airtable_payload.pl / push_airtable.pl): Name,
// followers, "last post or activity ", Instagram link, website link,
// Contacts — plus a few common synonyms so a differently-named base still
// maps sensibly.

const AT_BASE = 'https://api.airtable.com/v0';

async function testAirtableConnection(token, baseId) {
  const res = await fetch(`${AT_BASE}/meta/bases/${baseId}/tables`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Airtable rejected this token — check it has schema.bases:read + data.records:write scope.' };
  }
  if (!res.ok) return { ok: false, error: `Airtable returned ${res.status} — check the base ID.` };
  const data = await res.json();
  return { ok: true, tables: (data.tables || []).map((t) => ({ id: t.id, name: t.name })) };
}

async function getTableSchema(token, baseId, tableNameOrId) {
  const res = await fetch(`${AT_BASE}/meta/bases/${baseId}/tables`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not read Airtable base schema (${res.status}).`);
  const data = await res.json();
  const table = tableNameOrId
    ? data.tables.find((t) => t.name === tableNameOrId || t.id === tableNameOrId)
    : data.tables[0];
  if (!table) throw new Error(`Table "${tableNameOrId}" not found in this base.`);
  return table;
}

const FIELD_HINTS = {
  brandName: ['name', 'brand', 'business', 'store', 'company'],
  instagram: ['instagram', 'ig link', 'ig handle', 'handle'],
  website: ['website', 'url', 'domain', 'site'],
  followers: ['follow'],
  activity: ['last post', 'activity', 'last active', 'signal'],
  contacts: ['contact'],
  email: ['email', 'gmail'],
  phone: ['phone', 'tel'],
  niche: ['niche', 'category', 'industry', 'vertical'],
};

// Airtable computed field types are read-only via the API — writing to one
// always 422s with INVALID_VALUE_FOR_COLUMN no matter what value or
// `typecast` you send. A base with a formula/rollup column named something
// like "Followers" (common — people compute a display version of a raw
// field) would otherwise get silently matched and every push would fail
// there. Never match these.
const READ_ONLY_TYPES = new Set([
  'formula', 'rollup', 'count', 'autoNumber', 'createdTime',
  'lastModifiedTime', 'createdBy', 'lastModifiedBy', 'button',
  'aiText', 'multipleLookupValues', 'externalSyncSource',
]);

// For the follower count specifically, prefer an actually-numeric field
// over a same-named text field if both exist — avoids a second class of
// mismatch (e.g. matching a "Follow-up notes" text field over the real
// "Followers" number field just because it sorted first).
const NUMERIC_TYPES = new Set(['number', 'currency', 'percent']);

function mapFields(table) {
  const writable = table.fields.filter((f) => !READ_ONLY_TYPES.has(f.type));
  const map = {};
  const used = new Set();

  for (const [key, hints] of Object.entries(FIELD_HINTS)) {
    const candidates = writable.filter(
      (f) => !used.has(f.name) && hints.some((h) => f.name.toLowerCase().includes(h))
    );
    if (!candidates.length) continue;

    const field =
      key === 'followers'
        ? candidates.find((f) => NUMERIC_TYPES.has(f.type)) || candidates[0]
        : candidates[0];

    map[key] = field.name;
    used.add(field.name);
  }
  return map;
}

function buildRecordFields(lead, fieldMap, niche) {
  const igUrl = `https://instagram.com/${lead.instagramHandle}`;
  const fields = {};

  if (fieldMap.brandName) fields[fieldMap.brandName] = lead.brandName;
  if (fieldMap.instagram) fields[fieldMap.instagram] = igUrl;
  if (fieldMap.website) fields[fieldMap.website] = lead.website;
  // Sent as a string, matching push_airtable.pl's `"$followers"` exactly —
  // that's the version confirmed working error-free against this base.
  // typecast handles string->number more reliably than it does whatever
  // shape a bare JSON number takes against some field configurations.
  if (fieldMap.followers) fields[fieldMap.followers] = String(lead.followers);
  if (fieldMap.activity) fields[fieldMap.activity] = lead.lastPostAt ? lead.lastPostAt.toISOString().slice(0, 10) : '';
  if (fieldMap.niche && niche) fields[fieldMap.niche] = niche;

  // Prefer separate Email/Phone columns if the base has them; otherwise
  // fold everything into a single combined "Contacts"-style field, matching
  // the real production schema.
  if (fieldMap.email || fieldMap.phone) {
    if (fieldMap.email && lead.gmails?.length) fields[fieldMap.email] = lead.gmails.join(', ');
    if (fieldMap.phone && lead.phone) fields[fieldMap.phone] = lead.phone;
  } else if (fieldMap.contacts) {
    const parts = [...(lead.gmails || [])];
    if (lead.phone) parts.push(`tel: ${lead.phone}`);
    fields[fieldMap.contacts] = parts.join(' | ');
  }

  return fields;
}

/**
 * Pushes qualified leads to Airtable, skipping anything already present
 * (matched by the mapped Instagram/website field), same de-dup rule the
 * production script uses so re-runs don't create duplicates.
 */
async function pushLeadsToAirtable(token, baseId, tableNameOrId, leads, niche, onProgress) {
  if (!leads.length) return { created: 0, skippedDuplicate: 0 };
  const table = await getTableSchema(token, baseId, tableNameOrId);
  const fieldMap = mapFields(table);

  const existing = await fetchExistingKeys(token, baseId, table, fieldMap);

  const toCreate = [];
  let skippedDuplicate = 0;
  for (const lead of leads) {
    const igUrl = `https://instagram.com/${lead.instagramHandle}`.toLowerCase();
    const site = (lead.website || '').toLowerCase();
    if (existing.has(igUrl) || existing.has(site)) {
      skippedDuplicate++;
      continue;
    }
    toCreate.push({ fields: buildRecordFields(lead, fieldMap, niche) });
  }

  let created = 0;
  let failed = 0;
  const errors = [];
  for (let i = 0; i < toCreate.length; i += 10) {
    const batch = toCreate.slice(i, i + 10);
    try {
      const res = await fetch(`${AT_BASE}/${baseId}/${encodeURIComponent(table.id)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: batch, typecast: true }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Airtable push failed (${res.status}): ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      created += data.records?.length || 0;
      if (onProgress) onProgress(`pushed batch of ${data.records?.length || 0} (total ${created})`);
    } catch (err) {
      // A bad batch shouldn't cost the leads already pushed, or the ones in
      // batches still queued behind it — log it and keep going.
      failed += batch.length;
      errors.push(err.message);
      if (onProgress) onProgress(`batch failed, skipping ${batch.length} lead(s): ${err.message}`);
    }
    await sleep(250);
  }

  return { created, skippedDuplicate, failed, errors, fieldMap };
}

async function fetchExistingKeys(token, baseId, table, fieldMap) {
  const keys = new Set();
  const igField = fieldMap.instagram;
  const siteField = fieldMap.website;
  if (!igField && !siteField) return keys;

  let offset = '';
  const fieldsQuery = [igField, siteField]
    .filter(Boolean)
    .map((f) => `fields%5B%5D=${encodeURIComponent(f)}`)
    .join('&');

  do {
    const url = `${AT_BASE}/${baseId}/${encodeURIComponent(table.id)}?pageSize=100&${fieldsQuery}${offset ? `&offset=${offset}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break; // best-effort de-dup — a read failure shouldn't block the push
    const data = await res.json();
    for (const r of data.records || []) {
      const ig = igField ? r.fields[igField] : null;
      const site = siteField ? r.fields[siteField] : null;
      if (ig) keys.add(String(ig).toLowerCase());
      if (site) keys.add(String(site).toLowerCase());
    }
    offset = data.offset || '';
  } while (offset);

  return keys;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { testAirtableConnection, getTableSchema, mapFields, pushLeadsToAirtable };
