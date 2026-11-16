# Actual labor tracking per project — plan, 2026-11-16 (DRAFT, awaiting Mark)

**Goal:** record the real hours worked on each work order, by employee, day, component and labor type. The WO labor card then shows **quoted (+ approved COs) vs actual** for each bucket. This closes the dry run's last loop: estimate → quote → WO → what the job really took.

## What already exists

- **`Employee` form** (Phase 0, 2026-09-02): `Customer_Entry_Form` (shop), `Employee_Name`, `Employee_Number`, `Job_Function` (multi-select), `Hourly_Rate`, `Status`, `Hire_Date`, `Email`. Report `All_Employees` is **empty**.
- **`Work_Order_Actual_Labor_Details_Form`**:
  - links to the WO: `Job_Form`, `Work_Order_ID`, `Work_Order_Components_Form`, `Work_Order_Component_ID`;
  - 8 buckets `Cutting/CNC/Assy/Fab/Weld/Labor/Inspection/Misc` × `_Hrs/_Rate/_Amt`;
  - `Total_Hours`, `Total_Amount`, `Labor_Type`, `Type_Of_Entry`, `Comments`, plus `Employee` (lookup) and `Work_Date` (added in Phase 0).
  - 12 rows today, all hand-entered lump sums.
  - Its report `Work_Order_Actual_Labor_Details_Form_Report` does **not** return Employee / Work_Date (configured columns only).
- **WO labor card** (`Labor_Read_Only`) already sums quoted vs actual per component, with CO hours.

**Agreed rules (2026-09 / 10-14):**
- one row = one employee × one date × one component × one labor type;
- the type fills its matching bucket column;
- no separate time-entry form;
- non-job time (vacation, holiday, shop/office mgmt) must have its own codes so it never lands on a job.

## Build

### Step 1 — Time entry page (office / supervisor), Railway `/takeoff/time.html`

Opened from the Work Order, and from a shop-wide button.

- **Week grid:** rows are employee × WO × component × labor type, columns are Mon–Sun, cells are hours.
  - Tab and Enter move between cells.
  - Copy last week's rows.
  - The day total shows per employee, with a warning over 12 h/day; the week total warns over 40 (OT shown, not calculated).
- The pickers show only **open WOs for this shop** → their components → the shop's labor types (detail list from `laborTypes.js`, rolled up to the 8 buckets).
- **Save** writes one Actual Labor row per non-empty cell:
  - the hours go into the bucket column;
  - `_Rate` comes from the WO's own rate fields;
  - `_Amt` and the totals are written, because an API insert runs no Deluge.
- **Edits update the same row; deleted cells delete their row.** Nothing is duplicated.
- **Roster:** add, edit and deactivate employees on the same page (name, number, functions, active). This is the `Employee` form.
- **Non-job codes** (Vacation / Holiday / Shop mgmt / Office mgmt / Training) are kept in a Railway store for the payroll export. They are never written to a WO.

### Step 2 — Quoted vs actual on the WO

- Check that the WO labor card picks up the new rows. It sums by component, so it should.
- Add a per-bucket variance line: quoted + CO vs actual, both hours and $.
- Report: actual hours per job by bucket, per week.

### Step 3 — Shop-floor kiosk (later)

A wall tablet with a per-employee PIN, clock in/out, and allocation at day end, writing the same rows. Supervisor approval locks the week.

### Step 4 — Payroll export (later)

CSV per pay period: employee, regular / OT hours, non-job codes.

## Zoho changes (Mark)

1. A new report **`API_Actual_Labor`** on Work_Order_Actual_Labor_Details_Form: unfiltered, **all columns** (including Employee, Work_Date, Labor_Type, Type_Of_Entry).
2. A new report **`API_Employees`** on Employee: unfiltered, all columns.
3. A screenshot of the `Labor_Type` choices on the Actual Labor form, and of `Type_Of_Entry`'s choices.
4. The WO report the page reads open WOs from (Job_Form): its name, plus the status field and its "open" values.

## Open questions

- Is a component required on every entry, or may hours go to "whole job" and be spread by quoted hours (the same rule as the take-off's `spreadJobHours`)?
- Who enters time in step 1: you or a foreman, weekly from paper / timecards?
