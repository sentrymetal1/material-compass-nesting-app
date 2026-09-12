// ============================================================================
//  FILE STORE — the platform's first place to actually KEEP an uploaded file.
//
//  WHY THIS EXISTS. Until now nothing on the platform stored a document. The
//  triage manual intake read a drop of PDFs in the browser, posted them to the
//  model for extraction, and let them go; the take-off asked for the same set
//  again on its own screen. That is fine when one person does both steps in one
//  sitting and knows they are two steps. It is a trap otherwise: on 2026-09-09
//  an estimator dropped nine drawing sheets into triage, converted the row into
//  project MCP-10003, and everything downstream was empty — the drawings had
//  never been anywhere. Nothing in the product had told them so.
//
//  So: files uploaded anywhere in the flow land here, keyed to the record they
//  arrived with, and the next step in the chain picks them up instead of asking
//  for them again.
//
//  DURABILITY, said plainly. The root is RAILWAY_VOLUME_MOUNT_PATH when Railway
//  has a volume attached to the service, and the OS temp directory when it does
//  not. Without a volume the files survive the session but NOT a redeploy, and
//  this service redeploys on every push. Attaching a volume in the Railway
//  dashboard is one click and needs no code change; /api/files/health says which
//  of the two is in force. Everything else here behaves identically either way.
//
//  PATH SAFETY. A scope must be one of SCOPES and an owner must be digits only
//  (Zoho record ids are), so nothing a caller sends can climb out of the root.
//  File ids are generated here, never taken from the caller.
// ============================================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SCOPES = ['opportunity', 'project'];
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_OWNER_BYTES = 150 * 1024 * 1024;

const EXT = {
  'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg',
  'image/gif': '.gif', 'image/webp': '.webp', 'text/plain': '.txt', 'text/csv': '.csv',
};

function storeRoot() {
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.FILE_STORE_DIR;
  return path.join(vol || os.tmpdir(), 'mc-files');
}
function isDurable() { return !!(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.FILE_STORE_DIR); }

// Both halves are validated, not sanitised — a bad value is refused rather than
// quietly rewritten into some neighbouring directory.
function ownerDir(scope, owner) {
  if (SCOPES.indexOf(String(scope)) < 0) throw new Error('unknown scope: ' + scope);
  if (!/^[0-9]{6,25}$/.test(String(owner || ''))) throw new Error('owner must be a record id');
  return path.join(storeRoot(), String(scope), String(owner));
}
function indexPath(dir) { return path.join(dir, 'index.json'); }

function readIndex(dir) {
  try { const j = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8')); return Array.isArray(j.files) ? j.files : []; }
  catch (e) { return []; }
}
function writeIndex(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(indexPath(dir), JSON.stringify({ files, updated: new Date().toISOString() }, null, 2));
}

function extFor(name, mediaType) {
  const fromName = path.extname(String(name || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  return EXT[String(mediaType || '').toLowerCase()] || '.bin';
}

// The caller hands over what it already has in memory: base64 for binaries,
// plain text for text files. Nothing is re-read from the browser.
function saveFiles(scope, owner, incoming) {
  const dir = ownerDir(scope, owner);
  const files = readIndex(dir);
  let bytesHeld = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  const saved = [];
  const rejected = [];

  (Array.isArray(incoming) ? incoming : []).forEach((f) => {
    if (!f || (!f.data && !f.text)) return;
    const name = String(f.name || 'document').slice(0, 180);
    let buf;
    try { buf = f.data ? Buffer.from(String(f.data), 'base64') : Buffer.from(String(f.text), 'utf8'); }
    catch (e) { rejected.push({ name, why: 'could not be decoded' }); return; }
    if (!buf.length) { rejected.push({ name, why: 'empty' }); return; }
    if (buf.length > MAX_FILE_BYTES) { rejected.push({ name, why: 'over 40 MB' }); return; }
    if (bytesHeld + buf.length > MAX_OWNER_BYTES) { rejected.push({ name, why: 'would exceed the 150 MB kept per record' }); return; }

    // Same name and same size as something already held = the same document
    // being added twice. Keep the first; a second copy helps nobody downstream.
    if (files.some((x) => x.name === name && Number(x.size) === buf.length)) {
      rejected.push({ name, why: 'already stored' });
      return;
    }
    const id = crypto.randomBytes(12).toString('hex');
    const stored = id + extFor(name, f.media_type);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, stored), buf);
    const rec = {
      id, name, stored,
      kind: String(f.kind || '').slice(0, 20) || 'file',
      media_type: String(f.media_type || '').slice(0, 100) || 'application/octet-stream',
      size: buf.length,
      added: new Date().toISOString(),
    };
    files.push(rec); saved.push(rec); bytesHeld += buf.length;
  });

  if (saved.length) writeIndex(dir, files);
  return { saved, rejected, total: files.length };
}

function listFiles(scope, owner) {
  const dir = ownerDir(scope, owner);
  // A manifest entry whose file is gone (a redeploy on the no-volume path) must
  // not be reported as present — the caller would offer a document it cannot open.
  return readIndex(dir).filter((f) => { try { return fs.statSync(path.join(dir, f.stored)).isFile(); } catch (e) { return false; } });
}

function readFile(scope, owner, id) {
  const dir = ownerDir(scope, owner);
  const rec = readIndex(dir).find((f) => f.id === String(id));
  if (!rec) return null;
  try { return { rec, buf: fs.readFileSync(path.join(dir, rec.stored)) }; } catch (e) { return null; }
}

function removeFile(scope, owner, id) {
  const dir = ownerDir(scope, owner);
  const files = readIndex(dir);
  const rec = files.find((f) => f.id === String(id));
  if (!rec) return false;
  try { fs.unlinkSync(path.join(dir, rec.stored)); } catch (e) { /* already gone */ }
  writeIndex(dir, files.filter((f) => f.id !== rec.id));
  return true;
}

// Used when an opportunity becomes a project: the project gets its own copy, so
// deciding the opportunity later can never pull documents out from under a live
// job. Files already held by the destination are left alone.
function copyOwner(fromScope, fromOwner, toScope, toOwner) {
  const src = ownerDir(fromScope, fromOwner);
  const files = listFiles(fromScope, fromOwner);
  if (!files.length) return { copied: 0, total: listFiles(toScope, toOwner).length };
  const payload = files.map((f) => ({
    name: f.name, kind: f.kind, media_type: f.media_type,
    data: fs.readFileSync(path.join(src, f.stored)).toString('base64'),
  }));
  const out = saveFiles(toScope, toOwner, payload);
  return { copied: out.saved.length, total: out.total };
}

function registerFileRoutes(app) {
  app.get('/api/files/health', (req, res) => {
    res.json({ ok: true, durable: isDurable(), root: storeRoot(), scopes: SCOPES });
  });

  app.get('/api/files/:scope/:owner', (req, res) => {
    try { res.json({ ok: true, durable: isDurable(), files: listFiles(req.params.scope, req.params.owner) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // A document the estimator drops onto the take-off screen belongs to the project
  // exactly as much as one that arrived with the RFQ. Without this it lived only in
  // that browser tab: close the tab and the take-off could not be re-run from it, and
  // nothing downstream could attach it to the project. Same-name-same-size is treated
  // as the same document, so re-sending the RFQ's own files is a no-op.
  app.post('/api/files/:scope/:owner', (req, res) => {
    try {
      const out = saveFiles(req.params.scope, req.params.owner, (req.body && req.body.files) || []);
      res.json({ ok: true, durable: isDurable(), saved: out.saved, rejected: out.rejected, total: out.total });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ?as=base64 is what the take-off screen uses — it needs the bytes in the page,
  // not a URL, because the model is called with the document inline.
  app.get('/api/files/:scope/:owner/:id', (req, res) => {
    let got;
    try { got = readFile(req.params.scope, req.params.owner, req.params.id); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    if (!got) return res.status(404).json({ ok: false, error: 'No such file.' });
    if (String(req.query.as) === 'base64') {
      return res.json({ ok: true, name: got.rec.name, media_type: got.rec.media_type, size: got.rec.size, data: got.buf.toString('base64') });
    }
    res.setHeader('Content-Type', got.rec.media_type);
    res.setHeader('Content-Disposition', 'inline; filename="' + got.rec.name.replace(/"/g, '') + '"');
    res.send(got.buf);
  });

  app.delete('/api/files/:scope/:owner/:id', (req, res) => {
    try { res.json({ ok: removeFile(req.params.scope, req.params.owner, req.params.id) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  console.log('[files] store at ' + storeRoot() + (isDurable() ? ' (durable volume)' : ' (TEMPORARY — attach a Railway volume to keep files across deploys)'));
}

module.exports = { registerFileRoutes, saveFiles, listFiles, readFile, removeFile, copyOwner, isDurable, storeRoot, SCOPES };
