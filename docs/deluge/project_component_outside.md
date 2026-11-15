# Component outside costs by Item Type (2026-11-15)

Why: the header MARK UP / PROJECT TOTAL roll up from the components. The component's
Finish / Fasteners / Fittings / Misc amounts were found by `Component_ID` + the old
`Outsource_Type` radio. Take-off rows set `Component` + `Item_Type` only, so every component
got $0 outside cost and $0 markup on it.

Bucket (Item Type -> Category_of_Item) -> component field:
- Galvanize, Paint & Coatings -> Finish_Amt_Total / Paint_Galvanize_Cost_Per_Unit
- Fasteners & Hardware -> Fasteners_Amt_Total / Fasteners_Cost_Per_Unit
- Fittings & Valves -> Fittings_Amt_Total / Fittings_Amt_Per_Unit
- everything else -> Misc_Amt_Total / Miscellaneous_Cost_Per_Unit
Rows with no Item Type fall back to the old Outsource_Type radio.

Where: NEW PROJECT SUBMITTAL > Created or Edited > Successful form submission >
"Update Component Form" — replaces the `for each SourceLine in Project_Components_Form` loop.
Also delete the same-named loop in "Update BOM Fields" (it would overwrite with the old logic).

```
for each  SourceLine in Project_Components_Form[Project_LU == input.ID]
{
	finAmt = 0;
	fastAmt = 0;
	fitAmt = 0;
	miscAmt = 0;
	for each  r in Project_Outsource_Details_Form[MCP_Customer_Project_Form == input.ID && Component == SourceLine.ID]
	{
		amt = ifnull(r.Total_Amount,0);
		b = "";
		if(r.Item_Type != null)
		{
			b = ifnull(Project_Items_and_Subcontracting_Types[ID == r.Item_Type].Category_of_Item,"");
		}
		if(b == "")
		{
			if(r.Outsource_Type == "Finish (Paint/Galvanize)")
			{
				b = "Paint & Coatings";
			}
			else if(r.Outsource_Type == "Fasteners")
			{
				b = "Fasteners & Hardware";
			}
		}
		if(b == "Galvanize" || b == "Paint & Coatings")
		{
			finAmt = finAmt + amt;
		}
		else if(b == "Fasteners & Hardware")
		{
			fastAmt = fastAmt + amt;
		}
		else if(b == "Fittings & Valves")
		{
			fitAmt = fitAmt + amt;
		}
		else
		{
			miscAmt = miscAmt + amt;
		}
	}
	SourceLine.Finish_Amt_Total=finAmt;
	SourceLine.Fasteners_Amt_Total=fastAmt;
	SourceLine.Fittings_Amt_Total=fitAmt;
	SourceLine.Misc_Amt_Total=miscAmt;
	sq = ifnull(SourceLine.Quantity,0);
	if(sq > 0)
	{
		SourceLine.Paint_Galvanize_Cost_Per_Unit=finAmt / sq;
		SourceLine.Fasteners_Cost_Per_Unit=fastAmt / sq;
		SourceLine.Fittings_Amt_Per_Unit=fitAmt / sq;
		SourceLine.Miscellaneous_Cost_Per_Unit=miscAmt / sq;
	}
}
```
