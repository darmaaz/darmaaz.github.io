---
title: "trajkit: searchable chunks from noisy GPS"
description: "A reference design for taking raw GPS pings and producing trajectory primitives at three useful grains: typed segments, named episodes, and a per-segment similarity index."
pubDatetime: 2026-06-04T00:00:00Z
featured: true
tags:
  - trajectory
  - gps
  - python
  - segmentation
  - similarity
---

A reference design for taking raw GPS pings and producing trajectory primitives at three useful grains: typed segments, named episodes, and a per-segment similarity index.

[github.com/darmaaz/trajkit](https://github.com/darmaaz/trajkit)

## What this is for

Mobility analysis lives above the ping. Fleet anomaly detection, dwell-place discovery, trip-pattern mining, route comparison, stop-sequence prediction — none of these questions are answerable on a (lat, lon, ts) tuple alone. They all need the same upstream step: chunk the raw stream into units that mean something operationally. A stop. A leg. A visit. Once you have those, a similarity index (FAISS or similar) or any downstream model has something useful to work on.

The standard recipe in the literature is **stop-first**. [Lachesis](https://www.kentarotoyama.org/papers/Hariharan_2004_Project_Lachesis.pdf) (Hariharan & Toyama, 2004) and [Li et al. (2008)](https://dl.acm.org/doi/10.1145/1463434.1463477) detect stay points by sliding a radius+duration window over the points. Density-based clustering methods (DBSCAN, and its spatiotemporal variants [ST-DBSCAN](https://www.sciencedirect.com/science/article/abs/pii/S0169023X06000218) and DBSCAN-TE) cluster points spatially with time as an extra dimension. [scikit-mobility](https://github.com/scikit-mobility/scikit-mobility) ships Lachesis directly; [movingpandas](https://movingpandas.org/) wraps a similar detector. The transit between stops, in these pipelines, is whatever's left over.

trajkit does something different. It treats both kinds of boundary as primary signals: the motion-state change (stop ↔ move) *and* the sustained direction change within a move. The second one is the harder problem and the more interesting part of this writeup — when you only segment on stops, a forty-minute drive across town becomes one undifferentiated MOVE, and any analysis you do at the segment level loses the structure of the trip.

![A week of GPS as three time-aligned grains: pings, segments, episodes.](/figures/trajkit/time_ribbon.png)

*The pipeline, as time. A week of GPS becomes a handful of typed segments, which group into named episodes — all on one clock. The long blue TRIP is one journey; its white gaps are the direction-change splits this post is about. Three grains fall out: typed segment, named episode, similarity index.*

## The headline: bearing concentration as a boundary signal

Splitting moves on direction change has a clear intuition behind it: if the bearing changes, something about the trip context probably changed — the entity turned off a highway, walked around a corner, joined a different road. The challenge is measuring "direction change" in a way that fires on real turns and stays quiet on noise.

![The same cross-town walk: one undifferentiated blob versus legs split at the turns.](/figures/trajkit/blob_vs_split.png)

*The payoff. The same cross-town walk: stop-first segmentation leaves it as one undifferentiated unit (left); trajkit splits it into legs at the turns (right) — structure any segment-level analysis can use.*

The temptation is to threshold the per-step bearing delta or its rolling average. This fails because bearings are *angular*, and ordinary arithmetic doesn't respect the wrap at 360° → 0°. A heading that holds steady due north jitters between 359° and 1°; average those *numbers* and you land deep in the south — the opposite of the truth — with a "spread" that screams instability at a perfectly straight walk. The same blindness cuts the other way: a single sharp turn, diluted across many straight steps, has the same mean step-delta as gentle noise around a fixed heading. Only the first is a boundary; the second is straight-line walking with GPS jitter.

![A real northbound walk whose headings average to north as directions but to south as degrees.](/figures/trajkit/why_circular.png)

*Why circular statistics, not arithmetic. A real walk heading due north: the headings barely move, but as raw degrees they whipsaw between 0° and 360°. Average the numbers and you get 163° — pointing south, the opposite of the truth. Average the* directions *(the green arrow) and you get north. trajkit works in directions.*

**Mean resultant length** R sidesteps both cases. Map every bearing to a unit vector on the circle, take the vector mean, take its magnitude. R close to 1 means the bearings cluster (the entity is heading one direction); R close to 0 means they spread around the circle (direction is changing). R is a circular-statistics summary that holds regardless of where on the circle the bearings sit — the same test works whether the entity is heading north or south.

![Compass arrows agree on a straight stretch and fan out at the corner.](/figures/trajkit/how_concentration.png)

*What the detector measures. Take each GPS heading as an arrow on a compass and average them. On a straight stretch the arrows agree and the average is long; at the corner they fan out and the average collapses to a stub. That length — the mean resultant length R — is the boundary signal.*

A few choices stack on top of R:

**Distance windows, not time windows.** A 200 m window contains the same amount of physical-behaviour magnitude whether the device logs at 1 Hz or 1/min. A 30-second window does not. This makes the detector ping-rate invariant — the same parameters work on pedestrian 1 Hz cadence and vehicular 5-second cadence.

**Multi-scale: two windows.** A 75 m window catches street-corner turns; a 200 m window catches arterial / sustained sweeps. The entry signal fires when R falls below 0.80 in *either* window. The exit signal demands R above 0.92 in *both*. The asymmetric thresholds form a Schmitt trigger — once you're in the "direction changing" state, you need a clean straight run to release, not just R skimming back across the entry threshold.

The threshold of 0.80 sits just above a math floor: a clean 90° turn centred in the window has R ≈ √0.5 ≈ 0.707. Picking 0.80 means the detector also catches sub-90° arterial bends, not only sharp corners.

**Distance hysteresis on R itself.** The signal has to persist over 30 m of trajectory distance before the state flips. A one-ping bearing spike inside an otherwise straight leg doesn't fire a boundary, even when its R-window dips briefly. Three layers of resistance to flicker, each addressing a different scale: R smooths over the window, the asymmetric thresholds prevent threshold-skimming, and the sustainment requires the state to commit.

**Sparse-cadence adaptation.** On vehicular cadence (5-second pings at 50 km/h ≈ 70 m per ping), a 75 m window holds about one ping and R is undefined almost everywhere. The detector measures the trace's median per-ping displacement and lowers the minimum-pings guard accordingly — typically to about half the window's ping count — when the configured ceiling would otherwise be unsatisfiable. Without this, the detector goes blind on anything coarser than dense pedestrian data.

**Stop-period bearings are masked out** of R. They're GPS jitter at near-stationary points and would pollute the unit-circle vector mean with noise that has nothing to do with direction. Cumulative distance is also computed motion-only, so a pause inside a journey doesn't burn the window with no-progress pings.

The result is a detector that fires on sustained, meaningful direction changes — a street corner, an arterial sweep, a turn off a highway — and stays quiet through long straight legs, single sharp spikes, and stop-and-go noise.

![A real corner coloured by heading-steadiness, cut exactly at the bend.](/figures/trajkit/split_zoom.png)

*The cut, on a real corner. The same trajectory coloured by how steady the heading is — blue along each leg, orange at the bend. The detector splits exactly where the heading turns: no stop, no gap, just a sustained change of direction.*

<details>
<summary><strong>Try it yourself</strong> — slide a window along ten sample paths and watch R update, splits fire, and segments form</summary>
<iframe id="bearing-demo" src="/demos/bearing/index.html" loading="lazy" title="Bearing detector playground" style="border:0;width:100%;height:600px;margin-top:12px;display:block;background:transparent;"></iframe>
</details>
<script>
  // The embedded demo posts its content height up; mirror it onto the iframe
  // so there's no internal scrolling and the widget blends with the post.
  window.addEventListener("message", (e) => {
    if (e?.data?.type === "bearing-demo-resize" && typeof e.data.height === "number") {
      const iframe = document.getElementById("bearing-demo");
      if (iframe) iframe.style.height = (e.data.height + 4) + "px";
    }
  });
</script>

## Motion state and the segment taxonomy

The second boundary kind is the well-trodden one: stop ↔ move. A single speed threshold flickers around the boundary. Two thresholds with a dead zone — `stop_speed_kmh = 2.0` to enter stopped, `resume_speed_kmh = 5.0` to re-enter moving — eliminate the flicker. The parameter model rejects `resume ≤ stop` at construction time so the hysteresis can't be accidentally inverted.

![One speed trace, two state readouts: a single threshold flips 59 times, the dead zone 6.](/figures/trajkit/hysteresis.png)

*Two thresholds, not one. On a real trace where speed wobbles across the line, a single cutoff flips between moving and stopped 59 times; the dead zone between two cutoffs flips 6. (Shown with the pedestrian calibration — 1 and 3 km/h — rather than the 2 / 5 km/h defaults in the text.)*

Three additional rules tighten the four-state taxonomy (`MOVE`, `MOVE_BRIEF`, `STOP_BRIEF`, `STOP_DWELL`):

- Stop runs shorter than 30 seconds are reclassified as moving — too short to be a real stop, almost certainly hysteresis tripping on a momentary speed dip.
- A candidate `STOP_*` segment with crow-fly displacement above 500 m is reclassified as `MOVE`. Catches slow stop-and-go traffic where the mean speed stays below the stop threshold for ten minutes but the entity covers a kilometre.
- `MOVE` candidates with fewer than 5 pings or duration below 3 minutes become `MOVE_BRIEF`, separating real legs of a trip from momentary repositioning.

## Cleaning: quality flags with precedence

Five labels with explicit precedence, applied per ping: `DEVICE_FAULT > SPEED_OUTLIER > GAP_FOLLOWS > DRIFT > VALID`. Each handles a different real-world failure mode (sensor reporting motion at a stuck position, implausibly high derived speed, an inter-ping gap that spans an unobserved interval, stationary GPS jitter).

The interesting choice is the precedence order. A gap larger than `gap_threshold_min` makes the row's derived kinematics meaningless — the displacement covers an unobserved interval, the implied speed is "displacement / a long time." Drift heuristics ("tiny movement at near-zero speed") only apply when inter-ping spacing is normal. So `GAP_FOLLOWS` outranks `DRIFT`; without that ordering, an offline device coming back online with small apparent displacement gets silently stamped DRIFT and the segmenter grows a segment across the unobserved interval.

## Episodes: spatial-envelope STAY / TRANSIT

Segments give a useful grain for behavioural questions but stay too fine for "what trip was this?" Episodes are runs of segments that form one named operational unit — a `STAY` (the entity was here) or a `TRANSIT` (the entity was going somewhere). The recipe is closer to Lachesis territory: a `STAY` is a maximal run of segments whose endpoints stay within radius `R_m` of a running anchor centroid, allowing a `T_s` grace window outside the envelope before closure. Anything else becomes a `TRANSIT`.

Two specifics matter:

**Endpoint-aware containment.** The natural containment check is "is the segment's centroid within `R_m` of the anchor?" That fails for spatially-extended `MOVE` segments. A ten-minute walk traversing a few hundred metres has a centroid that's trivially within `R_m` of itself; a centroid-only check would let that walk anchor a single-segment "stay" by passing the duration gate alone. Checking both `start` and `end` endpoints fixes this — a segment whose start and end are far apart cannot be inside any small envelope. For stationary segments where start ≈ end ≈ centroid, the endpoint check reduces to the centroid check.

![A real winding walk whose centre is inside a small envelope but whose endpoints are not.](/figures/trajkit/centroid_endpoint.png)

*Why both endpoints, not the centre. A real ten-minute walk — ~500 m of path, endpoints ~250 m apart — that sits long enough to pass the duration gate. Its centre is trivially inside a 30 m envelope, so a centre-only check would accept it as a stay; checking both endpoints rejects it — they fall well outside.*

**Dual qualification gate.** A stay qualifies only if `stay_duration_s ≥ min_stay_s` AND `max_observed_radius ≤ R_m`. Duration alone admits the centroid case above; radius alone admits drive-through pass-bys. The anchor itself is a running mean over in-envelope segments, not pinned to the first segment, so parking-then-drift-to-bay resolves to one stay rather than two.

![Ten near-stationary segments orbiting a settling anchor inside the envelope, one straying out.](/figures/trajkit/stay_anatomy.png)

*Anatomy of a real STAY (10 segments). Near-stationary segments orbit a running anchor (the star) inside the 30 m envelope; the anchor settles as segments are absorbed. One segment strays past the envelope and is kept by the `T_s` grace window rather than closing the stay.*

## Per-segment vectors and similarity

Each segment becomes a 33-dimensional float32 vector with five blocks: logarithmically compressed kinematic magnitudes (`log1p` of duration, path length, displacement, max speed), sin/cos encodings of hour-of-day and day-of-week, a one-slot-per-type indicator for segment type, spatial endpoints scaled to a cohort bounding box, and distance-resampled bearing-shape statistics. The shape block carries a calibrated multiplier so it doesn't get drowned by the kinematic block once each vector is rescaled to unit length. A FAISS exact-inner-product index over the vectors gives k nearest neighbours by cosine similarity. Episode-level similarity uses a separate trip-native feature set: pooling per-segment vectors discards trip order and washes out the shape signal the embedding worked to encode, and the raw episode-level scalars you'd add to compensate then dominate the L2-normalised pool. A trip-native vector — motion-state mix, scale, speed band, shape, time context — is the fix.

What features matter for any specific use case depends on the downstream question, so the embedding here is one workable starting point rather than a universal answer. The chunking that feeds it is what the rest of this writeup argues for in detail.

![A query trip beside its four nearest neighbours — the same staircase shape of journey.](/figures/trajkit/similarity_gallery.png)

*"Find me trips like this one." Nearest neighbours by the trip-native embedding — same shape, scale and rhythm of journey, found anywhere on the map. The match is on what the journey was, not where it happened. (Arrows show travel direction; on the segment embedding, a neighbour-purity check retrieves same-type segments ~89% of the time against a 38% random baseline.)*

## Validation

The end-to-end pipeline runs on [Microsoft Geolife](https://www.microsoft.com/en-us/research/publication/geolife-gps-trajectory-dataset-user-guide/) (pedestrian + multi-modal Beijing). The accompanying notebook ([`examples/geolife/explore.ipynb`](https://nbviewer.org/github/darmaaz/trajkit/blob/main/examples/geolife/explore.ipynb)) walks every design decision through visible real-data examples — segment-coloured trajectory maps, the bearing R-curve overlaid on raw bearings at real boundaries, anatomy of one STAY and one TRANSIT, segment-similarity demos, and a neighbour-purity benchmark for the embedding.

![A week of one person's segments coloured by type across a city.](/figures/trajkit/segment_map.png)

*One person, one week. Every segment coloured by type (Okabe–Ito, colour-blind-safe). Blue threads are the trips; the warm clusters are the recurring stops. The pipeline output is sensible on real, messy data.*

## Stack

Python 3.12. pandas, numpy, pydantic v2, pandera, pyarrow, h3, pyproj, faiss-cpu. ruff + mypy strict + pytest on every commit. Schemas declared twice (Pandera for runtime, Arrow for parquet round-trip) with a test asserting they agree.

[github.com/darmaaz/trajkit](https://github.com/darmaaz/trajkit) · [Notebook on nbviewer](https://nbviewer.org/github/darmaaz/trajkit/blob/main/examples/geolife/explore.ipynb)
