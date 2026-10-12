// =============================================================================
//  triage.quotenote.test.js — the "What to quote" box on the Quoting tab MUST stay.
// -----------------------------------------------------------------------------
//  Mark's standing requirement (2026-10-11, in capitals): every Quoting card carries a visible
//  "What to quote" notes box, saved on change, sent with Create Project, shown on the AI Take-off
//  page and passed to the AI. It had gone missing twice before after other changes. This test fails
//  if any piece of that chain is removed. Run: node triage.quotenote.test.js
// =============================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const page = require('./triagePage.js');
const html = String((() => { try { return page.renderTriagePage({}); } catch (e) { return page.renderTriagePage(); } })());
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

test('Quoting cards render the "What to quote" box', () => {
  const quoting = html.slice(html.indexOf("status==='Quoting'"));
  assert.ok(html.indexOf("status==='Quoting'") > -1, 'the Quoting branch of the card is gone');
  assert.match(quoting.slice(0, 1500), /What to quote/, 'the Quoting card lost its "What to quote" heading');
  assert.match(quoting.slice(0, 1500), /<textarea onchange="saveNote\(this\)"/, 'the Quoting card lost its notes box');
  assert.match(quoting.slice(0, 1500), /o\.quote_note/, 'the box no longer shows the saved note');
});

test('the note is saved and sent with Create Project', () => {
  assert.match(html, /window\.saveNote\s*=/, 'saveNote() is gone');
  assert.match(html, /\/api\/triage\/quote-note/, 'the page no longer saves the note');
  assert.match(html, /window\.createProject\s*=[\s\S]{0,600}\.qnote textarea/, 'Create Project no longer takes the note');
});

test('the server keeps and returns the note', () => {
  const t = read('triage.js');
  assert.match(t, /app\.post\('\/api\/triage\/quote-note'/, 'POST /api\/triage/quote-note is gone');
  assert.match(t, /o\.quote_note\s*=/, 'the opportunities list no longer carries quote_note');
  assert.match(t, /quote_note: quoteNote/, 'source-files no longer hands the note to the take-off');
});

test('the take-off shows the note and sends it to the AI', () => {
  const idx = read('takeoff/public/index.html');
  assert.match(idx, /id="quoteBrief"/, 'the take-off page lost its "What to quote" box');
  assert.match(idx, /quote_brief:/, 'the run no longer sends quote_brief');
  assert.match(read('index.js'), /req\.body && req\.body\.quote_brief/, 'the server no longer passes quote_brief to the AI');
});
