# Teach the take-off from a shop's past jobs (plan, 2026-11-19)

Setup checklist step 6. A new shop's take-off starts with general defaults (and Sentry-calibrated labor).
This step learns **this shop's** habits from its own past work.

## Mark's direction
- Every shop is different, so it can't assume Sentry's format.
- What a shop may have, per job: estimate spreadsheets, supplier quotes, handwritten or typed material
  lists, hours, a quote/proposal letter, specifications, and possibly a job cost report with actual hours.

## Principle
Accept **anything**, one job at a time. The AI works out what each document is and pulls only what that
kind of document can tell us. Every number it proposes shows **where it came from** (file + page/line).
The admin confirms or edits, and **nothing is saved unconfirmed**. Numbers are never asserted without
an anchor in a document.

## Flow (page: /takeoff/teach.html, from the setup checklist)
1. **Add a past job.** Name / number (optional), plus drop **all its files**: PDF, Excel, CSV, Word,
   photos of handwritten sheets. Optional: won or lost, and the final price.
2. **The AI sorts the files**, one label each, which the admin can change:
   quote / proposal · estimate or take-off sheet · material list · supplier quote · specification ·
   job cost / actual hours report · drawings · other.
3. **It extracts by type:**

   | Document | What it can teach |
   |---|---|
   | Quote / proposal | Scope included and excluded, exclusions wording, finish (galv / paint / primer), buyouts, total price, job type |
   | Estimate / take-off sheet | Tons or lbs by material, estimated hours by trade, rates, markup |
   | Material list | Shapes and weights; tons when the proposal does not give them |
   | Supplier quote | Material $/lb or $/cwt actually paid, with the supplier and date |
   | Specification | Requirements that drove cost (galvanizing, coatings, NDE, certs) |
   | Job cost / actual hours | **Actual** hours (and cost) versus estimate. This is the best labor evidence. |
   | Drawings | Job type and size cross-check only |

4. **Cross-check before proposing.** Tons from the estimate vs the material list vs the proposal; hours
   estimated vs actual. A mismatch is shown, never averaged away (same rule as the take-off weight check).
5. **Proposals, one card each**, with the source quoted:
   - **Reference job**: type, material, tons, hours (actual when there is a cost report, else
     estimated, labeled as such), giving hr/ton. Confirmed → Labor Standards › Reference jobs (the section
     that weighs most in labor estimates).
   - **Scope habit**, e.g. "Excludes anchor bolts and grout", "Hot-dip galvanize stair and rail".
     Confirmed → Takeoff_Correction, Source = history (the take-off reads these as instructions).
   - **Outside cost**, e.g. "Galvanizing $0.42/lb, Valley Galv, 2025". Confirmed → Takeoff_Correction
     (history), and later the subcontractor price history.
   - **Material price**, e.g. "W-shapes $0.62/lb from Ryerson, Mar 2025". Confirmed and tagged
     *from old quotes*, to seed the parked material price fallback.
   - **Markup / margin** when both cost and price are present. Shown for information; it does not
     overwrite the profile markup without the admin choosing to.
6. **Done** when 3 or more jobs are reviewed (checklist step turns green). More jobs = better; any time later.

## What it never does
- Never saves anything the admin did not confirm.
- Never invents a number: a field with no document evidence stays empty.
- Never mixes shops: everything is stored per shop.

## Build order
1. Upload + classify + extract (one AI call per file, structured output per document type), with sources.
2. Job review screen: cross-checks + proposal cards + confirm/edit/reject.
3. Writes: reference jobs (labor shop file), Takeoff_Correction rows (Source = history).
4. Checklist link + status (already counts Takeoff_Correction Source = history).

## Open questions for Mark
- Keep the uploaded files (per shop file store, so they can be re-read later) or discard them after
  extraction?
- How many past jobs to suggest: "3 to start, 10 is better"?
