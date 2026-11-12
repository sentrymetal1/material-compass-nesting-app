// Run: node --test server/labor/
const test = require('node:test');
const assert = require('node:assert');
const { resolve, library, loadFromText, nonHoursRows } = require('./standards');
const { jointHours, pipeDims } = require('./pipeJoint');
const { estimateTakeoff, memberDepth, rowPounds } = require('./estimate');

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
  assert.ok(skid.hours.Fab_Hrs > 0, 'channel frame members — fit-up is fabrication');
  assert.ok(!(skid.hours.Assy_Hrs > 0), 'nothing here is assembly after fabrication');
  const fits = skid.lines.filter((l) => /^fit\b/.test(l.what));
  assert.ok(fits.length && fits.every((l) => l.bucket === 'Fab_Hrs'), 'member and plate fit-up land in Fabrication');
  assert.ok(fits.every((l) => /_fit$/.test(l.op)), 'and still group as fit work on the Work pills: ' + fits.map((l) => l.op));
  assert.ok(skid.hours.Cutting_Hrs > 0, 'plate burning');
  assert.ok(skid.hours.Labor_Hrs > 0, 'handling by weight');
  const joint = skid.lines.find((l) => l.standard === 'PIPE-JOINT');
  assert.strictEqual(joint.hours, 8, '2 elbows x 2 ends x 2 hrs from the shop anchor');
  assert.ok(skid.lines.every((l) => l.standard && l.source_ref), 'every hour names its source');
  // Gaps are filled from library rows, and every filled line says it was derived and why.
  const tube = skid.lines.find((l) => /Tube/.test(l.what) && /^fit\b/.test(l.what));
  assert.ok(tube && tube.derived && /Angle|Channel/.test(tube.note), 'tube priced from a stand-in welded-frame row, marked derived');
  assert.ok(skid.lines.some((l) => /weld Plate/.test(l.what) && l.derived && /perimeter/.test(l.note)), 'plate weld along the perimeter, marked as an assumption');
  assert.ok(skid.lines.some((l) => /Tube/.test(l.what) && /^handle/.test(l.what)), 'tube is weighed now, so it gets handling');
  assert.strictEqual(skid.missing.length, 0, 'nothing on this take-off is left unpriced: ' + JSON.stringify(skid.missing));
  assert.ok(!est.components.Grating, 'buyout carries no shop hours');
});

test('a weld schedule that cannot be measured keeps the drawing\'s assumed welds', () => {
  const rows = [{ form_type: 'Plate', material_type: 'Carbon Steel', size: '3/8"', length_ft: 0.5, width_ft: 0.67, quantity: 4, component: 'Handrail', source_sheet: '10053', disposition: 'fabricate' }];
  const plain = estimateTakeoff({ rows }, {}).components.Handrail.hours.Weld_Hrs;
  assert.ok(plain > 0, 'plates carry an assumed perimeter weld');
  // A typical-weld note with no length and no member: nothing to price, so the assumption stays.
  const blank = estimateTakeoff({ rows, welds: [{ joint: 'fillet', size_in: 0.1875, all_around: true, around_member: '', count: 4, component: 'Handrail', source_sheet: '10053' }] }, {});
  assert.strictEqual(blank.components.Handrail.hours.Weld_Hrs, plain, 'assumed weld kept');
  assert.ok(blank.components.Handrail.missing.length > 0, 'the unmeasured weld is still listed');
  // Once it names its member it prices, and replaces the assumption.
  const measured = estimateTakeoff({ rows, welds: [{ joint: 'fillet', size_in: 0.1875, all_around: true, around_member: 'Pipe 1-1/2" SCH 40 (STD)', count: 4, component: 'Handrail', source_sheet: '10053' }] }, {});
  assert.ok(measured.components.Handrail.lines.some((l) => l.from_drawing), 'priced from the drawing');
  assert.ok(!measured.components.Handrail.lines.some((l) => /weld Plate/.test(l.what)), 'assumed plate weld dropped');
});

test('a drawing built twice doubles its own rows, not the whole component', () => {
  const { laborForTakeoff } = require('./takeoffLabor');
  const row = (sheet, q) => ({ form_type: 'Pipe', material_type: 'Carbon Steel', size: '1-1/2" SCH 40 (STD)', length_ft: 4, quantity: 1, component: 'Handrail', source_sheet: sheet, disposition: 'fabricate', sheet_qty: q, units: q });
  const hrs = (rows) => laborForTakeoff({ rows, labor_methods: { handrail: { mode: 'member' } } }, null).components.find((c) => c.name === 'Handrail');
  const one = hrs([row('A', 1), row('B', 1)]);
  const mixed = hrs([row('A', 1), row('B', 2)]);
  const sum = (c) => c.items.reduce((a, i) => a + i.hours, 0);
  assert.strictEqual(mixed.units, 1, 'one handrail, not two');
  // B's second copy adds work, but the component is not doubled (that was ×1.9 with learning).
  assert.ok(sum(mixed) > sum(one) * 1.1 && sum(mixed) < sum(one) * 1.6, 'B built twice adds one drawing of work: ' + sum(one) + ' -> ' + sum(mixed));
});

test('handrail by the foot: top-rail feet × the shop hr/ft; plates on top; a drawing with no top rail is listed', () => {
  const { laborForTakeoff } = require('./takeoffLabor');
  const base = { material_type: 'Carbon Steel', component: 'Handrail', disposition: 'fabricate', units: 1, sheet_qty: 1 };
  const pipe = (sheet, role, ft, q) => Object.assign({ form_type: 'Pipe', size: '1-1/2" SCH 40 (STD)', length_ft: ft, quantity: q || 1, source_sheet: sheet, role }, base);
  const rows = [
    pipe('A', 'top_rail', 10), pipe('A', 'post', 3.5, 2), pipe('A', 'mid_rail', 9),
    Object.assign({ form_type: 'Bar - Flat', size: '4 x 1/4', length_ft: 10, quantity: 1, source_sheet: 'A', role: 'toe_plate' }, base),
    Object.assign({ form_type: 'Plate', size: '3/8', length_ft: 0.5, width_ft: 0.5, quantity: 2, source_sheet: 'A', role: 'base_plate' }, base),
    Object.assign(pipe('B', 'top_rail', 6), { units: 2, sheet_qty: 2 }),
    pipe('C', 'post', 3.5),
  ];
  const profile = { rates: { handrail_pipe_2_kick: 0.6 } };   // the shop's own rate
  const c = laborForTakeoff({ rows }, profile).components.find((x) => x.name === 'Handrail');
  const rail = c.items.filter((i) => /^Handrail /.test(i.what));
  const kick = rail.filter((i) => /kickplate/.test(i.what)).reduce((a, i) => a + i.hours, 0);
  assert.ok(Math.abs(kick - 10 * 0.6) < 0.01, 'A: 10 ft × the shop 0.6 hr/ft, split cut/fit/weld: ' + kick);
  const two = rail.filter((i) => /2-line —/.test(i.what));
  assert.ok(two.length && two.every((i) => Math.abs(i.qty - 12) < 1e-9), 'B: no toe plate → 2-line, 6 ft built twice = 12 ft: ' + two.map((i) => i.qty));
  assert.ok(c.items.some((i) => /Plate/.test(i.what)), 'base plates still priced on top');
  assert.ok(!c.items.some((i) => /Pipe/.test(i.what) && !/^Handrail /.test(i.what)), 'no pipe priced member by member');
  assert.ok(c.missing.some((m) => /drawing C/.test(m.what)), 'C has no top rail: listed, not guessed');
  assert.strictEqual(c.rail.rates.handrail_pipe_2_kick.source, 'yours');
  const member = laborForTakeoff({ rows, labor_methods: { handrail: { mode: 'member' } } }, profile).components.find((x) => x.name === 'Handrail');
  assert.ok(!member.rail && member.items.some((i) => /Pipe/.test(i.what)), 'member by member when the estimator picks it');
});

test('no reference joint: pipe butt and socket welds by the weld-time method', () => {
  const est = estimateTakeoff({ rows: [], fittings: [
    { fitting_type: 'Elbow', end_type: 'Butt Weld', size: '4"', schedule_or_class: 'SCH 40', quantity: 1, component: 'P' },
    { fitting_type: 'Elbow', end_type: 'Butt Weld', size: '8"', schedule_or_class: 'SCH 40', quantity: 1, component: 'P' },
    { fitting_type: 'Tee', end_type: 'Socket Weld', size: '1"', schedule_or_class: 'SCH 80', quantity: 1, component: 'P' },
    { fitting_type: 'Elbow', end_type: 'Threaded', size: '1"', schedule_or_class: '3000', quantity: 1, component: 'P' },
  ] }, {});
  const p = est.components.P;
  const [four, eight, sock] = p.lines;
  assert.strictEqual(four.standard, 'LINCOLN-GROOVE');
  assert.ok(four.derived && /reference joint/.test(four.note));
  assert.ok(eight.per_unit > four.per_unit * 2, 'an 8" joint is more than twice a 4" (longer and thicker): ' + four.per_unit + ' / ' + eight.per_unit);
  assert.strictEqual(sock.standard, 'LINCOLN-FILLET');
  assert.strictEqual(sock.units, 3, 'a tee has three socket ends');
  assert.ok(p.missing.some((m) => /Threaded/.test(m.reason)), 'threaded is still listed, not guessed');
});

test('weights for sections that do not carry weight in their name', () => {
  const lb = (form_type, size) => rowPounds({ form_type, size, material_type: 'Carbon Steel', length_ft: 1, quantity: 1 });
  assert.ok(Math.abs(lb('Angle', 'L3 x 3 x 1/4') - 4.9) < 0.1, 'L3x3x1/4 ~4.9 lb/ft: ' + lb('Angle', 'L3 x 3 x 1/4'));
  // weights.js tube_rect ignores corner radii: 4.5% over the published HSS4x4x1/4 (12.21) and
  // 12% over HSS4x2x3/8 (11.97). Heavy, never light — the safe side for a quote. Known; see handoff.
  const sq = lb('Tube - Square', '4 x 1/4'), rt = lb('Tube - Rectangular', 'HSS4x2x3/8');
  assert.ok(sq >= 12.21 && sq < 12.21 * 1.06, 'HSS4x4x1/4 a little over 12.21 lb/ft: ' + sq);
  assert.ok(rt >= 11.97 && rt < 11.97 * 1.13, 'HSS4x2x3/8 over 11.97 lb/ft: ' + rt);
  assert.ok(Math.abs(lb('Bar - Flat', '3 x 1/4') - 2.55) < 0.05, '3x1/4 flat 2.55 lb/ft');
  assert.ok(Math.abs(lb('Pipe', '4" SCH 40') - 10.79) < 0.1, '4" sch 40 pipe 10.79 lb/ft: ' + lb('Pipe', '4" SCH 40'));
  assert.strictEqual(lb('Channel', 'C6 x 13'), 13);
});
