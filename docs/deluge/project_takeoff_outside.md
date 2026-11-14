# AI take-off outside costs → project page

Form: **MCP_Customer_Project_Form**, tab **MISC ITEM SOURCING** (the `Tabs` choice) (the Item Sourcing Take-Off subform `Outsource_Details`).
Server: `GET /api/takeoff/project-outside/<project ID>` (server/takeoff/projectOutside.js).

## Fields to add (form builder, in the MISC ITEM SOURCING section)

| Field type | Label | Link name | Where |
|---|---|---|---|
| Decision box | Load AI take-off outside costs | `Load_Takeoff_Outside` | ABOVE the Item Sourcing Take-Off subform |
| Add Notes | (leave blank) | `Note_Takeoff_Outside` | directly BELOW the Item Sourcing Take-Off subform |

## Block 1 — Load v4 (2026-11-14: one row per component, split by weight). Workflow "Load Take-off Outside Rows": NEW PROJECT SUBMITTAL › User input of `Load_Takeoff_Outside` (Created or Edited)

Replaces v1/v2. Each take-off line now carries an Item Type **code** (server/takeoff/public/outside-types.js =
the Zoho table *Project Items and Subcontracting Types*). The row gets that **Item Type** and its **Category of Item**
(the bucket), so it lands in the right Outsource Total. Totals are recounted here because rows added by script do
not fire the Outsource Recount workflows (docs/deluge/project_outsource_totals.md — same bucket → field map).

```
// ==== Load the AI take-off's outside costs into Item Sourcing Take-Off (v4: Item Type by code, one row per component) ====
if(input.Load_Takeoff_Outside == true)
{
	input.Load_Takeoff_Outside = false;
	if(input.ID == null)
	{
		alert "Save the project first, then load the AI take-off outside costs.";
	}
	else
	{
		already = 0;
		for each r in input.Outsource_Details
		{
			if(ifnull(r.Comments,"").startsWith("AI take-off estimate"))
			{
				already = already + 1;
			}
		}
		if(already > 0)
		{
			alert "The AI take-off outside costs are already loaded (" + already + " rows). Delete those rows first to load them again.";
		}
		else
		{
			resp = invokeurl
			[
				url :"https://material-compass-nesting-app-production.up.railway.app/api/takeoff/project-outside/" + input.ID
				type :GET
			];
			respMap = ifnull(resp,"").toString().toMap();
			lines = respMap.get("lines");
			if(lines == null || lines.size() == 0)
			{
				alert "No outside costs are marked Include on this project's AI take-off yet. Answer them on the take-off Summary tab first.";
			}
			else
			{
				// Item Types by Code
				typeId = Map();
				typeCat = Map();
				for each t in Project_Items_and_Subcontracting_Types[ID != 0]
				{
					if(ifnull(t.Code,"") != "")
					{
						typeId.put(t.Code,t.ID);
						typeCat.put(t.Code,ifnull(t.Category_of_Item,"Miscellaneous"));
					}
				}
				// this project's components, by name (the Component lookup is filtered to Project_LU == the row's project)
				compId = Map();
				for each pc in Project_Components_Form[Project_LU == input.ID]
				{
					compId.put(ifnull(pc.Project_Component,"").trim().toLowerCase(),pc.ID);
				}
				// the new rows - one per component the line applies to - and their money by bucket
				rows = Collection();
				cat = Map();
				grand = 0;
				for each ln in lines
				{
					code = ifnull(ln.get("code"),"other").toString();
					if(!typeId.containKey(code))
					{
						code = "other";
					}
					b = "Miscellaneous";
					if(typeId.containKey(code))
					{
						b = typeCat.get(code);
					}
					// its shares per component (from the take-off); none = one row, no component
					pl = List();
					rawParts = ln.get("parts");
					if(rawParts != null)
					{
						for each p0 in rawParts
						{
							pl.add(p0);
						}
					}
					if(pl.size() == 0)
					{
						one = Map();
						one.put("component","");
						one.put("pct",100);
						one.put("qty",ln.get("qty"));
						one.put("unit_amt",ln.get("unit_amt"));
						one.put("total",ln.get("total"));
						pl.add(one);
					}
					// shared-cost note on every row of a line split across components (field Allocation_Note)
					allocTxt = "";
					if(pl.size() > 1)
					{
						lt = ifnull(ln.get("total"),"").toString();
						ltTxt = "";
						if(lt != "" && lt != "null")
						{
							ltTxt = " $" + utility.format_currency(lt.toDecimal());
						}
						allocTxt = "Shared cost:" + ltTxt + " " + ifnull(ln.get("description"),"").toString() + ", split by " + ifnull(ln.get("split_basis"),"weight").toString() + ":";
						for each pa in pl
						{
							pt = ifnull(pa.get("total"),"").toString();
							ptTxt = "";
							if(pt != "" && pt != "null")
							{
								ptTxt = " = $" + utility.format_currency(pt.toDecimal());
							}
							allocTxt = allocTxt + "\n" + ifnull(pa.get("component"),"").toString() + " " + ifnull(pa.get("pct"),"").toString() + "%" + ptTxt;
						}
					}
					for each p in pl
					{
						row = MCP_Customer_Project_Form.Outsource_Details();
						row.MCP_Customer_Project_Form = input.ID;
						row.Customer_Entry_Form = input.MANUFACTURE;
						if(typeId.containKey(code))
						{
							row.Item_Type = typeId.get(code);
						}
						row.Category_of_Item = b;
						cn = ifnull(p.get("component"),"").toString().trim();
						note = "";
						if(cn != "")
						{
							if(compId.containKey(cn.toLowerCase()))
							{
								row.Component = compId.get(cn.toLowerCase());
							}
							else
							{
								note = " - component " + cn + " not found on this project, pick it";
							}
						}
						d = ifnull(ln.get("description"),"").toString();
						if(pl.size() > 1)
						{
							d = d + " - " + ifnull(p.get("pct"),"").toString() + "% share";
						}
						row.Description = d;
						row.Allocation_Note = allocTxt;
						row.Date_field = zoho.currentdate;
						q = ifnull(p.get("qty"),"").toString();
						if(q != "" && q != "null")
						{
							row.QTY = q.toDecimal().round(0).toLong();
						}
						u = ifnull(p.get("unit_amt"),"").toString();
						if(u != "" && u != "null")
						{
							row.Unit_Amt = u.toDecimal();
						}
						amt = 0;
						tt = ifnull(p.get("total"),"").toString();
						if(tt != "" && tt != "null")
						{
							amt = tt.toDecimal();
							row.Total_Amount = amt;
						}
						row.Comments = "AI take-off estimate - confirm supplier and price (" + ifnull(ln.get("unit"),"").toString() + ")" + note;
						rows.insert(row);
						cat.put(b,ifnull(cat.get(b),0) + amt);
						grand = grand + amt;
					}
				}
				// plus the rows already on the project (by their Item Type, else their text)
				buckets = {"Cutting","Decking","Engineering & Detailing","Fasteners & Hardware","Fittings & Valves","Forming & Rolling","Freight","Galvanize","Grating","Heat Treat","Inspection & Testing","Installation & Rigging","Machining","Miscellaneous","Outside Welding & Fab","Paint & Coatings"};
				bucketOf = Map();
				for each t2 in Project_Items_and_Subcontracting_Types[ID != 0]
				{
					bucketOf.put(t2.ID.toString(),ifnull(t2.Category_of_Item,"Miscellaneous"));
				}
				for each r in input.Outsource_Details
				{
					amt = ifnull(r.Total_Amount,0);
					if(amt != 0)
					{
						b = "";
						if(r.Item_Type != null)
						{
							b = ifnull(bucketOf.get(r.Item_Type.toString()),"");
						}
						if(b == "")
						{
							b = ifnull(r.Category_of_Item,"").trim();
						}
						if(!buckets.contains(b))
						{
							b = "Miscellaneous";
						}
						cat.put(b,ifnull(cat.get(b),0) + amt);
						grand = grand + amt;
					}
				}
				input.Outsource_Details.insert(rows);
				input.Outsource_Blast_Paint = ifnull(cat.get("Paint & Coatings"),0);
				input.Outsource_Cutting = ifnull(cat.get("Cutting"),0);
				input.Outsource_Decking = ifnull(cat.get("Decking"),0);
				input.Outsource_Detailing = ifnull(cat.get("Engineering & Detailing"),0);
				input.Outsource_Fasteners = ifnull(cat.get("Fasteners & Hardware"),0);
				input.Outsource_Fittings = ifnull(cat.get("Fittings & Valves"),0);
				input.Outsource_Forming_Rolling = ifnull(cat.get("Forming & Rolling"),0);
				input.Outsource_Galvanize = ifnull(cat.get("Galvanize"),0);
				input.Outsource_Grating = ifnull(cat.get("Grating"),0);
				input.Outsource_Heat_Treat = ifnull(cat.get("Heat Treat"),0);
				input.Outsource_Inspection = ifnull(cat.get("Inspection & Testing"),0);
				input.Outsource_Installation = ifnull(cat.get("Installation & Rigging"),0);
				input.Outsource_Machining = ifnull(cat.get("Machining"),0);
				input.Outsource_Misc = ifnull(cat.get("Miscellaneous"),0);
				input.Outsource_Outside_Welding_Fab = ifnull(cat.get("Outside Welding & Fab"),0);
				input.Outsource_Trucking = ifnull(cat.get("Freight"),0);
				input.Outsource_Total_Amount = grand;
				// the project's totals row - created if the project has none
				foundTot = false;
				for each otr in input.Outsource_Totals
				{
					if(otr.Project_Number_ID == input.ID)
					{
						foundTot = true;
						otr.Blast_Paint = ifnull(cat.get("Paint & Coatings"),0);
						otr.Cutting = ifnull(cat.get("Cutting"),0);
						otr.Decking = ifnull(cat.get("Decking"),0);
						otr.Detailing = ifnull(cat.get("Engineering & Detailing"),0);
						otr.Fasteners = ifnull(cat.get("Fasteners & Hardware"),0);
						otr.Fittings = ifnull(cat.get("Fittings & Valves"),0);
						otr.Forming_Rolling = ifnull(cat.get("Forming & Rolling"),0);
						otr.Galvanize = ifnull(cat.get("Galvanize"),0);
						otr.Grating = ifnull(cat.get("Grating"),0);
						otr.Heat_Treat = ifnull(cat.get("Heat Treat"),0);
						otr.Inspection = ifnull(cat.get("Inspection & Testing"),0);
						otr.Installation = ifnull(cat.get("Installation & Rigging"),0);
						otr.Machining = ifnull(cat.get("Machining"),0);
						otr.Other = ifnull(cat.get("Miscellaneous"),0);
						otr.Outside_Welding_Fab = ifnull(cat.get("Outside Welding & Fab"),0);
						otr.Trucking = ifnull(cat.get("Freight"),0);
						otr.Total_Amount = grand;
					}
				}
				if(foundTot == false)
				{
					nr = MCP_Customer_Project_Form.Outsource_Totals();
					nr.Project_Number_ID = input.ID;
					nr.Blast_Paint = ifnull(cat.get("Paint & Coatings"),0);
					nr.Cutting = ifnull(cat.get("Cutting"),0);
					nr.Decking = ifnull(cat.get("Decking"),0);
					nr.Detailing = ifnull(cat.get("Engineering & Detailing"),0);
					nr.Fasteners = ifnull(cat.get("Fasteners & Hardware"),0);
					nr.Fittings = ifnull(cat.get("Fittings & Valves"),0);
					nr.Forming_Rolling = ifnull(cat.get("Forming & Rolling"),0);
					nr.Galvanize = ifnull(cat.get("Galvanize"),0);
					nr.Grating = ifnull(cat.get("Grating"),0);
					nr.Heat_Treat = ifnull(cat.get("Heat Treat"),0);
					nr.Inspection = ifnull(cat.get("Inspection & Testing"),0);
					nr.Installation = ifnull(cat.get("Installation & Rigging"),0);
					nr.Machining = ifnull(cat.get("Machining"),0);
					nr.Other = ifnull(cat.get("Miscellaneous"),0);
					nr.Outside_Welding_Fab = ifnull(cat.get("Outside Welding & Fab"),0);
					nr.Trucking = ifnull(cat.get("Freight"),0);
					nr.Total_Amount = grand;
					input.Outsource_Totals.insert(nr);
				}
				input.Item_Sourcing_Amount = grand;
				input.Total_Sourcing_Amount = grand;
				input.TOTAL_PROJECT_AMOUNT = ifnull(input.Project_Material_Amount,0) + ifnull(input.Total_Labor_Amount,0) + grand;
			}
		}
	}
}
```

## Block 2 — NEW workflow "Load Take-off Outside Costs": MCP_Customer_Project_Form › Load of the form › Edited (its own workflow; leave Load Tabs and Fields alone)

Working on MCP-10013 2026-11-13. Builds the table in `Note_Takeoff_Outside` (under the Item Sourcing Take-Off subform) every time the project opens in Edit.

```
// ---- AI take-off outside costs, as a table under Item Sourcing Take-Off -> Note_Takeoff_Outside ----
showTo = false;
if(input.ID != null)
{
	toResp = invokeurl
	[
		url :"https://material-compass-nesting-app-production.up.railway.app/api/takeoff/project-outside/" + input.ID
		type :GET
	];
	toMap = ifnull(toResp,"").toString().toMap();
	toLines = toMap.get("lines");
	if(toLines != null && toLines.size() > 0)
	{
		showTo = true;
		// take-off total per category (two lines can share one, e.g. Miscellaneous)
		tkAmt = Map();
		for each ln in toLines
		{
			c = ifnull(ln.get("category"),"Miscellaneous").toString();
			t = ifnull(ln.get("total"),"").toString();
			tv = 0;
			if(t != "" && t != "null")
			{
				tv = t.toDecimal();
			}
			tkAmt.put(c,ifnull(tkAmt.get(c),0) + tv);
		}
		// this project's rows per category
		pjAmt = Map();
		openEst = 0;
		for each r in input.Outsource_Details
		{
			c = ifnull(r.Category_of_Item,"").toString();
			pjAmt.put(c,ifnull(pjAmt.get(c),0) + ifnull(r.Total_Amount,0));
			if(ifnull(r.Comments,"").startsWith("AI take-off estimate") && r.Subcontractor_Supplier == null)
			{
				openEst = openEst + 1;
			}
		}
		th = "padding:5px 10px;border-bottom:2px solid #c9d8ea;font-size:11px;color:#5a6b7d;text-transform:uppercase";
		td = "padding:5px 10px;border-bottom:1px solid #e6edf5";
		h = "<div style='border:1px solid #c9d8ea;border-radius:8px;padding:10px 12px;background:#f6f9fd;font-size:13px;margin-top:6px'>";
		h = h + "<b>AI take-off outside costs</b> <span style='color:#5a6b7d'>- at cost, from the approved take-off</span>";
		h = h + "<table style='border-collapse:collapse;margin-top:6px;font-size:13px;width:100%;background:#ffffff'>";
		h = h + "<tr><th align='left' style='" + th + "'>Category of Item</th><th align='left' style='" + th + "'>Description</th><th align='right' style='" + th + "'>Qty</th><th align='right' style='" + th + "'>Unit Amount</th><th align='right' style='" + th + "'>Total Amt</th><th align='left' style='" + th + "'>On this project</th></tr>";
		tkTot = 0;
		missing = 0;
		shown = List();
		for each ln in toLines
		{
			c = ifnull(ln.get("category"),"Miscellaneous").toString();
			d = ifnull(ln.get("description"),"").toString();
			un = ifnull(ln.get("unit"),"").toString();
			q = ifnull(ln.get("qty"),"").toString();
			u = ifnull(ln.get("unit_amt"),"").toString();
			t = ifnull(ln.get("total"),"").toString();
			qTxt = "-";
			if(q != "" && q != "null")
			{
				qTxt = q + " " + un;
			}
			uTxt = "-";
			if(u != "" && u != "null")
			{
				if(u.toDecimal() < 1)
				{
					uTxt = "$" + u;
				}
				else
				{
					uTxt = "$" + utility.format_currency(u.toDecimal());
				}
			}
			tTxt = "<span style='color:#b26a00'>no amount</span>";
			if(t != "" && t != "null")
			{
				tTxt = "$" + utility.format_currency(t.toDecimal());
				tkTot = tkTot + t.toDecimal();
			}
			// status once per category (on its first line)
			st = "";
			if(!shown.contains(c))
			{
				shown.add(c);
				tk = tkAmt.get(c).toDecimal();
				pj = ifnull(pjAmt.get(c),0).toDecimal();
				diff = pj - tk;
				if(pj == 0)
				{
					st = "<span style='color:#b26a00'><b>not entered</b></span>";
					missing = missing + 1;
				}
				else if(diff < 1 && diff > -1)
				{
					st = "<span style='color:#2e7d32'>matches - $" + utility.format_currency(pj) + "</span>";
				}
				else
				{
					st = "<span style='color:#555555'>$" + utility.format_currency(pj) + " on project</span>";
				}
			}
			h = h + "<tr><td style='" + td + "'><b>" + c + "</b></td><td style='" + td + "'>" + d + "</td><td align='right' style='" + td + "'>" + qTxt + "</td><td align='right' style='" + td + "'>" + uTxt + "</td><td align='right' style='" + td + "'>" + tTxt + "</td><td style='" + td + "'>" + st + "</td></tr>";
		}
		h = h + "<tr><td colspan='4' style='padding:6px 10px'><b>Total outside, at cost</b></td><td align='right' style='padding:6px 10px'><b>$" + utility.format_currency(tkTot) + "</b></td><td></td></tr>";
		h = h + "</table>";
		if(missing > 0)
		{
			h = h + "<div style='color:#b26a00;margin-top:6px'><b>" + missing + " categor" + if(missing == 1,"y","ies") + " not on this project yet.</b> Tick <b>Load Takeoff Outside</b> above to add them, then save.</div>";
		}
		if(openEst > 0)
		{
			h = h + "<div style='margin-top:4px'>" + openEst + " row(s) above are still AI take-off estimates with no supplier - confirm the supplier and price before submitting.</div>";
		}
		h = h + "</div>";
		input.Note_Takeoff_Outside = h;
	}
}
if(showTo)
{
	show Note_Takeoff_Outside;
}
else
{
	hide Note_Takeoff_Outside;
}
```

## Block 3 — your existing tab-switch workflow: MCP_Customer_Project_Form › User input of `Tabs`

Add the two new fields to the show/hide lists, so they appear on MISC ITEM SOURCING only.

Inside the branch for **MISC ITEM SOURCING**:

```
show Load_Takeoff_Outside;
if(ifnull(input.Note_Takeoff_Outside,"") != "")
{
	show Note_Takeoff_Outside;
}
```

Inside **every other** tab branch (or once before the branches, if the workflow hides everything first):

```
hide Load_Takeoff_Outside;
hide Note_Takeoff_Outside;
```
