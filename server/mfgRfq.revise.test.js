// =============================================================================
//  mfgRfq.revise.test.js — revising a quote must re-send its fittings.
// -----------------------------------------------------------------------------
//  2026-11-06: MMQ-100477 (Rev 0) sent a 1-1/2" SCH 40 elbow, qty 50. Its Zoho Revise,
//  MMQ-100478, carried all 14 structural lines and NO fitting, and the elbow was never re-sent.
//  The off-Zoho /mfg-rfq Revise rebuilds both line sets from the project every time.
//  Shapes below are the real API records. Run: node --test server/mfgRfq.revise.test.js
// =============================================================================
const test = require('node:test');
const assert = require('node:assert');
const { revisionPlan, fittingRow } = require('./mfgRfq');

const q100477 = {
  ID: '4111484000006370034', Reference_Number: 'MMQ-100477', Status: 'Quote Revised', Revision_Number: '0',
  Original_Quote_Revised: { ID: '4111484000006370034' },
  Quote_Description: 'Amrize – Midlothian – Texas – Lone Star Expansion – Handrails ',
};
const q100478 = {
  ID: '4111484000006370103', Reference_Number: 'MMQ-100478', Status: 'Submitted - Waiting Responses', Revision_Number: '1',
  Original_Quote_Revised: { ID: '4111484000006370034' },
  Quote_Description: 'Rev # 1 - Amrize – Midlothian – Texas – Lone Star Expansion – Handrails ',
};

test('the next revision of 100478 is Rev 2 of the 100477 chain', () => {
  const p = revisionPlan(q100478, [q100477, q100478]);
  assert.strictEqual(p.number, 2);
  assert.strictEqual(p.root_id, q100477.ID);
  assert.strictEqual(p.replaces_id, q100478.ID);
  assert.strictEqual(p.reference, 'MMQ-100477');
  assert.strictEqual(p.base_description, 'Amrize – Midlothian – Texas – Lone Star Expansion – Handrails');
  assert.strictEqual(p.allowed, true);
});

test('a first quote revises to Rev 1 of itself', () => {
  const first = { ...q100477, Status: 'Submitted - Waiting Responses' };
  const p = revisionPlan(first, [first]);
  assert.strictEqual(p.number, 1);
  assert.strictEqual(p.root_id, first.ID);
});

test('an older quote with no Original_Quote_Revised still chains to itself', () => {
  const old = { ID: '1', Reference_Number: 'MMQ-10003', Status: 'Open - Not Submitted', Revision_Number: '' };
  const p = revisionPlan(old, [old]);
  assert.strictEqual(p.root_id, '1');
  assert.strictEqual(p.number, 1);
});

test('closed and cancelled quotes cannot be revised', () => {
  for (const s of ['Closed - Completed', 'Closed - Allocation Process', 'Cancelled', 'Purchase Order Pending']) {
    assert.strictEqual(revisionPlan({ ...q100478, Status: s }, [q100477, q100478]).allowed, false, s);
  }
});

test('the project elbow becomes a fitting line on the quote', () => {
  // Project_Allocate_Quote_Form 4111484000006353006, as the API returns it.
  const elbow = {
    ID: '4111484000006353006', Line_Item_Fitting: '1', Quantity: '50', Total_Weight: '37.55',
    Fitting_Type: { ID: '4111484000000655007', zc_display_value: 'Elbow' },
    Fitting_Make: { ID: '4111484000000655111', zc_display_value: 'Wrought - Carbon Steel' },
    Fitting_Specification: { ID: '4111484000000657119', zc_display_value: 'WPB | ASTM A234' },
    End_Type: { ID: '4111484000000655319', zc_display_value: 'Butt Weld' },
    Connection_Type: { ID: '4111484000000655179', zc_display_value: '180° (Long Radius)' },
    Fitting_Description_Text: '1-1/2" | SCH 40 (.145")',
  };
  const row = fittingRow(elbow, 1, { projectId: '4111484000006294010' });
  assert.strictEqual(row.Project_Allocate_Quote_Form, elbow.ID);
  assert.strictEqual(row.Quantity, '50');
  assert.strictEqual(row.Fitting_Type, '4111484000000655007');
  assert.strictEqual(row.Fitting_Make, '4111484000000655111');
  assert.strictEqual(row.Fitting_Specification, '4111484000000657119');
  assert.strictEqual(row.Fitting_Description_Text, '1-1/2" | SCH 40 (.145")');
  assert.strictEqual(row.Line_Item_Fitting, 1);
});
