// Publish the view-only folder to a GitHub repo as one commit, via the REST API (no git install needed).
// Only files PADDOCK manages are written/removed; anything else in the repo (README, LICENSE…) is left alone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANAGED = (p) => p === 'index.html' || p === 'data.js' || p === 'app.js' || p === 'match.js' ||
  p === 'styles.css' || p === 'theme.js' || p === 'logo.svg' || p === '.nojekyll' || p.startsWith('images/');

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push({ rel: path.relative(base, full).split(path.sep).join('/'), full });
  }
  return out;
}
const blobSha = (buf) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');

async function publish({ repo, token, branch, dir, message, onProgress }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Repository should look like owner/name');
  if (!token) throw new Error('No GitHub token set');
  const api = async (method, url, body) => {
    const r = await fetch('https://api.github.com' + url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'PADDOCK-diecast-tracker', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const json = text ? JSON.parse(text) : {};
    if (!r.ok) {
      const msg = json.message || r.statusText;
      if (r.status === 401) throw new Error('GitHub rejected the token (401). Check it hasn\'t expired.');
      if (r.status === 403 || r.status === 404) throw new Error(`GitHub: ${msg}. Check the repo name and that the token has Contents: Read and write on it.`);
      throw new Error(`GitHub ${r.status}: ${msg}`);
    }
    return json;
  };

  const info = await api('GET', `/repos/${repo}`);
  const br = branch || info.default_branch || 'main';
  const ref = await api('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(br)}`);
  const headSha = ref.object.sha;
  const head = await api('GET', `/repos/${repo}/git/commits/${headSha}`);
  const tree = await api('GET', `/repos/${repo}/git/trees/${head.tree.sha}?recursive=1`);
  const remote = new Map(tree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));

  // local files (+ .nojekyll so GitHub Pages serves everything as-is)
  if (!fs.existsSync(path.join(dir, '.nojekyll'))) fs.writeFileSync(path.join(dir, '.nojekyll'), '');
  const local = walk(dir);
  const localSet = new Set(local.map((f) => f.rel));
  const entries = [];
  let uploaded = 0, done = 0;
  for (const f of local) {
    const buf = fs.readFileSync(f.full);
    const sha = blobSha(buf);
    done++;
    if (remote.get(f.rel) === sha) continue;          // unchanged
    const blob = await api('POST', `/repos/${repo}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
    entries.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
    uploaded++;
    onProgress && onProgress({ done, total: local.length });
  }
  // remove managed files that no longer exist locally (e.g. replaced photos)
  let removed = 0;
  for (const p of remote.keys()) if (MANAGED(p) && !localSet.has(p)) { entries.push({ path: p, mode: '100644', type: 'blob', sha: null }); removed++; }

  if (!entries.length) return { changed: false, uploaded: 0, removed: 0, branch: br, url: `https://github.com/${repo}`, pages: pagesUrl(repo) };
  const newTree = await api('POST', `/repos/${repo}/git/trees`, { base_tree: head.tree.sha, tree: entries });
  const commit = await api('POST', `/repos/${repo}/git/commits`, { message, tree: newTree.sha, parents: [headSha] });
  await api('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(br)}`, { sha: commit.sha });
  return { changed: true, uploaded, removed, branch: br, commit: commit.sha, url: `https://github.com/${repo}/commit/${commit.sha}`, pages: pagesUrl(repo) };
}
function pagesUrl(repo) { const [o, n] = repo.split('/'); return `https://${o.toLowerCase()}.github.io/${n}/`; }

module.exports = { publish, blobSha };
