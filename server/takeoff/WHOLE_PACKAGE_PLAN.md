# Whole-package take-off: upload the bid set, read what matters

Status: **plan, not built**. Written 2026-10-03. Waiting on Mark to check the keep/skip rules.

## The idea

Today the estimator decides which sheets and spec sections to upload. That's where take-offs go
wrong: Portville missed the loose lintels because the A-sheets weren't uploaded, and on Dunkirk the
G-series typical details turned up after the run. The estimator should be able to upload the whole
bid set (every discipline and the full spec book) and let the take-off pick what a steel and
miscellaneous metals fabricator needs, show its picks, and let the estimator change them.

## How it works

1. **Upload everything.** Drawings, the spec book, addenda and the bid form, in any number of files.
   Files go into the project's file store in pieces, so size isn't a wall (see "Size" below).
2. **Sort it for free, without the AI.**
   - **Drawings:** most bid sets are CAD exports, so each sheet's number and title are readable text.
     The server reads every title block in seconds at no cost. The sheet prefix and title decide most
     sheets (rules below).
   - **Spec book:** split into sections by their `SECTION nn nn nn -` headers. This already works:
     it is how Division 09 was cut to its painting sections on 2026-10-03. Keep sections by number,
     plus any section whose text mentions steel items (keyword list below).
3. **One cheap AI pass over the list of titles,** with no drawings attached, only for sheets the
   rules can't settle. Cost is a few cents.
4. **The estimator confirms a short summary,** for example: "Reading 38 of 240 sheets and 9 spec
   sections. Here's why each was picked, and here's what was skipped." Each line can be moved
   between read and skip.
5. **The take-off runs** on the picked set, in parts if it's big (this already works), with addenda
   paired to their originals (this already works).

## Keep / skip rules: please check these

### Drawings

| Sheets | Read | Why |
|---|---|---|
| **G / GS / SD**: general notes, typical details, schedules | Always | Default finishes, typical lintel / ledger / edge-angle details, embeds; answers many conflicts |
| **S**: all structural | Always | The core take-off. Demolition plans are read as reference only (no rows) |
| **A**: floor plans, roof plan, building sections, wall sections, details | Yes | Loose lintels, shelf angles, edge angles, roof frames, screen-wall framing |
| **A**: stair and railing sheets | Yes | Stairs, rails, guards, ladders |
| **A**: door / frame / hardware schedules | Yes | Lintels over openings; overhead coiling-door jamb angles |
| **A**: elevations | Yes | Canopies, sunshades, screen walls, exposed steel |
| **A**: finish plans, RCP, furniture, signage, life safety, enlarged toilet plans | Skip | Unless the title or text mentions steel, supports, frames or lintels |
| **C / L**: site and landscape | Only details and site plans | Bollards, guardrails, fences, gates, trench-grate frames, site railings |
| **M / P / E / FP / T** | Only sheets mentioning supports, frames, platforms, dunnage, hangers or equipment pads | Equipment support steel, roof dunnage, pipe racks. Everything else skipped |
| **Q / F / K**: equipment, food service | Only if the text mentions steel supports | Rare, but operable-partition and equipment support steel lives here |
| Cover, index, code / life-safety sheets | Index only | The drawing index is read to check nothing is missing from the upload |

### Spec sections

| Sections | Read | Why |
|---|---|---|
| **00 41 xx** bid form, **01 10 00** summary, **01 23 00** alternates, **01 22 00** unit prices | Yes | Scope, phasing, alternates and unit prices that change the quote |
| **01 40 00 / 01 45 xx** quality, testing, special inspections | Yes | Inspection and testing costs |
| **03 30 00** cast-in-place concrete | Only steel mentions | Embeds and anchor rods; who sets them |
| **04 20 00** unit masonry | Only steel mentions | Loose lintels are often specified here, not in 05 |
| **05** all of Division 5 | Always, whole | The core spec |
| **07 72 00** roof accessories | Only steel mentions | Roof hatches, ladders, curb framing |
| **07 81 00 / 07 81 23** fireproofing, intumescent | Yes | Surface prep and primer compatibility |
| **08 33 xx** overhead coiling / sectional doors | Only steel mentions | Jamb angles and headers |
| **09 90 / 09 91 / 09 96 / 09 97** painting and coatings | Yes | Shop primer, finish systems, galvanizing touch-up |
| **10 xx** specialties | Only steel mentions | Toilet-partition and operable-partition support steel |
| **11 xx** equipment | Only steel mentions | Equipment support steel |
| **13 34 19** metal building systems | Yes | Pre-engineered buildings |
| **14 xx** elevators | Only steel mentions | Hoist beams, divider beams, sill angles, pit ladders |
| **21–28** MEP | Only steel mentions | Supports usually by the trade, but sometimes by steel |
| **31 / 32** earthwork and site | Only steel mentions | Bollards, guardrails, fences, gates |
| Everything else | Skip | Listed in the summary as skipped |

**"Steel mentions"** means the section's text contains any of: structural steel, miscellaneous
metal(s), lintel, embed(ded) plate, anchor rod / bolt, ledger, shelf angle, edge angle, bent plate,
pour stop, bollard, ladder, railing / handrail / guardrail, grating, galvaniz, shop primer, hoist
beam, dunnage, support steel, "Section 05". A section that only *mentions* steel is read for those
passages, not whole.

## Size

Full bid sets run 150–250 MB. Today the upload tops out at 140 MB and the project file store at
150 MB per project. The plan:

- The browser uploads each file to the project store on its own, the way it already does, and the
  store's per-project cap is raised (the Railway volume has room).
- Sorting runs on the server against the stored files, so the browser never sends the whole package
  in one request.
- The take-off itself only sends the picked sheets, in parts, under the 32 MB per-read limit.

## Scanned sets

A scanned set has no text, so free sorting can't read its title blocks. Fallback: crop each page's
title-block corner as a small image and read the number and title with the cheap model, about a
few cents per 100 sheets, then apply the same rules.

## Cost

| Step | Cost |
|---|---|
| Free sorting (text title blocks, spec split, rules) | $0 |
| Title-list AI pass for borderline sheets | ~$0.02–0.05 |
| Scanned title blocks (only if scanned) | ~$0.03 per 100 sheets |
| The take-off | Same as today, but only on the picked sheets |

Zoho: almost none. Sorting and storage are on Railway. Writing the picked drawings as project
drawing records is the same few calls the intake already makes.

## What already exists and gets reused

- `pdfkind.js`: drawing vs document by sheet size; text extraction
- `docprep.js`: documents as text, spec section split, batching, page-splitting large PDFs
- Intake addendum pairing (`setAsideSuperseded`) and the review page's Addenda tab
- Split runs that keep finished parts, quote clarifications, By drawing scope

## Build steps

1. **Server-side sort:** read title-block text per page for every stored PDF, apply the rules,
   split spec books into sections, tag keyword passages. Endpoint returns the proposed read/skip
   list with a reason per line. No AI.
2. **Borderline pass:** one text-only AI call over the unresolved titles.
3. **Intake screen:** "Whole package" mode showing the summary, counts and reasons, with read/skip
   toggles. The confirmed set feeds the existing preview and run.
4. **Size:** raise the per-project store cap; make sure every upload path stores file by file.
5. **Scanned fallback:** title-block crop and cheap read.
6. **Drawing-index check:** compare the G-series index against what was uploaded and flag missing
   sheets ("the index lists A501–A505; A503 wasn't uploaded").

## Questions for Mark

1. Are the keep/skip rules right? What does your estimator always open that isn't on the list, and
   what's on the list you'd never read?
2. Mechanical, plumbing and electrical support steel: usually by the trade on your jobs, or yours?
3. Should skipped sheets still be stored on the project and listed, so the estimator can ask the AI
   about them later? (Recommended: yes.)
4. Division 03 anchor rods and embeds: do you typically supply them, set them, or neither?
