// =============================================================================
//  ironFittingWeights.js â€” catalogued weights for threaded iron fittings.
// -----------------------------------------------------------------------------
//  WHY THIS IS A TABLE AND NOT A FORMULA.
//
//  weights.js derives every butt-weld fitting from a length of pipe section,
//  and that works because a butt-weld fitting IS a length of pipe section. A
//  threaded iron fitting is not: it is a casting with a hex, a band and a wall
//  thickness set by ASME B16.3, and at small sizes it is far bulkier than any
//  pipe of the same bore.
//
//  That is not a matter of taste, it is arithmetic. Take the elbow formula in
//  weights.js (area x radius x angle, radius = NPS for short radius) and give it
//  the most metal it could possibly hold â€” a SOLID body, wall = OD/2 â€” at
//  malleable iron's 0.264 lb/in3:
//
//      size    catalogued (Sigma)   formula ceiling, solid body
//      1/2"    0.24 lb              0.115 lb     <- unreachable
//      1"      0.54 lb              0.563 lb     <- only just reachable
//      2"      1.91 lb              3.674 lb
//      6"      21.97 lb             85.770 lb
//
//  At 1/2" no wall thickness exists that reaches the real weight, so there is no
//  fudge factor that rescues the geometric route. It only becomes usable from
//  about 2" up. Hence: real catalogue numbers, keyed on material, type and size.
//
//  â”€â”€ PROVENANCE, WHICH IS RECORDED BECAUSE SOURCES DISAGREE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  Every figure here comes from ONE source: Sigma Piping Products' threaded
//  fittings catalog (SPP_Threaded_Fittings.pdf), page noted per group. SOURCE is
//  exported so a caller can say where a number came from. Do not merge a second
//  catalogue's figures into these objects â€” published weights for the same
//  nominal Class 150 fitting differ between manufacturers, so a mixed table
//  becomes a table whose numbers cannot be explained. Add a second source as its
//  own object and choose between them explicitly.
//
//  â”€â”€ THREE DEFECTS IN THE SOURCE, CORRECTED HERE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  These were found by checking each table against its own neighbours, and are
//  corrected or dropped on the way in rather than loaded and discovered later:
//
//   1. malleable bushing 1" x 1/4" prints 1.76 lb. Its neighbours are
//      1x3/8 = 0.16, 1x1/2 = 0.22, 1x3/4 = 0.18. Carried here as 0.176.
//   2. ductile bushing 1-1/4" x 1" prints 1.28 lb, where ductile 1-1/2x1 = 0.44,
//      2x1 = 0.66 and malleable 1-1/4x1 = 0.31. Carried here as 0.128.
//   3. the ductile COUPLING column is the ductile straight tee column, value for
//      value (1:0.85, 1-1/4:1.22, 1-1/2:1.55, 2:2.45). A coupling has no branch,
//      so it cannot weigh what a tee weighs. Those four are DROPPED, not guessed;
//      ductileCouplingFrom() below derives them from the malleable coupling and
//      marks the result as derived.
//
//  â”€â”€ AND ONE THAT IS NOT CORRECTABLE FROM INSIDE THE CATALOG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  Twenty values are shared, identical, between the DUCTILE (B16.3 Class 150)
//  and CAST (B16.4 Class 125) tables: the whole 90 reducing elbow set, the whole
//  straight tee set and the whole 45 elbow set. Different standard, different
//  class, different wall â€” they should not match, so one of each pair is wrong
//  and the catalog gives no way to tell which. They are KEPT, because a value
//  a few percent out beats no value on a quote, and flagged: ironFittingLb()
//  returns confidence 'shared' for them so a reviewer can find them later.
// =============================================================================

// Source of every number below. One catalogue, recorded, per the rule above.
const SOURCE = {
  id: 'sigma-spp',
  name: 'Sigma Piping Products â€” Threaded Fittings',
  file: 'SPP_Threaded_Fittings.pdf',
  standards: {
    malleable: 'ANSI B16.3 Class 150, ASTM A197',
    ductile: 'ANSI B16.3 Class 150, ASTM A536 Gr 65-45-12',
    cast: 'ANSI B16.4 Class 125, ASTM A126 Class B',
  },
};

// Groups whose numbers are duplicated in another material's table. See the
// header. Keyed material|type, value is the material it collides with.
const SHARED_WITH = {
  'ductile|elbow_45': 'cast',
  'cast|elbow_45': 'ductile',
  'ductile|elbow_90_reducing': 'cast',
  'cast|elbow_90_reducing': 'ductile',
  'ductile|tee': 'cast',
  'cast|tee': 'ductile',
};

// Pounds. Sizes are written the way the catalog writes them, normalised through
// sizeKey() below, so '1-1/4', '1 1/4' and '1.25' all land on the same entry.
// Reducing fittings are keyed run x run x branch for tees, large x small for
// everything else, in the catalog's own order.
const IRON_WT = {

  // â”€â”€ MALLEABLE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  malleable: {
    // 14 sizes, Sigma p2
    elbow_90: {
      '1': 0.54, '2': 1.91, '3': 4.76, '4': 8.53,
      '5': 13.55, '6': 21.97, '1/8': 0.07, '1/4': 0.11,
      '3/8': 0.15, '1/2': 0.24, '3/4': 0.38, '1-1/4': 0.93,
      '1-1/2': 1.26, '2-1/2': 2.91,
    },
    // 14 sizes, Sigma p2
    elbow_45: {
      '1': 0.51, '2': 1.5, '3': 3.92, '4': 7.07,
      '5': 8.07, '6': 17.79, '1/8': 0.07, '1/4': 0.1,
      '3/8': 0.16, '1/2': 0.19, '3/4': 0.32, '1-1/4': 0.74,
      '1-1/2': 1.01, '2-1/2': 2.57,
    },
    // 14 sizes, Sigma p3
    elbow_90_street: {
      '1': 0.53, '2': 1.91, '3': 4.93, '4': 9.69,
      '5': 13.56, '6': 25.26, '1/8': 0.06, '1/4': 0.09,
      '3/8': 0.14, '1/2': 0.21, '3/4': 0.34, '1-1/4': 0.91,
      '1-1/2': 1.13, '2-1/2': 3.09,
    },
    // 12 sizes, Sigma p3
    cross: {
      '1': 0.89, '2': 2.64, '3': 7.25, '4': 13.05,
      '1/8': 0.13, '1/4': 0.18, '3/8': 0.26, '1/2': 0.38,
      '3/4': 0.6, '1-1/4': 1.38, '1-1/2': 1.78, '2-1/2': 4.74,
    },
    // 27 sizes, Sigma p4
    elbow_90_reducing: {
      '3/8 x 1/8': 0.12, '3/8 x 1/4': 0.13, '1/2 x 1/8': 0.4, '1/2 x 1/4': 0.18,
      '1/2 x 3/8': 0.2, '3/4 x 1/4': 0.26, '3/4 x 3/8': 0.27, '3/4 x 1/2': 0.3,
      '1 x 1/2': 0.38, '1 x 3/4': 0.5, '1-1/4 x 1/2': 0.56, '1-1/4 x 3/4': 0.66,
      '1-1/4 x 1': 0.8, '1-1/2 x 1/2': 0.78, '1-1/2 x 3/4': 0.78, '1-1/2 x 1': 0.82,
      '1-1/2 x 1-1/4': 1.1, '2 x 1/2': 1.15, '2 x 3/4': 1.12, '2 x 1': 1.43,
      '2 x 1-1/4': 2.26, '2 x 1-1/2': 2.8, '2-1/2 x 1-1/4': 3.35, '2-1/2 x 1-1/2': 3.79,
      '2-1/2 x 2': 4.43, '3 x 2': 5.73, '3 x 2-1/2': 5.82,
    },
    // 13 sizes, Sigma p5
    tee: {
      '1': 0.72, '2': 2.46, '3': 5.95, '4': 11.17,
      '6': 28.74, '1/8': 0.09, '1/4': 0.14, '3/8': 0.2,
      '1/2': 0.34, '3/4': 0.5, '1-1/4': 1.11, '1-1/2': 1.5,
      '2-1/2': 4.14,
    },
    // 13 sizes, Sigma p5
    cap: {
      '1': 0.36, '2': 1.06, '3': 2.73, '4': 4.51,
      '6': 10.8, '1/8': 0.03, '1/4': 0.05, '3/8': 0.09,
      '1/2': 0.12, '3/4': 0.18, '1-1/4': 0.53, '1-1/2': 0.67,
      '2-1/2': 1.63,
    },
    // 88 sizes, Sigma p6,7
    tee_reducing: {
      '1/2 x 1/2 x 1/4': 0.3, '1/2 x 1/2 x 3/8': 0.3, '1/2 x 1/2 x 3/4': 0.46, '3/4 x 1/2 x 1/2': 0.38,
      '3/4 x 1/2 x 3/4': 0.46, '3/4 x 1/2 x 1': 0.49, '3/4 x 3/4 x 3/8': 0.46, '3/4 x 3/4 x 1/2': 0.47,
      '3/4 x 3/4 x 1': 0.57, '3/4 x 3/4 x 1-1/4': 0.59, '1 x 1/2 x 1/2': 0.58, '1 x 1/2 x 3/4': 0.58,
      '1 x 1/2 x 1': 0.59, '1 x 3/4 x 1/2': 0.59, '1 x 3/4 x 3/4': 0.59, '1 x 3/4 x 1': 0.59,
      '1 x 1 x 1/2': 0.7, '1 x 1 x 3/4': 0.81, '1 x 1 x 1-1/4': 0.82, '1-1/4 x 1/2 x 1': 1.1,
      '1-1/4 x 1/2 x 1-1/4': 1.1, '1-1/4 x 3/4 x 3/4': 1.1, '1-1/4 x 3/4 x 1': 1.12, '1-1/4 x 3/4 x 1-1/4': 1.12,
      '1-1/4 x 1 x 1/2': 1.13, '1-1/4 x 1 x 3/4': 1.13, '1-1/4 x 1 x 1': 1.13, '1-1/4 x 1 x 1-1/4': 1.15,
      '1-1/4 x 1-1/4 x 1/2': 1.15, '1-1/4 x 1-1/4 x 3/4': 1.15, '1-1/4 x 1-1/4 x 1': 1.2, '1-1/4 x 1-1/4 x 1-1/2': 1.2,
      '1-1/4 x 1-1/4 x 2': 1.23, '1-1/2 x 1/2 x 3/4': 1.23, '1-1/2 x 1/2 x 1': 1.35, '1-1/2 x 3/4 x 1/2': 1.38,
      '1-1/2 x 3/4 x 3/4': 1.38, '1-1/2 x 3/4 x 1': 1.41, '1-1/2 x 3/4 x 1-1/4': 1.42, '1-1/2 x 1 x 1/2': 1.2,
      '1-1/2 x 1 x 3/4': 1.2, '1-1/2 x 1 x 1': 1.23, '1-1/2 x 1 x 1-1/4': 1.23, '1-1/2 x 1-1/4 x 1/2': 1.36,
      '1-1/2 x 1-1/4 x 3/4': 1.38, '1-1/2 x 1-1/4 x 1': 1.38, '1-1/2 x 1-1/4 x 1-1/4': 1.41, '1-1/2 x 1-1/4 x 1-1/2': 1.42,
      '1-1/2 x 1-1/2 x 1/2': 1.43, '1-1/2 x 1-1/2 x 3/4': 1.3, '1-1/2 x 1-1/2 x 1': 1.45, '1-1/2 x 1-1/2 x 1-1/4': 1.52,
      '1-1/2 x 1-1/2 x 2': 1.53, '2 x 1/2 x 2': 1.53, '2 x 3/4 x 2': 1.56, '2 x 1 x 1': 1.57,
      '2 x 1 x 1-1/2': 1.58, '2 x 1-1/4 x 1': 1.62, '2 x 1-1/4 x 1-1/2': 1.63, '2 x 1-1/4 x 2': 1.63,
      '2 x 1-1/2 x 1/2': 1.56, '2 x 1-1/2 x 3/4': 1.58, '2 x 1-1/2 x 1': 1.62, '2 x 1-1/2 x 1-1/4': 1.63,
      '2 x 1-1/2 x 1-1/2': 1.64, '2 x 1-1/2 x 2': 1.65, '2 x 2 x 1/2': 1.65, '2 x 2 x 3/4': 1.87,
      '2 x 2 x 1': 1.78, '2 x 2 x 1-1/4': 2.35, '2 x 2 x 1-1/2': 2.55, '2 x 2 x 2-1/2': 2.85,
      '2-1/2 x 2 x 2': 2.85, '2-1/2 x 2-1/2 x 1': 2.85, '2-1/2 x 2-1/2 x 1-1/4': 3.36, '2-1/2 x 2-1/2 x 1-1/2': 3.46,
      '2-1/2 x 2-1/2 x 2': 3.65, '3 x 3 x 1/2': 4.03, '3 x 3 x 3/4': 4.03, '3 x 3 x 1': 4.13,
      '3 x 3 x 1-1/4': 4.5, '3 x 3 x 1-1/2': 5.18, '3 x 3 x 2': 5.7, '3 x 3 x 2-1/2': 5.72,
      '4 x 4 x 1-1/2': 7.47, '4 x 4 x 2': 7.7, '4 x 4 x 2-1/2': 7.7, '4 x 4 x 3': 8.5,
    },
    // 13 sizes, Sigma p8
    coupling: {
      '1': 0.38, '2': 1.32, '3': 3.5, '4': 5.66,
      '6': 12.32, '1/8': 0.06, '1/4': 0.09, '3/8': 0.11,
      '1/2': 0.19, '3/4': 0.28, '1-1/4': 0.66, '1-1/2': 0.8,
      '2-1/2': 2.25,
    },
    // 6 sizes, Sigma p8
    floor_flange: {
      '1': 1, '2': 2.2, '1/2': 0.56, '3/4': 0.6,
      '1-1/4': 1.12, '1-1/2': 1.4,
    },
    // 10 sizes, Sigma p9
    union: {
      '1': 0.99, '2': 2.72, '3': 5.73, '4': 9.04,
      '1/4': 0.23, '3/8': 0.34, '1/2': 0.45, '3/4': 0.61,
      '1-1/4': 1.23, '1-1/2': 1.77,
    },
    // 10 sizes, Sigma p9
    union_brass_seat: {
      '1': 0.99, '2': 2.78, '3': 5.73, '4': 9.19,
      '1/4': 0.23, '3/8': 0.35, '1/2': 0.43, '3/4': 0.62,
      '1-1/4': 1.27, '1-1/2': 1.77,
    },
    // 30 sizes, Sigma p10
    coupling_reducing: {
      '3/8 x 1/4': 0.1, '1/2 x 3/8': 0.13, '3/4 x 1/2': 0.13, '1 x 1/2': 0.14,
      '1 x 3/4': 0.19, '1-1/4 x 1/2': 0.19, '1-1/4 x 3/4': 0.21, '1-1/4 x 1': 0.22,
      '1-1/2 x 1/2': 0.31, '1-1/2 x 3/4': 0.33, '1-1/2 x 1': 0.34, '1-1/2 x 1-1/4': 0.54,
      '2 x 1/2': 0.5, '2 x 3/4': 0.56, '2 x 1': 0.66, '2 x 1-1/4': 0.71,
      '2 x 1-1/2': 0.6, '2-1/2 x 1-1/4': 0.71, '2-1/2 x 1-1/2': 0.79, '2-1/2 x 2': 1.05,
      '3 x 1': 0.99, '3 x 1-1/4': 1.03, '3 x 1-1/2': 1.08, '3 x 2': 1.85,
      '3 x 2-1/2': 1.96, '4 x 1-1/2': 2.14, '4 x 2': 2.71, '4 x 2-1/2': 2.91,
      '4 x 3': 4.43, '6 x 4': 12.47,
    },
    // 12 sizes, Sigma p11
    plug: {
      '1': 0.22, '2': 0.73, '3': 1.73, '4': 2.2,
      '1/8': 0.02, '1/4': 0.04, '3/8': 0.06, '1/2': 0.09,
      '3/4': 0.15, '1-1/4': 0.33, '1-1/2': 0.47, '2-1/2': 1.19,
    },
    // 7 sizes, Sigma p11
    hex_nut: {
      '1': 0.38, '2': 1.13, '1/2': 0.12, '3/4': 0.22,
      '1-1/4': 0.58, '1-1/2': 0.73, '2-1/2': 1.15,
    },
    // 52 sizes, Sigma p12
    bushing: {
      '1/4 x 1/8': 0.03, '3/8 x 1/8': 0.05, '3/8 x 1/4': 0.04, '1/2 x 1/8': 0.08,
      '1/2 x 1/4': 0.08, '1/2 x 3/8': 0.07, '3/4 x 1/8': 0.15, '3/4 x 1/4': 0.13,
      '3/4 x 3/8': 0.12, '3/4 x 1/2': 0.11, '1 x 1/8': 0.18, '1 x 1/4': 0.176,
      '1 x 3/8': 0.16, '1 x 1/2': 0.22, '1 x 3/4': 0.18, '1-1/4 x 1/4': 0.32,
      '1-1/4 x 3/8': 0.29, '1-1/4 x 1/2': 0.3, '1-1/4 x 3/4': 0.4, '1-1/4 x 1': 0.31,
      '1-1/2 x 1/4': 0.37, '1-1/2 x 3/8': 0.36, '1-1/2 x 1/2': 0.37, '1-1/2 x 3/4': 0.41,
      '1-1/2 x 1': 0.48, '1-1/2 x 1-1/4': 0.35, '2 x 1/4': 0.56, '2 x 3/8': 0.55,
      '2 x 1/2': 0.53, '2 x 3/4': 0.62, '2 x 1': 0.61, '2 x 1-1/4': 0.74,
      '2 x 1-1/2': 0.62, '2-1/2 x 1/2': 0.95, '2-1/2 x 3/4': 0.84, '2-1/2 x 1': 0.87,
      '2-1/2 x 1-1/2': 1.31, '2-1/2 x 2': 0.92, '3 x 3/4': 1.42, '3 x 1': 1.46,
      '3 x 1-1/4': 1.39, '3 x 2': 1.91, '3 x 2-1/2': 1.75, '4 x 3/4': 2.58,
      '4 x 1': 2.45, '4 x 1-1/4': 2.49, '4 x 2': 2.1, '4 x 2-1/2': 2.78,
      '4 x 3': 2.58, '5 x 4': 4.34, '6 x 3': 6.06, '6 x 5': 6.41,
    },
    // 4 sizes, Sigma p13
    extension: {
      '1': 0.34, '1/2': 0.16, '3/4': 0.25, '1-1/4': 0.55,
    },
    // 6 sizes, Sigma p13
    coupling_right_left: {
      '1': 0.5, '2': 1.7, '1/2': 0.2, '3/4': 0.3,
      '1-1/4': 0.9, '1-1/2': 0.9,
    },
  },

  // â”€â”€ DUCTILE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ductile: {
    // 4 sizes, Sigma p14
    elbow_90: {
      '1': 0.62, '2': 1.85, '1-1/4': 0.9, '1-1/2': 1.2,
    },
    // 12 sizes, Sigma p14  SHARED WITH CAST TABLE â€” see SUSPECT below
    elbow_90_reducing: {
      '1 x 1/2': 0.44, '1 x 3/4': 0.52, '1-1/4 x 1/2': 0.64, '1-1/4 x 3/4': 0.72,
      '1-1/4 x 1': 0.75, '1-1/2 x 1': 0.92, '1-1/2 x 1-1/4': 1.08, '2 x 1/2': 1.08,
      '2 x 3/4': 1.24, '2 x 1': 1.4, '2 x 1-1/4': 1.52, '2 x 1-1/2': 1.65,
    },
    // 4 sizes, Sigma p15  SHARED WITH CAST TABLE â€” see SUSPECT below
    tee: {
      '1': 0.85, '2': 2.45, '1-1/4': 1.22, '1-1/2': 1.55,
    },
    // 4 sizes, Sigma p15  SHARED WITH CAST TABLE â€” see SUSPECT below
    elbow_45: {
      '1': 0.46, '2': 1.5, '1-1/4': 0.73, '1-1/2': 0.92,
    },
    // 2 sizes, Sigma p15
    coupling_reducing: {
      '1 x 1/2': 0.39, '1 x 3/4': 0.53,
    },
    // 7 sizes, Sigma p16
    cross: {
      '1': 0.98, '2': 2.95, '1-1/4': 1.5, '1-1/2': 1.9,
      '1-1/4 x 1': 1.27, '1-1/2 x 1': 1.45, '2 x 1': 2.1,
    },
    // 8 sizes, Sigma p17
    bushing: {
      '1 x 1/2': 0.22, '1 x 3/4': 0.17, '1-1/4 x 1': 0.128, '1-1/2 x 1': 0.44,
      '1-1/2 x 1-1/4': 0.3, '2 x 1': 0.66, '2 x 1-1/4': 0.72, '2 x 1-1/2': 0.61,
    },
    // 4 sizes, Sigma p17
    cap: {
      '1': 0.32, '2': 0.91, '1-1/4': 0.43, '1-1/2': 0.6,
    },
    // 45 sizes, Sigma p18
    tee_reducing: {
      '1 x 1 x 1/2': 0.64, '1 x 1 x 3/4': 0.73, '1 x 1/2 x 1': 0.71, '1 x 3/4 x 1': 0.76,
      '1 x 1 x 1-1/4': 0.98, '1 x 1 x 1-1/2': 1.16, '1-1/4 x 1 x 1/2': 0.82, '1-1/4 x 1 x 3/4': 0.9,
      '1-1/4 x 1 x 1': 1, '1-1/4 x 1 x 1-1/4': 1.08, '1-1/4 x 1 x 1-1/2': 1.42, '1-1/4 x 1-1/4 x 1/2': 0.86,
      '1-1/4 x 1-1/4 x 3/4': 0.92, '1-1/4 x 1-1/4 x 1': 0.95, '1-1/4 x 1-1/4 x 1-1/2': 1.45, '1-1/4 x 1-1/4 x 2': 1.75,
      '1-1/2 x 1 x 1/2': 0.95, '1-1/2 x 1 x 3/4': 1.14, '1-1/2 x 1 x 1': 1.17, '1-1/2 x 1 x 1-1/4': 1.34,
      '1-1/2 x 1 x 1-1/2': 1.45, '1-1/2 x 1-1/4 x 1/2': 1.05, '1-1/2 x 1-1/4 x 3/4': 1.15, '1-1/2 x 1-1/4 x 1': 1.25,
      '1-1/2 x 1-1/4 x 2': 1.9, '1-1/2 x 1-1/2 x 1/2': 1.15, '1-1/2 x 1-1/2 x 3/4': 1.24, '1-1/2 x 1-1/2 x 1': 1.3,
      '1-1/2 x 1-1/2 x 1-1/4': 1.48, '1-1/2 x 1-1/2 x 2': 1.98, '2 x 1 x 2': 2.15, '2 x 1-1/4 x 2': 2.3,
      '2 x 1-1/2 x 1/2': 1.5, '2 x 1-1/2 x 3/4': 1.62, '2 x 1-1/2 x 1': 1.64, '2 x 1-1/2 x 1-1/4': 1.8,
      '2 x 1-1/2 x 1-1/2': 2, '2 x 1-1/2 x 2': 2.35, '2 x 2 x 1/2': 1.6, '2 x 2 x 3/4': 1.68,
      '2 x 2 x 1': 1.85, '2 x 2 x 1-1/4': 2.04, '2 x 2 x 1-1/2': 2.18, '2 x 2 x 2-1/2': 3.61,
      '2-1/2 x 2 x 3/4': 2.28,
    },
  },

  // â”€â”€ CAST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  cast: {
    // 5 sizes, Sigma p19
    elbow_90: {
      '1': 0.85, '2': 2.45, '1-1/4': 1.22, '1-1/2': 1.55,
      '2-1/2': 4.8,
    },
    // 14 sizes, Sigma p19  SHARED WITH DUCTILE TABLE â€” see SUSPECT below
    elbow_90_reducing: {
      '1 x 1/2': 0.44, '1 x 3/4': 0.52, '1-1/4 x 1/2': 0.64, '1-1/4 x 3/4': 0.72,
      '1-1/4 x 1': 0.75, '1-1/2 x 1/2': 1.17, '1-1/2 x 3/4': 1.3, '1-1/2 x 1': 0.92,
      '1-1/2 x 1-1/4': 1.08, '2 x 1/2': 1.08, '2 x 3/4': 1.24, '2 x 1': 1.4,
      '2 x 1-1/4': 1.52, '2 x 1-1/2': 1.65,
    },
    // 5 sizes, Sigma p20  SHARED WITH DUCTILE TABLE â€” see SUSPECT below
    tee: {
      '1': 0.85, '2': 2.45, '1-1/4': 1.22, '1-1/2': 1.55,
      '2-1/2': 6.39,
    },
    // 4 sizes, Sigma p20  SHARED WITH DUCTILE TABLE â€” see SUSPECT below
    elbow_45: {
      '1': 0.46, '2': 1.5, '1-1/4': 0.73, '1-1/2': 0.92,
    },
    // 2 sizes, Sigma p20
    coupling_reducing: {
      '1 x 1/2': 0.62, '1 x 3/4': 0.69,
    },
    // 46 sizes, Sigma p21
    tee_reducing: {
      '1 x 1 x 1/2': 0.95, '1 x 1 x 3/4': 1.1, '1 x 1/2 x 1': 1.08, '1 x 3/4 x 1': 1.18,
      '1 x 1 x 1-1/4': 1.52, '1 x 1 x 1-1/2': 1.73, '1-1/4 x 1 x 1/2': 1.17, '1-1/4 x 1 x 3/4': 1.38,
      '1-1/4 x 1 x 1': 1.47, '1-1/4 x 1 x 1-1/4': 1.8, '1-1/4 x 1 x 1-1/2': 2.05, '1-1/4 x 1-1/4 x 1/2': 1.37,
      '1-1/4 x 1-1/4 x 3/4': 1.54, '1-1/4 x 1-1/4 x 1': 1.65, '1-1/4 x 1-1/4 x 1-1/2': 2.21, '1-1/4 x 1-1/4 x 2': 2.55,
      '1-1/2 x 1 x 1/2': 1.41, '1-1/2 x 1 x 3/4': 1.65, '1-1/2 x 1 x 1': 1.65, '1-1/2 x 1 x 1-1/4': 2,
      '1-1/2 x 1 x 1-1/2': 2.3, '1-1/2 x 1-1/4 x 1/2': 1.58, '1-1/2 x 1-1/4 x 3/4': 1.72, '1-1/2 x 1-1/4 x 1': 1.85,
      '1-1/2 x 1-1/4 x 1-1/4': 2.22, '1-1/2 x 1-1/4 x 1-1/2': 2.45, '1-1/2 x 1-1/4 x 2': 2.8, '1-1/2 x 1-1/2 x 1/2': 1.76,
      '1-1/2 x 1-1/2 x 3/4': 1.87, '1-1/2 x 1-1/2 x 1': 1.94, '1-1/2 x 1-1/2 x 1-1/4': 2.29, '1-1/2 x 1-1/2 x 2': 3.28,
      '2 x 1 x 2': 3.4, '2 x 1-1/4 x 2': 2.8, '2 x 1-1/2 x 1/2': 2.09, '2 x 1-1/2 x 3/4': 2.4,
      '2 x 1-1/2 x 1': 2.54, '2 x 1-1/2 x 1-1/4': 2.85, '2 x 1-1/2 x 1-1/2': 2.24, '2 x 1-1/2 x 2': 3.75,
      '2 x 2 x 1/2': 2.6, '2 x 2 x 3/4': 2.71, '2 x 2 x 1': 2.97, '2 x 2 x 1-1/4': 3.32,
      '2 x 2 x 1-1/2': 3.72, '2 x 2 x 2-1/2': 5.1,
    },
    // 6 sizes, Sigma p22
    plug: {
      '1': 0.28, '2': 0.91, '1/2': 0.1, '3/4': 0.17,
      '1-1/4': 0.44, '1-1/2': 0.62,
    },
    // 7 sizes, Sigma p22
    cross: {
      '1': 1.54, '2': 4, '1-1/4': 2.4, '1-1/2': 3.1,
      '1-1/4 x 1': 2.05, '1-1/2 x 1': 2.4, '2 x 1': 2.75,
    },
  },
};

// Densities of the three irons, lb/in3, for the derived-value path only. These
// are NOT used to scale catalogued weights; a catalogued weight is used as it is.
const IRON_DENSITY = { malleable: 0.2640, ductile: 0.2560, cast: 0.2600 };

// â”€â”€ NAME NORMALISATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The take-off and the catalog do not spell things the same way, and neither is
// wrong. Everything funnels through these before a lookup.

// A make or material string to one of the three iron families, or null. Null is
// the important case: it means "not an iron fitting", and the caller must fall
// back to the pipe-section route rather than to a default iron.
function ironFamily(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  if (!s) return null;
  if (/malleable/.test(s)) return 'malleable';
  if (/ductile/.test(s)) return 'ductile';
  // "Cast Iron", "Cast Gray Iron", "Grey Iron". Must come after ductile, since
  // ductile iron is also a cast product and some makes read "Ductile Cast Iron".
  if (/cast|gray iron|grey iron/.test(s)) return 'cast';
  return null;
}

// A fitting type and its qualifiers to a table key, or null.
//   type      'Elbow', 'Tee', 'Reducing Tee', 'Bushing', 'Union', ...
//   opts      { degrees, street, reducing, brassSeat }
function ironTypeKey(type, opts) {
  const s = String(type == null ? '' : type).toLowerCase();
  const o = opts || {};
  const reducing = o.reducing === true || /reduc/.test(s);

  if (/elbow|bend|ell\b/.test(s)) {
    const deg = Number(o.degrees) || (/45/.test(s) ? 45 : 90);
    if (deg === 45) return 'elbow_45';
    if (o.street === true || /street/.test(s)) return 'elbow_90_street';
    return reducing ? 'elbow_90_reducing' : 'elbow_90';
  }
  if (/cross/.test(s)) return 'cross';
  if (/tee/.test(s)) return reducing ? 'tee_reducing' : 'tee';
  if (/coupling/.test(s)) {
    // A right & left coupling is a distinct part with its own weight; without
    // this it would fall through to the plain coupling and read light.
    if (o.rightLeft === true || /right\s*(&|and)\s*left|\br\s*&\s*l\b/.test(s)) return 'coupling_right_left';
    return reducing ? 'coupling_reducing' : 'coupling';
  }
  if (/union/.test(s)) return (o.brassSeat === true || /brass/.test(s)) ? 'union_brass_seat' : 'union';
  if (/bushing|bush\b/.test(s)) return 'bushing';
  if (/\bcap\b/.test(s)) return 'cap';
  if (/\bplug\b/.test(s)) return 'plug';
  if (/hex\s*nut|locknut|lock\s*nut/.test(s)) return 'hex_nut';
  if (/extension/.test(s)) return 'extension';
  if (/floor\s*flange/.test(s)) return 'floor_flange';
  return null;
}

// '1-1/4"', '1 1/4 in', '1.25' -> '1-1/4'. A size that does not parse returns
// null so it cannot half-match something else.
function sizeKey(size) {
  const raw = String(size == null ? '' : size).replace(/[â€â€œ"â€³']/g, '').replace(/inch(es)?|in\b/gi, '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s*[xXÃ—]\s*/).map((p) => p.trim()).filter(Boolean);
  const keys = parts.map(oneSizeKey);
  if (!keys.length || keys.some((k) => k == null)) return null;
  return keys.join(' x ');
}

const NAMED_FRACTION = [
  [0.125, '1/8'], [0.25, '1/4'], [0.375, '3/8'], [0.5, '1/2'],
  [0.625, '5/8'], [0.75, '3/4'], [0.875, '7/8'],
];

function oneSizeKey(text) {
  const s = String(text).trim();
  if (!s) return null;
  let v = null;
  const mixed = s.match(/^(\d+)\s*[-\s]\s*(\d+)\s*\/\s*(\d+)$/);
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (mixed) v = Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  else if (frac) v = Number(frac[1]) / Number(frac[2]);
  else if (/^\d+(\.\d+)?$/.test(s)) v = Number(s);
  if (v == null || !(v > 0)) return null;

  const whole = Math.floor(v + 1e-9);
  const rest = v - whole;
  if (rest < 1e-6) return String(whole);
  const hit = NAMED_FRACTION.find(([n]) => Math.abs(n - rest) < 1e-6);
  if (!hit) return null;
  return whole ? whole + '-' + hit[1] : hit[1];
}

// â”€â”€ THE LOOKUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Returns null when it cannot work it out, per the rule in weights.js: a null
// means "ask a human" and a zero is never an acceptable answer.
//
// On success returns an object, not a bare number, because a caller that writes
// a weight to a quote should be able to say where it came from:
//   { lb, source, confidence, material, type, size, note }
//
// confidence is one of:
//   'catalog'    a published figure, used as printed
//   'corrected'  a published figure with a confirmed decimal slip fixed
//   'shared'     published, but identical to another material's table (see header)
//   'derived'    computed from a different material's catalogued figure
//
//   spec = { type:'Elbow', material:'Malleable Iron', size:'1/2', degrees:90 }
//   spec = { type:'Reducing Tee', material:'Malleable', size:'3/4 x 1/2 x 1/2' }
function ironFittingLb(spec) {
  const s = spec || {};
  const family = ironFamily(s.material || s.make || s.fitting_make);
  if (!family) return null;

  const type = ironTypeKey(s.type || s.fitting_type, s);
  if (!type) return null;

  const key = sizeKey(s.size);
  if (!key) return null;

  const table = IRON_WT[family] && IRON_WT[family][type];
  if (table && table[key] != null) {
    const shared = SHARED_WITH[family + '|' + type];
    const corrected = CORRECTED[family + '|' + type + '|' + key];
    return {
      lb: table[key],
      source: SOURCE.id,
      standard: SOURCE.standards[family],
      material: family,
      type: type,
      size: key,
      confidence: corrected ? 'corrected' : (shared ? 'shared' : 'catalog'),
      note: corrected ? corrected
          : (shared ? 'identical to the ' + shared + ' table for every size; one of the two is wrong' : null),
    };
  }

  // The one derived path: the four ductile couplings the catalog got wrong.
  // Ductile and malleable threaded fittings share B16.3 Class 150 dimensions, so
  // the bodies are the same shape and only the density differs.
  const derived = ductileCouplingFrom(family, type, key);
  if (derived) return derived;

  return null;
}

// The corrections carried in the table, so a caller can see which figure moved.
const CORRECTED = {
  'malleable|bushing|1 x 1/4': 'catalog prints 1.76 lb; neighbours 1x3/8=0.16, 1x1/2=0.22, 1x3/4=0.18 â€” carried as 0.176',
  'ductile|bushing|1-1/4 x 1': 'catalog prints 1.28 lb; ductile 1-1/2x1=0.44, 2x1=0.66, malleable 1-1/4x1=0.31 â€” carried as 0.128',
};

function ductileCouplingFrom(family, type, key) {
  if (family !== 'ductile' || (type !== 'coupling' && type !== 'coupling_reducing')) return null;
  const mall = IRON_WT.malleable[type] && IRON_WT.malleable[type][key];
  if (mall == null) return null;
  const ratio = IRON_DENSITY.ductile / IRON_DENSITY.malleable;
  return {
    lb: Math.round(mall * ratio * 1000) / 1000,
    source: SOURCE.id + '+derived',
    standard: SOURCE.standards.ductile,
    material: 'ductile',
    type: type,
    size: key,
    confidence: 'derived',
    note: 'the catalog\'s ductile coupling column is a copy of its straight tee column and was dropped; '
        + 'this is the malleable ' + type + ' at ' + key + ' (' + mall + ' lb) scaled by density '
        + IRON_DENSITY.ductile + '/' + IRON_DENSITY.malleable,
  };
}

// What the table actually covers, for the backfill report and for deciding
// whether a gap is a gap or just an unlisted size.
function ironCoverage() {
  const out = [];
  Object.keys(IRON_WT).forEach((mat) => {
    Object.keys(IRON_WT[mat]).forEach((type) => {
      const sizes = Object.keys(IRON_WT[mat][type]);
      out.push({
        material: mat, type: type, sizes: sizes.length,
        shared: SHARED_WITH[mat + '|' + type] || null,
        first: sizes[0], last: sizes[sizes.length - 1],
      });
    });
  });
  return out;
}

module.exports = {
  ironFittingLb, ironCoverage,
  ironFamily, ironTypeKey, sizeKey,
  IRON_WT, IRON_DENSITY, SOURCE, SHARED_WITH, CORRECTED,
};
