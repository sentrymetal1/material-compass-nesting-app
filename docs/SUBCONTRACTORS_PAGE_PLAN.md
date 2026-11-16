# Subcontractors page (off-Zoho) — plan, 2026-11-15

Mark approved points 1–6 on 2026-11-15. Subcontractors are **per shop**: each manufacturer keeps its own list.
Phase 1 is a Railway page that edits the existing Zoho records. Later, the data moves off Zoho.

## Zoho today (field link names)

**Subcontractor_and_Item_Suppliers_Form**

| Field | Link name | Notes |
|---|---|---|
| Manufacture | `Manufacture` | Lookup to Customer Entry Form. Filter: `ID == thisapp.GetCustomerID_Int()`. Not mandatory. |
| Add Supplier | `Add_Supplier` | Radio, one choice "Add New Supplier". UI only. |
| Supplier | `Supplier` | Single line, mandatory. This is the company name. |
| (notes block) | `Supplier_CSS` | CSS injection. |
| Project Items and Subcontracting Types | `Project_Items_and_Subcontracting_Types` | Single lookup, mandatory. **Retire.** |
| Type Of Outsource | `Type_Of_Outsource` | Old 10-choice radio, mandatory. **Retire.** |
| Address | `Address` | Geo coordinates on. |
| Representative List | `Representative_List` | Subform built on the reps child form. |

**Subcontractors_and_Item_Representatives** (reps child form)

| Field | Link name |
|---|---|
| Parent lookup | `Subcontractor_and_Item_Suppliers_Form` |
| Supplier Representative (Name) | `Supplier_Representative` (First_Name / Last_Name) |
| Phone Number | `Phone_Number1` |
| Cell Number | `Cell_Number` |
| Email | `Email` |

**Project_Outsource_Details_Form** (the MISC ITEM SOURCING row)

| Field | Link name | Filter today |
|---|---|---|
| Subcontractor / Supplier | `Subcontractor_Supplier` | `Project_Items_and_Subcontracting_Types.ID == input.Item_Type`. **Not filtered by shop: leaks across tenants.** |
| Representative | `Representative1` | `Subcontractor_and_Item_Suppliers_Form.ID == input.Subcontractor_Supplier` |

## Zoho changes (Mark)

1. Subcontractor form, new fields:
   - `Item_Types`: Lookup to Project_Items_and_Subcontracting_Types. Display "Item Type", type Multi Select.
   - `Active`: Decision box, initial value checked.
   - `Preferred`: Decision box.
   - `Company_Phone` (Phone), `Company_Email` (Email), `Website` (URL), `Notes` (Multi line).
2. Untick Mandatory on `Project_Items_and_Subcontracting_Types` and `Type_Of_Outsource`. Delete them after the page is live.
3. Tick Mandatory on `Manufacture`.
4. Reps child form, new field `Primary_Contact`: Decision box.
5. Two unfiltered API reports showing all columns, because report filters hide API rows and the API returns only the configured columns:
   - `API_Subcontractors` on the subcontractor form;
   - `API_Subcontractor_Reps` on the reps form.
6. Project row `Subcontractor_Supplier` filter becomes Item Type in `Item_Types`, plus `Manufacture == input.Customer_Entry_Form`, plus `Active == true`. The exact criteria syntax for a multi-select lookup is tested through the API before Mark pastes it.

## One-time data step — DONE 2026-11-15

18 records: Item_Types = old single type, Active = true. Orphan rep Dan Mancuso (4111484000003617003) deleted. Backup in session scratchpad subcontractors_backup_2026-11-15.json.
REST criteria `Item_Types == <id>` matches membership (tested).

**Project row filter — LIVE and tested 2026-11-15** (set on Project_Outsource_Details_Form › Subcontractor_Supplier; the builder cannot pick a multi-select as a whole, so it matches the ID sub-field):
`(Item_Types.ID == input.Item_Type) && (Manufacture.ID == thisapp.GetCustomerID_Int()) && (Active == true)`
The old filter (`Project_Items_and_Subcontracting_Types.ID == input.Item_Type`) was still there at first, so new types picked on the page never showed.

**Launcher — LIVE:** function `OpenSubcontractors(int Manufacture_ID)` (Default namespace). NEW PROJECT SUBMITTAL › Created or Edited › User input of Supplier Button (`Supplier_Button` radio, choice "Manage Subcontractors"): `thisapp.OpenSubcontractors(input.MANUFACTURE.toLong()); Supplier_Button.deselect(input.Supplier_Button);`. Old page Subcontract_and_Misc_Suppliers_Page no longer called; delete later.

### Original note

Copy each record's old single `Project_Items_and_Subcontracting_Types` into `Item_Types`. Set `Active` to true.

## Railway page `/subcontractors` (server/subcontractors.js + takeoff/public/subcontractors.html)

- Opened from Zoho with `?t=<mcToken>`. The shop comes from the token, never from the URL. Every read and write is scoped to `Manufacture == shop`.
- **List:**
  - search;
  - an Item Type filter (the 37 types grouped by bucket, from outside-types.js);
  - an Active / All toggle;
  - Preferred listed first.
- **Row:**
  - company, types (as chips), phone, email, distance from the shop (from Address coordinates);
  - price history: last and average unit price per Item Type, from Project_Outsource_Details_Form rows where `Subcontractor_Supplier` is this record. Shows the unit and the last project.
- **Edit inline:**
  - name, types (multi-pick), Active, Preferred, contact fields, address, notes;
  - reps: add, edit and remove, with one Primary.
- **Duplicate check:** same name within the shop, ignoring case and spaces.
- **Delete:** allowed only when the subcontractor is on no project rows. Otherwise the action is Deactivate.
- No vendor names anywhere in the UI.

## Later

- The project row dropdown is served from Railway (Preferred first, with last price shown).
- Data moves off Zoho. Zoho keeps only the finished totals.
- Retire `Type_Of_Outsource` and the row-level `Outsource_Type` radio.
