// Online lookups for "add by name": parse the name, then find photo candidates.
// Runs in the Electron main process (no browser CORS limits).
const Match = require('./match.js');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function decode(s) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function bingImages(q) {
  const url = 'https://www.bing.com/images/search?form=HDRSC2&first=1&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Bing HTTP ' + r.status);
  const html = await r.text();
  const out = [];
  const tagRe = /<a\b[^>]*class="[^"]*\biusc\b[^"]*"[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html)) && out.length < 12) {
    const attr = m[0].match(/\sm="([^"]+)"/);
    if (!attr) continue;
    try {
      const j = JSON.parse(decode(attr[1]));
      if (j.murl) out.push({ t: j.t || '', u: j.murl, th: j.turl || null, p: j.purl || null });
    } catch (e) { /* skip */ }
  }
  return out;
}

async function ddgImages(q) {
  const page = await fetch('https://duckduckgo.com/?ia=images&iax=images&q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }).then((r) => r.text());
  const vqd = (page.match(/vqd=["']?([\d-]+)/) || [])[1];
  if (!vqd) throw new Error('DDG token not found');
  const r = await fetch(`https://duckduckgo.com/i.js?l=uk-en&o=json&f=,,,,,&p=1&q=${encodeURIComponent(q)}&vqd=${vqd}`, { headers: { 'User-Agent': UA, Referer: 'https://duckduckgo.com/' }, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  return (j.results || []).slice(0, 12).map((x) => ({ t: x.title || '', u: x.image, th: x.thumbnail, p: x.url }));
}

let browserSearch = null; // set by main.js: real Chromium window, handles cookie/consent pages
function setBrowserSearch(fn) { browserSearch = fn; }

async function imageSearch(q) {
  const query = q;
  let res = [];
  if (browserSearch) { try { res = await browserSearch(query); } catch (e) { /* fall through */ } }
  if (res.length < 3) { try { res = res.concat(await bingImages(query)); } catch (e) { /* fall through */ } }
  if (res.length < 3) { try { res = res.concat(await ddgImages(query)); } catch (e) { /* ignore */ } }
  return res;
}

async function autofill(name, brandHint) {
  const parsed = Match.parseName(name, brandHint);
  let candidates = [];
  try { candidates = await imageSearch(Match.searchQuery(parsed)); } catch (e) { /* offline */ }
  const ranked = Match.rankCandidates(parsed, candidates);
  return { ...parsed, imageCandidates: ranked.map(({ t, u, th, p, score }) => ({ t, u, th, p, score })) };
}

// Best photo for an entry with none: returns { cand, score } or null.
async function bestPhoto(item) {
  const res = await imageSearch(Match.searchQuery(item));
  const ranked = Match.rankCandidates(item, res);
  return ranked.length ? { cand: ranked[0], all: ranked.slice(0, 12).map(({ t, u, th, p, score }) => ({ t, u, th, p, score })) } : null;
}

module.exports = { autofill, bestPhoto, imageSearch, bingImages, ddgImages, setBrowserSearch };
