---
title: "Probabilistic trajectory reconstruction from sparse GPS"
description: "What can be recovered from GPS pings sampled every two minutes — measured on Porto taxi data with the dense 15-second cadence as the held-out ground truth."
pubDatetime: 2026-06-08T00:00:00Z
featured: true
tags:
  - gps
  - map-matching
  - trajectory
  - python
  - probabilistic
---

A reference pipeline for reconstructing what a vehicle did between sparse GPS pings, when the input is a road map and nothing else.

[github.com/darmaaz/gps-trajectory-reconstruction](https://github.com/darmaaz/gps-trajectory-reconstruction)

## What's between the pings

GPS is a second-hand signal. The device samples a position every few seconds, which under certain tight cost constraints can stretch to once every minute or more, and reports a noisy estimate of where the vehicle was at each sample. Between samples the truth is hidden. Two reported pings two minutes apart are consistent with multiple routes the vehicle could have taken between them, and the route taken determines how the interval split between transit and dwell. The time budget for any reconstruction is fixed by the timestamps: `budget = t_first[k+1] − t_first[k]`. The route taken determines `expected_travel_time(path)`. What's left over — `budget − expected_travel_time(path)` — is the time the vehicle would have been stationary if it took that path. A faster route along a four-lane road leaves time the vehicle would have spent stationary; a slower route through a residential network consumes the full interval and leaves none. Knowing the path constrains the dwell, knowing the dwell constrains the path, and the observations alone constrain neither tightly. The reconstruction this pipeline produces is a distribution over paths whose members each carry their own implied dwell.

![Four plausible reconstructions of the same 120-second transition, each with its implied dwell.](/figures/gps-reconstruction/fig1_two_pings_four_stories.png)

*One real 120-second transition between two reported pings, reconstructed four ways. Each candidate path implies a different dwell — shorter routes leave more time-budget unaccounted-for, longer routes consume it. The figure does not claim where in the interval the dwell occurred; allocation convention is a separate modelling choice.*

Most map-matching pipelines — map-matching being the task of aligning noisy GPS positions to the roads actually driven — pick one of those stories. They run the observations through a [hidden Markov model](https://en.wikipedia.org/wiki/Hidden_Markov_model), which treats the true road position as a hidden state to be inferred from the noisy reports, and return the Viterbi-best path — the single sequence of road segments with the highest joint probability given the data. The single path is what trip displays, mileage logging, and routing UIs need, and it is the right answer for those uses most of the time.

The cost of returning only the single path is that downstream analyses asking questions about the distribution the single path summarises do not get that distribution. "What is the range of plausible dwell at customer X" is a range. "How confident are we the vehicle traversed road R" is a probability. "Was this trip a typical variant of this driver's usual route" is a comparison against a posterior — the probability distribution over what happened, after the observations have had their say. These questions can be asked from the same observations the standard approach already runs through — they need the candidate set the Viterbi argmax was taken over.

This pipeline produces and reports that candidate set alongside the single-path summary, and derives two further objects from it.

![Pipeline block diagram from raw pings through preprocessing, state projection, candidate enumeration, and CRF inference to three outputs.](/figures/gps-reconstruction/fig2_pipeline_overview.png)

*Five conceptual stages, three terminal artefacts. The same model class as standard HMM map-matching, with the posterior the Viterbi summary marginalises over surfaced as first-class outputs.*

The three artefacts:

- the **Viterbi-best path** that the standard approach returns, as a coherent single-story summary of the posterior;
- a **per-edge marginal probability** `P(E ∈ path) = Σ_p r(p) · 1[E ∈ p]` that any given road segment was traversed during the trip, summed across all candidate paths that contain it, where `r(p)` is the posterior weight of path `p`;
- a **per-path inferred dwell** `time_budget − expected_travel_time(path)`, the residual time the vehicle is implied to have spent stationary on the way if it took that path. Different candidates carry different inferred dwells, and the posterior over paths induces a distribution over dwell.

Edge marginals are the query target for spatial questions about the trip. Dwell annotations are the query target for time-allocation questions. Both come from the same posterior. The Viterbi summary is preserved for consumers who want one path on one map.

This pipeline is the sister to [trajkit](/posts/trajkit-searchable-chunks-from-noisy-gps/), which handles segment- and episode-level chunking at a coarser grain. Together they cover the segmentation-then-reconstruction spine of trajectory analysis: trajkit answers "what are the operational chunks this trip decomposes into," this article answers "and within a chunk, what's the distribution of plausible paths the vehicle took to traverse it."

## What the article shows

The article carries two measured results from running this pipeline on Porto taxi data. The dataset logs one ping every 15 seconds; downsampling each trip to a 120-second cadence puts the input at the sparse-sampling regime that cost-constrained fleet GPS and asset-tracking deployments operate in, while the dropped 15-second pings (the seven of every eight pings the 120-second pipeline didn't see) provide raw-observation ground truth to score the 120-second reconstruction against. The dropped pings are the actual GPS reports, not a model's reconstruction; the comparison is reconstruction-vs-data rather than reconstruction-vs-reconstruction.

![A 15-minute Porto trip with 15-second pings as small dots and 120-second pings as larger orange markers, overlaid on the road network.](/figures/gps-reconstruction/fig3_downsampling_simulation.png)

*A real ~16-minute Porto trip at both cadences. The 9 orange markers are what the 120-second pipeline sees; the 56 small dots are what it doesn't. The dropped pings are the raw GPS observations the pipeline is scored against.*

**Capacity** — does the pipeline's candidate set contain a path that faithfully reproduces what the vehicle actually drove? The drive is scored directly against the raw 15-second GPS pings, with two gates: a candidate has to pass within δ = 25 m of every ping (recall) *and* keep almost all of its own length near the ping trail (precision, ≤ 25% excess). On transitions where the route is structurally recoverable from 120-second data, a candidate clears both gates 93.8% of the time (96.4% on recall alone). The four-way decomposition of capacity outcomes, the two thresholds, and the δ sweep are in the Coverage section.

**Calibration** — when the model says edge `E` has probability `p` of being traversed, does it land near `p` empirically? Across all five bins the reliability curve runs close to and slightly under the diagonal; the two upper bins are the widest, at 7 and 10 percentage points — smaller than earlier configurations of this pipeline, and now measured against a ground-truth ruler rebuilt so wrong-way corridors count as driven rather than as misses. The reliability table and the high-bin diagnosis are in the Calibration section.

## How the pipeline gets there

The pipeline lives in five conceptual stages: preprocessing, state projection, path enumeration, CRF inference, and dwell derivation.

**Preprocessing** offloads observation-level pathology so inference sees a clean sequence. Sentinel coordinates, out-of-range lat/lon, and high-HDOP pings (the device's own satellite-geometry quality flag) are dropped. Consecutive reports within ε metres of each other are collapsed into a single observation tagged `(position, t_first, t_last, count)` — the span `t_last − t_first` becomes the *confirmed dwell* at that observation, a floor on the time the vehicle was stationary there. Stale runs — long static spans on a device whose true position was actually moving, common in cached-position chip behaviour — are detected by checking whether the minimum routable time from the static span's start to the next observation is feasible from `t_last` (the end of the static span) or only from `t_first` (its start). When only the latter is feasible, the static span is flagged stale and contributes zero confirmed dwell to the budget arithmetic. Single-ping kinematic spikes (chip glitches) are removed; long bursts of buffered-replay packets are collapsed.

The output is a sequence of `(position, t_first, t_last, stale_flagged)` observations. The inference layer treats them as ordinary low-frequency GPS.

**State projection.** Each preprocessed observation is projected onto its top-K nearest road edges by perpendicular distance, within a 50 m search radius and capped at 5 candidates per observation. Each candidate state carries `(edge, offset_along_edge, entry_time)`.

**Path enumeration.** Between consecutive observations the pipeline enumerates feasible paths using [A\*](https://en.wikipedia.org/wiki/A*_search_algorithm) — best-first graph search over the road network — with travel-time cost (length divided by max-speed-per-edge). Accepted paths are pruned against an inflated time-budget cap: each path's expected travel time must be at most `path_budget_slack × time_budget`, with `path_budget_slack = 1.5` as default. The 1.5 slack is empirically grounded — Porto taxis exceed posted limits frequently enough that a 1.2 slack drops the true route from the candidate set in a measurable fraction of transitions. 1.5 absorbs that without inflating the set so much that downstream marginalisation is dominated by implausibly fast paths.

A single shortest-path search collapses the candidate set onto near-duplicates of the optimum. The pipeline diversifies via the plateau / penalty method: after each accepted path, its edges are multiplicatively surcharged by `(1 + λ)` with `λ = 0.3`; the next search penalises re-using those edges and tends to find structurally different paths (highway vs surface street, detour around a bottleneck) rather than near-duplicates. The cap is 100 paths per transition; A\* usually terminates earlier on the budget-slack constraint, producing a median of ~33 paths per transition.

Enumeration runs on a *permissive* road graph: alongside the legal directed edges, every one-way edge carries a penalized reverse arc, so the candidate set can include the wrong-way maneuvers vehicles actually make rather than being forced onto legal detours around them. The penalty keeps these candidates out of the posterior unless the evidence demands them; the wrong-way section below works through a case where it does.

Each accepted path carries `(edges, start_offset, end_offset, expected_travel_time, length_meters, time_budget, reversed_mask, feature_vector)`. `inferred_dwell = time_budget − expected_travel_time` is a derived property — never stored, never stale relative to the budget under which the path was enumerated.

**CRF inference.** The pipeline runs forward-backward over a conditional random field (CRF) — a probabilistic model that scores a whole trajectory as a product of local compatibility terms, its *factors*; forward-backward is the two-sweep dynamic-programming routine that turns those scores into per-step probabilities. The factors are:

- a **heavy-tailed emission** `ω(y_k | x_k)` — the term scoring how plausibly a candidate road position explains the reported one — Student-t with scale 10 m and degrees-of-freedom 4, on perpendicular distance from the reported position to the candidate edge. Student-t rather than Gaussian because its heavier tails treat occasional large errors as expected rather than catastrophic: residual upstream pathology not caught by preprocessing should be absorbed rather than allowed to dominate the posterior.
- a **path factor** `η(p) = exp(μᵀφ(p))` parameterised by `μ`, where `φ(p)` is a 19-dimensional feature vector over the path (length, n_turns, road-class fractions, expected travel time, projection-distance from endpoints to their observations, and a count of wrong-way maneuvers). The pipeline ships a `μ` fit by supervised MLE on Porto (‖μ‖ ≈ 5). One weight earns its place decisively — the direction-violation penalty (slot [18], −2.78 per wrong-way maneuver) that lets the model admit a route the directed map forbids when the GPS evidence demands it; the ordinary route-preference weights add little on taxi data. Both the wrong-way mechanism and the near-noise preference signal are detailed below.

Forward-backward yields per-observation state marginals `q^k` and per-transition path marginals `r^k(p)` — a *marginal* being the probability of one thing (this state, this path) with everything else summed out — both in log-domain. Viterbi yields the most-likely interleaved sequence of states and paths. When a transition has zero feasible paths, the trajectory is split at that boundary — the segment terminates, a `Discontinuity` record is emitted with structural context, and a new segment begins at the next observation that does have candidates.

**Edge marginals** are derived post-hoc:

```
P(E ∈ path_k) = Σ_p r^k(p) · 1[E ∈ p]
```

An edge in every candidate has `P = 1`. An edge in no candidate has `P = 0`. An edge in some candidates carries a probability between, weighted by how much posterior mass sits on the paths containing it.

## Coverage: can the candidate set construct what the vehicle actually drove?

The ground truth is the **raw 15-second GPS pings** — the device's own reports, not a reconstruction of them. An earlier version of this check scored candidates against the 15-second *Viterbi reconstruction*, which is itself a model output with its own spurs and disconnections; scoring one reconstruction against another is circular. Grounding the metric on the raw pings removes that circularity, at the cost of the pings carrying their own GPS noise — which is exactly what the tolerance δ is for.

A candidate is judged on its **offset-trimmed path geometry** (the terminal edges clipped to where the path actually enters and leaves them, not their full length), against two gates and one diagnostic:

- **recall** — every raw ping in the window lies within δ of the candidate. This says the candidate *covers* the drive.
- **precision** — at most a fraction of the candidate's own length lies farther than δ from the ping trail. This says the candidate *didn't pad the drive with extra road*: a recall-covering candidate that loops around the block to reach the same pings is rejected here. The gate is set at ≤ 25% excess, drawn from the excess distribution (the best recall-covering candidate's excess has p75 = 4% and p95 = 20%, so 25% clears the projection-noise mass and rejects only genuine detour padding).
- **direction** — the time-ordered pings thread the candidate in non-decreasing arc order. This is recorded as a **diagnostic flag only, never a gate**: a genuine reversal is a non-simple drive, not a candidate fault (7 of the 181 faithful windows flag, and they correspond to real maneuvers, not enumeration errors).

A window is *capacity-covered* if some candidate passes both gates. The two thresholds — δ in metres and the excess fraction — are the only tuning the metric exposes; per-ping and per-sample distances are stored, so both sweep without recomputing.

![Cumulative coverage curve of distances from each dropped 15-second ping to the nearest candidate footprint, with δ=25m marked.](/figures/gps-reconstruction/fig4_ping_footprint_distance.png)

*The distance distribution decomposes into a projection-noise body (0–25 m) and a small structural-miss tail (>50 m, 33 pings out to 264 m). δ = 25 m covers 96.6% of dropped pings and sits at the knee — widening the tolerance a further 10 m buys only +0.7%, so it is past the noise mass but before tolerance starts absorbing genuine misses.*

Of 349 windows, 137 (39%) are *data-gaps* — the raw polyline teleports across them, so there is no continuous ground truth to score against — leaving 212 scoreable windows. The recall-only four-way decomposition at δ = 25 m makes the failure modes legible. *Capacity_ok* (186, 87.7%) is the success case — some candidate threads every raw ping. *Off-footprint excursion* (19, 9.0%) is the case where dropped pings sit off every candidate's footprint — the vehicle drove roads no candidate covers. These are non-simple excursions (parking loops, out-and-backs, same-edge backtracks) that the simple-path enumerator structurally cannot produce, which is why they are the one bucket excluded from the headline denominator as un-constructible. *On-footprint split* (3, 1.4%) is the failure mode where the road exists in the candidate footprint but no single candidate threads the full sequence — the right edges are there, distributed across different candidates rather than concentrated in one. *Generator gap* (4, 1.9%) is the case where a kept (observed) ping is missed, a structural failure of the enumeration.

Excluding only the 19 off-footprint excursions as provably un-constructible (nothing else is dropped from the denominator) leaves 193 recoverable windows. On recall alone the pipeline threads **96.4% (186 / 193)** of them; layering the precision gate on top — recall *and* ≤ 25% excess — drops 5 recall-covering-but-padded candidates and gives the operational headline of **93.8% (181 / 193)**. When the data is sufficient to recover the route from 120-second sampling, the pipeline produces a faithful candidate 93.8% of the time.

![Stacked area chart showing how capacity outcomes shift as δ varies from 10 to 50 metres; the green band is the precision-gated capacity, with the recall-only and three failure bands stacked above.](/figures/gps-reconstruction/fig5_capacity_by_delta.png)

*The green band is the headline — windows where some candidate passes both gates (recall ∧ ≤ 25% excess) — read at its top edge: 85% of scoreable windows at δ = 25 m, climbing from 34% at δ = 10 m to 92% by δ = 50 m. The amber band above it is recall-covered windows the precision gate rejects as having driven extra road. The off-footprint excursion share settles to a near-flat ~8–10% structural floor by δ = 25 m — non-simple excursions the candidate enumeration can't produce at any tolerance — while generator_gap and on-footprint split shrink to near zero.*

What the precision gate buys is the distinction between a candidate that drove the road and one that merely passed near every ping on a longer detour: of the 186 recall-covered windows, it rejects 5 whose extra length marks them as padded, leaving the 181.

## When the true route is illegal: wrong-way corridors

The route the taxi drove in Figure 1 is one the road map forbids. The corridor between those two pings is a one-way street in Porto, and the taxi drove it against the arrow. A one-way street is a single directed edge the router cannot traverse backward, so the driven route was *unconstructible* — it never entered the candidate set, and the model put two-thirds of its posterior weight on a legal loop running ~51 m off the truth. Confidently wrong, and recall-only coverage couldn't see it.

![Before-and-after of the Figure 1 transition. Left: with directed-only routing, every candidate is a legal detour and the posterior winner sits 51 m off the truth. Right: with wrong-way routing on, the corridor enters the set, hugs the truth, and wins.](/figures/gps-reconstruction/fig_wrongway_before_after.png)

*Both halves are the same transition; steel-blue dots are the dropped 15-second truth pings. **Left (before)** — directed-only routing: all four candidates are legal loops, and the posterior winner (gold frame, C, weight 0.65) runs 51 m off the route the vehicle drove. **Right (after)** — with wrong-way routing on, the corridor enters the candidate set as panel A, threads the truth at 1 m, and takes the posterior (gold frame, weight 0.51). The winner goes from a route the vehicle didn't drive to the one it did.*

The fix routes on a *permissive* graph where one-way edges carry a penalized reverse arc, priced per wrong-way maneuver rather than per edge. With it on, the corridor enters the candidate set and wins — threading the truth at 1 m against the detour's tens of metres. It is a real street, checkable against the world rather than just the OSM tag: [Google Street View of the corridor](https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=41.196383,-8.656559&heading=173), facing the legal direction the taxi drove against.

Confidence in an illegal route is legitimate because the penalty (−2.78 per maneuver) keeps wrong-way candidates out of the posterior unless the geometry overwhelms it, and that confidence is calibrated: among the edges the model is sure about (`P ≥ 0.5`) that are wrong-way, 96% were actually driven. Turning the mechanism on moved failing windows from 11% to 7%, against about 1 window in 200 regressing on a low-confidence wrong-way shortcut.

## Calibration: is the model's confidence trustworthy?

For each candidate edge `E` in some candidate path of some transition, the model assigns a marginal probability `P(E ∈ path)`. The calibration question is whether that probability corresponds empirically to traversal frequency. Per bin of predicted `P`, what fraction of edges in that bin were actually traversed? The ground-truth ruler here is deliberately `μ`-independent — a generic physics-only length prior, not the shipped driver model — so the reliability check doesn't grade the model against itself. It is, however, direction-violation-capable: the truth route can run down wrong-way corridors rather than scoring them as misses, so calibration is not blind to exactly the routes the previous section's penalty fixed.

![Reliability diagram of edge-marginal calibration, with predicted P on the x-axis and empirical traversal rate on the y-axis.](/figures/gps-reconstruction/fig6_edge_marginal_reliability.png)

*Five bins, bin populations annotated. The curve runs close to and slightly under the diagonal across the full range — predicted 0.30 → empirical 0.26, 0.49 → 0.45, 0.70 → 0.63, 0.99 → 0.89 (the lowest bin, predicted 0.01, sits just above at 0.03). Rank-calibrated throughout, with mild overconfidence concentrated at the backbone where alternative paths are structurally absent.*

Across all five bins the curve stays close to the diagonal, slightly under it. The two upper bins are the widest gaps — about 7 percentage points at [0.6, 0.8) and 10 at [0.8, 1.0] — and they concentrate on backbone edges, where almost all candidates agree and within-transition correlation among edges injects finite-sample variance into the bin estimate. The [0.6, 0.8) gap in particular is much smaller than in earlier configurations of this pipeline (where it ran to ~16 points): offset-trimming the path geometry removed the phantom terminal segments that used to collect probability mass off the true route, and the direction-violation handling stopped debiting the model for wrong-way corridors it now represents correctly. The lower three bins — the operationally informative range, where multiple candidates carry plausible mass and the consumer most needs to trust the model's confidence — land within about 4 points of the diagonal.

## Inferred dwell as a derived posterior

Each candidate path carries `inferred_dwell = time_budget − expected_travel_time(path)`. The posterior over paths at transition `k` induces a posterior over dwell:

```
P(dwell_k = d) = Σ_p r^k(p) · 1[inferred_dwell(p) = d]
```

For consumers asking "what's the plausible range of dwell at this point in the trip," this is the answer — a discrete distribution over dwell values, each weighted by the posterior mass of paths that imply it. The most likely path gives a point estimate; the credible range comes from the spread.

The pipeline does not localise *where in the interval* the dwell occurred. The same time budget split (say, 30 seconds of dwell across a 120-second interval that includes a 90-second drive) is consistent with the dwell being at the start of the interval (vehicle stopped, then drove), at the end (vehicle drove, then stopped), or distributed along the way. Three allocation conventions are exposed — front-loaded, back-loaded, evenly spread — as a configuration layer used when off-grid position queries are needed. The choice of allocation rule is a configurable convention, not a learned property.

![Stem plot of inferred_dwell across candidate paths for one transition, with the 15s-reference dwell marked at 30 seconds.](/figures/gps-reconstruction/fig7_inferred_dwell_transition.png)

*One transition's full candidate set re-indexed by `inferred_dwell`. The posterior over paths becomes a posterior over dwell. The dense-cadence (15-second) reference at 30 seconds falls inside the candidate set's support; the posterior puts most weight on dwells in the 40–45 second range, so the model and the reference disagree about the point estimate while agreeing on the range of plausible answers.*

## The driver-preference model: one weight that matters, and the rest that doesn't

The path factor `η(p) = exp(μᵀφ(p))` is built to absorb learned driver-preference signal when such signal exists. It is worth separating two kinds of weight it carries. One is *structural* — the direction-violation penalty `μ[18]`, which encodes a hard fact about how vehicles relate to one-way roads, not a taste. That weight is load-bearing: at −2.78 per maneuver it is what lets the wrong-way corridor win when the evidence demands it while staying out of the posterior when it doesn't, and the capacity and calibration numbers above depend on it (turning the violation handling on moved failing windows from 11% to 7% and tightened the upper calibration bins). The pipeline ships a trained `μ`, and this is the weight that earns its training.

The other kind is *preference* — length, turn counts, road-class fractions, the features that would encode "this driver prefers arterials" or "this fleet avoids left turns." On Porto taxi data these add little. Taxi data is structurally hostile to learned driver preference: different drivers, different destinations, traffic-dependent routing, no stable per-driver habit for the model to latch onto. Refitting the preference weights by maximum likelihood produces only near-noise movement on the 40-trip held-out evaluation — the apparent gains mostly tracked correcting stale shipped artefacts rather than the model learning real preference signal. The structural weight matters on this data; the preference weights, on this data, do not.

Whether commuter-fleet data or structured delivery-fleet data carries learnable driver *preference* is a separate question. The pipeline is built to absorb that signal cleanly if it exists in the data; on Porto, the preference part doesn't, while the structural part does.

## What this earns its cost for

Edge marginals support spatial queries: "did the vehicle traverse road R," "what fraction of plausible reconstructions pass through district X," "is the trip a credible variant of this driver's usual route." Per-path dwell distributions support time-allocation queries: "what's the plausible range of stationary time at customer Y," "is the reported 12-minute dwell within the credible range under the pipeline's posterior." The Viterbi path remains available for consumers who want one route on one map; the rest of the machinery is for consumers who want to act on the distribution behind it.

## Stack

Python 3.12. numpy, scipy, networkx for the routing graph, rtree for spatial indexing, [osmium](https://osmcode.org/osmium-tool/) for parsing the OpenStreetMap (OSM PBF) extract, [shapely](https://shapely.readthedocs.io/) for geometry. The capacity measurements use 349 windows from 50 trips (212 scoreable after data-gaps, 193 recoverable after the un-constructible excursions); the calibration measurements use roughly 18,000 edge-instances from 40 held-out trips, scored against the `μ`-independent length-prior ruler.

The repo: [github.com/darmaaz/gps-trajectory-reconstruction](https://github.com/darmaaz/gps-trajectory-reconstruction). The companion article on segment-level chunking, which this pipeline is the sister project to, is at [/posts/trajkit-searchable-chunks-from-noisy-gps/](/posts/trajkit-searchable-chunks-from-noisy-gps/).

## References

- Newson, P. & Krumm, J. (2009). *Hidden Markov Map Matching Through Noise and Sparseness.* Proc. ACM SIGSPATIAL.
- Hunter, T., Abbeel, P. & Bayen, A. (2013). *The Path Inference Filter: Model-Based Low-Latency Map Matching of Probe Vehicle Data.* IEEE T-ITS 15(2).
- Microsoft Research, [Porto taxi trajectory dataset](https://www.kaggle.com/c/pkdd-15-predict-taxi-service-trajectory-i).
