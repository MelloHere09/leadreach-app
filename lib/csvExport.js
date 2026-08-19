// Fallback deliverable when no Airtable is connected — same qualified-lead
// data, as a CSV (opens natively in Excel/Sheets, no extra dependency
// needed to produce it).

function escapeCsv(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function leadsToCsv(leads, niche) {
  const headers = ['Brand', 'Instagram', 'Website', 'Followers', 'Last Post', 'Emails', 'Phone', 'Niche'];
  const rows = leads.map((l) => [
    l.brandName,
    `https://instagram.com/${l.instagramHandle}`,
    l.website,
    l.followers,
    l.lastPostAt ? new Date(l.lastPostAt).toISOString().slice(0, 10) : '',
    (l.gmails || []).join('; '),
    l.phone || '',
    niche || '',
  ].map(escapeCsv).join(','));
  return [headers.join(','), ...rows].join('\n');
}

module.exports = { leadsToCsv };
