// Run: node --test server/labor/
const test = require('node:test');
const assert = require('node:assert');
const { resolve, library, loadFromText, nonHoursRows } = require('./standards');
const { jointHours, pipeDims } = require('./pipeJoint');
const { estimateTakeoff, memberDepth } = require('./estimate');

test('library loads: 240 hours rows, 15 that are not hours', () => {
  const lib = library();
  assert.strictEqual(lib.length, 255);
  assert.strictEqual(lib.filter((r) => r.kind === 'Hours').length, 240);
  assert.strictEqual(nonHoursRows().length, 15);
});

test('a non-hours row is never returned as hours', () => {
  // 250 sq ft/ton sitting in an Hr/Ton column would add 2,500 hours to a 10-ton job.
  const r = resolve({ category: 'Blast/Paint', operation: /Surface area allowance/ });
  assert.ok(r.missing);
});

test('bad data refuses to load', () => {
  const head = 'Standard_Code,Operation_Category,Value_Kind,Hours_Per_Unit\n';
  assert.throws(() => loadFromText(head + 'A,Cutting,Hours,0.1\nA,Cutting,Hours,0.2\n'), /duplicate/);
  assert.throws(() => loadFromText(head + 'A,Cutting,Hours,\n'), /no hours/);
  assert.throws(() => loadFromText(head + 'A,Cutting,Multiplier,1.5\n'), /carries/);
});

test('banded lookup: C6 channel frame member', () => {
  const r = resolve({ category: 'Assembly', operation: 'Welded frame member - square cut and welded all around',
    form: 'Channel', material: 'Carbon Steel', size: { 'Member Depth (in)': 6 } });
  assert.ok(r.row, r.missing);
  assert.strictEqual(r.bucket, 'Assy_Hrs');
  assert.ok(r.row.sizeMin <= 6 && 6 < r.row.sizeMax);
});

test('no match is missing, not zero', () => {
  const r = resolve({ category: 'Assembly', operation: 'Welded frame member - square cut and welded all around',
    form: 'Channel', material: 'Carbon Steel', size: { 'Member Depth (in)': 99 } });
  assert.ok(r.missing);
});

test('a shop override beats the library', () => {
  const lib = resolve({ category: 'Handling' });
  const shop = Object.assign({}, lib.row, { code: 'SHOP-HANDLE', hours: 3, source: 'Shop Anchor' });
  assert.strictEqual(resolve({ category: 'Handling' }, { overrides: [shop] }).row.code, 'SHOP-HANDLE');
});

test('member depth parses catalog sizes', () => {
  assert.strictEqual(memberDepth('W12 x 26'), 12);
  assert.strictEqual(memberDepth('MC8 x 20'), 8);
  assert.strictEqual(memberDepth('C 12 x 8.274'), 12);
});

test('pipe dims: STD and XS follow B36.10 past the SCH 40/80 range', () => {
  assert.deepStrictEqual(pipeDims('4"', 'SCH 40'), { od: 4.5, wall: 0.237 });
  assert.deepStrictEqual(pipeDims('4"', 'STD'), { od: 4.5, wall: 0.237 });
  assert.strictEqual(pipeDims('12"', 'STD').wall, 0.375);
  assert.strictEqual(pipeDims('10"', 'XS').wall, 0.5);
});

test('pipe joints: no anchor is missing; anchors are reproduced exactly', () => {
  assert.ok(jointHours('6"', 'SCH 40', []).missing);
  const anchors = [{ size: '4"', schedule: 'SCH 40', hours: 2 }, { size: '8"', schedule: 'SCH 40', hours: 4.5 }];
  assert.ok(Math.abs(jointHours('4"', 'SCH 40', anchors).hours - 2) < 1e-9);
  assert.ok(Math.abs(jointHours('8"', 'SCH 40', anchors).hours - 4.5) < 1e-9);
  const six = jointHours('6"', 'SCH 40', anchors).hours;
  assert.ok(six > 2 && six < 4.5, 'a 6" joint sits between the 4" and 8" anchors: ' + six);
  // Heavier wall, same size -> more weld metal -> more hours.
  assert.ok(jointHours('6"', 'SCH 80', anchors).hours > six);
});

test('take-off estimate: hours per component, sources named, gaps listed', () => {
  const est = estimateTakeoff({
    rows: [
      { form_type: 'Channel', material_type: 'Carbon Steel', size: 'C6 x 13', length_ft: 8, quantity: 4, component: 'Skid', disposition: 'fabricate' },
      { form_type: 'Plate', material_type: 'Carbon Steel', size: '1/2"', length_ft: 2, width_ft: 1, quantity: 2, component: 'Skid', disposition: 'fabricate' },
      { form_type: 'Tube - Square', material_type: 'Carbon Steel', size: '4 x 1/4', length_ft: 10, quantity: 1, component: 'Skid', disposition: 'fabricate' },
      { form_type: 'Angle', material_type: 'Carbon Steel', size: 'L2 x 2 x 1/4', length_ft: 10, quantity: 1, component: 'Grating', disposition: 'buyout' },
    ],
    fittings: [
      { fitting_type: 'Elbow', end_type: 'Butt Weld', size: '4"', schedule_or_class: 'SCH 40', quantity: 2, component: 'Skid' },
    ],
  }, { pipeAnchors: [{ size: '4"', schedule: 'SCH 40', hours: 2 }] });

  const skid = est.components.Skid;
  assert.ok(skid.hours.Assy_Hrs > 0, 'channel frame members');
  assert.ok(skid.hours.Cutting_Hrs > 0, 'plate burning');
  assert.ok(skid.hours.Labor_Hrs > 0, 'handling by weight');
  assert.strictEqual(skid.hours.Weld_Hrs, 8, '2 elbows x 2 ends x 2 hrs');
  assert.ok(skid.lines.every((l) => l.standard && l.source_ref), 'every hour names its source');
  assert.ok(skid.missing.some((m) => /Tube/.test(m.reason)), 'tube is flagged, not zeroed');
  assert.ok(skid.missing.some((m) => /fit & weld/.test(m.reason)), 'plate welding is flagged');
  assert.ok(!est.components.Grating, 'buyout carries no shop hours');
});
