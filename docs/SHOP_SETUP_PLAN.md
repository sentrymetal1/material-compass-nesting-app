# First-time shop setup — plan, 2026-11-16 (DRAFT, awaiting Mark)

**Goal:** a new shop's admin works through one guided checklist before running a project. Once they finish it, their first project needs almost no typing. Clients, reps, suppliers, subcontractors and team are already there, and the take-off already knows how the shop quotes.

**Where it lives:** a Railway page, `/takeoff/setup.html`. It opens from the Manufacture Profile page, using the same pattern as the Subcontractors page: `?t=<mcToken>`, with the shop taken from the token.
- **Why Railway:** the imports (spreadsheets, PDFs of old quotes) need file parsing and the AI. Zoho pages can't do that.
- **What Zoho keeps:** the records the rest of the platform already reads.

**How the checklist works:**
- Each step shows **Done / Partly done / Not started**.
- Status is computed live from the shop's real records, the same way the profile guidance works today. Nothing is ticked by hand.
- Every step can be skipped and finished later.
- The checklist stays reachable from the profile until all steps are Done.

## The steps

| # | Step | What the admin does | Where it lands (Zoho) | Done when |
|---|---|---|---|---|
| 1 | **Shop profile** | Existing Manufacture Profile guidance: labor rates, project types, shipping locations, labor types, markup. Unchanged. | Customer_Entry_Form + its child forms | The existing five flags are true |
| 2 | **Your team** | Enter name, email and role for each person. The page adds the email to the shop's login list and emails an invite. | `Account_User_Email` on Customer_Entry_Form (exact-match list, see the risk below) | Each person shows *Invited* or *Signed in* |
| 3 | **Clients** | Upload a spreadsheet (Excel/CSV export from accounting, CRM or Outlook contacts), or paste. The page maps the columns, previews, flags duplicates, then imports. One row can create both the client and the client contact. | Client form + client Representatives form + Locations | ≥1 active client |
| 4 | **Material suppliers** | (a) Pick from suppliers already on Material Compass within a radius of the shop (Match Hub data). (b) Invite the shop's own suppliers by email: name, contact, email. | Shop's supplier list / supplier invite | ≥1 supplier picked or invited |
| 5 | **Subcontractors** | Same spreadsheet import, plus the Subcontractors page already built. Types of work are picked per company. | Subcontractor_and_Item_Suppliers_Form + reps | ≥1 active subcontractor |
| 6 | **Teach the take-off** | Upload past quotes or estimates (PDF/Excel). Drawings and the result (won/lost, final price) are optional. The AI reads each one and **proposes** shop preferences, which the admin confirms or edits. Nothing is saved unconfirmed. | `Takeoff_Correction` (Source = `history`), plus proposed defaults where fields exist | ≥3 quotes read and reviewed |
| 7 | **Ready check** | A summary of what's set and what's missing, with a **Start your first project** button. | — | Steps 1, 3 and 6 done |

### Step 6 in more detail: what the AI pulls from each old quote

These become proposals, not facts, until the admin confirms them:
- **Project type** and **scope pattern**: what this shop includes or excludes, and its buyouts.
- **Finish defaults**: galvanize vs paint, for which kind of work.
- **Outside costs used**, with unit and price. This seeds subcontractor price history.
- **Material $/lb as quoted**. This seeds the parked material price fallback at its "own history" level, tagged as *from old quotes, unconfirmed*.
- **Labor**: hours by operation if shown. If not, total labor $ is backed out per job and flagged as an estimate.
- **Markup / margin**: only if the quote shows it.

Each confirmed item is written the way take-off corrections are written today. `fetchShopLearning` injects them into every later take-off for that shop, and only that shop. The privacy firewall is unchanged.

## Risks and decisions

1. **Team invites.** Login today resolves by `Account_User_Email.contains(login)`, which is a substring test. A shared catch-all address also sits in several shops. The setup page should write a clean comma list and match exactly. Creating the actual portal user may still need the admin to click Zoho's invite once; that gets confirmed during the build.
2. **API budget.** Bulk imports must use batch inserts (up to 200 records per call). One shop's setup is about 10–30 calls, not one per row.
3. **Never invent a number.** Anything the AI reads from old quotes is shown as *proposed* with its source quote, and nothing is stored until confirmed.
4. **No vendor names in the UI.** Import screens say "spreadsheet" / "accounting export", never a product name.

## Build order (each part usable on its own)

1. Checklist page with live status, launched from the Manufacture Profile (steps 1, 5, 7 wired to existing screens).
2. Spreadsheet import engine (map columns → preview → duplicates → batch insert), used for clients, then subcontractors.
3. Team invites.
4. Supplier pick-and-invite.
5. Teach the take-off (old-quote reader + confirm screen).

## Open questions for Mark

- Which field link names to use for the client, client representative and location forms (screenshots when that step is built).
- Which roles a team member can have (admin / estimator / shop / purchasing?) and what each may see.
- What a typical shop's old quotes look like. Sentry's are `Projects/JobHistory/<customer>/<job#> - <name>.pdf`.
