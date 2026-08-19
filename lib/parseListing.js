const cheerio = require('cheerio');

// Ported from the working ig_lead_qualifier.py parse_myip_html(): structural,
// not selector-based. A data row is any <tr> containing both a bare-domain
// cell and a bare-IPv4 cell — that survives myip.ms reshuffling its class
// names, which it does. Works on pages saved as "Webpage, HTML Only".
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * @param {string} html a saved myip.ms results page
 * @returns {Array<{name: string, website: string, domain: string}>}
 */
function parseListingHtml(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const out = [];

  $('tr').each((_, tr) => {
    const cells = $(tr)
      .find('td, th')
      .map((__, cell) => $(cell).text().trim())
      .get();
    if (cells.length < 3) return;

    const hasIp = cells.some((c) => IPV4_RE.test(c));
    if (!hasIp) return;

    const domainCell = cells.find((c) => DOMAIN_RE.test(c) && !IPV4_RE.test(c));
    if (!domainCell) return;

    const domain = domainCell.toLowerCase();
    // myip.ms repeats a domain across its mobile/desktop row variants —
    // dedupe within the page, same as the reference parser.
    if (seen.has(domain)) return;
    seen.add(domain);

    out.push({
      name: titleCase(domain.split('.')[0].replace(/-/g, ' ')),
      website: `https://${domain}`,
      domain,
    });
  });

  return out;
}

function titleCase(s) {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

module.exports = { parseListingHtml };
