# Time Sheet launcher (Zoho) — 2026-11-16

The time sheet is a Railway page: `/takeoff/time.html` (server/labor/timeEntry.js). It writes
Work_Order_Actual_Labor_Details_Form rows and rebuilds the WO's Actual Labor Totals record.

## Page: `Time_Sheet` (2026-11-27 — opens INSIDE the portal, not a new window)

Hidden page, one HTML snippet. Params `manufacturer_id`, `wo` (shop falls back to the login's shop).
Mints the token with `thisapp.utility.mcToken(v_mfg)` and iframes
`/takeoff/time.html?manufacturer_id=…&wo=…&t=…` (height calc(100vh - 110px)).

## Function: `OpenTimeSheet` (Workflow › Functions, Default namespace)

```
string OpenTimeSheet(int Manufacture_ID, string WO_ID)
{
	url = "#Page:Time_Sheet?manufacturer_id=" + Manufacture_ID.toString();
	if(WO_ID != null && WO_ID != "")
	{
		url = url + "&wo=" + WO_ID;
	}
	openUrl(url,"same window");
	return url;
}
```

## Work Order form (Job_Form): button

Radio field with one choice "Time Sheet", the same pattern as `Supplier_Button` on the project.
Workflow: Job_Form › Created or Edited › User input of that field:

```
thisapp.OpenTimeSheet(input.Manufacture_ID.toLong(), input.ID.toString());
<Field_Link_Name>.deselect(input.<Field_Link_Name>);
```

`Manufacture_ID` is the WO's own shop number field (seen in API_Work_Orders). On a WO that has not been
saved yet, `input.ID` is empty; the sheet then opens on all work.

## Shop-wide (no WO)

Anywhere with the shop id, call `thisapp.OpenTimeSheet(<shop id>, "");`.
