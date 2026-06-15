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

A GPS device reports a position every few seconds — and on cost-constrained fleet hardware, sometimes only once a minute or more. Each report is a noisy estimate, and between reports the vehicle's path is unknown. Two pings two minutes apart fit many possible routes, and which route the vehicle took decides how those two minutes split between driving and sitting still.

The timestamps fix a time budget for the gap: `budget = t_first[k+1] − t_first[k]`. A given path uses up `expected_travel_time(path)` of it, and whatever is left, `budget − expected_travel_time(path)`, is time the vehicle must have spent stationary. A fast route down a four-lane road leaves time over for a stop; a slow route through side streets uses the whole budget and leaves none. So the path tells you the dwell and the dwell tells you the path — but the pings alone pin down neither. What this pipeline returns is not one answer but a set of plausible paths, each carrying the dwell it implies.

![Four plausible reconstructions of the same 120-second transition, each with its implied dwell.](/figures/gps-reconstruction/fig1_two_pings_four_stories.png)

*One real 120-second gap between two reported pings, reconstructed four ways. Each path implies a different dwell — a shorter route leaves more of the budget for a stop, a longer route uses it up. The figure doesn't say where in the gap the stop happened; that's a separate choice.*

Most map-matching pipelines pick one of those paths. They feed the pings to a [hidden Markov model](https://en.wikipedia.org/wiki/Hidden_Markov_model), which treats the true road position as a hidden state behind each noisy report, and return the single most likely sequence of road segments: the Viterbi-best path. One path is what a trip display, a mileage log, or a routing screen needs, and for those it is the right call.

What you give up by keeping only that one path is the rest of the distribution it stands for. Some questions need that distribution. "What is the range of plausible dwell at location X" is a range. "How confident are we the vehicle drove down road R" is a probability. "Was this trip a typical version of this driver's usual route" is a comparison against everything else the trip could have been. All three can be answered from the same pings the standard approach already processes — they just need the set of candidate paths the single best one was chosen from.

This pipeline keeps that candidate set instead of discarding it, reports it alongside the single-path summary, and builds two more things from it.

![Pipeline block diagram from raw pings through preprocessing, state projection, candidate enumeration, and CRF inference to three outputs.](/figures/gps-reconstruction/fig2_pipeline_overview.png)

*Five stages, three outputs. The same kind of model as standard HMM map-matching, but the distribution the single Viterbi path normally collapses is kept and reported.*

The three outputs:

- the **Viterbi-best path** the standard approach returns, as a single-route summary;
- a **per-edge marginal** `P(E ∈ path) = Σ_p r(p) · 1[E ∈ p]` — the probability a given road segment was driven, adding up the weight `r(p)` of every candidate path that includes it;
- a **per-path inferred dwell** `time_budget − expected_travel_time(path)` — the stationary time a path implies. Different paths imply different dwells, so the distribution over paths becomes a distribution over dwell.

Edge marginals answer spatial questions about the trip; dwell annotations answer time questions. Both come from the same distribution, and the single Viterbi path stays available for anyone who just wants one route on a map.

For the coarser-grained view — how a whole trip breaks into operational segments and episodes — see [trajkit](/posts/trajkit-searchable-chunks-from-noisy-gps/). This article works one level down: within a single segment, what's the distribution of plausible paths the vehicle took to traverse it.

## What the article shows

The article carries two measured results from running this pipeline on Porto taxi data. The dataset logs one ping every 15 seconds; downsampling each trip to a 120-second cadence puts the input at the sparse-sampling regime that cost-constrained fleet GPS and asset-tracking deployments operate in, while the dropped 15-second pings (the seven of every eight pings the 120-second pipeline didn't see) provide raw-observation ground truth to score the 120-second reconstruction against. The dropped pings are the actual GPS reports, not a model's reconstruction; the comparison is reconstruction-vs-data rather than reconstruction-vs-reconstruction.

![A 15-minute Porto trip with 15-second pings as small dots and 120-second pings as larger orange markers, overlaid on the road network.](/figures/gps-reconstruction/fig3_downsampling_simulation.png)

*A real ~16-minute Porto trip at both cadences. The 9 orange markers are what the 120-second pipeline sees; the 56 small dots are what it doesn't. The dropped pings are the raw GPS observations the pipeline is scored against.*

**Capacity** — does the pipeline's candidate set contain a path that faithfully reproduces what the vehicle actually drove? The drive is scored directly against the raw 15-second GPS pings, with two gates: a candidate has to pass within δ = 25 m of every ping (recall) *and* keep almost all of its own length near the ping trail (precision, ≤ 25% excess). On transitions where the route is structurally recoverable from 120-second data, a candidate clears both gates 93.8% of the time (96.4% on recall alone). The four-way decomposition of capacity outcomes, the two thresholds, and the δ sweep are in the Coverage section.

**Calibration** — when the model says edge `E` has probability `p` of being traversed, does it land near `p` empirically? Across all five bins the reliability curve runs close to and slightly under the diagonal; the two upper bins are the widest, at 7 and 10 percentage points — smaller than earlier configurations of this pipeline, and now measured against a ground-truth ruler rebuilt so wrong-way corridors count as driven rather than as misses. The reliability table and the high-bin diagnosis are in the Calibration section.

## How the pipeline gets there

The pipeline lives in five conceptual stages: preprocessing, state projection, path enumeration, CRF inference, and dwell derivation.

**Preprocessing** cleans the observation stream so inference sees a well-behaved sequence. The hygiene drops are routine: sentinel coordinates, out-of-range lat/lon, and high-HDOP pings (the device's own satellite-geometry quality flag). Consecutive reports within ε metres of each other collapse into one observation tagged `(position, t_first, t_last, count)`, and the span `t_last − t_first` becomes the *confirmed dwell* there — a floor on how long the vehicle was stationary, and the one preprocessing output the budget arithmetic later depends on.

Two device pathologies get special handling. Stale runs — long static spans logged by a chip reporting a cached position while the vehicle was actually moving — are flagged so they don't contribute false dwell to the budget. Single-ping kinematic spikes (chip glitches) are dropped, and long bursts of buffered-replay packets are collapsed. The result is a sequence of `(position, t_first, t_last, stale_flagged)` observations the inference layer treats as ordinary low-frequency GPS.

**State projection.** Each preprocessed observation is projected onto its top-K nearest road edges by perpendicular distance, within a 50 m search radius and capped at 5 candidates per observation. Each candidate state carries `(edge, offset_along_edge, entry_time)`.

**Path enumeration.** Between consecutive observations the pipeline finds feasible paths with [A\*](https://en.wikipedia.org/wiki/A*_search_algorithm) — best-first search over the road network — costed by travel time (edge length over its max speed). A path is kept only if its travel time is within `path_budget_slack × time_budget`. The slack is 1.5 because in the Porto data drivers exceed posted speeds by up to ~1.5×; a tighter cap would drop genuinely fast routes from the candidate set.

One search alone would just return near-duplicates of the optimum, so the pipeline diversifies: after each path is accepted, its edges are surcharged by `(1 + λ)` (λ = 0.3) so the next search avoids them and finds a structurally different route — highway versus surface street, a detour around a bottleneck. It caps at 100 paths per transition but usually stops earlier on the budget constraint, at a median of ~33.

Enumeration runs on a *permissive* graph: alongside the legal directed edges, every one-way edge carries a penalized reverse arc, so the candidate set can include the wrong-way maneuvers vehicles actually make instead of being forced onto legal detours around them. The penalty keeps these candidates out of the posterior unless the evidence demands them — the wrong-way section below is a case where it does.

Each accepted path carries its edges, offsets, travel time, length, budget, `reversed_mask`, and feature vector. `inferred_dwell = time_budget − expected_travel_time` is computed on demand, never stored.

**CRF inference.** The pipeline runs forward-backward over a conditional random field (CRF) — a probabilistic model that scores a whole trajectory as a product of local compatibility terms, its *factors*; forward-backward is the two-sweep dynamic-programming routine that turns those scores into per-step probabilities. The factors are:

- a **heavy-tailed emission** `ω(y_k | x_k)` — the term scoring how plausibly a candidate road position explains the reported one — Student-t with scale 10 m and degrees-of-freedom 4, on perpendicular distance from the reported position to the candidate edge. Student-t rather than Gaussian because its heavier tails treat occasional large errors as expected rather than catastrophic: residual upstream pathology not caught by preprocessing should be absorbed rather than allowed to dominate the posterior.
- a **path factor** `η(p) = exp(μᵀφ(p))`, where `φ(p)` is a 19-dimensional feature vector over the path (length, turns, road-class fractions, travel time, endpoint projection distances, and a count of wrong-way maneuvers). `μ` is trained on the data; on Porto taxis its route-preference weights turn out near-noise while a single structural weight — the wrong-way penalty — carries the signal. Both results are detailed below.

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
- **precision** — at most a fraction of the candidate's own length lies farther than δ from the ping trail. This says the candidate *didn't pad the drive with extra road*: a recall-covering candidate that loops around the block to reach the same pings is rejected here. The gate is ≤ 25% excess, set from the gap in the excess distribution between projection noise and genuine detour padding.
- **direction** — the time-ordered pings thread the candidate in non-decreasing arc order. This is recorded as a **diagnostic flag only, never a gate**: a genuine reversal is a non-simple drive, not a candidate fault.

A window is *capacity-covered* if some candidate passes both gates. The two thresholds — δ and the excess fraction — are the only tuning the metric exposes.

![Cumulative coverage curve of distances from each dropped 15-second ping to the nearest candidate footprint, with δ=25m marked.](/figures/gps-reconstruction/fig4_ping_footprint_distance.png)

*The distance distribution decomposes into a projection-noise body (0–25 m) and a small structural-miss tail (>50 m, 33 pings out to 264 m). δ = 25 m covers 96.6% of dropped pings and sits at the knee — widening the tolerance a further 10 m buys only +0.7%, so it is past the noise mass but before tolerance starts absorbing genuine misses.*

Of the 349 windows, 137 (39%) are *data-gaps* — the raw polyline teleports across them, so there is nothing continuous to score against — leaving 212 scoreable. Each window runs between two observed endpoints, with the held-out 15-second pings falling in between. At δ = 25 m each lands in one of four outcomes (counts out of the 212):

- **capacity_ok** (186, 87.7%) — one candidate passes within δ of every ping. The success case.
- **generator_gap** (4, 1.9%) — no candidate even reaches one of the two endpoints; generation failed at the connection itself.
- **off-footprint excursion** (19, 9.0%) — the endpoints are connected, but between them the vehicle made a detour (a parking loop, an out-and-back) that lies off every candidate, so no simple path can construct it.
- **on-footprint split** (3, 1.4%) — that in-between road *is* in the candidate set, just fragmented across candidates, with no single path threading it all.

Only the off-footprint excursions are genuinely un-constructible, so they are the one bucket dropped from the headline denominator; the other failures count against the score.

That leaves 193 recoverable windows. On recall alone the pipeline threads **96.4% (186 / 193)**; adding the precision gate — recall *and* ≤ 25% excess — drops 5 padded candidates for an operational headline of **93.8% (181 / 193)**. When the data is enough to recover the route from 120-second sampling, the pipeline produces a faithful candidate 93.8% of the time.

![Stacked area chart showing how capacity outcomes shift as δ varies from 10 to 50 metres; the green band is the precision-gated capacity, with the recall-only and three failure bands stacked above.](/figures/gps-reconstruction/fig5_capacity_by_delta.png)

*Green is the precision-gated headline — 85% of scoreable windows at δ = 25 m, rising from 34% at δ = 10 m to 92% by δ = 50 m. The sliver above it is recall-covered windows the gate rejects for extra road; off-footprint excursions hold a ~8–10% floor and the other failures fall to near zero.*

## When the true route is illegal: wrong-way corridors

The route the taxi drove in Figure 1 is one the road map forbids. The corridor between those two pings is a one-way street in Porto, and the taxi drove it against the arrow. A one-way street is a single directed edge the router cannot traverse backward, so the driven route was *unconstructible* — it never entered the candidate set, and the model put two-thirds of its posterior weight on a legal loop running ~51 m off the truth. Confidently wrong, and recall-only coverage couldn't see it.

![Before-and-after of the Figure 1 transition. Left: with directed-only routing, every candidate is a legal detour and the posterior winner sits 51 m off the truth. Right: with wrong-way routing on, the corridor enters the set, hugs the truth, and wins.](/figures/gps-reconstruction/fig_wrongway_before_after.png)

*Both halves are the same transition; steel-blue dots are the dropped 15-second truth pings. **Left (before)** — directed-only routing: all four candidates are legal loops, and the posterior winner (gold frame, C, weight 0.65) runs 51 m off the route the vehicle drove. **Right (after)** — with wrong-way routing on, the corridor enters the candidate set as panel A, threads the truth at 1 m, and takes the posterior (gold frame, weight 0.51). The winner goes from a route the vehicle didn't drive to the one it did.*

The fix routes on a *permissive* graph where one-way edges carry a penalized reverse arc, priced per wrong-way maneuver rather than per edge. With it on, the corridor enters the candidate set and wins — threading the truth at 1 m against the detour's tens of metres. It is a real street, checkable against the world rather than just the OSM tag: [Google Street View of the corridor](https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=41.196383,-8.656559&heading=173), facing the legal direction the taxi drove against.

Confidence in an illegal route is legitimate because the penalty (−2.78 per maneuver) keeps wrong-way candidates out of the posterior unless the geometry overwhelms it, and that confidence is calibrated: among the edges the model is sure about (`P ≥ 0.5`) that are wrong-way, 96% were actually driven. Turning the mechanism on moved failing windows from 11% to 7%, against about 1 window in 200 regressing on a low-confidence wrong-way shortcut.

## Calibration: is the model's confidence trustworthy?

The model assigns each candidate edge a marginal probability `P(E ∈ path)`. The calibration question is whether that probability matches reality: per bin of predicted `P`, what fraction of those edges were actually traversed? The ground-truth ruler is deliberately `μ`-independent — a generic length prior, not the trained driver model — so the check doesn't grade the model against itself, but it is direction-violation-capable, so the truth route can run down wrong-way corridors rather than counting them as misses.

![Reliability diagram of edge-marginal calibration, with predicted P on the x-axis and empirical traversal rate on the y-axis.](/figures/gps-reconstruction/fig6_edge_marginal_reliability.png)

*Five bins, populations annotated. The curve runs close to and slightly under the diagonal: predicted 0.30 → empirical 0.26, 0.49 → 0.45, 0.70 → 0.63, 0.99 → 0.89 (the lowest bin, 0.01, sits just above at 0.03).*

Where it matters most — the low and mid bins, where several candidates carry plausible mass and a caller most needs the probability to mean something — the model lands within about 4 points of the diagonal. The overconfidence is mild and confined to the upper two bins (gaps of 7 and 10 points), which sit on backbone edges: there almost all candidates agree, so the marginals pile up near 1 and within-transition correlation leaves few independent samples to pin the bin down. Earlier this gap was ~16 points. It came down as two bugs were fixed: terminal edges a path barely touched had been counted as fully driven, and correctly-driven wrong-way corridors had been scored as misses.

## Inferred dwell as a derived posterior

Each candidate path implies its own dwell — `inferred_dwell = time_budget − expected_travel_time(path)` — so the posterior over paths is at the same time a posterior over how long the vehicle sat:

```
P(dwell_k = d) = Σ_p r^k(p) · 1[inferred_dwell(p) = d]
```

each dwell value weighted by the posterior mass of the paths that imply it. Ask "what's the plausible range of dwell here" and that distribution is the answer — a point estimate from the most likely path, a credible range from its spread. The confirmed dwell carried through from preprocessing is a floor on it (the time the vehicle was provably stationary); the posterior can place the stop above that floor when the candidates imply it, as the figure shows.

![Stem plot of inferred_dwell across candidate paths for one transition, with the 15s-reference dwell marked at 30 seconds.](/figures/gps-reconstruction/fig7_inferred_dwell_transition.png)

*The 120s dwell posterior against the 15s reconstruction — the finest scale available, and itself only a floor: it confirms 30 s between co-located pings, but the vehicle is gone by the next sample, so the true stop is 30–45 s. The posterior peaks near 43 s, recovering the dwell the 15s floor misses.*

The pipeline does not localise *where in the interval* the dwell occurred. The same split — say 30 seconds of dwell across a 120-second interval with a 90-second drive — is consistent with the stop coming at the start, at the end, or spread along the way. Three conventions (front-loaded, back-loaded, spread) are exposed for off-grid position queries; the choice is a configuration, not something the model learns.

## The driver-preference model

The path factor `η(p) = exp(μᵀφ(p))` is built to absorb learned driver-preference signal when such signal exists. The weights it carries split two ways. One is *structural* — the direction-violation penalty `μ[18]`, which encodes a hard fact about one-way roads. It decides whether a wrong-way corridor can enter the posterior at all, admitting one only when the evidence demands it. The capacity and calibration results above both depend on it. The μ here is trained on Porto data, and this penalty is most of what that training buys.

The other kind is *preference* — length, turn counts, road-class fractions, the features that would encode "this driver prefers arterials" or "this fleet avoids left turns." On Porto taxi data these add little. Taxi data is structurally hostile to learned driver preference: different drivers, different destinations, traffic-dependent routing, no stable per-driver habit for the model to latch onto. Refitting the preference weights by maximum likelihood produces only near-noise movement on the 40-trip held-out evaluation — the apparent gains mostly tracked correcting stale saved weights rather than the model learning real preference signal.

None of this rules out driver preference in general — only that we looked for it in this data and didn't find it. Whether commuter or structured delivery fleets carry it is a separate question, and the model can pick that signal up if they turn out to.

## What this is for

Edge marginals support spatial queries: "did the vehicle traverse road R," "what fraction of plausible reconstructions pass through district X," "is the trip a credible variant of this driver's usual route." Per-path dwell distributions support time-allocation queries: "what's the plausible range of stationary time at customer Y," "is the reported 12-minute dwell within the credible range under the pipeline's posterior." The Viterbi path remains available for callers who want one route on one map; the rest is for callers who want to act on the distribution behind it.

## Stack

Python 3.12. numpy, scipy, networkx for the routing graph, rtree for spatial indexing, [osmium](https://osmcode.org/osmium-tool/) for parsing the OpenStreetMap (OSM PBF) extract, [shapely](https://shapely.readthedocs.io/) for geometry. The capacity measurements use 349 windows from 50 trips (212 scoreable after data-gaps, 193 recoverable after the un-constructible excursions); the calibration measurements use roughly 18,000 edge-instances from 40 held-out trips, scored against the `μ`-independent length-prior ruler.

The repo: [github.com/darmaaz/gps-trajectory-reconstruction](https://github.com/darmaaz/gps-trajectory-reconstruction). The companion article on segment-level chunking, which this pipeline is the sister project to, is at [/posts/trajkit-searchable-chunks-from-noisy-gps/](/posts/trajkit-searchable-chunks-from-noisy-gps/).

## References

- Newson, P. & Krumm, J. (2009). *Hidden Markov Map Matching Through Noise and Sparseness.* Proc. ACM SIGSPATIAL.
- Hunter, T., Abbeel, P. & Bayen, A. (2013). *The Path Inference Filter: Model-Based Low-Latency Map Matching of Probe Vehicle Data.* IEEE T-ITS 15(2).
- Microsoft Research, [Porto taxi trajectory dataset](https://www.kaggle.com/c/pkdd-15-predict-taxi-service-trajectory-i).
