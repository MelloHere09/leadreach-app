// Ported from crawl_one.pl — one store -> Instagram handle + up to two gmail
// addresses + phone + brand name. Same precision rules as the working script:
// phone only trusted from a tel: link, JSON-LD "telephone", or free text
// sitting right next to an explicit label (a bare digit-group regex is too
// noisy — CSS rgb(), asset hashes, and tracking ids all look like phone
// numbers otherwise).
//
// TLS verification is intentionally relaxed for these store-site requests
// only (never for the Apify/Airtable calls elsewhere in the app) — ported
// straight from crawl_one.pl's `$ua->ssl_opts(verify_hostname => 0)`.
// Confirmed against a real listing: kayakshop.com's cert chain fails strict
// verification in Node's fetch (and in `curl` without -k) but serves fine
// with it relaxed. We're only reading public marketing pages, never sending
// credentials, so this trades off the same way the working Perl script does.

const { Agent, fetch: undiciFetch } = require('undici');
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

const RESERVED = new Set([
  'p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'direct',
  'about', 'developer', 'legal', 'privacy', 'terms', 'help', 'press', 'api',
  'web', 'graphql', 'challenge', 'oauth', 'invites', 'ads', 'business',
  'blog', 'download', 's', 'your_activity', 'sharer', 'share',
]);

const IG_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:#!\/)?@?([A-Za-z0-9._]{1,30})/gi;
const GMAIL_RE = /([A-Za-z0-9._%+-]+@gmail\.com)/gi;
const TEL_HREF_RE = /href=["']tel:([^"']+)["']/i;
const JSONLD_PHONE_RE = /"telephone"\s*:\s*"([^"]+)"/i;
const LABELED_PHONE_RE = /(?:Phone|Tel|Call us|Contact us|Contact)\s*[:\-]?\s*(\+?\(?\d[\d\-.() \s]{7,16}\d)/i;
const OG_SITE_NAME_RE = [
  /property=["']og:site_name["']\s+content=["']([^"']+)["']/i,
  /content=["']([^"']+)["']\s+property=["']og:site_name["']/i,
];
const TITLE_RE = /<title[^>]*>([^<]+)<\/title>/i;

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function fetchWithRetry(url, timeoutMs = 15000) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await undiciFetch(url, {
        signal: controller.signal,
        dispatcher: insecureAgent,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      clearTimeout(timer);
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        await sleep(1500 * attempt);
        continue;
      }
      return res;
    } catch (_) {
      clearTimeout(timer);
      if (attempt === 3) return null;
      await sleep(1500 * attempt);
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{name: string, website: string, domain: string}} store
 */
async function crawlStore(store) {
  const { website, domain, name } = store;
  const htmls = [];
  let outcome = 'unreachable';

  const home = await fetchWithRetry(website);
  if (home && home.ok) {
    htmls.push(await home.text());
    outcome = 'fetched';
  } else if (home && (home.status === 429 || home.status === 503)) {
    outcome = 'blocked';
  } else if (home) {
    outcome = `http_${home.status}`;
  }

  // Best-effort second page — ignored on failure, still tried even if the
  // homepage already yielded the handle, because it's a good source of
  // contact info the homepage often doesn't have.
  const contact = await fetchWithRetry(`${website}/pages/contact`);
  if (contact && contact.ok) {
    htmls.push(await contact.text());
    if (outcome !== 'fetched') outcome = 'fetched';
  }

  const blob = htmls.join('\n');
  if (!blob) {
    return { ...store, instagramHandle: null, gmails: [], phone: '', brandName: name, outcome };
  }

  let handle = null;
  IG_RE.lastIndex = 0;
  let m;
  while ((m = IG_RE.exec(blob))) {
    let h = m[1].toLowerCase().replace(/\.+$/, '');
    if (!h || RESERVED.has(h) || h.startsWith('.')) continue;
    handle = h;
    break;
  }

  const gmails = [];
  GMAIL_RE.lastIndex = 0;
  const seenGmail = new Set();
  while ((m = GMAIL_RE.exec(blob)) && gmails.length < 2) {
    const g = m[1].toLowerCase();
    if (!seenGmail.has(g)) {
      seenGmail.add(g);
      gmails.push(g);
    }
  }
  gmails.sort();

  let phone = '';
  const telMatch = blob.match(TEL_HREF_RE);
  const jsonldMatch = blob.match(JSONLD_PHONE_RE);
  const labeledMatch = blob.match(LABELED_PHONE_RE);
  if (telMatch) phone = telMatch[1];
  else if (jsonldMatch) phone = jsonldMatch[1];
  else if (labeledMatch) phone = labeledMatch[1];
  phone = phone.trim();
  const digitCount = phone.replace(/\D/g, '').length;
  if (digitCount < 7 || digitCount > 15) phone = '';

  let brand = '';
  for (const re of OG_SITE_NAME_RE) {
    const match = blob.match(re);
    if (match) {
      brand = decodeEntities(match[1]);
      break;
    }
  }
  if (!brand) {
    const titleMatch = (htmls[0] || '').match(TITLE_RE);
    if (titleMatch) brand = decodeEntities(titleMatch[1]);
  }
  brand = brand.trim() || name;

  return { ...store, instagramHandle: handle, gmails, phone, brandName: brand, outcome };
}

module.exports = { crawlStore, RESERVED, IG_RE };
