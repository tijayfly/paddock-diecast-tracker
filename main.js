// PADDOCK — 1:64 diecast collection tracker (full version, Electron main process)
const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const Match = require('./lib/match.js');
const Prices = require('./lib/prices.js');
const Lookup = require('./lib/lookup.js');
const GitHub = require('./lib/github.js');

const ROOT = __dirname;                               // running from source: data and exports live inside this folder (git-ignored)
const DATA_DIR = app.isPackaged
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath), 'paddock-data')
  : path.join(ROOT, 'paddock-data');
const DATA_FILE = path.join(DATA_DIR, 'collection.json');
const IMG_DIR = path.join(DATA_DIR, 'images');
const VIEW_DIR = app.isPackaged
  ? path.join(path.dirname(DATA_DIR), 'view-only')
  : path.join(ROOT, 'view-only');

protocol.registerSchemesAsPrivileged([{ scheme: 'paddock', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// ---------- data ----------
function loadDB() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'seed-collection.json'), 'utf8'));
    seed.settings = { githubRepo: '', githubToken: '', githubPublish: false, priceProvider: 'dummy', ebayAppId: '', ebayCertId: '', theme: 'system', ...seed.settings };
    saveDB(seed);
  }
  const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  // RRP was removed: tidy away any old RRP fields
  for (const it of db.items || []) for (const k of ['rrpJpy', 'rrpGbp', 'rrpSource', 'rrpUrl']) delete it[k];
  if (db.settings) for (const k of ['jpyPerGbp', 'fxUpdated', 'rrpByBrand']) delete db.settings[k];
  return db;
}
function saveDB(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db.updated = new Date().toISOString();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak');
  fs.renameSync(tmp, DATA_FILE);
}
let DB;

// ---------- images ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
async function download(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const type = r.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('not an image: ' + type);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 2000) throw new Error('too small');
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('avif') ? 'avif' : type.includes('gif') ? 'gif' : 'jpg';
  return { buf, ext };
}
async function cacheImage(item) {
  if (!item.image || (!item.image.url && !item.image.thumb)) return false;
  if (item.image.local && fs.existsSync(path.join(DATA_DIR, item.image.local))) return true;
  fs.mkdirSync(IMG_DIR, { recursive: true });
  for (const u of [item.image.url, item.image.thumb].filter(Boolean)) {
    try {
      const { buf, ext } = await download(u);
      const name = `${item.id}-${Date.now().toString(36)}.${ext}`;
      fs.writeFileSync(path.join(IMG_DIR, name), buf);
      item.image.local = 'images/' + name;
      item.image.cachedFrom = u;
      return true;
    } catch (e) { /* try next */ }
  }
  item.image.error = 'Could not download';
  return false;
}
let caching = false;
async function cacheAll(win) {
  if (caching) return; caching = true;
  const todo = DB.items.filter((i) => i.image && !(i.image.local && fs.existsSync(path.join(DATA_DIR, i.image.local))));
  let done = 0;
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const it = queue.shift();
      await cacheImage(it);
      done++;
      win && !win.isDestroyed() && win.webContents.send('progress', { kind: 'images', done, total: todo.length });
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  saveDB(DB);
  caching = false;
  win && !win.isDestroyed() && win.webContents.send('db-changed');
}

// ---------- find photos for entries that have none ----------
let autoing = false;
async function autoPhotos(win, list) {
  if (autoing) return { busy: true }; autoing = true;
  const todo = DB.items.filter((i) => !i.image && (!list || i.list === list));
  let done = 0, found = 0;
  const send = () => win && !win.isDestroyed() && win.webContents.send('progress', { kind: 'autophoto', done, total: todo.length });
  send();
  for (const it of todo) {
    try {
      const r = await Lookup.bestPhoto(it);
      if (r && r.cand) {
        it.image = { url: r.cand.u, thumb: r.cand.th || null, title: r.cand.t || '', local: null };
        it.imageCandidates = r.all;
        it.imageReview = r.cand.score < 6;         // low-confidence match: flag it for "Check photos"
        await cacheImage(it); found++;
      }
    } catch (e) { /* offline or blocked: leave it */ }
    done++; send();
    if (done % 5 === 0) saveDB(DB);
    await new Promise((r) => setTimeout(r, 600));
  }
  saveDB(DB); autoing = false;
  win && !win.isDestroyed() && win.webContents.send('db-changed');
  return { total: todo.length, found };
}

// ---------- prices ----------
async function refreshPrices(ids) {
  const items = DB.items.filter((i) => !ids || ids.includes(i.id));
  for (const it of items) {
    try {
      const p = await Prices.getCurrentPrice(it, DB.settings);
      if (p) it.current = p;
    } catch (e) {
      // keep the last value, and record why this refresh failed (a later successful refresh replaces it all)
      it.current = { ...(it.current || {}), error: String(e.message || e), errorAt: new Date().toISOString() };
    }
  }
  saveDB(DB);
}
// Update every value from eBay in one go. All or nothing: if anything goes wrong, nothing changes
// (old values and the old "last updated" time stay). Skipped when eBay isn't set up.
const ebayReady = (s) => s.priceProvider === 'ebay' && (s.ebayAppId || '').trim() && (s.ebayCertId || '').trim();
let updating = null;
function updateAllPrices() {
  if (updating) return updating;
  updating = (async () => {
    const s = DB.settings;
    if (!ebayReady(s)) return { ok: false, skipped: true };
    const items = DB.items.slice();
    // every app window except the hidden photo-search one (the main window variable isn't in scope here)
    const send = (m) => { for (const w of BrowserWindow.getAllWindows()) if (w !== searchWin && !w.isDestroyed()) w.webContents.send('progress', { kind: 'prices', ...m }); };
    const results = new Map();
    try {
      for (let n = 0; n < items.length; n++) {
        send({ done: n, total: items.length });
        results.set(items[n].id, await Prices.getCurrentPrice(items[n], s));
      }
    } catch (e) {
      s.pricesError = { message: String(e.message || e), at: new Date().toISOString() };
      saveDB(DB);
      send({ done: items.length, total: items.length, failed: s.pricesError.message });
      return { ok: false, error: s.pricesError.message };
    }
    for (const it of items) {
      const p = results.get(it.id);
      if (!p) continue;
      if (p.gbp == null && it.current && it.current.gbp != null) {   // too few listings: keep the previous value
        it.current = { ...it.current }; delete it.current.error; delete it.current.errorAt;
        continue;
      }
      it.current = p;
    }
    s.pricesUpdatedAt = new Date().toISOString(); delete s.pricesError;
    saveDB(DB);
    send({ done: items.length, total: items.length });
    return { ok: true };
  })().finally(() => { updating = null; });
  return updating;
}

// ---------- view-only export ----------
const PRICE_FIELDS = ['paid', 'gift', 'boughtAt', 'current', 'targetPrice', 'whereToBuy', 'imageCandidates', 'original'];
function exportViewOnly() {
  const outImg = path.join(VIEW_DIR, 'images');
  fs.mkdirSync(outImg, { recursive: true });
  const items = DB.items.map((it) => {
    const o = {};
    for (const [k, v] of Object.entries(it)) if (!PRICE_FIELDS.includes(k)) o[k] = v;
    if (it.image && it.image.local && fs.existsSync(path.join(DATA_DIR, it.image.local))) {
      const base = path.basename(it.image.local);
      fs.copyFileSync(path.join(DATA_DIR, it.image.local), path.join(outImg, base));
      o.image = { local: 'images/' + base, title: it.image.title };
    } else o.image = null;
    if (o.notes && /£|\$|¥|price|paid|ebay/i.test(o.notes)) o.notes = o.notes.replace(/(bought on ebay\.?|£\S+|¥\S+)/gi, '').trim();
    return o;
  });
  const snapshot = { mode: 'view', exported: new Date().toISOString(), items };
  const R = path.join(__dirname, 'renderer');
  fs.writeFileSync(path.join(VIEW_DIR, 'data.js'), 'window.PADDOCK_SNAPSHOT = ' + JSON.stringify(snapshot) + ';\n');
  for (const f of ['styles.css', 'app.js', 'logo.svg', 'theme.js']) fs.copyFileSync(path.join(R, f), path.join(VIEW_DIR, f));
  fs.copyFileSync(path.join(__dirname, 'lib', 'match.js'), path.join(VIEW_DIR, 'match.js'));
  let html = fs.readFileSync(path.join(R, 'index.html'), 'utf8')
    .replace('<!--DATA-->', '<script src="data.js"></script>')
    .replace('../lib/match.js', 'match.js')
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  fs.writeFileSync(path.join(VIEW_DIR, 'index.html'), html);
  return { dir: VIEW_DIR, count: items.length };
}

// ---------- photo search in a hidden browser window ----------
let searchWin = null;
async function browserImageSearch(q) {
  if (!searchWin || searchWin.isDestroyed()) {
    searchWin = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, partition: 'persist:search' } });
  }
  const url = 'https://www.bing.com/images/search?form=HDRSC2&first=1&q=' + encodeURIComponent(q);
  await searchWin.loadURL(url, { userAgent: UA });
  const grab = () => searchWin.webContents.executeJavaScript(`(() => {
    const out = [];
    for (const a of document.querySelectorAll('a.iusc')) { try { const m = JSON.parse(a.getAttribute('m')); if (m.murl) out.push({ t: m.t || '', u: m.murl, th: m.turl || null, p: m.purl || null }); } catch (e) {} if (out.length >= 12) break; }
    if (!out.length) { const els = [...document.querySelectorAll('button, a')]; const b = els.find(x => /^reject/i.test((x.textContent || '').trim())) || els.find(x => /^(accept|agree)/i.test((x.textContent || '').trim())); if (b) b.click(); }
    return out; })()`);
  let res = await grab();
  for (let i = 0; !res.length && i < 6; i++) { await new Promise((r) => setTimeout(r, 700)); res = await grab(); }
  return res;
}

// ---------- window ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121317' : '#ecebe7',
    title: 'PADDOCK — Diecast Collection',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => app.quit());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  return win;
}

app.whenReady().then(async () => {
  protocol.handle('paddock', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(DATA_DIR, u.host, rel));
    if (!file.startsWith(DATA_DIR)) return new Response('no', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  DB = loadDB();
  const win = createWindow();
  Lookup.setBrowserSearch(browserImageSearch);

  ipcMain.handle('db:get', () => DB);
  // Windows/Electron bug: after a native dialog, text fields can stop accepting clicks until the window
  // is refocused. Every dialog goes through these wrappers, which hand focus back to the page afterwards.
  const refocus = () => setTimeout(() => { if (!win.isDestroyed()) { win.blur(); win.focus(); win.webContents.focus(); } }, 60);
  const messageBox = async (opts) => { try { return await dialog.showMessageBox(win, opts); } finally { refocus(); } };
  const openDialog = async (opts) => { try { return await dialog.showOpenDialog(win, opts); } finally { refocus(); } };
  // anything that changes what the catalogue shows is stamped, so closing can offer to publish (price updates don't count)
  const markChanged = () => { DB.settings.contentChangedAt = new Date().toISOString(); };
  ipcMain.handle('db:paths', () => ({ data: DATA_DIR, view: VIEW_DIR }));
  ipcMain.handle('item:save', (_e, item) => {
    const i = DB.items.findIndex((x) => x.id === item.id);
    if (i >= 0) DB.items[i] = item; else DB.items.push(item);
    markChanged(); saveDB(DB); return item;
  });
  ipcMain.handle('item:delete', async (_e, id) => {
    const it = DB.items.find((x) => x.id === id);
    const { response } = await messageBox({ type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: `Delete "${it ? it.title : id}"?`, detail: 'This removes the entry from your list. A backup of the previous data file is kept as collection.json.bak.' });
    if (response !== 0) return false;
    DB.items = DB.items.filter((x) => x.id !== id); markChanged(); saveDB(DB); return true;
  });
  ipcMain.handle('item:remove', (_e, id) => { DB.items = DB.items.filter((x) => x.id !== id); markChanged(); saveDB(DB); return true; });
  ipcMain.handle('settings:save', (_e, s) => { DB.settings = { ...DB.settings, ...s }; saveDB(DB); return DB.settings; });
  ipcMain.handle('lookup:name', (_e, name, brand) => Lookup.autofill(name, brand));
  ipcMain.handle('lookup:images', (_e, q) => Lookup.imageSearch(q));
  ipcMain.handle('image:set', async (_e, id, img) => {
    const it = DB.items.find((x) => x.id === id); if (!it) return null;
    it.image = { url: img.u || img.url, thumb: img.th || img.thumb || null, title: img.t || img.title || '', local: null };
    it.imageReview = false;
    await cacheImage(it); markChanged(); saveDB(DB); return it;
  });
  ipcMain.handle('image:file', async (_e, id) => {
    const r = await openDialog({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const it = DB.items.find((x) => x.id === id); if (!it) return null;
    const ext = path.extname(r.filePaths[0]).toLowerCase() || '.jpg';
    const name = `${id}-own-${Date.now().toString(36)}${ext}`;
    fs.mkdirSync(IMG_DIR, { recursive: true });
    fs.copyFileSync(r.filePaths[0], path.join(IMG_DIR, name));
    it.image = { url: null, thumb: null, title: 'Own photo', local: 'images/' + name, own: true };
    it.imageReview = false; markChanged(); saveDB(DB); return it;
  });
  ipcMain.handle('images:cacheAll', () => cacheAll(win));
  ipcMain.handle('images:auto', (_e, list) => autoPhotos(win, list));
  // Refresh all values with eBay set up = a full all-or-nothing update (ignores the 24-hour rule); single items as before
  ipcMain.handle('prices:refresh', async (_e, ids) => { if (!ids && ebayReady(DB.settings)) await updateAllPrices(); else await refreshPrices(ids); return DB; });
  ipcMain.handle('ebay:test', (_e, appId, certId) => Prices.testEbayKeys(appId, certId));
  async function exportAndPublish(publish) {
    const r = exportViewOnly();
    const s = DB.settings;
    if (publish) {
      if (!s.githubToken || !s.githubRepo) { r.publishError = 'Add a GitHub repo and token in Settings first.'; return r; }
      try {
        r.github = await GitHub.publish({
          repo: s.githubRepo.trim(), token: s.githubToken.trim(), branch: (s.githubBranch || '').trim(), dir: VIEW_DIR,
          message: 'Update collection – ' + new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
          onProgress: (p) => win && !win.isDestroyed() && win.webContents.send('progress', { kind: 'github', ...p }),
        });
        DB.settings.githubLast = { at: new Date().toISOString(), ...r.github }; saveDB(DB);
      } catch (e) { r.publishError = String(e.message || e); }
      win && !win.isDestroyed() && win.webContents.send('progress', { kind: 'github', done: 1, total: 1 });
    }
    return r;
  }
  ipcMain.handle('export:view', (_e, opts = {}) => exportAndPublish(opts.publish ?? DB.settings.githubPublish));

  // closing: if the collection changed since the catalogue was last published, offer to publish it first
  let closing = false;
  win.on('close', async (e) => {
    if (closing || process.env.PADDOCK_SHOTS) return;
    const s = DB.settings;
    const ghReady = (s.githubRepo || '').trim() && (s.githubToken || '').trim();
    const changed = s.contentChangedAt && (!s.githubLast || Date.parse(s.contentChangedAt) > Date.parse(s.githubLast.at));
    if (!ghReady || !changed) return;
    e.preventDefault();
    const { response } = await messageBox({
      type: 'question', buttons: ['Publish and close', 'Close without publishing', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
      message: 'Publish your updated catalogue?',
      detail: `You've added or changed cars since the catalogue was last published to ${s.githubRepo.trim()}. Publish a new version to GitHub Pages before closing?`,
    });
    if (response === 2) return;
    if (response === 0) {
      const r = await exportAndPublish(true);
      if (r.publishError) {
        const { response: again } = await messageBox({ type: 'warning', buttons: ['Close anyway', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, message: 'Couldn’t publish the catalogue', detail: r.publishError });
        if (again !== 0) return;
      }
    }
    closing = true; win.close();
  });
  ipcMain.handle('open:path', (_e, p) => shell.openPath(p));
  ipcMain.handle('open:url', (_e, u) => shell.openExternal(u));

  // first-run work in the background
  win.webContents.once('did-finish-load', async () => {
    if (ebayReady(DB.settings)) {
      // once a day is plenty: skip if the last successful update was under 24 hours ago (Refresh all values still forces one)
      const last = Date.parse(DB.settings.pricesUpdatedAt || 0) || 0;
      if (Date.now() - last >= 24 * 3600 * 1000) { await updateAllPrices(); win.webContents.send('db-changed'); }
    }
    else if (DB.items.some((i) => !i.current)) { await refreshPrices(); win.webContents.send('db-changed'); }
    cacheAll(win);
  });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { for (const w of [searchWin]) if (w && !w.isDestroyed()) w.destroy(); });

// Developer self-test: PADDOCK_SHOTS=<dir> captures screenshots of the main screens, then quits.
if (process.env.PADDOCK_SHOTS) {
  app.whenReady().then(() => setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const out = process.env.PADDOCK_SHOTS; fs.mkdirSync(out, { recursive: true });
    const routes = (process.env.PADDOCK_ROUTES || '#/,#/item/c001,#/wishlist,#/add,#/settings').split(',');
    for (const theme of ['light', 'dark']) {
      await win.webContents.executeJavaScript(`localStorage.setItem('paddock-theme','${theme}');document.documentElement.dataset.theme='${theme}';1`);
      for (const r of routes) {
        await win.webContents.executeJavaScript(`location.hash='${r}';1`);
        await new Promise((res) => setTimeout(res, 900));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(out, `${theme}-${r.replace(/[#\/]+/g, '_') || 'home'}.png`), img.toPNG());
      }
    }
    if (process.env.PADDOCK_STEPS) {
      for (const [js, wait, shot] of JSON.parse(fs.readFileSync(process.env.PADDOCK_STEPS, 'utf8'))) {
        try { await win.webContents.executeJavaScript(js); } catch (e) { fs.appendFileSync(path.join(out, 'errors.txt'), String(e) + '\n'); }
        await new Promise((r) => setTimeout(r, wait));
        if (shot) fs.writeFileSync(path.join(out, shot + '.png'), (await win.webContents.capturePage()).toPNG());
      }
    }
    if (process.env.PADDOCK_EXPORT) exportViewOnly();
    const logs = await win.webContents.executeJavaScript('window.__errs||[]');
    fs.writeFileSync(path.join(out, 'errors.json'), JSON.stringify(logs));
    app.quit();
  }, 2500));
}
