// Current-price providers. 'dummy' is used until the eBay developer account is approved.
const Match = require('./match.js');
// Every result: { gbp, source, asOf, samples?, dummy? }

function hash(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }

// Typical UK price for this brand and range (standard release), used when nothing better is known.
function typical(item) {
  const b = Match.brandInfo(item.brand);
  return (b.ranges && b.ranges[item.range]) || b.typical || 3;
}

function dummyPrice(item, settings) {
  const qty = item.qty || 1;
  const base = (item.paid || item.targetPrice || 0) / qty || typical(item);
  if (!base) return null;
  const r = hash(item.id + item.title);
  // chases and treasure hunts trade at a multiple of a normal car of that range (what you paid doesn't tell us much);
  // limited runs drift a little higher; everyday cars sit near retail
  const special = { sth: [10, 15], th: [2, 3], chase: [3, 5] }[item.rarity];
  const k = special || (item.rarity === 'limited' ? [1.0, 1.6] : [0.8, 0.6]);
  const gbp = Math.max(1, Math.round((special ? typical(item) : base) * (k[0] + r * k[1]) * qty * 100) / 100);
  return { gbp, source: 'Dummy data', asOf: new Date().toISOString(), dummy: true };
}

// ---- eBay Browse API (active listings, EBAY_GB). Live responses not yet confirmed with real keys. ----
const AUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

// Plain-English message for a failed eBay request; the HTTP status stays at the end for reference.
function ebayError(stage, status) {
  let msg;
  if (stage === 'auth' && (status === 400 || status === 401)) msg = 'eBay rejected your keys. Use the Production App ID and Cert ID from the same keyset, and check the keyset is active';
  else if (status === 401) msg = 'eBay sign-in expired or was rejected';
  else if (status === 403) msg = 'eBay denied access. Your keyset may not have Browse API access yet';
  else if (status === 429) msg = 'eBay rate limit reached. Try again later';
  else if (status >= 500) msg = 'eBay is having problems right now. Try again later';
  else msg = 'eBay request failed';
  const e = new Error(`${msg} (HTTP ${status})`); e.status = status; e.stage = stage;
  return e;
}
// Every eBay request goes through here. stage: 'auth' | 'search'
async function ebayFetch(url, opts, stage) {
  let r;
  try { r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error("Couldn't reach eBay. Check your internet connection"); }
  if (!r.ok) throw ebayError(stage, r.status);
  return r.json();
}

// The token is cached together with the keys it was issued for, so changed keys get a new token straight away.
let tokenCache = { key: '', token: null, exp: 0 };
async function ebayToken(appId, certId, fresh) {
  appId = String(appId || '').trim(); certId = String(certId || '').trim();
  const key = appId + ':' + certId;
  if (!fresh && tokenCache.token && tokenCache.key === key && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const j = await ebayFetch(AUTH_URL, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(key).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  }, 'auth');
  tokenCache = { key, token: j.access_token, exp: Date.now() + (j.expires_in || 7200) * 1000 };
  return tokenCache.token;
}
function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

function ebaySearch(t, q, limit) {
  const url = SEARCH_URL + '?limit=' + limit + '&q=' + encodeURIComponent(q) +
    '&filter=' + encodeURIComponent('buyingOptions:{FIXED_PRICE},conditions:{NEW},priceCurrency:GBP');
  return ebayFetch(url, { headers: { Authorization: `Bearer ${t}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } }, 'search');
}

async function ebayPrice(item, settings) {
  const t = await ebayToken(settings.ebayAppId, settings.ebayCertId);
  const q = item.ebayQuery || Match.searchQuery(item).replace(/[()]/g, ' ').replace(/ diecast$/, '');
  const j = await ebaySearch(t, q, 50);
  const prices = (j.itemSummaries || []).map((s) => parseFloat(s.price && s.price.value)).filter((n) => n > 0);
  // not an error: just not enough listings to give a value
  if (prices.length < 3) return { gbp: null, source: 'eBay UK (too few listings)', asOf: new Date().toISOString(), samples: prices.length };
  // trim outliers (accessories, bundles)
  const s = prices.sort((a, b) => a - b); const cut = Math.floor(s.length * 0.15);
  const trimmed = s.slice(cut, s.length - cut);
  return { gbp: Math.round(median(trimmed) * (item.qty || 1) * 100) / 100, source: 'eBay UK median asking price', asOf: new Date().toISOString(), samples: prices.length };
}

// Settings → Test eBay keys: sign in afresh (ignoring the cache), then run one small search.
async function testEbayKeys(appId, certId) {
  if (!String(appId || '').trim() || !String(certId || '').trim()) return { ok: false, message: 'Enter both the App ID and the Cert ID first' };
  try {
    const t = await ebayToken(appId, certId, true);
    const j = await ebaySearch(t, 'hot wheels', 1);
    const n = j.total != null ? Number(j.total).toLocaleString('en-GB') : 'some';
    return { ok: true, message: `Keys work: eBay UK returned ${n} listings for a test search.` };
  } catch (e) { return { ok: false, message: String(e.message || e) }; }
}

async function getCurrentPrice(item, settings) {
  if (settings.priceProvider === 'ebay' && settings.ebayAppId && settings.ebayCertId) return ebayPrice(item, settings);
  return dummyPrice(item, settings);
}

module.exports = { getCurrentPrice, dummyPrice, typical, testEbayKeys, ebayError };
