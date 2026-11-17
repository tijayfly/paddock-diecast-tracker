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

// ---- eBay Browse API (active listings, EBAY_GB). Untested until keys are available. ----
let token = null, tokenExp = 0;
async function ebayToken(appId, certId) {
  if (token && Date.now() < tokenExp - 60000) return token;
  const auth = Buffer.from(`${appId}:${certId}`).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  if (!r.ok) throw new Error('eBay auth failed: HTTP ' + r.status);
  const j = await r.json();
  token = j.access_token; tokenExp = Date.now() + j.expires_in * 1000;
  return token;
}
function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

async function ebayPrice(item, settings) {
  const t = await ebayToken(settings.ebayAppId, settings.ebayCertId);
  const q = item.ebayQuery || Match.searchQuery(item).replace(/[()]/g, ' ').replace(/ diecast$/, '');
  const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?limit=50&q=' + encodeURIComponent(q) +
    '&filter=' + encodeURIComponent('buyingOptions:{FIXED_PRICE},conditions:{NEW},priceCurrency:GBP');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${t}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } });
  if (!r.ok) throw new Error('eBay search failed: HTTP ' + r.status);
  const j = await r.json();
  const prices = (j.itemSummaries || []).map((s) => parseFloat(s.price && s.price.value)).filter((n) => n > 0);
  if (prices.length < 3) return { gbp: null, source: 'eBay UK (too few listings)', asOf: new Date().toISOString(), samples: prices.length };
  // trim outliers (accessories, bundles)
  const s = prices.sort((a, b) => a - b); const cut = Math.floor(s.length * 0.15);
  const trimmed = s.slice(cut, s.length - cut);
  return { gbp: Math.round(median(trimmed) * (item.qty || 1) * 100) / 100, source: 'eBay UK median asking price', asOf: new Date().toISOString(), samples: prices.length };
}

async function getCurrentPrice(item, settings) {
  if (settings.priceProvider === 'ebay' && settings.ebayAppId && settings.ebayCertId) return ebayPrice(item, settings);
  return dummyPrice(item, settings);
}

module.exports = { getCurrentPrice, dummyPrice, typical };
