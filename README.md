# Unfold to sheets

Take a 3D model, cut it into pieces that flatten, nest those onto sheet stock,
mark the seams so it can be reassembled, and sweep the scale to find the size
that wastes the least material.

Browser app, vanilla ES modules, no build step. 144 tests under `node --test`,
including the DXF and PDF output validated by `ezdxf` and `pypdf` rather than by
eye.

```bash
python3 -m http.server 8778        # then open http://localhost:8778
npm test
node tools/unfold.mjs sample/Bunny-LowPoly.stl --units mm --out ./out
node tools/unfold.mjs sample/Bunny-LowPoly.stl --units mm --sweep 0.5:4:0.1
```

---

## The constraint that shapes everything

**Most 3D surfaces cannot be flattened.** This is a theorem, not a missing
feature. A surface flattens exactly only where its Gaussian curvature is zero —
planes, cylinders, cones. A sphere does not, and neither does most of anything
organic.

So this tool does both of the two honest things: it **segments** the mesh into
near-developable patches, and it **measures and reports** what the flattening
still could not do. Two numbers, in the units you are working in, on every
output:

| number | what it is |
|---|---|
| **spread** | how far apart the copies of one corner ended up before they were reconciled — the raw lie |
| **edge error** | after reconciliation, the worst disagreement between an edge on the model and the same edge on the flat — what a tape measure would find |

Both are exactly zero, to the last bit of a double, on anything that really is
developable. That is asserted in the tests rather than hoped for.

---

## The questions the spec left open, and what was decided

**1. Who chooses the seams?** *Both, and the user always wins.* An OBJ with
groups is read as authored seams and used in preference to any inference. Where
there is nothing to read, region growing decides — and every edge can still be
declared a seam (`forceSeam`), declared *not* a seam (`forceJoin`), or pinned to
a named patch (`forcePatch`), and those are applied before the heuristic runs.
A heuristic with no override is a trap: it will meet input that names things
differently and have no way to be told it is wrong.

**2. What does the material want?** *One question reaches the geometry: does it
fold?* If it does, a crease is a score line and a cardboard box is one piece. If
it does not, the same crease is a cut and the same box is six parts with joints.
That single answer lives in `materials.js`, sets the fold limit in segmentation,
and changes the part count by an order of magnitude.

**3. Tabs or butt joints?** *Declared by the material and generated.* Foldable
stock gets real glue tabs: a trapezoid standing outside the cut line on **one**
side of each seam, folded up along it. Rigid stock gets butt joints and no tabs.
Either can be overridden. See "Glue tabs" below.

**4. Is closed topology required?** *No.* Open surfaces are easier and are
handled throughout; boundary vertices are exempted from the curvature test
rather than failing it.

**5. What is the object's "size" in the sweep?** *Stated, not assumed.* Longest
bounding-box side by default, or any named axis or the diagonal.

---

## Pipeline

Eight stages, each independently testable, each runnable on its own.

```
  1. LOAD      js/mesh.js      STL (binary + ASCII) and OBJ, welded, stable edge IDs
  2. SEGMENT   js/segment.js   near-developable patches, or the file's own groups
  3. UNFOLD    js/unfold.js    spanning-tree placement + measured distortion
  4. SPLIT     js/split.js     cut on real edges, against what the nester can place
  5. SEAM      js/seams.js     a token on both sides of every cut, plus fold angles
  6. NEST      js/nesting.js   shape-aware raster packing onto real stock
  7. SWEEP     js/sweep.js     stages 2–6 across scales, Pareto frontier
  8. EXPORT    js/{svg,dxf,pdf,assembly,package}.js
```

Stages 1–6 are a pure function of `(mesh, scale, stock, options)` in
`js/pipeline.js`. Stage 7 calls it in a loop. Keeping that boundary clean is why
the sweep — the part of this that does not already exist elsewhere — is about
150 lines.

### Two ideas that earn their keep

**A stable global edge ID, assigned at load and never reassigned.** By the time
two pieces exist they share no data structure — they have been segmented apart,
cut apart and nested onto different sheets — but they still refer to the same
numbered edge. That is the only reason both sides of a cut can be given the same
token without either knowing about the other.

**Every derived value carries its own error.** A flattened patch is not an
outline, it is `{outline, spread, maxEdgeError, worstEdge, overlaps, method}`. A
nest is not a list, it is `{sheets, oversize, usable}`. A caller cannot lose the
error without deleting a field, which is at least a visible act.

---

## What segmentation actually tests, and why the obvious tests fail

Three constraints, and all three were added because the previous two were not
enough. Each one was found on the sample bunny.

**Not "do the normals stay in a cone".** That test shreds a cylinder, whose
normals sweep a half turn and which rolls out to an exact rectangle. Curvature in
one direction is free. The right test is the discrete Gaussian curvature — at
every corner interior to the patch, do the angles meeting there add to a full
turn? A cylinder: yes. A sphere: no. Ten lines, and it is the theorem applied
directly.

**Not just per-corner.** A closed surface carries a fixed 720° of curvature
however finely it is divided, so on a mesh with a few hundred vertices every
single corner passes comfortably while the total runs away. The bunny's *median*
corner is 24.5° from flat. So the defect is budgeted **per patch** as well, and
that is the limit that usually binds.

**Patches must be topological discs.** Without this the search finds a loophole:
curvature is only counted once a corner is completely surrounded, so a patch can
flow all the way around a sharp corner and leave the single face that would close
it. On the bunny that produced one 231-face "flat" patch, slit at a hundred
corners like a paper snowflake, plus 57 leftover single triangles — the faces it
had declined to close. Euler settles it in a line.

**And they must be compact.** Being a disc is not the same as being a part. A
long spiral is a disc, encloses no curvature, and is therefore free under all
three rules above — so on a surface where nearly every corner is too sharp to
enclose, growth finds exactly that, because wandering is the only move left. The
bunny gave a 150-face patch with 138 edges of boundary and 7 interior corners. It
flattens beautifully and it is not a part anybody can cut. So the perimeter is
held near that of a compact region of equal area.

---

## Glue tabs

A tab is a trapezoid standing outside the cut line, folded up along the seam it
belongs to. Three things about it matter more than the shape:

**Only one side of a seam gets one.** Two tabs on the same joint means the two
pieces cannot meet — the material is in the way. So each seam picks a side, and
because a tab can fail to fit on the side it picked, it tries the other, then
narrows itself, and only then gives up **in writing**.

**The ends are angled in.** A rectangular tab collides with its neighbour at
every corner of the piece. Drawing each end back by `width / tan θ` leaves the
corner clear. Every tab is checked against its own piece and against every other
tab on it, so a tab never lands on the part it is meant to be glued to.

**A tab is part of the part.** It is cut with the piece, so it is inside the
outline the nester packs *and* inside the size the splitter measures. That is
the §5.4 rule again wearing a different hat: tabs are decided after the pieces
are, but `nestGeometry()` knows the tab width in advance and holds room for it.
Without that, every piece is a tab-width bigger than the thing that was checked
against the sheet, and the symptom is the same as ever — a part that is never
cut and never mentioned.

On the sample bunny at ×2: **164 of 173 seams get a tab**, and the nine that do
not are listed by token with the reason.

**Every tab is a mountain fold.** Whatever the seam it serves does, the tab has
to end up sandwiched between the two panels — on the inside — so it always folds
away from the marked face. That keeps the rivets and the glue out of sight and
leaves the outside clear for seam tape.

---

## Which way does it fold?

A dashed line says *crease here* and stops there, which is half an instruction.
On a dome panel the same dashes mean bend the sheet away from you at one seam and
towards you at the next, and coroplast creases once. So there are two:

| | line | means |
|---|---|---|
| **mountain** | dash-dot `—·—·—` | crease towards you, panels away |
| **valley** | plain dash `— — —` | crease away, panels towards you |

The papercraft convention, and the **pattern** rather than the colour carries it,
because these come off a black-and-white printer more often than not. They are
separate layers everywhere it matters: `SCORE-MOUNTAIN` and `SCORE-VALLEY` in
DXF, with real R12 linetypes so CAD draws them differently too, and `<g
id="mountain">` / `<g id="valley">` in SVG. Every sheet carries its own key,
because the README does not make it out to the workshop.

**Which face is the reference.** Unfolding lays each triangle down preserving
winding, so a face that runs counter-clockwise seen from its normal runs
counter-clockwise on the sheet: *the marked side of the sheet is the outside of
the model*. A convex edge is then a ridge coming towards the reader with the
flanks falling away — a mountain. There is a test that checks no piece ever comes
out mirrored, because a mirrored piece is still the right shape, still nests, and
has every fold on it reversed.

**And which way is out.** All of that rests on the face normals, which come from
the winding, so a model exported inside out would have every mountain printed as
a valley — silently, since the pattern still cuts, still nests, and still
assembles, just inside out. For a **closed** model the divergence theorem settles
it exactly in one pass, and the senses are corrected to match; rewind the bunny
triangle by triangle and every crease still folds the same way.

For an **open** surface there is no geometric answer and the tool says so. A dome
with its normals out and a bowl with its normals in are the same triangles in the
same places — only the winding says which the author meant. Measuring the bulk
anyway gets a dish confidently labelled inside out, and then the correction that
exists to fix a reversed model reverses a correct one instead. That is not
hypothetical: it is what the first version of this did to a gutter fixture. So an
open surface is taken as wound, and every sheet says as much.

## Corrugated plastic

`coro-4x8` — 4 × 8 ft coroplast, 4 mm, exactly 1:2. It is the material this tool
suits best: it scores and folds cleanly across the flutes, takes rivets or vinyl
cement through a glue tab, and wants seam tape over the outside afterwards. Its
flutes run the long way, so it is **grain constrained** — parts may be turned end
for end but not across. That costs about 7% more sheets, and it is real: folding
along the flutes rather than across them does not work.

## The scale sweep

Nest the whole model at a range of sizes and count. **It is a sawtooth, not a
slope**: the stock stays the size it is sold at while the model grows, so each
piece walks across the sheet until it no longer fits, then splits, and the offcut
it leaves is dead.

Measured on the sample bunny, on 420 × 210 mm card:

| scale | size | sheets | used |
|---|---|---|---|
| ×1.0 | 108.1 mm | 1 | 33.4% |
| **×1.1** | **118.9 mm** | **1** | **40.5%** |
| ×1.2 | 129.7 mm | 2 | 24.1% |
| **×1.6** | **173.0 mm** | **2** | **42.8%** |
| ×1.7 | 183.8 mm | 3 | 32.2% |
| **×2.4** | **259.5 mm** | **4** | **48.2%** |

Utilisation is not monotone anywhere: 40.5% → 24.1% → 42.8% → 32.2%. And the
result the feature exists to produce is the third and fourth rows together —
**×1.6 gives a bunny 43 mm bigger than ×1.2 on exactly the same two sheets.**
Going up in size is free over that whole range, and nothing on the drawing says
so.

The same bunny in 6 mm ply on 4 × 8 sheets, where the effect is larger because
the stock is larger relative to the parts:

| scale | size | sheets | used |
|---|---|---|---|
| **×7.5** | **811 mm** | **1** | **55.8%** |
| ×8 | 865 mm | 2 | 31.7% |
| **×11** | **1189 mm** | **2** | **60.0%** |
| ×11.5 | 1243 mm | 3 | 43.7% |
| **×13.5** | **1460 mm** | **3** | **60.3%** |

Two sheets of plywood buy you either an 865 mm rabbit or a 1189 mm one. **The
bigger one is 324 mm taller and costs exactly the same.** That is the whole
reason this feature exists, and there is no way to see it without nesting the
model at every size and counting.

The frontier is a Pareto front over (size up, sheets down). **A row with any
unplaceable part is disqualified from it outright, not annotated** — a run that
omits part of the model is not a cheaper way to build it, and a footnote invites
exactly the mistake it is warning about.

### What the sweep does NOT capture

Every row is nested from stock of one thickness, so the rows compare *different
objects built from the same material*. As a measure of packing it is exact. As a
comparison of cost across sizes it is not: six sheets of 6 mm and eighteen sheets
of 12 mm are not comparable purchases.

And scaling does not scale everything. For anything structural, panel thickness
wants roughly `k^1.5`, not `k` — bending stress goes as `p·b²/t²` and both the
pressure and the span grow with `k` — so geometric scaling *under-builds* going
up and over-builds coming down. `sweep.js` reports it; it is physics, not a
design rule, and for anything load-bearing the authority is the relevant
standard.

---

## The dome

`sample/dome-6m.obj`, generated by `tools/make-dome.mjs` — a 4V geodesic
hemisphere, 6 m span, 3 m high, 28 m² floor, with a door and three windows cut
into it. 140 panels, struts 0.76–0.97 m, and an **open** surface with four
boundary loops, which is a much more realistic test than a tidy closed model.

```bash
node tools/make-dome.mjs --radius 3 --frequency 4 --out sample/dome-6m.obj
node tools/unfold.mjs sample/dome-6m.obj --units m --stock coro-4x8 --material coroplast
node tools/unfold.mjs sample/dome-6m.obj --units m --sweep 0.5:2:0.1 --stock coro-4x8 --material coroplast
```

**The frequency must be even.** An icosahedron has no ring of vertices on its
equator, so an odd-frequency dome cannot be cut in half without leaving a zigzag
base that no floor will ever meet. Even frequencies put subdivision points
exactly on z = 0. Odd ones are refused rather than quietly produced.

### What it costs

At the default settings:

| | pieces | sheets | used |
|---|---|---|---|
| Coroplast 4 × 8, folded, 107 glue tabs | 59 | **42** | 42.5% |
| Plywood 4 × 8, butt joints | 140 | **38** | 43.6% |

**Folding does not pay here, and that is worth knowing before buying anything.**
Coroplast keeps 140 facets as 59 foldable islands and still needs *more* sheets
than plywood's 140 separate triangles. Big folded islands are awkward shapes that
nest badly, and the glue tabs are material too. Choose the material for how you
want to fasten it — rivets and seam tape, or battens and glass cloth — not
because one of them folds.

**Grain costs about 7%.** With the open-sheet window set to 6 so the runs are
quick and comparable: coroplast 45 sheets constrained against 43 free, plywood 43
against 40. Coroplast's flutes are real — score across them and it folds, score
along them and it does not — but plywood is cross-laminated and much less
directional, so ignoring grain there is usually honest and saves three sheets.

### How big a dome will this frequency take?

Sweeping the 4V dome's size on coroplast, the interesting part is where it stops:

| scale | span | sheets | |
|---|---|---|---|
| ×0.7 | 4.2 m | 17 | 52.6% used |
| ×1.0 | 6.0 m | 44 | |
| ×1.1 | 6.6 m | 47 | last size that works |
| ×1.2 | 7.2 m | — | **3 panels too big for a sheet** |
| ×1.4 | 8.4 m | — | 95 panels too big |

Above 6.6 m span, individual facets exceed the 1.1 m the nester can use, and a
single triangle cannot be cut — there is no edge inside it to cut along. Every
one is named with its size, and the frontier drops those rows entirely.

The fix is not a bigger sheet, it is a finer dome: a 6V hemisphere at the same
span has 0.6 m struts. That is exactly why real domes go up in frequency as they
go up in size, and the tool arrives at it from the sheet rather than from theory.

## The sample model

`sample/Bunny-LowPoly.stl` — 292 triangles, 148 vertices, closed manifold,
V − E + F = 2. 108 × 87 × 107 mm as stated (an STL records no units; the tool
asks and never guesses).

| stock / material | patches | pieces | worst edge error |
|---|---|---|---|
| 420 × 210 card, folds | 23 | 35 | **0.260 mm** — 0.24% of the model |
| 420 × 210 rigid sheet | 275 | 275 | **0** exactly |

The rigid figure is not a rounding. The model is faceted, so once every crease
becomes a cut each piece is a flat region of a flat thing and there is nothing
left to approximate. The card figure is the honest cost of keeping 23 large
foldable islands instead of 275 small rigid ones.

---

## What this does not do

Stated plainly, because a tool that hides its limits moves the discovery to the
point where the material is already cut.

- **No bend allowance for sheet metal.** The preset exists and the fold angles
  are correct, but a real bend consumes material along its length and that is not
  modelled. Do not cut metal from this without adding it.
- **Overlap is detected and cut, not resolved.** An island that laps over itself
  is divided until it does not. Pepakura's value is largely in resolving those
  overlaps intelligently instead; this does the honest simple thing.
- **The nester is bottom-left-fill on a raster.** `deepnest`/`libnest2d` would
  beat it, and the dome shows where: 140 triangles pack at only ~44%, where a
  no-fit-polygon nester would pair them into parallelograms and get most of the
  rest. This is the single biggest material saving still on the table.
- **A facet larger than the sheet is a dead end.** The splitter cuts along edges
  the model already has, so a single triangle too big for the stock cannot be
  divided at all — it is reported, by name and size, and the fix is a finer mesh.
  A 2V dome at 6 m span hits this squarely; a 4V one does not.
- **Rigid stock on a large sheet is the slow case.** 275 pieces on a 2.4 m
  plywood raster is about 1.5 s per nest — a skyline bound on where a part can
  come to rest cut that from 6.8 s, but a wide sweep in that configuration is
  still a minute rather than an instant.
- **The assembly view is a painter's-algorithm projection.** Exact for a closed
  model; on an open one a triangle seen edge-on can land the wrong way round.

---

## Testing

`npm test` — 144 tests, about 10 seconds.

**Exact cases, asserted numerically.** A flat plate unfolds to itself: 100 × 60,
area 6000, spread 3.6e-15. An open tube unfolds to a rectangle of its height by
the **chord** circumference, not π·d — the mesh is a prism and its edges are
straight lines, and a pattern measured to the true circle is longer than the part
it has to fit. A cone's rim lands at exactly its slant height and the sector
opens by exactly 23 facet angles. These fail *numerically* rather than plausibly,
which is why they caught more real bugs than any amount of looking at the output
— including the one where the side-selection in the triangle placement projected
along the shared edge instead of across it, and a flat plate came out as a
tangle.

**The cases that must NOT flatten.** A closed tube reports a spread of exactly
one circumference, because an annulus is not a disc however flat it is. A cone
with its apex enclosed reports its 145° of missing angle. Neither is quietly
turned into a rectangle that does not exist.

**Invariants.** Every edge length in the plane equals the edge length on the
surface. Every piece is placed or named. Every token appears exactly twice, and
both sides of a cut carry the same token and the same length. Nothing is placed
off a sheet and no two pieces overlap. No material is created or destroyed.

**Which way it folds.** A ridge tent is a mountain and a gutter is a valley, with
the crease angle asserted against `atan(20/50)` each side of flat. No piece from
the dome, the bunny or a sphere ever comes out mirrored in the plane — the claim
the words rest on. Rewinding a closed model triangle by triangle leaves every
crease folding the same way, and that test refuses to pass unless the raw
dihedral sign really did flip for every edge, so it cannot go quietly vacuous. A
convex dome has **zero** valley folds and the bunny has plenty of both, which is
the only thing standing between the valley layer and never being drawn at all.

**Adversarial.** A non-manifold mesh, degenerate triangles, a stray disconnected
triangle, a single triangle larger than the stock, and a scale walked in steps
across the point where a part stops fitting — nothing may vanish on the way past.

**Foreign validation.** Never trust your own writer. Every DXF goes through
`ezdxf`'s strict reader *and* its auditor (zero errors, zero fixes). Every PDF
goes through `pypdf` in strict mode, including after a round trip through the
zip. Every SVG is parsed as XML. The archive is checked with the system `unzip`.
This caught a PDF whose cross-reference offsets were wrong wherever an em-dash
appeared — invisible by eye, because readers repair it silently, and fatal on
anything stricter.

---

## Lessons inherited from `lofting`, and where they landed

| lesson | where |
|---|---|
| measure the error and put it on the drawing | `unfold.js`, and every export |
| silent drops are the enemy | `split.js`, `nesting.js`, `pipeline.js#missing`, the README block that names them |
| one function owns "how big can a part be" | `split.js#nestGeometry` — the splitter and the nester both call it |
| labels must survive the cut | `labels.js` — a piece name may fall outside, a seam token may not |
| two places deciding one thing will drift | `sheetview.js` owns what is drawn; `package.js` declares each file once |
| an unfolded piece's orientation is arbitrary | `unfold.js#alignToPrincipalAxis` |
| explicit overrides beat name-guessing | `segment.js` — `forceSeam` / `forceJoin` / `forcePatch` |
| test against known exact answers | `test/fixtures/shapes.mjs` |
| verify output with foreign tools | `test/export.test.mjs` |
| cache-bust on content, not a version string | `tools/stamp.mjs` |
| state the scale on every page, with a measured bar | `pdf.js`, `svg.js` |
| a sweep needs a `setTimeout` fallback, not just rAF | `app.js#nextTick` — confirmed live: with the pane hidden, `document.hidden` was true and the sweep kept advancing, which without the fallback is a silent stall with the button still saying "Stop" |

Three were added.

**More choices can make a greedy algorithm worse.** The inherited lesson was that
angles past two gain nothing. On the dome's 140 triangles they actively *lose*:
eight angles took 40 sheets, sixteen took 41, twenty-four took 42, and the last
was four times slower. Bottom-left-fill is greedy, and more options let it make a
locally lower placement that ruins the skyline for everything after it. Defaults
that came from measurement have to be re-measured on a different shape.

**A missing unit is worse than a wrong one.** The unit conversion knew
millimetres and inches and silently treated anything else as millimetres. The
dome is modelled in metres, so it was nested against a sheet of plywood 2438
metres long — and nothing complained: 140 panels on one sheet at 0.0%
utilisation. That absurdity is easy to spot. The same mistake at a factor of ten
would have produced a plausible number and a skip full of scrap. There is now a
units table, unknown units throw, and a model with no stated units is refused
rather than guessed at.

**A correction can be worse than the thing it corrects.** Naming a fold mountain
or valley needs to know which face of the sheet is the outside, so the first
version measured the model's bulk by the divergence theorem and flipped the sense
when it came out negative. Exact on a closed model, and confidently wrong on an
open one: a gutter is concave about its own centre, so it was declared inside out
and its one correct valley was corrected into a mountain. A dish and a dome are
the same triangles; nothing but the winding distinguishes them. The rule now
fires only where it is exact, and elsewhere prints a sentence saying what it does
not know. A heuristic that improves the common case and corrupts a correct one is
not an improvement — and the fixture that caught it was four triangles.

And the original: **a rule that is necessary is not the same as a rule that is
sufficient.** Segmentation needed four constraints, and each of the first three
looked complete until the fourth failure showed up on a real model. The synthetic
fixtures never found any of them; the bunny found all four.

## License

Apache License 2.0. See [LICENSE](LICENSE).
