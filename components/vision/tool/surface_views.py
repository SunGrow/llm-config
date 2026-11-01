"""Blender script: surface-defect views of mesh objects as view-space normal and high-pass curvature renders.

    blender -b FILE.blend --factory-startup --python surface_views.py -- --objects A,B --out DIR \
        [--modes normal,curv] [--views front,side,back,q34] [--size 1200] [--frame X,Y,Z,SIZE] \
        [--curv-scale auto|FLOAT] [--smooth-iters 12]

Why: subtle dents, creases and lumps that a plain shaded render hides show clearly as a colour-coded normal or as the
curvature left after removing the smooth shape.

Input: any mesh (any topology) of the open file, evaluated at its current pose/frame (modifiers, armature, shape keys
applied), in world space. The .blend is never saved. Positions are welded by position before any measurement, so split
vertices (UV or normal seams) give no curvature and no shading seam. Only numpy besides Blender's own modules.

Views (orthographic, Z up, Blender convention: front looks along +Y from -Y, side looks from +X, back from +Y,
q34 from the front-right): the same camera for both modes and all objects of a run. The frame is a square of
SIZE scene units centred on (X,Y,Z); without --frame it is the union bounds of all --objects (3D box centre, size
= largest half-extent over all views x 2 x 1.08).

Modes (emission only, Cycles CPU 16 samples, no denoise, view transform Raw, so pixel value = encoded value):
  normal  shading normal n in camera axes (x right, y up, z towards the camera): RGB = 0.5 n + 0.5 (plus 0.25/255 so
          the 127.5 tie rounds to 128), so a flat surface facing the camera = (128, 128, 255). Normals are the area-weighted vertex normals of the welded
          mesh (smooth shading; no faceting). Background 0.6 grey.
  curv    mean curvature (cotangent Laplacian of the welded triangle mesh, convex positive, in 1/scene unit) minus
          its local mean (--smooth-iters rounds of neighbour averaging, which is about sqrt(iters) edge lengths, so
          the cut-off follows the mesh density). Blue-white-red diverging, +-scale saturated, convex = red.
          Background 0.25 grey. Open boundaries and very thin triangles give some edge noise.
          --curv-scale auto (default) = max(90th percentile of |high-pass curvature| over all welded vertices of all
          objects, 0.05 / median edge length), one value for the whole run; a number fixes it (1/scene unit).

Outputs in DIR: object__view__mode.png (object name with characters other than A-Z a-z 0-9 . _ - replaced by _) and
surface_views.json (frame, curvature scale and how it was derived, units, files).
Object scale and parenting count: curvature is measured in world units. Mirrored (negative-scale) objects are flipped
back to outward normals.
"""
import bpy
import sys
import os
import re
import json
import math
import numpy as np
from mathutils import Vector

VIEW_DIRS = {'front': (0.0, -1.0, 0.0), 'side': (1.0, 0.0, 0.0), 'back': (0.0, 1.0, 0.0),
             'q34': (math.sqrt(0.5), -math.sqrt(0.5), 0.0)}          # direction from the centre to the camera
BACKGROUND = {'normal': 0.6, 'curv': 0.25}
# diverging blue-white-red stops at -S .. +S (pixel values)
STOPS = np.array([[0.10, 0.20, 0.80], [0.55, 0.70, 0.95], [0.97, 0.97, 0.97], [0.95, 0.65, 0.55], [0.80, 0.10, 0.10]])
FRAME_MARGIN = 1.08
WELD_REL = 1e-6                                                       # weld distance relative to the bounds diagonal
AUTO_FLOOR_PER_EDGE = 0.05                                            # auto scale floor = this / median edge length
COT_CLIP = 4.0
NORMAL_OFFSET = 0.5 + 0.25 / 255.0                                    # 0.5 n + 0.5, plus a quarter level so a 127.5 tie rounds up to 128


# ------------------------------------------------------------------------------------------------ numpy geometry
def weld(W, tri):
    """positions W (n,3), triangles tri (m,3) -> (inv: vertex -> welded id, welded positions, welded triangles without degenerates)"""
    diag = float(np.linalg.norm(W.max(0) - W.min(0)))
    eps = max(diag * WELD_REL, 1e-30)
    q = np.round((W - W.min(0)) / eps).astype(np.int64)
    _, inv = np.unique(q, axis=0, return_inverse=True)
    inv = np.asarray(inv).reshape(-1)
    nw = int(inv.max()) + 1
    cnt = np.bincount(inv, minlength=nw)
    Pw = np.stack([np.bincount(inv, weights=W[:, k], minlength=nw) / cnt for k in range(3)], 1)
    T = inv[tri]
    ok = (T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])
    return inv, Pw, T[ok]


def edge_list(T):
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    return np.unique(np.sort(e, 1), axis=0)


def vertex_normals(Pw, T):
    """area-weighted vertex normals of the welded mesh"""
    fn = np.cross(Pw[T[:, 1]] - Pw[T[:, 0]], Pw[T[:, 2]] - Pw[T[:, 0]])
    acc = np.stack([sum(np.bincount(T[:, k], weights=fn[:, c], minlength=len(Pw)) for k in range(3)) for c in range(3)], 1)
    return acc / np.maximum(np.linalg.norm(acc, axis=1), 1e-300)[:, None]


def mean_curvature(Pw, T):
    """cotangent-Laplacian mean curvature per welded vertex, 1/length, convex positive. Computed in a normalised frame
    (bounds diagonal = 1), so it does not depend on the scene unit."""
    nw = len(Pw)
    s = float(np.linalg.norm(Pw.max(0) - Pw.min(0))) or 1.0
    P = (Pw - Pw.min(0)) / s
    p = [P[T[:, k]] for k in range(3)]
    cr = np.linalg.norm(np.cross(p[1] - p[0], p[2] - p[0]), axis=1)
    good = cr > 1e-18
    L = np.zeros((nw, 3)); A = np.zeros(nw)
    for k in range(3):
        i, j, o = T[:, (k + 1) % 3], T[:, (k + 2) % 3], T[:, k]               # corner o is opposite edge (i, j)
        a, b = p[(k + 1) % 3] - p[k], p[(k + 2) % 3] - p[k]
        cot = np.where(good, np.clip((a * b).sum(1) / np.maximum(cr, 1e-18), -COT_CLIP, COT_CLIP) * 0.5, 0.0)
        dij = P[j] - P[i]
        for c in range(3):
            L[:, c] += np.bincount(i, weights=cot * dij[:, c], minlength=nw) - np.bincount(j, weights=cot * dij[:, c], minlength=nw)
        A += np.bincount(o, weights=0.5 * cr / 3.0, minlength=nw)
    n = vertex_normals(P, T)
    valid = A > 1e-12 * max(A.max(), 1e-300)
    H = np.where(valid, -0.5 * (L * n).sum(1) / np.where(valid, A, 1.0), 0.0)
    return H / s


def smooth(f, E, iters):
    """uniform neighbour averaging of a per-vertex scalar field"""
    nw = len(f)
    i, j = E[:, 0], E[:, 1]
    deg = np.maximum(np.bincount(E.ravel(), minlength=nw), 1)
    f = np.asarray(f, float).copy()
    for _ in range(iters):
        acc = np.bincount(i, weights=f[j], minlength=nw) + np.bincount(j, weights=f[i], minlength=nw)
        f = 0.5 * f + 0.5 * acc / deg
    return f


def analyze(W, tri, iters=12):
    """world positions + triangles -> dict(inv, Pw, T, normals, H, hp, edge_len); H, hp, normals per welded vertex"""
    inv, Pw, T = weld(np.asarray(W, float), np.asarray(tri))
    E = edge_list(T)
    H = mean_curvature(Pw, T)
    return {'inv': inv, 'Pw': Pw, 'T': T, 'E': E, 'normals': vertex_normals(Pw, T), 'H': H,
            'hp': H - smooth(H, E, iters), 'edge_len': np.linalg.norm(Pw[E[:, 0]] - Pw[E[:, 1]], axis=1)}


def auto_curv_scale(results):
    """one curvature scale (1/length) for all objects of a run, and how it was derived"""
    hp = np.concatenate([np.abs(r['hp'][np.bincount(r['E'].ravel(), minlength=len(r['hp'])) > 0]) for r in results])
    ell = float(np.median(np.concatenate([r['edge_len'] for r in results])))
    p90 = float(np.percentile(hp, 90))
    floor = AUTO_FLOOR_PER_EDGE / ell
    return max(p90, floor), {'p90_abs_highpass': p90, 'median_edge_length': ell, 'floor_from_edge_length': floor,
                             'rule': 'max(p90, %g / median_edge_length)' % AUTO_FLOOR_PER_EDGE}


def curv_colors(x, scale):
    """curvature values -> RGB rows (pixel values), clipped at +-scale, convex (positive) = red"""
    t = (np.clip(np.asarray(x, float) / scale, -1, 1) + 1) * 2.0              # 0..4
    i = np.minimum(t.astype(int), 3)
    f = (t - i)[:, None]
    return STOPS[i] * (1 - f) + STOPS[i + 1] * f


# ------------------------------------------------------------------------------------------------ Blender side
def object_geometry(ob, depsgraph):
    """evaluated mesh of ob (current pose) as a new temporary mesh datablock + world positions, loop triangles, mirrored flag"""
    ev = ob.evaluated_get(depsgraph)
    me = bpy.data.meshes.new_from_object(ev, depsgraph=depsgraph)
    n = len(me.vertices)
    co = np.zeros(n * 3); me.vertices.foreach_get('co', co)
    M = np.array(ev.matrix_world)
    W = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    me.calc_loop_triangles()
    tri = np.zeros(len(me.loop_triangles) * 3, dtype=np.int64); me.loop_triangles.foreach_get('vertices', tri)
    mirrored = np.linalg.det(M[:3, :3]) < 0
    return me, W, tri.reshape(-1, 3), bool(mirrored)


def make_material(mode):
    m = bpy.data.materials.new('SV_' + mode)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    L = nt.links.new
    em = nt.nodes.new('ShaderNodeEmission'); out = nt.nodes.new('ShaderNodeOutputMaterial')
    L(em.outputs[0], out.inputs['Surface'])
    dots = []
    if mode == 'normal':
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        for _ in range(3):                      # dot(normal, camera axis k); axis constants are set per view
            dn = nt.nodes.new('ShaderNodeVectorMath'); dn.operation = 'DOT_PRODUCT'
            L(geo.outputs['Normal'], dn.inputs[0]); dots.append(dn)
        cx = nt.nodes.new('ShaderNodeCombineXYZ')
        for k, ax in enumerate('XYZ'):
            L(dots[k].outputs['Value'], cx.inputs[ax])
        ma = nt.nodes.new('ShaderNodeVectorMath'); ma.operation = 'MULTIPLY_ADD'
        ma.inputs[1].default_value = (0.5, 0.5, 0.5); ma.inputs[2].default_value = (NORMAL_OFFSET,) * 3
        L(cx.outputs[0], ma.inputs[0]); L(ma.outputs[0], em.inputs['Color'])
    else:
        ca = nt.nodes.new('ShaderNodeVertexColor'); ca.layer_name = 'hp'
        L(ca.outputs['Color'], em.inputs['Color'])
    w = bpy.data.worlds.new('SV_world_' + mode)
    if w.node_tree is None:
        w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    g = BACKGROUND[mode]
    bg.inputs['Color'].default_value = (g, g, g, 1.0); bg.inputs['Strength'].default_value = 1.0
    return m, w, dots


def safe_name(s):
    return re.sub(r'[^A-Za-z0-9._-]', '_', s)


def parse(argv):
    import argparse
    ap = argparse.ArgumentParser(prog='surface_views.py')
    ap.add_argument('--objects', required=True, help='comma list of object names')
    ap.add_argument('--out', required=True)
    ap.add_argument('--modes', default='normal,curv')
    ap.add_argument('--views', default='front,side,back,q34')
    ap.add_argument('--size', type=int, default=1200)
    ap.add_argument('--frame', default='', help='X,Y,Z,SIZE: frame centre and size in scene units')
    ap.add_argument('--curv-scale', default='auto')
    ap.add_argument('--smooth-iters', type=int, default=12)
    a = ap.parse_args(argv)
    a.out = os.path.abspath(a.out)  # Blender resolves a relative render path against the drive root
    a.objects =[x for x in a.objects.split(',') if x]
    a.modes = [x for x in a.modes.split(',') if x]
    a.views = [x for x in a.views.split(',') if x]
    for m in a.modes:
        if m not in BACKGROUND:
            raise SystemExit('surface_views: unknown mode %r (normal, curv)' % m)
    for v in a.views:
        if v not in VIEW_DIRS:
            raise SystemExit('surface_views: unknown view %r (%s)' % (v, ', '.join(VIEW_DIRS)))
    a.frame_t = None
    if a.frame:
        try:
            f = [float(x) for x in a.frame.split(',')]
            assert len(f) == 4 and f[3] > 0
        except (ValueError, AssertionError):
            raise SystemExit('surface_views: --frame needs X,Y,Z,SIZE with SIZE > 0')
        a.frame_t = f
    a.scale_t = None if a.curv_scale == 'auto' else float(a.curv_scale)
    if a.scale_t is not None and a.scale_t <= 0:
        raise SystemExit('surface_views: --curv-scale must be > 0')
    if not a.objects:
        raise SystemExit('surface_views: --objects is empty')
    return a


def view_basis(d):
    d = Vector(d)
    rgt = Vector((0, 0, 1)).cross(d).normalized()
    upv = d.cross(rgt).normalized()
    return d, rgt, upv


def main(argv):
    a = parse(argv)
    sc = bpy.context.scene
    missing = [n for n in a.objects if n not in bpy.data.objects]
    if missing:
        raise SystemExit('surface_views: objects not found: %s' % missing)
    os.makedirs(a.out, exist_ok=True)
    dg = bpy.context.evaluated_depsgraph_get()

    # geometry and measurements, once per object
    items = []
    for n in a.objects:
        ob = bpy.data.objects[n]
        me, W, tri, mirrored = object_geometry(ob, dg)
        if len(W) == 0 or len(tri) == 0:
            raise SystemExit('surface_views: object %r has no evaluated faces' % n)
        res = analyze(W, tri[:, [0, 2, 1]] if mirrored else tri, a.smooth_iters)
        items.append({'name': n, 'mesh': me, 'W': W, 'mirrored': mirrored, 'res': res})

    # shared frame
    allP = np.concatenate([it['W'] for it in items])
    if a.frame_t:
        centre, size = np.array(a.frame_t[:3]), a.frame_t[3]
        frame_src = 'given'
    else:
        centre = 0.5 * (allP.min(0) + allP.max(0))
        half = 0.0
        for v in a.views:
            _, rgt, upv = view_basis(VIEW_DIRS[v])
            q = allP - centre
            half = max(half, np.abs(q @ np.array(rgt)).max(), np.abs(q @ np.array(upv)).max())
        size = max(2.0 * half * FRAME_MARGIN, 1e-12)
        frame_src = 'auto'
    radius = float(np.linalg.norm(allP - centre, axis=1).max())
    dist = 2.0 * radius + size

    # shared curvature scale
    scale, scale_info = None, None
    if 'curv' in a.modes:
        if a.scale_t is None:
            scale, scale_info = auto_curv_scale([it['res'] for it in items])
            scale_info['source'] = 'auto'
        else:
            scale, scale_info = a.scale_t, {'source': 'given'}

    # scene: temporary objects, camera, render settings
    coll = bpy.data.collections.new('SV_tmp'); sc.collection.children.link(coll)
    for it in items:
        me, res, mirrored = it['mesh'], it['res'], it['mirrored']
        me.vertices.foreach_set('co', it['W'].reshape(-1)); me.update()
        if mirrored:
            me.flip_normals()
        me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
        me.normals_split_custom_set_from_vertices(res['normals'][res['inv']].tolist())
        if 'curv' in a.modes:
            col = np.ones((len(it['W']), 4)); col[:, :3] = curv_colors(res['hp'], scale)[res['inv']]
            if 'hp' in me.color_attributes:
                me.color_attributes.remove(me.color_attributes['hp'])
            ca = me.color_attributes.new('hp', 'FLOAT_COLOR', 'POINT')
            ca.data.foreach_set('color', col.reshape(-1))
        me.update()
        it['obj'] = bpy.data.objects.new('SV_' + it['name'], me)
        coll.objects.link(it['obj'])
    hidden_before = {o.name: o.hide_render for o in bpy.data.objects}
    old = {'engine': sc.render.engine, 'camera': sc.camera, 'world': sc.world, 'override': bpy.context.view_layer.material_override}

    cd = bpy.data.cameras.new('SV_cam'); cam = bpy.data.objects.new('SV_cam', cd); sc.collection.objects.link(cam); sc.camera = cam
    cd.type = 'ORTHO'; cd.sensor_fit = 'AUTO'; cd.sensor_width = 36.0; cd.ortho_scale = size
    cd.clip_start = max(dist - 1.05 * radius, dist * 1e-3); cd.clip_end = dist + 1.05 * radius
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 16
    sc.cycles.use_adaptive_sampling = False; sc.cycles.use_denoising = False; sc.cycles.max_bounces = 0
    sc.cycles.pixel_filter_type = 'BLACKMAN_HARRIS'; sc.cycles.filter_width = 1.5
    sc.render.film_transparent = False; sc.render.use_motion_blur = False; sc.render.use_border = False
    sc.render.use_compositing = False; sc.render.use_sequencer = False; sc.render.dither_intensity = 0.0
    sc.view_settings.view_transform = 'Raw'; sc.view_settings.look = 'None'; sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0; sc.view_settings.use_curve_mapping = False
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGB'
    sc.render.image_settings.color_depth = '8'
    sc.render.resolution_x = sc.render.resolution_y = a.size; sc.render.resolution_percentage = 100

    files = []
    try:
        for mode in a.modes:
            mat, world, dots = make_material(mode)
            sc.world = world; bpy.context.view_layer.material_override = mat
            for it in items:
                for o in bpy.data.objects:
                    o.hide_render = o is not it['obj'] and o is not cam
                it['obj'].hide_render = False
                for v in a.views:
                    d, _, _ = view_basis(VIEW_DIRS[v])
                    cam.location = Vector(centre.tolist()) + d * dist
                    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
                    bpy.context.view_layer.update()
                    if mode == 'normal':                    # camera axes (right, up, towards camera) in world space
                        Rm = cam.matrix_world.to_3x3()
                        for k in range(3):
                            dots[k].inputs[1].default_value = tuple(Rm.col[k])
                    path = os.path.join(a.out, '%s__%s__%s.png' % (safe_name(it['name']), v, mode))
                    sc.render.filepath = path
                    bpy.ops.render.render(write_still=True)
                    files.append(os.path.basename(path))
    finally:
        for o in bpy.data.objects:
            if o.name in hidden_before:
                o.hide_render = hidden_before[o.name]
        sc.render.engine = old['engine']; sc.camera = old['camera']; sc.world = old['world']
        bpy.context.view_layer.material_override = old['override']
        bpy.data.objects.remove(cam); bpy.data.cameras.remove(cd)
        for it in items:
            bpy.data.objects.remove(it['obj']); bpy.data.meshes.remove(it['mesh'])
        bpy.data.collections.remove(coll)

    info = {'objects': a.objects, 'modes': a.modes, 'views': a.views, 'size_px': a.size, 'units': 'scene units',
            'frame': {'center': [float(x) for x in centre], 'size': float(size), 'source': frame_src,
                      'axes': 'ortho square, Z up; front looks along +Y, side from +X, back from +Y, q34 from front-right'},
            'curv_scale': scale, 'curv_scale_unit': '1/scene unit' if scale is not None else None,
            'curv_scale_info': scale_info, 'smooth_iters': a.smooth_iters, 'files': files,
            'mirrored_objects': [it['name'] for it in items if it['mirrored']]}
    with open(os.path.join(a.out, 'surface_views.json'), 'w', encoding='utf-8') as f:
        json.dump(info, f, indent=1)
    print('SURFACE_VIEWS %d images -> %s (frame %.4g, curv scale %s)' % (len(files), a.out, size, scale))


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
