// Run: node --test server/labor/shop.test.js
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Keep the test's shop files out of the real store.
process.env.FILE_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'labor-test-'));

const { weldHoursPerFt, deposition, operatingFactor, sentryMigDeposition, filletLbPerFt } = require('./weldTime');
const { catalog } = require('./components');
const shop = require('./shop');

test('fillet weld metal: 1/4" is 0.106 lb/ft of steel', () => {
  assert.ok(Math.abs(filletLbPerFt(0.25) - 0.1063) < 0.001);
});

test('SMAW deposition follows the 1962 chart (0.1.6 p.14)', () => {
  const d = deposition({ weld_process: 'SMAW', smaw_amps: 202 });
  assert.ok(Math.abs(d.value - 4.30) < 0.05, 'chart reads 4.30 lb/hr at 202 A, got ' + d.value);
  assert.ok(deposition({ weld_process: 'SMAW' }).missing, 'stick without amperage asks the shop');
});

test('MIG defaults reproduce Sentry: 1/4" fillet at 6 in/min, applied 0.0714 hr/ft', () => {
  assert.ok(Math.abs(sentryMigDeposition() - 3.19) < 0.02);
  const of = operatingFactor({});
  assert.ok(of.value > 0.4 && of.value < 0.5, 'about 47%: ' + of.value);
  const w = weldHoursPerFt({ kind: 'fillet', size: 0.25 }, {});
  assert.ok(Math.abs(w.hours_per_ft - 0.0714) < 0.001, 'closes the loop on the 1997 rate: ' + w.hours_per_ft);
});

test('shop numbers win, position slows it down', () => {
  const mine = weldHoursPerFt({ kind: 'fillet', size: 0.25 }, { deposition_lb_hr: 6, operating_factor: 0.3 });
  assert.strictEqual(mine.source, 'yours');
  assert.ok(Math.abs(mine.hours_per_ft - 0.1063 / 6 / 0.3) < 0.001);
  const up = weldHoursPerFt({ kind: 'fillet', size: 0.25, position: 'vertical' }, {});
  assert.ok(up.hours_per_ft > weldHoursPerFt({ kind: 'fillet', size: 0.25 }, {}).hours_per_ft);
});

test('standard components: handrail from the library, treads ask the shop', () => {
  const c = Object.fromEntries(catalog({}).map((x) => [x.key, x]));
  assert.ok(Math.abs(c.handrail_pipe_2.library - 0.36) < 0.001);
  assert.ok(Math.abs(c.handrail_pipe_2_kick.library - 0.54) < 0.001);
  assert.ok(c.handrail_pipe_3.library > 0.36 && c.handrail_pipe_3.library < 0.54);
  assert.strictEqual(c.tread.source, 'missing');
  assert.strictEqual(catalog({ tread: 0.75 }).find((x) => x.key === 'tread').source, 'yours');
});

test('shop profile: saves, cleans, never stores a zero, rates by type', () => {
  const saved = shop.save('4111484000000000001', {
    settings: { weld_process: 'SMAW', smaw_amps: 175, operating_factor: 7 },
    rates: { tread: 0.8, handrail_pipe_2: 0, bogus: 3 },
    reference_jobs: [
      { type: 'skid_frame', name: 'Keller 40778', tons: 11, hours: 1129 },
      { type: 'skid_frame', name: 'Pipe support skids 40785', tons: 3, hours: 290.75 },
      { type: 'skid_frame', name: 'no hours', tons: 2 },
    ],
  });
  assert.strictEqual(saved.settings.operating_factor, null, 'a factor over 1 is dropped');
  assert.deepStrictEqual(saved.rates, { tread: 0.8 }, 'zero and unknown keys are dropped');
  assert.strictEqual(saved.reference_jobs.length, 2);
  const r = shop.referenceRates(shop.load('4111484000000000001')).skid_frame;
  assert.strictEqual(r.jobs, 2);
  assert.ok(Math.abs(r.hr_per_ton - (1129 + 290.75) / 14) < 0.1);
  assert.throws(() => shop.load('../../etc'), /record id/);
});

test('pipe reference joints: only sizes the scaler can read are kept or offered', () => {
  const p = shop.clean({ pipe_anchors: [
    { size: '4"', schedule: 'SCH 40', hours: 2 },
    { size: '4-1/2"', schedule: 'SCH 40', hours: 2 },   // not in the NPS table under that schedule
    { size: '6"', schedule: 'STD', hours: 3 },
  ] }, '4111484000000000003');
  assert.deepStrictEqual(p.pipe_anchors.map((a) => a.size), ['4"', '6"']);
  const four = shop.pipeChoices().find((c) => c.size === '4"');
  assert.ok(four.schedules.includes('SCH 40') && four.schedules.includes('STD'));
});

test('take-off labour: job hours = per unit × units, ballpark from the shop\'s own jobs', () => {
  const { laborForTakeoff } = require('./takeoffLabor');
  const profile = shop.clean({ reference_jobs: [{ type: 'skid_frame', name: 'K', tons: 10, hours: 1000 }] }, '4111484000000000004');
  const takeoff = {
    rows: [
      { form_type: 'Channel', material_type: 'Carbon Steel', size: 'C6 x 13', length_ft: 10, quantity: 4, units: 3, component: 'Skid' },
      { form_type: 'Channel', material_type: 'Carbon Steel', size: 'C6 x 13', length_ft: 10, quantity: 9, units: 3, component: 'Skid', deleted: true },
      { form_type: 'Tube - Square', material_type: 'Carbon Steel', size: '4 x 1/4', length_ft: 10, quantity: 1, units: 3, component: 'Skid' },
    ],
    fittings: [],
  };
  const one = laborForTakeoff(takeoff, profile, 'skid_frame');
  const skid = one.components.find((c) => c.name === 'Skid');
  assert.strictEqual(skid.units, 3);
  const assy = skid.items.find((i) => i.bucket === 'Assy_Hrs');
  assert.ok(Math.abs(assy.hours - assy.per_unit * 3) < 0.02, 'job hours are 3 units of the per-unit hours');
  assert.ok(Math.abs(one.tons - 4 * 10 * 13 * 3 / 2000) < 0.01, 'deleted rows carry no weight; tube has none: ' + one.tons);
  assert.strictEqual(one.unweighed_rows, 1, 'the tube is counted as unweighed, not as zero');
  assert.ok(Math.abs(one.ballpark.hours - 100 * one.tons) < 0.1, 'ballpark = 100 hr/ton × tons');
  assert.ok(skid.missing.some((m) => /Tube/.test(m.reason)));
  assert.strictEqual(laborForTakeoff(takeoff, profile, 'plate_tank').ballpark.hours, null, 'no jobs of that type → no ballpark');
  assert.strictEqual(laborForTakeoff(takeoff, null, 'skid_frame').ballpark.hours, null, 'no shop → no ballpark');
});

test('weld preview: unsaved settings win, and are cleaned like a save', () => {
  const { weldSettings } = require('./routes');
  const id = '4111484000000000002';
  shop.save(id, { settings: { deposition_lb_hr: 6, operating_factor: 0.3 } });
  assert.strictEqual(weldSettings(id, {}).deposition_lb_hr, 6, 'no draft → saved settings');
  const draft = weldSettings(id, { settings: { deposition_lb_hr: 4, operating_factor: 30 } });
  assert.strictEqual(draft.deposition_lb_hr, 4);
  assert.strictEqual(draft.operating_factor, null, 'a percent typed as 30 is dropped, not read as 3000%');
  assert.deepStrictEqual(weldSettings('', {}), {});
});
