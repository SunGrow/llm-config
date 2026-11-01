# Visual review

Applies when a result is judged by how it looks: 3D models and renders, images, art references, UI screenshots.

- Metrics and scripts choose which candidates to look at; acceptance of a shape or image needs looking. When a metric passes and the view disagrees, the view wins and the metric is wrong for this case: say so.
- Before saying a shape is right, check every view it will be seen from (front, side, 3/4, back, underside as relevant), not the one that looks best.
- Look at the scale of the defect. A panel in a large collage is too small to show steps, ledges, flat patches or seams; crop or render the region so it fills the image.
- Compare with the reference at the same view and scale, side by side or overlaid, not from memory or from a description of the reference.
- Report only images you opened yourself in this task. Mark an executor's or script's visual claim as relayed until you have looked.
- Name defects in the user's terms and recheck the ones the user already named before reporting a new version.
- Classify references by what is visible in the frame, not by labels, titles, characters or canon.
- Downscale whole sheets to the project's size limit; for detail, open a crop rather than a larger sheet.

## Tools

Skip the ones that are not installed. `vision.py` and `surface_views.py` are in `~/.agents/tools/vision/`.

- Render and look early, before building further, and again after each substantial change.
- For surface quality (steps, ledges, flat patches, creases), look at a normal or curvature render of the region as well as the plain render. Plain and clay renders miss small defects. In Blender use `surface_views.py`, or the project's own renderer if it has these modes.
- Use curvature as a picture to look at. A threshold on curvature does not separate defects from anatomy.
- To find images in a large folder, run `vision.py index` once with `--model siglip2`, then `search --text`, and look at the hits. If the folder mixes references with generated renders, limit results with `--under`. Describe the whole frame in the query ("full body character standing, seen from the side"), and try a second wording before deciding the images aren't there. Search hides duplicates, contact sheets and blank images; add `--all` when you need them, such as rows of figures for motion. Searching by an example image finds near-copies, not the same view. Treat the view label from `vision.py pose` as a hint and confirm by looking.
- Use `vision.py compare` as a coarse silhouette check, not as acceptance.

## Motion

- In a 3D scene, read motion from per-frame bone and vertex data, not from pixels.
- On video, run `vision.py track` with a moving point and a reference point on a rigid part, then `dynamics` or a spectrum. Trust the frequency after opening the strip to check the tracks stay on target. Check amplitude, lag and damping by a second method before relying on them. A sustained cycle does not give natural frequency or damping.
- To show motion to a model, draw the tracks on sampled frames instead of giving a few bare frames.
- Fix one definition per project for a motion metric such as foot sliding, and do not compare it with numbers from other definitions.
