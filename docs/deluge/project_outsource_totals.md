# Project outsource totals — one recount from the rows (v1, 2026-11-14)

Replaces the two "Add To Totals" workflows (User input of Item Sourcing Take-Off.Total_Amount).
Those only ADD, match 12 hard-coded spellings, and never fire for rows added by code or deleted.
This block throws the old totals away and adds up EVERY row again, by bucket.

Bucket = the row's **Item Type → Category of Item** (form `Project_Items_and_Subcontracting_Types`).
Old rows with no Item Type fall back to their `Category_of_Item` text (old spellings mapped).
Anything unknown lands in **Miscellaneous** — money never drops out of the totals.

## Project form fields to add first

`Outsource_Totals` subform — 4 new Currency columns:

| Label | Link name |
|---|---|
| Cutting | `Cutting` |
| Forming & Rolling | `Forming_Rolling` |
| Outside Welding & Fab | `Outside_Welding_Fab` |
| Heat Treat | `Heat_Treat` |

Header (next to Outsource_Machining) — 4 new Currency fields:
`Outsource_Cutting`, `Outsource_Forming_Rolling`, `Outsource_Outside_Welding_Fab`, `Outsource_Heat_Treat`.

Relabel only (keep link names): Blast_Paint → "Paint & Coatings", Detailing → "Engineering & Detailing",
Fasteners → "Fasteners & Hardware", Fittings → "Fittings & Valves", Inspection → "Inspection & Testing",
Installation → "Installation & Rigging", Trucking → "Freight", Other → "Miscellaneous".

## Bucket → field map

| Bucket (Category of Item) | Totals column | Header field |
|---|---|---|
| Cutting | Cutting | Outsource_Cutting |
| Decking | Decking | Outsource_Decking |
| Engineering & Detailing | Detailing | Outsource_Detailing |
| Fasteners & Hardware | Fasteners | Outsource_Fasteners |
| Fittings & Valves | Fittings | Outsource_Fittings |
| Forming & Rolling | Forming_Rolling | Outsource_Forming_Rolling |
| Freight | Trucking | Outsource_Trucking |
| Galvanize | Galvanize | Outsource_Galvanize |
| Grating | Grating | Outsource_Grating |
| Heat Treat | Heat_Treat | Outsource_Heat_Treat |
| Inspection & Testing | Inspection | Outsource_Inspection |
| Installation & Rigging | Installation | Outsource_Installation |
| Machining | Machining | Outsource_Machining |
| Miscellaneous | Other | Outsource_Misc |
| Outside Welding & Fab | Outside_Welding_Fab | Outsource_Outside_Welding_Fab |
| Paint & Coatings | Blast_Paint | Outsource_Blast_Paint |

## THE RECOUNT BLOCK

Paste the same block into each trigger listed below.

```
// ==== Outsource totals: recount every Item Sourcing row by bucket (v1) ====
buckets = {"Cutting","Decking","Engineering & Detailing","Fasteners & Hardware","Fittings & Valves","Forming & Rolling","Freight","Galvanize","Grating","Heat Treat","Inspection & Testing","Installation & Rigging","Machining","Miscellaneous","Outside Welding & Fab","Paint & Coatings"};
legacy = Map();
legacy.put("Blast / Paint","Paint & Coatings");
legacy.put("Detailing","Engineering & Detailing");
legacy.put("Fasteners","Fasteners & Hardware");
legacy.put("Fittings","Fittings & Valves");
legacy.put("Inspection","Inspection & Testing");
legacy.put("Installation / Rigging","Installation & Rigging");
legacy.put("Trucking","Freight");
legacy.put("Form/Roll","Forming & Rolling");
legacy.put("Outside Fab","Outside Welding & Fab");
bucketOf = Map();
for each t in Project_Items_and_Subcontracting_Types[ID != 0]
{
	bucketOf.put(t.ID.toString(),ifnull(t.Category_of_Item,"Miscellaneous"));
}
cat = Map();
grand = 0;
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
			txt = ifnull(r.Category_of_Item,"").trim();
			b = txt;
			if(legacy.containKey(txt))
			{
				b = legacy.get(txt);
			}
		}
		if(!buckets.contains(b))
		{
			b = "Miscellaneous";
		}
		cat.put(b,ifnull(cat.get(b),0) + amt);
		grand = grand + amt;
	}
}
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
// ==== end recount ====
```

## Where it goes

| # | Workflow (MCP_Customer_Project_Form) | Trigger | Code |
|---|---|---|---|
| 1 | **Outsource Recount – Amount** | User input of Item Sourcing Take-Off › **Total_Amount** | the block |
| 2 | **Outsource Recount – Item Type** | User input of Item Sourcing Take-Off › **Item_Type** | the 4 lines below, then the block |
| 3 | **Outsource Recount – Delete** | **Deletion of row** in Item Sourcing Take-Off | the block |
| 4 | Load Take-off Outside Rows (Load button) | (existing) | Load v3 — calls the same block at its end |

Line for #2 (keeps the row's Category in step with its Item Type):

```
if(row.Item_Type != null)
{
	row.Category_of_Item = ifnull(Project_Items_and_Subcontracting_Types[ID == row.Item_Type].Category_of_Item,"Miscellaneous");
}
```

Then **disable** both old "Add To Totals" workflows (don't delete yet).
