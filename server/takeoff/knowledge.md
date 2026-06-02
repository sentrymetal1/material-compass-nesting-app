# Structural & Miscellaneous Metals — Take-off Knowledge Base

This is the estimating expertise injected into every take-off (prompt-cached). It is
meant to GROW: add a rule whenever a real correction teaches us something. In
production the CATALOG section is replaced by the customer's live Zoho lookup values,
and a PER-CUSTOMER OVERRIDES block is appended from that customer's learned history.

---

## 1. Classification catalog (Material Compass — exact values)

Every row MUST use a Form Type + Material Type + Specification + Material(size) that
match the platform's lookups EXACTLY, character-for-character. The downstream import
fuzzy-matches, but it will fail outright if you use the wrong sub-type or the wrong
size format. These are the real values — do not paraphrase, abbreviate, or re-style them.

### Form Types — SUB-TYPED. Output the specific sub-type, NOT a generic parent.
There is NO bare "Beam", no "HSS", no "Grating" (grating is buyout — see §5). The 20 valid Form Types:
- Beams: `Beam - I` · `Beam - W` · `Beam - S` · `Beam - HP` · `Beam - WT`
- Channels: `Channel` (C-shapes) · `Channel - MC` (MC-shapes)
- Tubes (this is what drawings call HSS): `Tube - Square` · `Tube - Round` · `Tube - Rectangle`
- Bars: `Bar - Flat` · `Bar - Round` · `Bar - Square` · `Bar - Hex`
- `Angle` · `Tee` · `Pipe` · `Plate` · `Tread Plate` · `Sheet`

**Designation → Form Type:** I-beam (I6x4.03)→`Beam - I` · wide-flange (W12x26)→`Beam - W` ·
American-Standard S→`Beam - S` · HP→`Beam - HP` · structural tee→`Tee` or `Beam - WT` ·
C-channel→`Channel` · MC-channel→`Channel - MC` · square HSS→`Tube - Square` ·
round HSS→`Tube - Round` · rectangular HSS→`Tube - Rectangle` · L-angle→`Angle` ·
pipe→`Pipe` · diamond/tread/checker plate→`Tread Plate` · flat plate→`Plate`.

### Material Types — output the exact string.
`Aluminum` · `Carbon Steel` · `Carbon Steel - Galvanized` · `Stainless Steel`
(others exist — Brass, Bronze, Tool Steel, Nickel-*, etc. — but structural fab uses the four above.)
**GALVANIZED IS A MATERIAL TYPE, not a flag:** galvanized steel → Mat Type `Carbon Steel - Galvanized`
+ a "… Galvanized" spec. "ALUM"/"ALUMINUM" → `Aluminum`.

### Specifications — constrained by Form Type + Material Type. Common structural ones:
- **Aluminum:** Beam-I `6061-T6`/`6063` · Channel/Angle/Tee/Bar-Flat `6061-T6` · Pipe `6063-T6` ·
  Bar-Round/Pipe `6061-B308` · Tread Plate `6061-T6 Diamond Tread`
- **Carbon Steel:** Beam-W/S/HP `A992` or `A36` · Beam-WT `A992`/`A36` · Channel `A36`/`A572`/`A588` ·
  Channel-MC `A36`/`A572 Gr 50`/`A588` · Angle `A36`/`A588` · Tee `A992`/`A36` ·
  Pipe `A53 Gr B`/`A500 Gr B`/`A106B Seamless` · Tube-* `A500 Gr B`/`A513` · Plate `A36`/`A572 Gr 50`/`A516 Gr 70`
- **Carbon Steel - Galvanized:** `A36 Galvanized` · Tube `A500 Gr B Galvanized` · Pipe `A53 Galvanized T&C`
- **Stainless Steel:** most forms `304` or `316` (Plate `A240 304/316` · Pipe `A312 316L` · Bar/Angle `A276`)
Never invent a spec; if unsure pick the most common valid one for that Form×Material and lower confidence.

### Material (size) — EXACT formats from the Beam_Channel_Tee_Lookup. SPACES around `x`, correct prefix.
This is the #1 thing that broke the first import — drawings style ≠ catalog style. Output catalog style:
- **Angle:** `L{a} x {b} x {t}` → `L4 x 4 x 1/4`, `L5 x 3 x 1/4`  (spaces, not `L4x4x1/4`)
- **Channel (Carbon/Stainless):** `C{d} x {wt}` → `C10 x 15.3`, `C8 x 11.5`  (NO space after C)
- **Channel (Aluminum):** `C {d} x {wt}` → `C 12 x 8.274`, `C 6 x 4.030`  (SPACE after C, **3-decimal** weight). A drawing's aluminum "CS12x8.27" = catalog `C 12 x 8.274`.
- **Channel - MC:** `MC{d} x {wt}` → `MC8 x 8.5`, `MC12 x 31`  (an "8 channel @ 8.5#" is `MC8 x 8.5`, NOT `C8x8.5`)
- **Beam - W/S/HP/WT:** `W12 x 26` · `S3 x 5.7` · `HP12 x 53` · `WT6 x 20`  · Beam - I (alum): `I{d} x {wt}`
- **Pipe:** `{n}" SCH {sch} ({STD|XS|XXS})` → `6" SCH 40 (STD)`, `2" SCH 80 (XS)`  (no "PIPE" word; inch-quote; SCH 40=STD, SCH 80=XS)
- **Plate:** `{thick}"` → `1/2"`, `3/8"`  (just thickness + quote — no "PL"). Carries a WIDTH/length, not a linear length.
- **Tube - Square:** `{dim} x {wall}` → `2 x 1/4`  (no "HSS") · **Tube - Rectangle:** `{a} x {b} x {wall}` → `4 x 2 x 1/4` · **Tube - Round:** `{OD} x {wall|gauge}` → `2 x 1/4`, `1 x 16 Ga`
- **Bar - Flat:** `{thick} x {width}` → `1/4 x 2` · **Bar - Round/Square/Hex:** bare dim → `1`, `2-1/2`, `3/8`
- **Tee (alum):** `{a} x {b} x {t}` → `2 x 2 x 1/4` · **Tread Plate (aluminum):** DECIMAL thickness with quote → `0.250"`, `0.125"`, `0.375"` (NOT `1/4"`); carbon/SS tread plate use fractions/gauge · **Sheet:** `{ga} ga ({dec})` → `16 ga (0.0598)`

### Galvanizing is a FINISH, not a material type (for fabricated shapes)
You fabricate from black steel then send it out to hot-dip — so a galvanized W-beam/angle/channel/HSS/pipe is
still `Carbon Steel` for catalog purposes (that's where the size lives), with galvanizing flagged separately.
When the spec or drawings call for galvanizing — e.g. "galvanize lintels, shelf angles and welded door frames
in exterior walls," exterior railings, bollards — set **`material_type` = `Carbon Steel`** (so the size resolves)
and **`galvanized: true`** (rides in the Galv column as "Yes"). **Do NOT output a `Carbon Steel - Galvanized`
material type for fabricated members** — your size lookup has no galvanized W/angle/channel entries, so it errors.

### Plate / Sheet / Tread Plate are area-measured — they need a WIDTH
A thickness alone is not a complete plate row (the form is "Panel," which requires a width). Put the thickness in
`size` (`1/2"`, `3/8"`) AND the plate **width in `width_ft`** (feet — a 12"-wide plate = 1.0). If the drawing gives
plate dimensions (base PL 12"×12"×3/4", shelf angle plate, etc.), capture them; if width is unknown, lower
confidence and say so in the top-level notes. Linear members (beams/channels/angles/tube/pipe/bar) carry only length.

**The four columns per row:** Form Type (sub-typed, e.g. `Channel - MC`) · Mat Type (e.g. `Carbon Steel`) ·
Specification (valid for that Form×Mat, e.g. `A36`) · Material = size in the exact format above (e.g. `MC8 x 8.5`).

---

## 2. Be exhaustive — where members hide

Most first-pass misses come from NOT reading past the plan views. Check every source:
- **Plans** (framing, foundation, roof) — primary members.
- **SCHEDULES** (door, lintel, column, beam) — often the ONLY place a member's size/qty appears.
- **DETAILS & SECTIONS** (e.g. S-3xx "Misc Metal Details") — connection clips, embeds, frames.
- **"TYP." callouts** — one detail standing in for many locations; quantity comes from counting locations across the set.
- **Spec sections 05-xx** (Metals) — list fabricated items the drawings may only imply.

---

## 3. Commonly OMITTED items — run this checklist every time

These are the items estimators (and naive AI passes) miss most. For each, actively confirm presence/absence:
- **Loose / masonry lintels** (over door & window openings) — often a separate lintel schedule.
- **Masonry partition ledger & embed angles** (e.g. L5x3 at block walls) — watch finish + clip-vs-continuous.
- **Grating support / embed angles** (at UV, splitter box, effluent box, walkways) — easy to undercount LF.
- **Overhead / coiling DOOR FRAMES** — channel jambs + plate header + sill angle, per door, per door schedule.
- **Bollards** — pipe (e.g. 6" Sch 80), at equipment pads & door openings; often "typ." only.
- **Embed / support beams** (e.g. effluent-box beam) — small, easy to drop.
- **Column base & cap plates** — cap plates especially get missed.
- **Clip / gusset plates** — high count, rarely itemized on plans (live in details).
- **Anchor rods / leveling nuts / embeds** — in foundation details.

---

## 4. Recurring CONFLICTS — pre-flag these for the reviewer

These specific disputes recur between a drawings-only read and the authoritative (spec/PM) numbers.
When you see one, output your best read AND a note that it's a known conflict point:
- **Base-plate thickness** (drawings light vs spec/PM heavier, e.g. PL 1/2 vs PL 3/4).
- **Column height / member length** (plan scale vs actual cut length — often under).
- **Ledger: continuous vs clips** (one long angle vs many short clips at each block course) — huge weight + finish swing.
- **Finish: prime vs galvanized vs mill** (drawing may show galv at masonry; PM may prime) — verify against spec.
- **Single vs mixed channel sections** (e.g. landings all C12x8.27 vs mixed C10/C12).
- **Grating support LF** (per-area pieces roll up to far more LF than a single bucket suggests).

---

## 5. Fabricate vs Buyout vs By-Others

A fabricator does NOT make everything shown. Classify scope, don't just list members:
- **FABRICATE (in-house):** loose steel lintels, ledger/embed/clip angles, metal stairs (channel stringers, landing channels, cross bracing, HSS columns, base/cap plates), walkway/equipment framing, OH-door steel frames, bollards.
- **BUYOUT (manufactured systems — list but tag as purchased, not fab):**
  - **Aluminum railing** — proprietary NON-WELDED mechanical system (Julius Blum / Moultrie or equal); internal-splice, mechanical joints, machined brackets. NOT shop-welded pipe. Often the single biggest buyout. There IS some in-house labor (cut/roll to radius, pre-assemble) but the system is purchased.
  - **Bar grating + frames + abrasive stair-tread nosing** (IKG / Ohio Gratings, per 05-53-xx).
  - **Floor/roof hatches + telescoping safety post** (Bilco / USF).
- **SEND-OUT processing:** hot-dip galvanizing of steel; anodizing of aluminum.
- **BY OTHERS (exclude):** davit/jib cranes, overhead coiling doors (the door itself), wood roof trusses, PE-stamped delegated engineering for stairs/railings, process-equipment-supplied items.

---

## 6. Finish rules

- **Galvanized (HDG):** steel exposed to weather / at masonry / wet environments; lintels & door frames common.
- **Prime paint:** interior/dry steel, or per PM preference (PM may prime items a spec would galvanize — flag it).
- **Mill finish:** aluminum stairs/framing default unless anodizing called out.
- **Anodized (AAMA Class I):** aluminum railing systems.
- Capture finish in the note; flag any finish that looks spec-driven or conflicts with PM intent.

---

## 7. Compliance — BABA / AIS (domestic content)

On USDA Rural-Development / state-revolving-fund (e.g. NYSEFC) and many public works:
- **All iron & steel** must be domestically melted, poured, and manufactured (Build America Buy America / American Iron & Steel).
- Affects every steel & fastener line (lintels, ledgers, bollard pipe, door-frame steel, galvanizing, SS fasteners).
- **Aluminum** is generally outside AIS, but BABA may still apply — verify with railing/grating manufacturers.
- When a project shows BABA/AIS language (Spec 00-73-xx), NOTE it on the take-off so every RFQ requests a domestic-content cert.

---

## 8. Quantity reality — flag what drawings can't give

Many real quantities come from the estimator's spec/field judgment, NOT the sheet (connection counts,
clips per course, bollards "typ." at every door, fastener counts). When a member is referenced but you
cannot size or count it from the drawings: output a row with your best guess (or 0), **confidence 0**, and
note **"GAP — verify with spec/PM."** A flagged gap is far more valuable than a silent omission.

---

## 9. Project-type patterns (extend as we learn)

- **Water / wastewater treatment (WWTP):** aluminum stairs & railings at tanks, aluminum grating at UV / splitter / effluent boxes with embed angles, masonry partition ledgers, loose lintels, bollards at pads & doors, OH coiling door steel frames. Stainless fasteners for wet areas. Usually BABA/AIS. Lots of "by others" process equipment.
- *(Add commercial, industrial, bridge, etc. patterns as projects come in.)*

---

## 10. Per-customer overrides

*(In production, this section is appended at run time from the customer's learned history: their
classification quirks, finish defaults, fab/buy/exclude boundaries, and corrections from past take-offs.
Empty during the spike.)*
