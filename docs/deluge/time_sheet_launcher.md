# Time Sheet launcher (Zoho) — 2026-11-16

The time sheet is a Railway page: `/takeoff/time.html` (server/labor/timeEntry.js). It writes
Work_Order_Actual_Labor_Details_Form rows and rebuilds the WO's Actual Labor Totals record.

## Function: `OpenTimeSheet` (Workflow › Functions, Default namespace)

```
string OpenTimeSheet(int Manufacture_ID, string WO_ID)
{
	mfg = Manufacture_ID.toString();
	url = "https://material-compass-nesting-app-production.up.railway.app/takeoff/time.html?manufacturer_id=" + mfg;
	if(WO_ID != null && WO_ID != "")
	{
		url = url + "&wo=" + WO_ID;
	}
	tok = thisapp.utility.mcToken(mfg);
	if(tok != null && tok != "")
	{
		url = url + "&t=" + tok;
	}
	openUrl(url,"new window");
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
