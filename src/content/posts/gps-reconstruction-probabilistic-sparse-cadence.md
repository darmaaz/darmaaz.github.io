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

Most map-matching pipelines pick one of those stories. They run the observations through a [hidden Markov model](https://en.wikipedia.org/wiki/Hidden_Markov_model) and return the Viterbi-best path — the single sequence of road segments with the highest joint probability given the data. The single path is what trip displays, mileage logging, and routing UIs need, and it is the right answer for those uses most of the time.

The cost of returning only the single path is that downstream analyses asking questions about the distribution the single path summarises do not get that distribution. "What is the range of plausible dwell at customer X" is a range. "How confident are we the vehicle traversed road R" is a probability. "Was this trip a typical variant of this driver's usual route" is a comparison against a posterior. These questions can be asked from the same observations the standard approach already runs through — they need the candidate set the Viterbi argmax was taken over.

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

The article carries two measured results from running this pipeline on Porto taxi data. The dataset logs at a dense 15-second cadence; downsampling each trip to a 120-second cadence puts the input at the sparse-sampling regime that cost-constrained fleet GPS and asset-tracking deployments operate in, while the dropped 15-second pings (the seven of every eight pings the 120-second pipeline didn't see) provide raw-observation ground truth to score the 120-second reconstruction against. The dropped pings are the actual GPS reports, not a model's reconstruction; the comparison is reconstruction-vs-data rather than reconstruction-vs-reconstruction.

![A 15-minute Porto trip with 15-second pings as small dots and 120-second pings as larger orange markers, overlaid on the road network.](/figures/gps-reconstruction/fig3_downsampling_simulation.png)

*A real ~16-minute Porto trip at both cadences. The 9 orange markers are what the 120-second pipeline sees; the 56 small dots are what it doesn't. The dropped pings are the raw GPS observations the pipeline is scored against.*

**Capacity** — does the pipeline's candidate set contain a path that threads every dropped 15-second ping? On transitions where the route is structurally recoverable from 120-second data, the answer is yes 96.3% of the time. The full four-way decomposition of capacity outcomes, the relaxed-A\* check that fixes the conditional, and the δ sweep are in the Coverage section.

**Calibration** — when the model says edge `E` has probability `p` of being traversed, does it land near `p` empirically? Through the operationally informative low and mid bins, the answer is within 3 percentage points of the diagonal; the upper two bins show mild overconfidence (8 and 16 percentage points). The reliability table and the high-bin diagnosis are in the Calibration section.

## How the pipeline gets there

The pipeline lives in five conceptual stages: preprocessing, state projection, path enumeration, CRF inference, and dwell derivation.

**Preprocessing** offloads observation-level pathology so inference sees a clean sequence. Sentinel coordinates, out-of-range lat/lon, and high-HDOP pings are dropped. Consecutive reports within ε metres of each other are collapsed into a single observation tagged `(position, t_first, t_last, count)` — the span `t_last − t_first` becomes the *confirmed dwell* at that observation, a floor on the time the vehicle was stationary there. Stale runs — long static spans on a device whose true position was actually moving, common in cached-position chip behaviour — are detected by checking whether the minimum routable time from the static span's start to the next observation is feasible from `t_last` (the end of the static span) or only from `t_first` (its start). When only the latter is feasible, the static span is flagged stale and contributes zero confirmed dwell to the budget arithmetic. Single-ping kinematic spikes (chip glitches) are removed; long bursts of buffered-replay packets are collapsed.

The output is a sequence of `(position, t_first, t_last, stale_flagged)` observations. The inference layer treats them as ordinary low-frequency GPS.

**State projection.** Each preprocessed observation is projected onto its top-K nearest road edges by perpendicular distance, within a 50 m search radius and capped at 5 candidates per observation. Each candidate state carries `(edge, offset_along_edge, entry_time)`.

**Path enumeration.** Between consecutive observations the pipeline enumerates feasible paths using [A\*](https://en.wikipedia.org/wiki/A*_search_algorithm) with travel-time cost (length divided by max-speed-per-edge). Accepted paths are pruned against an inflated time-budget cap: each path's expected travel time must be at most `path_budget_slack × time_budget`, with `path_budget_slack = 1.5` as default. The 1.5 slack is empirically grounded — Porto taxis exceed posted limits frequently enough that a 1.2 slack drops the true route from the candidate set in a measurable fraction of transitions. 1.5 absorbs that without inflating the set so much that downstream marginalisation is dominated by implausibly fast paths.

A single shortest-path search collapses the candidate set onto near-duplicates of the optimum. The pipeline diversifies via the plateau / penalty method: after each accepted path, its edges are multiplicatively surcharged by `(1 + λ)` with `λ = 0.3`; the next search penalises re-using those edges and tends to find structurally different paths (highway vs surface street, detour around a bottleneck) rather than near-duplicates. The cap is 100 paths per transition; A\* usually terminates earlier on the budget-slack constraint, producing a median of ~33 paths per transition.

Each accepted path carries `(edges, start_offset, end_offset, expected_travel_time, length_meters, time_budget, feature_vector)`. `inferred_dwell = time_budget − expected_travel_time` is a derived property — never stored, never stale relative to the budget under which the path was enumerated.

**CRF inference.** The pipeline runs forward-backward over a conditional random field whose factors are:

- a **heavy-tailed emission** `ω(y_k | x_k)` — Student-t with scale 10 m and degrees-of-freedom 4 — on perpendicular distance from the reported position to the candidate edge. Heavy-tailed because residual upstream pathology not caught by preprocessing should be absorbed rather than allowed to dominate the posterior.
- a **path factor** `η(p) = exp(μᵀφ(p))` parameterised by `μ`, where `φ(p)` is a feature vector over the path (length, n_turns, road-class fractions, expected travel time, projection-distance from endpoints to their observations). The results in this article use `μ = 0`; the reasoning is in the driver-preference section below.

Forward-backward yields per-observation state marginals `q^k` and per-transition path marginals `r^k(p)`, both in log-domain. Viterbi yields the most-likely interleaved sequence of states and paths. When a transition has zero feasible paths, the trajectory is split at that boundary — the segment terminates, a `Discontinuity` record is emitted with structural context, and a new segment begins at the next observation that does have candidates.

**Edge marginals** are derived post-hoc:

```
P(E ∈ path_k) = Σ_p r^k(p) · 1[E ∈ p]
```

An edge in every candidate has `P = 1`. An edge in no candidate has `P = 0`. An edge in some candidates carries a probability between, weighted by how much posterior mass sits on the paths containing it.

## Coverage: can the candidate set construct what the vehicle actually drove?

For each 120-second transition, the question is whether the candidate set contains at least one path that threads all of the dropped 15-second pings — the GPS reports the 120-second pipeline did not see — within a tolerance δ. The unit is the individual dropped ping. The check is binary per ping: shapely's nearest-point-on-line for each candidate edge, equirectangular distance in metres at Porto's latitude, minimum over all candidate edges of the transition. A ping is *covered* by a candidate if its perpendicular distance to that candidate's geometry is ≤ δ. A transition's outcome is determined by the best candidate (the one that covers the most dropped pings).

![Histogram of distances from each dropped 15-second ping to the nearest candidate footprint, with δ=25m marked.](/figures/gps-reconstruction/fig4_ping_footprint_distance.png)

*The distance distribution decomposes into a projection-noise body (0–25 m) and a small structural-miss tail (>50 m, 36 pings out to 263 m). δ = 25 m sits at the join — wide enough to absorb GPS noise around correct candidates, narrow enough to keep the structural-miss tail outside.*

The four-way decomposition makes the failure modes legible. *Capacity_ok* (85.8%) is the success case — some candidate threads every dropped ping. *Off-footprint excursion* (10.8%) is the case where dropped pings sit off every candidate's footprint; these are routes A\* with simple-path enumeration cannot produce, verified by re-running A\* on each off-footprint window with relaxed parameters (slack 3.0, λ 0.1, 3× the candidate budget) — 0 of 23 were rescued, so all 23 are genuine non-simple excursions (parking loops, out-and-backs, same-edge backtracks). *On-footprint split* (1.4%) is the failure mode where the road exists in the candidate footprint but no single candidate threads the full sequence of dropped pings — the right edges are there, distributed across different candidates rather than concentrated in one. *Generator gap* (1.9%) is the case where a kept (observed) ping is missed, which is a structural failure of the enumeration.

The conditional 96.3% (182 / 189, excluding the 23 off-footprint excursions as un-constructible) is the operational headline: when the data is sufficient to recover the route from 120-second sampling, the pipeline recovers it 96.3% of the time.

![Stacked area chart showing how the four capacity outcomes shift as δ varies from 10 to 50 metres.](/figures/gps-reconstruction/fig5_capacity_by_delta.png)

*The capacity_ok share climbs from 50% at δ = 10 m to 91% by δ ≈ 40 m, with generator_gap and on-footprint split shrinking to near zero. The off-footprint excursion share is a near-flat ~10% structural ceiling — these are non-simple excursions the candidate enumeration can't produce at any tolerance.*

A useful sanity check is the same distance measurement on the *kept* pings — the 120-second observations the pipeline used as projection anchors. By construction those pings should sit essentially on top of some candidate edge. They came out 100% covered at δ = 20 m with a median distance of 2.6 m. If the timestamp-to-transition bucketing were wrong, the kept set wouldn't asymptote that cleanly.

## Calibration: is the model's confidence trustworthy?

For each candidate edge `E` in some candidate path of some transition, the model assigns a marginal probability `P(E ∈ path)`. The calibration question is whether that probability corresponds empirically to traversal frequency. Per bin of predicted `P`, what fraction of edges in that bin were actually traversed?

![Reliability diagram of edge-marginal calibration, with predicted P on the x-axis and empirical traversal rate on the y-axis.](/figures/gps-reconstruction/fig6_edge_marginal_reliability.png)

*Five bins, bin populations annotated. The lower three sit on the diagonal; the upper two dip below by 8 and 16 percentage points. Rank-calibrated through the operationally informative range, mild overconfidence concentrated at the backbone where alternative paths are structurally absent.*

The lower three bins are within 3 percentage points of the diagonal — the operationally informative range, where multiple candidates carry plausible mass and the consumer most needs to trust the model's confidence. The two upper bins show mild overconfidence. The −16 pp gap at the [0.6, 0.8) bin and the −8 pp gap at [0.8, 1.0] are smaller than the gaps reported in earlier configurations of this pipeline and concentrate on backbone edges, where almost all candidates agree and within-transition correlation among edges injects finite-sample variance in the bin estimate.

## Inferred dwell as a derived posterior

Each candidate path carries `inferred_dwell = time_budget − expected_travel_time(path)`. The posterior over paths at transition `k` induces a posterior over dwell:

```
P(dwell_k = d) = Σ_p r^k(p) · 1[inferred_dwell(p) = d]
```

For consumers asking "what's the plausible range of dwell at this point in the trip," this is the answer — a discrete distribution over dwell values, each weighted by the posterior mass of paths that imply it. The most likely path gives a point estimate; the credible range comes from the spread.

The pipeline does not localise *where in the interval* the dwell occurred. The same time budget split (say, 30 seconds of dwell across a 120-second interval that includes a 90-second drive) is consistent with the dwell being at the start of the interval (vehicle stopped, then drove), at the end (vehicle drove, then stopped), or distributed along the way. Three allocation conventions are exposed — front-loaded, back-loaded, evenly spread — as a configuration layer used when off-grid position queries are needed. The choice of allocation rule is a configurable convention, not a learned property.

![Stem plot of inferred_dwell across candidate paths for one transition, with the 15s-reference dwell marked at 30 seconds.](/figures/gps-reconstruction/fig7_inferred_dwell_transition.png)

*One transition's full candidate set re-indexed by `inferred_dwell`. The posterior over paths becomes a posterior over dwell. The dense-cadence (15-second) reference at 30 seconds falls inside the candidate set's support; the posterior puts most weight on dwells in the 40–45 second range, so the model and the reference disagree about the point estimate while agreeing on the range of plausible answers.*

## The driver-preference model, and why it does little here

The path factor `η(p) = exp(μᵀφ(p))` is built to absorb learned driver-preference signal when such signal exists. On Porto taxi data, refitting μ on top of a previously-shipped artefact recovers +1.6 percentage points of MLE accuracy on held-out trips (94.1% → 95.7%) — but a richer training recipe (priors over feature weights, off-road candidate support) adds only +0.7 percentage points more (95.7% → 96.4%), a near-noise gain on a 40-trip evaluation. The bulk of the apparent "μ training improvement" was correcting a stale shipped artefact rather than the model learning real preference signal. Taxi data is structurally hostile to learned driver preference — different drivers, different destinations, traffic-dependent routing — and the pipeline's results in this article hold with `μ = 0`.

Whether commuter-fleet data or structured delivery-fleet data carries learnable driver preference is a separate question. The pipeline is built to absorb that signal cleanly if it exists in the data; on Porto, it doesn't.

## What this earns its cost for

Edge marginals support spatial queries: "did the vehicle traverse road R," "what fraction of plausible reconstructions pass through district X," "is the trip a credible variant of this driver's usual route." Per-path dwell distributions support time-allocation queries: "what's the plausible range of stationary time at customer Y," "is the reported 12-minute dwell within the credible range under the pipeline's posterior." The Viterbi path remains available for consumers who want one route on one map; the rest of the machinery is for consumers who want to act on the distribution behind it.

## Open threads

**Top-k Viterbi.** The pipeline returns single-best Viterbi plus per-transition marginals. Consumers who want the k most likely globally-coherent reconstructions need top-k Viterbi (a textbook DP extension), which the pipeline does not yet expose. Top-k Viterbi gives a different object from per-transition marginals — each member of the top-k set is a coherent end-to-end story rather than a per-step marginal that may not compose into one.

**μ training on data with stable preferences.** The Porto result establishes that the pipeline doesn't need a learned driver preference to deliver the calibration and capacity numbers reported here. Whether μ adds real signal on data that does exhibit stable preference — commuter, structured delivery, fixed-route fleet — is an open question this article does not address.

**The on-footprint split residual.** 1.4% of transitions have the right road in the candidate footprint but no single path threading it. This is the partition pathology the article's calibration section addresses at the edge-marginal level; for capacity at the path level, it remains a small structural cost of the current enumeration. Wider enumeration or cluster-aggregated reporting at the path level would address it.

## Stack

Python 3.12. numpy, scipy, networkx for the routing graph, rtree for spatial indexing, [osmium](https://osmcode.org/osmium-tool/) for the OSM PBF parse, [shapely](https://shapely.readthedocs.io/) for geometry. The calibration measurements use 307 transitions from 40 held-out trips; the capacity measurements use 348 transitions from 50 trips.

The repo: [github.com/darmaaz/gps-trajectory-reconstruction](https://github.com/darmaaz/gps-trajectory-reconstruction). The companion article on segment-level chunking, which this pipeline is the sister project to, is at [/posts/trajkit-searchable-chunks-from-noisy-gps/](/posts/trajkit-searchable-chunks-from-noisy-gps/).

## References

- Newson, P. & Krumm, J. (2009). *Hidden Markov Map Matching Through Noise and Sparseness.* Proc. ACM SIGSPATIAL.
- Hunter, T., Abbeel, P. & Bayen, A. (2013). *The Path Inference Filter: Model-Based Low-Latency Map Matching of Probe Vehicle Data.* IEEE T-ITS 15(2).
- Microsoft Research, [Porto taxi trajectory dataset](https://www.kaggle.com/c/pkdd-15-predict-taxi-service-trajectory-i).
