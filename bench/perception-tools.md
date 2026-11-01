# Perception tools: what was tried and what it showed

Backs `components/vision/` and the tool section of `components/core/files/instructions/visual-review.md`. Run 2026-11-01 on Windows 11, RTX 5070 Ti Laptop 12 GB, 31 GB RAM, with another process holding about 7 GB of VRAM at 99% load, so speeds are lower bounds. External sources were read through a summarizing fetch.

## Surface defects: which render view helps

Blind test. One accepted character body, 18 close-ups (belly, back, thigh): 12 with one injected defect (ledge, flat patch, dent or bump, crease; small, medium, large at 0.2, 0.45 and 1 of the large amplitude of 0.8 to 2 cm), 6 clean. Each reader saw one view of all 18 with shuffled ids, looking only, and had no access to the key.

Defects found of 12; clean images flagged of 6 in brackets:

| Reader, high effort | Skin | Matcap | Zebra | Normal | Curvature |
| --- | --- | --- | --- | --- | --- |
| Sonnet 5.5 | 8 (0) | 9 (0) | 10 (0) | 11 (0) | 10 (0) |
| Opus 5.5 | 8 (0) | 10 (0) | 11 (0) | 11 (0) | 12 (0) |
| Haiku 5.5 | 4 (1) | not run | not run | not run | 7 (2) |

- Small defects, Sonnet and Opus together, of 8: skin 2, matcap 3, zebra 6, normal 6, curvature 6.
- Every Sonnet and Opus hit named the right cell of a 3 by 3 grid. Haiku located 3 of 4 and 2 of 7.
- Sonnet and Opus named the defect type right on 3 to 7 of their hits, so the type name is not reliable from one view.
- A numeric high-pass curvature scanner with one threshold, calibrated on the clean body, found 0 to 2 of 12 and raised 21 to 24 other clusters, because anatomy has the same curvature as the defects. Not added.
- Render seconds per 18 images: curvature 15, normal 22, zebra 94 (with spare views).

Limits: one body, one run per reader, synthetic defects, seven of them mirrored pairs. Readers knew defects were possible and could compare same-zone images with each other, which they cannot do in real use. Gaps of 1 or 2 are not meaningful; the gap to plain skin and to Haiku is the finding. Anatomy and taste judgments were not tested.

## Image search

3000 random images from a 56,853-image art reference folder, judged blind on the top 8 hits.

| Query | DINOv2 | SigLIP 2 |
| --- | --- | --- |
| Example image, same view (front, side, back, side), hits of 32 | 5 | 3 |
| Text, hits matching of 8 | no text | side 8, back 6, hand 6, three-quarter 2 |

Example-image search mostly returned crops or copies of the query and similar drawing styles, so it finds near-duplicates, not views. Speed: DINOv2 128 images/s, 335 MB VRAM; SigLIP 2 36 images/s, 2.8 GB VRAM, 4.4 GB RAM. Cold start 8 to 14 s.

## View labels from pose

`estimate_view` on 400 random images, labelled classes judged blind on up to 16 samples each: back 8 of 12 exact, front 6 of 16, side 6 of 16 (13 of 16 side or three-quarter), three-quarter 3 of 16; 212 of 400 returned unknown. Too weak to sort references. Keypoints were right on the two character sheets opened. 1.3 s per image on CPU; the GPU build needs CUDA 13 DLLs that torch does not ship.

## Point tracking and dynamics

BootsTAPIR (Apache-2.0, not CoTracker3, which is non-commercial).

Synthetic clip with known values, true then recovered: frequency 2.5 and 2.66 Hz, damping ratio 0.12 and 0.149, lag 40 and 38.1 ms, overshoot 68.4% and 62.3%; tracker error 1.3 to 2.1 px.

Real clips against earlier hand-assisted measurements, one run per row:

| Quantity | Hand | Tool | Result |
| --- | --- | --- | --- |
| Bounce frequency | 0.86 Hz | 0.87 Hz | agrees |
| Contour frequency | 3.75 Hz | 3.755 Hz | agrees |
| Step frequency | 1.30 to 1.31 Hz | 1.297 Hz | agrees |
| Contour amplitude | 2.0 px | 4.2 px | about twice |
| Lag in walk | 0.04 to 0.10 s | 104 ms or -118 ms by reference | partial |
| Natural frequency and damping in walk | 1.43 to 1.96 Hz, 0.19 to 0.52 | locks onto the step cycle | not comparable |

No clear drift in 84 sampled point-frames, with 3 ambiguous on a sliding contour and 1 marginal. About 53 s per clip window, up to 7 GB VRAM. Frequency is the checked output; amplitude, lag and damping need a second method.

## Tried and kept with caveats

- `compare`: silhouette IoU 0.872 front against back and 0.615 front against side; usable as a coarse check, arms fuse into the torso.
- `normals` (MoGe-2): faint on flat-shaded art, rough only.
- All model licences checked are Apache-2.0 or MIT, none gated. MoGe-2's weights have an MIT tag with an empty card, and the pose models' training-data terms were not verified.

## Researched, not added

| Tool | Why |
| --- | --- |
| TRELLIS.2 | at least 24 GB VRAM, Linux only (reported) |
| Hunyuan3D 2.1 | licence excludes the EU, UK and South Korea; texture needs 21 GB; starting mesh only, and nothing found for moving one onto a fixed topology |
| HY-Motion 1.0 | at least 26 GB VRAM (reported) |
| GVHMR, SMPL-X, AMASS, LAFAN1, CoTracker3 | non-commercial terms |
| SAM 3, SAM 3D Body, SAM 3D Objects, DINOv3 | gated |
| nvdiffrast fitting | commercial terms unclear; no study found on fixed-topology fitting |
| SAM 2.1, SEA-RAFT | no measured need yet; add if tracking needs masks or dense motion |
| pybvh, 100STYLE (CC BY 4.0), Mixamo | animation data, not tried; add when a task needs a motion library |

Evidence read but not reproduced here: viewing renders early tracks AA-3D rank (Spearman 0.82, correlational); a depth tool raised GPT-4o on BLINK relative depth from 71.8 to 83.9 and spatial relation from 72.0 to 81.1 (Sketchpad, with other tools present); VLM-SubtleBench found side-by-side lowered accuracy in 9 of 10 categories while targeted overlays helped specific ones; point tracks drawn on frames raised GPT-5.5 by 4.2 and 8.9% (Motion-as-Prompt, abstract only).
