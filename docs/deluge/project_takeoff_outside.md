# AI take-off outside costs → project page

Form: **MCP_Customer_Project_Form**, tab **Subcontract and Item Details** (the Item Sourcing Take-Off subform `Outsource_Details`).
Server: `GET /api/takeoff/project-outside/<project ID>` (server/takeoff/projectOutside.js).

## Fields to add (form builder, same tab, above the subform)

| Field type | Label | Link name |
|---|---|---|
| Decision box | Load AI take-off outside costs | `Load_Takeoff_Outside` |
| Add Notes | (leave blank) | `Note_Takeoff_Outside` |

## Block 1 — Workflow: MCP_Customer_Project_Form › User input of `Load_Takeoff_Outside` (Created or Edited)

```
// Load the AI take-off's outside costs into Item Sourcing Take-Off, supplier left blank.
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
			respMap = resp.toString().toMap();
			lines = respMap.get("lines");
			if(lines == null || lines.size() == 0)
			{
				alert "No outside costs are marked Include on this project's AI take-off yet. Answer them on the take-off Summary tab first.";
			}
			else
			{
				rows = Collection();
				for each ln in lines
				{
					row = MCP_Customer_Project_Form.Outsource_Details();
					row.Category_of_Item = ifnull(ln.get("category"),"Miscellaneous").toString();
					row.Description = ifnull(ln.get("description"),"").toString();
					row.Date_field = zoho.currentdate;
					row.Customer_Entry_Form = input.MANUFACTURE;
					q = ifnull(ln.get("qty"),"").toString();
					if(q != "" && q != "null")
					{
						row.QTY = q.toDecimal().round(0).toLong();
					}
					u = ifnull(ln.get("unit_amt"),"").toString();
					if(u != "" && u != "null")
					{
						row.Unit_Amt = u.toDecimal();
					}
					t = ifnull(ln.get("total"),"").toString();
					if(t != "" && t != "null")
					{
						row.Total_Amount = t.toDecimal();
					}
					row.Comments = "AI take-off estimate - confirm supplier and price (" + ifnull(ln.get("unit"),"").toString() + ")";
					rows.insert(row);
				}
				input.Outsource_Details.insert(rows);
			}
		}
	}
}
```

## Block 2 — Workflow: MCP_Customer_Project_Form › Load of the form (Edit) — add at the END of the existing OnLoad

```
// ---- AI take-off outside costs vs this project -> Note_Takeoff_Outside ----
showTo = false;
if(input.ID != null)
{
	toResp = invokeurl
	[
		url :"https://material-compass-nesting-app-production.up.railway.app/api/takeoff/project-outside/" + input.ID
		type :GET
	];
	toMap = toResp.toString().toMap();
	toLines = toMap.get("lines");
	if(toLines != null && toLines.size() > 0)
	{
		showTo = true;
		tkAmt = Map();
		tkOrder = List();
		for each ln in toLines
		{
			c = ifnull(ln.get("category"),"Miscellaneous").toString();
			if(!tkOrder.contains(c))
			{
				tkOrder.add(c);
				tkAmt.put(c,0);
			}
			t = ifnull(ln.get("total"),"").toString();
			if(t != "" && t != "null")
			{
				tkAmt.put(c,tkAmt.get(c) + t.toDecimal());
			}
		}
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
		missing = 0;
		h = "<div style='border:1px solid #c9d8ea;border-radius:8px;padding:10px 12px;background:#f6f9fd;font-size:13px'>";
		h = h + "<b>AI take-off outside costs vs this project</b>";
		h = h + "<table style='border-collapse:collapse;margin-top:6px;font-size:13px'>";
		h = h + "<tr><th align='left' style='padding:3px 14px 3px 0'>Category</th><th align='right' style='padding:3px 14px'>AI take-off</th><th align='right' style='padding:3px 14px'>On this project</th><th></th></tr>";
		for each c in tkOrder
		{
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
				st = "<span style='color:#2e7d32'>matches</span>";
			}
			else
			{
				st = "<span style='color:#555555'>changed from the take-off</span>";
			}
			tkTxt = if(tk == 0,"no amount yet",utility.format_currency(tk));
			h = h + "<tr><td style='padding:3px 14px 3px 0'>" + c + "</td><td align='right' style='padding:3px 14px'>" + tkTxt + "</td><td align='right' style='padding:3px 14px'>" + utility.format_currency(pj) + "</td><td style='padding:3px 14px'>" + st + "</td></tr>";
		}
		h = h + "</table>";
		if(missing > 0)
		{
			h = h + "<div style='color:#b26a00;margin-top:6px'><b>" + missing + " outside cost(s) from the take-off are not on this project.</b> Tick <b>Load AI take-off outside costs</b> to add them, then save.</div>";
		}
		if(openEst > 0)
		{
			h = h + "<div style='margin-top:4px'>" + openEst + " row(s) are still AI take-off estimates with no supplier - confirm the supplier and price before submitting.</div>";
		}
		h = h + "</div>";
		input.Note_Takeoff_Outside = h;
	}
}
if(!showTo)
{
	hide Note_Takeoff_Outside;
}
```
