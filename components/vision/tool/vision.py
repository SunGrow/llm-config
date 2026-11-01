#!/usr/bin/env python
"""Small on-demand vision toolkit: image retrieval, normals, silhouette masks, comparison, pose, point tracking.

Each sub-command loads only the model it needs and exits; there is no daemon.
stdout is one short JSON object; large output goes to files.
Run "vision.py setup" once (about 12 GB with model weights); afterwards any Python can start this file and it
hands over to its own virtual environment.

How far each output was checked: bench/perception-tools.md in the llm-config repository.

Cache locations (override with environment variables):
  VISION_CACHE  base cache dir (default ~/.agents/cache/vision)
  HF_HOME       Hugging Face cache (default $VISION_CACHE/hf)
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

_CACHE = Path(os.environ.get("VISION_CACHE", Path.home() / ".agents" / "cache" / "vision"))
_VENV = _CACHE / "venv"
_VENV_PY = _VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
os.environ.setdefault("HF_HOME", str(_CACHE / "hf"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}

# Model ids. BiRefNet is pinned because it runs the repository's own code (trust_remote_code).
MODELS = {
    "dinov2": "facebook/dinov2-base",
    "siglip2": "google/siglip2-so400m-patch14-384",
}
MOGE_ID = "Ruicheng/moge-2-vitl-normal"
BIREFNET_ID = "ZhengPeng7/BiRefNet"
BIREFNET_REV = "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4"


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, default=lambda o: o.item() if hasattr(o, "item") else str(o)))


def fail(msg, code=1):
    out({"error": msg})
    sys.exit(code)


def proc_start_age():
    """Seconds since this process was created (includes interpreter start and imports)."""
    import psutil
    return time.time() - psutil.Process().create_time()


def peak_ram_mb():
    import psutil
    mi = psutil.Process().memory_info()
    return round(getattr(mi, "peak_wset", mi.rss) / 2**20, 1)


def cuda_peaks():
    import torch
    if not torch.cuda.is_available():
        return {}
    return {"peak_vram_alloc_mb": round(torch.cuda.max_memory_allocated() / 2**20, 1),
            "peak_vram_reserved_mb": round(torch.cuda.max_memory_reserved() / 2**20, 1)}


def require_cuda():
    import torch
    if not torch.cuda.is_available():
        fail("CUDA not available to torch")
    return torch.device("cuda")


def crop_to_alpha(im):
    """Square crop of an RGBA image around its visible pixels, or the image itself if they nearly fill it.
    A small figure on a large transparent canvas otherwise embeds as mostly white."""
    box = im.getchannel("A").point(lambda v: 255 if v > 12 else 0).getbbox()
    if not box:
        return im
    w, h = box[2] - box[0], box[3] - box[1]
    if w * h >= 0.9 * im.width * im.height:
        return im
    side = round(max(w, h) * 1.1)
    x, y = (box[0] + box[2] - side) // 2, (box[1] + box[3] - side) // 2
    return im.crop((x, y, x + side, y + side))


def load_rgb(path, max_side=None, crop_alpha=False):
    """Open an image as RGB (alpha composited on white). Optionally cap the longest side."""
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 400_000_000
    im = Image.open(path)
    if max_side and im.format == "JPEG":
        im.draft("RGB", (max_side, max_side))
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        if crop_alpha:
            im = crop_to_alpha(im)
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    im = im.convert("RGB")
    if max_side and max(im.size) > max_side:
        s = max_side / max(im.size)
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    return im


# ----------------------------------------------------------------------------- embeddings

class Embedder:
    """DINOv2 (CLS, letterboxed 224) or SigLIP 2 (384, squashed as in the model's own processor)."""

    def __init__(self, kind):
        import torch
        from transformers import AutoModel
        self.torch = torch
        self.kind = kind
        self.dev = require_cuda()
        mid = MODELS[kind]
        self.model = AutoModel.from_pretrained(mid, dtype=torch.float16).to(self.dev).eval()
        if kind == "dinov2":
            self.size, self.mean, self.std, self.letterbox = 224, (0.485, 0.456, 0.406), (0.229, 0.224, 0.225), True
        else:
            from transformers import AutoTokenizer
            self.tok = AutoTokenizer.from_pretrained(mid)
            self.size, self.mean, self.std, self.letterbox = 384, (0.5,) * 3, (0.5,) * 3, False
        self._m = torch.tensor(self.mean, device=self.dev).view(1, 3, 1, 1) * 255
        self._s = torch.tensor(self.std, device=self.dev).view(1, 3, 1, 1) * 255

    def prep(self, path):
        """Decode + resize to a uint8 HxWx3 array of the model size (runs in worker threads)."""
        import numpy as np
        from PIL import Image
        n = self.size
        im = load_rgb(path, max_side=n * 4, crop_alpha=True)
        if self.letterbox:
            s = n / max(im.size)
            im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.BICUBIC)
            canvas = Image.new("RGB", (n, n), tuple(int(m * 255) for m in self.mean))
            canvas.paste(im, ((n - im.width) // 2, (n - im.height) // 2))
            im = canvas
        else:
            im = im.resize((n, n), Image.BICUBIC)
        return np.asarray(im)

    def _feat(self, out_obj):
        torch = self.torch
        if isinstance(out_obj, torch.Tensor):
            return out_obj
        return out_obj.pooler_output

    def embed_arrays(self, arrs):
        torch = self.torch
        x = torch.from_numpy(__import__("numpy").stack(arrs)).to(self.dev).permute(0, 3, 1, 2).float()
        x = ((x - self._m) / self._s).half()
        with torch.inference_mode():
            if self.kind == "dinov2":
                f = self.model(pixel_values=x).pooler_output
            else:
                f = self._feat(self.model.get_image_features(pixel_values=x))
            f = torch.nn.functional.normalize(f.float(), dim=-1)
        return f.cpu().numpy()

    def embed_text(self, text):
        torch = self.torch
        if self.kind != "siglip2":
            raise ValueError("text queries need --model siglip2")
        t = self.tok([text.lower()], padding="max_length", max_length=64, truncation=True, return_tensors="pt")
        t = {k: v.to(self.dev) for k, v in t.items() if k == "input_ids"}
        with torch.inference_mode():
            f = self._feat(self.model.get_text_features(**t))
            f = torch.nn.functional.normalize(f.float(), dim=-1)
        return f.cpu().numpy()[0]


def list_images(root):
    files = []
    for dp, _dn, fn in os.walk(root):
        for f in fn:
            if os.path.splitext(f)[1].lower() in IMG_EXT:
                files.append(os.path.join(dp, f))
    files.sort()
    return files


def cmd_index(a):
    import random
    from concurrent.futures import ThreadPoolExecutor
    import numpy as np

    t_start = time.time()
    root = Path(a.dir)
    if not root.is_dir():
        fail(f"not a directory: {root}")
    files = list_images(root)
    n_found = len(files)
    if a.limit and a.limit < len(files):
        files = random.Random(a.seed).sample(files, a.limit)
    files = [str(Path(p).resolve()) for p in files]

    idx = Path(a.out)
    parts = idx.with_name(idx.name + ".parts")
    parts.mkdir(parents=True, exist_ok=True)
    done, skipped = set(), set()
    for jf in parts.glob("chunk_*.json"):
        d = json.loads(jf.read_text(encoding="utf-8"))
        done.update(d["paths"])
        skipped.update(d["skipped"])
    todo = [p for p in files if p not in done and p not in skipped]
    next_chunk = len(list(parts.glob("chunk_*.json")))

    emb = Embedder(a.model)
    import torch
    torch.cuda.reset_peak_memory_stats()
    t_loaded = proc_start_age()

    CH, BS = 256, 32
    chunks = [todo[i:i + CH] for i in range(0, len(todo), CH)]
    ex = ThreadPoolExecutor(max_workers=8)

    def submit(ch):
        return [ex.submit(emb.prep, p) for p in ch]

    t0 = time.time()
    t_first = None
    n_emb = n_skip = 0
    pending = submit(chunks[0]) if chunks else None
    for ci, ch in enumerate(chunks):
        futs = pending
        pending = submit(chunks[ci + 1]) if ci + 1 < len(chunks) else None
        ok_paths, ok_arrs, bad = [], [], []
        for p, f in zip(ch, futs):
            try:
                ok_arrs.append(f.result())
                ok_paths.append(p)
            except Exception as e:  # unreadable / corrupt / too large: skip
                bad.append(p)
                print(f"skip {p}: {type(e).__name__}", file=sys.stderr)
        feats = []
        for i in range(0, len(ok_arrs), BS):
            feats.append(emb.embed_arrays(ok_arrs[i:i + BS]))
            if t_first is None:
                t_first = proc_start_age()
        arr = np.concatenate(feats).astype(np.float16) if feats else np.zeros((0, 1), np.float16)
        np.save(parts / f"chunk_{next_chunk:06d}.npy", arr)
        (parts / f"chunk_{next_chunk:06d}.json").write_text(
            json.dumps({"paths": ok_paths, "skipped": bad}), encoding="utf-8")
        next_chunk += 1
        n_emb += len(ok_paths)
        n_skip += len(bad)
        print(f"chunk {ci + 1}/{len(chunks)} embedded={n_emb} skipped={n_skip}", file=sys.stderr)
    elapsed = time.time() - t0
    ex.shutdown()

    # Assemble in sample order from all parts.
    table = {}
    for jf in sorted(parts.glob("chunk_*.json")):
        d = json.loads(jf.read_text(encoding="utf-8"))
        npy = np.load(jf.with_suffix(".npy"))
        for p, v in zip(d["paths"], npy):
            table[p] = v
    paths = [p for p in files if p in table]
    mat = np.stack([table[p] for p in paths]) if paths else np.zeros((0, 1), np.float16)
    np.save(str(idx) + ".npy", mat)
    Path(str(idx) + ".paths.json").write_text(json.dumps(paths), encoding="utf-8")
    meta = {"model": a.model, "model_id": MODELS[a.model], "count": len(paths), "dim": int(mat.shape[1]),
            "root": str(root.resolve()), "seed": a.seed, "limit": a.limit}
    Path(str(idx) + ".meta.json").write_text(json.dumps(meta), encoding="utf-8")

    res = {"index": str(idx), "model": a.model, "found": n_found, "sampled": len(files), "indexed": len(paths),
           "embedded_this_run": n_emb, "skipped_this_run": n_skip,
           "images_per_s": round(n_emb / elapsed, 2) if elapsed > 0 and n_emb else None,
           "embed_seconds": round(elapsed, 1),
           "cold_start_model_ready_s": round(t_loaded, 1),
           "cold_start_first_batch_s": round(t_first, 1) if t_first else None,
           "peak_ram_mb": peak_ram_mb(), "total_wall_s": round(time.time() - t_start, 1)}
    res.update(cuda_peaks())
    out(res)


DUPLICATE_SIM = 0.97  # identical-looking pairs measured 0.98 and up, same figure in another outfit 0.88
BLANK_STROKE = 15  # empty gradients measured 2 to 11, the flattest real image 20, faint pencil sketches 26 and up
SHEET_TEXT = "a contact sheet, a grid of many small thumbnails"
SHEET_SIM = 0.055  # known grids measured 0.058 and up, single-subject hits 0.032 at most


def is_blank(path):
    """True if an image has no strokes or edges: 99th percentile brightness step on a 128 px thumbnail."""
    import numpy as np
    try:
        im = load_rgb(path, max_side=512, crop_alpha=True).convert("L")
    except Exception:
        return False
    im.thumbnail((128, 128))
    g = np.asarray(im, dtype=np.float32)
    steps = np.concatenate([np.abs(np.diff(g, axis=0)).ravel(), np.abs(np.diff(g, axis=1)).ravel()])
    return float(np.percentile(steps, 99)) < BLANK_STROKE


def cmd_search(a):
    import numpy as np
    idx = Path(a.idx)
    meta = json.loads(Path(str(idx) + ".meta.json").read_text(encoding="utf-8"))
    mat = np.load(str(idx) + ".npy").astype(np.float32)
    paths = json.loads(Path(str(idx) + ".paths.json").read_text(encoding="utf-8"))
    keep = np.arange(len(paths))
    if a.under:
        base = os.path.normcase(os.path.normpath(os.path.join(meta["root"], a.under))) + os.sep
        keep = np.array([i for i, p in enumerate(paths) if os.path.normcase(os.path.normpath(p)).startswith(base)], dtype=int)
        if not len(keep):
            fail(f"no indexed image under {a.under} (relative paths start at {meta['root']})")
    emb = Embedder(meta["model"])
    if a.text is not None:
        if meta["model"] != "siglip2":
            fail("--text needs an index built with --model siglip2")
        q = emb.embed_text(a.text)
    else:
        q = emb.embed_arrays([emb.prep(a.image)])[0]
    sc = mat @ q
    sheet = mat @ emb.embed_text(SHEET_TEXT) if meta["model"] == "siglip2" and not a.all else None
    order, dup, grid, blank = [], 0, 0, 0
    for j in keep[np.argsort(-sc[keep])]:
        if len(order) == a.top:
            break
        if a.all:
            order.append(int(j))
        elif order and float((mat[order] @ mat[j]).max()) > DUPLICATE_SIM:
            dup += 1
        elif sheet is not None and sheet[j] > SHEET_SIM:
            grid += 1
        elif is_blank(paths[j]):
            blank += 1
        else:
            order.append(int(j))
    res = {"model": meta["model"], "query": a.text if a.text is not None else str(a.image),
           "hidden": {"duplicates": dup, "contact_sheets": grid, "blank": blank},
           "results": [{"rank": i + 1, "path": paths[j], "score": round(float(sc[j]), 4)} for i, j in enumerate(order)]}
    if a.sheet:
        contact_sheet([paths[j] for j in order], a.sheet)
        res["sheet"] = str(a.sheet)
    out(res)


def contact_sheet(paths, out_png, cell=320, cols=4):
    """Numbered contact sheet (1..N). Numbers only; no scores or model names, so it can be judged blind."""
    from PIL import Image, ImageDraw, ImageFont
    rows = (len(paths) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * cell), (40, 40, 40))
    try:
        font = ImageFont.truetype("arialbd.ttf", 36)
    except OSError:
        font = ImageFont.load_default()
    d = ImageDraw.Draw(sheet)
    for i, p in enumerate(paths):
        x, y = (i % cols) * cell, (i // cols) * cell
        try:
            im = load_rgb(p, max_side=cell * 2, crop_alpha=True)
            im.thumbnail((cell - 8, cell - 8))
            sheet.paste(im, (x + (cell - im.width) // 2, y + (cell - im.height) // 2))
        except Exception:
            d.text((x + 10, y + cell // 2), "unreadable", fill=(255, 80, 80), font=font)
        d.rectangle([x + 4, y + 4, x + 54, y + 48], fill=(0, 0, 0))
        d.text((x + 10, y + 6), str(i + 1), fill=(255, 255, 0), font=font)
    Path(out_png).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_png)


# ----------------------------------------------------------------------------- normals

def cmd_normals(a):
    import numpy as np
    import torch
    from PIL import Image
    t0 = time.time()
    dev = require_cuda()
    from moge.model.v2 import MoGeModel
    model = MoGeModel.from_pretrained(MOGE_ID).to(dev).eval()
    t_ready = proc_start_age()
    im = load_rgb(a.img, max_side=2048)
    x = torch.from_numpy(np.asarray(im)).float().div(255).permute(2, 0, 1).to(dev)
    with torch.inference_mode():
        o = model.infer(x, use_fp16=True)
    if "normal" not in o:
        fail("checkpoint did not return normals")
    n = o["normal"].float().cpu().numpy()  # OpenCV camera coords: x right, y down, z forward
    valid = o["mask"].cpu().numpy().astype(bool)
    n = n * np.array([1, -1, -1], np.float32)  # -> x right, y up, z toward viewer (usual normal-map colours)
    rgb = ((n * 0.5 + 0.5).clip(0, 1) * 255).astype(np.uint8)
    rgb[~valid] = 0
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(a.out)
    out({"out": str(a.out), "size": list(im.size), "valid_fraction": round(float(valid.mean()), 3),
         "model_ready_s": round(t_ready, 1), "total_s": round(time.time() - t0, 1),
         "peak_ram_mb": peak_ram_mb(), **cuda_peaks()})


# ----------------------------------------------------------------------------- masks

class Segmenter:
    def __init__(self):
        import torch
        from transformers import AutoModelForImageSegmentation
        self.torch = torch
        self.dev = require_cuda()
        # trust_remote_code: official ZhengPeng7/BiRefNet repo, pinned to a revision.
        self.model = AutoModelForImageSegmentation.from_pretrained(
            BIREFNET_ID, revision=BIREFNET_REV, trust_remote_code=True, dtype=torch.float16).to(self.dev).eval()

    def mask(self, path):
        """Return (rgb PIL image, float mask HxW in [0,1] at original resolution)."""
        import numpy as np
        from PIL import Image
        torch = self.torch
        im = load_rgb(path, max_side=4096)
        x = np.asarray(im.resize((1024, 1024), Image.BICUBIC), dtype=np.float32) / 255
        x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
        t = torch.from_numpy(x).permute(2, 0, 1)[None].to(self.dev).half()
        with torch.inference_mode():
            p = self.model(t)[-1].sigmoid().float()
            p = torch.nn.functional.interpolate(p, size=(im.height, im.width), mode="bilinear", align_corners=False)
        return im, p[0, 0].clamp(0, 1).cpu().numpy()


def cmd_mask(a):
    import numpy as np
    from PIL import Image
    t0 = time.time()
    seg = Segmenter()
    t_ready = proc_start_age()
    im, m = seg.mask(a.img)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((m * 255).astype(np.uint8)).save(a.out)
    out({"out": str(a.out), "size": list(im.size), "foreground_fraction": round(float((m > 0.5).mean()), 4),
         "model_ready_s": round(t_ready, 1), "total_s": round(time.time() - t0, 1),
         "peak_ram_mb": peak_ram_mb(), **cuda_peaks()})


# ----------------------------------------------------------------------------- compare

def _largest_component(b):
    import cv2
    import numpy as np
    n, lab, stats, _ = cv2.connectedComponentsWithStats(b.astype(np.uint8), connectivity=8)
    if n <= 1:
        return b
    keep = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return lab == keep


def cmd_compare(a):
    import cv2
    import numpy as np
    t0 = time.time()
    seg = Segmenter()
    H, MARG, NB = 768, 64, 100
    items = []
    for p in (a.a, a.b):
        im, m = seg.mask(p)
        b = _largest_component(m > 0.5)
        ys, xs = np.where(b)
        if len(ys) == 0:
            fail(f"empty silhouette for {p}")
        items.append((np.asarray(im), b, (xs.min(), xs.max() + 1, ys.min(), ys.max() + 1)))

    scales = [H / (bb[3] - bb[2]) for _, _, bb in items]
    CW = int(max(H + 2 * MARG, max((bb[1] - bb[0]) * s for (_, _, bb), s in zip(items, scales)) + 2 * MARG))
    CH = H + 2 * MARG
    warped_img, warped_mask = [], []
    for (img, b, (x0, x1, y0, y1)), s in zip(items, scales):
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        M = np.array([[s, 0, CW / 2 - s * cx], [0, s, CH / 2 - s * cy]], np.float32)
        warped_img.append(cv2.warpAffine(img, M, (CW, CH), flags=cv2.INTER_AREA, borderValue=(255, 255, 255)))
        warped_mask.append(cv2.warpAffine(b.astype(np.uint8) * 255, M, (CW, CH), flags=cv2.INTER_LINEAR) > 127)
    ma, mb = warped_mask
    inter, union = int((ma & mb).sum()), int((ma | mb).sum())
    iou = inter / union if union else 0.0

    def profile(m):
        ys = np.where(m.any(1))[0]
        y0, y1 = ys.min(), ys.max() + 1
        h = y1 - y0
        prof = np.zeros(NB, np.float32)
        for i in range(NB):
            r0 = y0 + int(i * h / NB)
            r1 = max(r0 + 1, y0 + int((i + 1) * h / NB))
            prof[i] = m[r0:r1].sum(1).mean() / h  # silhouette width as a fraction of silhouette height
        return prof

    pa, pb = profile(ma), profile(mb)
    diff = pb - pa
    prof_out = Path(a.out).with_suffix(".profile.json")
    prof_out.write_text(json.dumps({"bins": NB, "unit": "width / silhouette height, top to bottom",
                                    "a": pa.round(4).tolist(), "b": pb.round(4).tolist(),
                                    "b_minus_a": diff.round(4).tolist()}), encoding="utf-8")

    def contour_overlay():
        base = np.full((CH, CW, 3), 235, np.uint8)
        for m, col in ((ma, (220, 40, 40)), (mb, (30, 110, 230))):
            base[m] = (0.5 * base[m] + 0.5 * np.array(col)).astype(np.uint8)
        for m, col in ((ma, (180, 0, 0)), (mb, (0, 60, 200))):
            cs, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(base, cs, -1, col, 3)
        return base

    def tag(img, text):
        img = img.copy()
        cv2.putText(img, text, (12, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2, cv2.LINE_AA)
        return img

    panel = np.concatenate([tag(warped_img[0], "A"), tag(warped_img[1], "B"),
                            tag(contour_overlay(), f"overlay A red, B blue  IoU {iou:.3f}")], axis=1)
    from PIL import Image
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(panel).save(a.out)
    out({"out": str(a.out), "profile_file": str(prof_out), "silhouette_iou": round(iou, 4),
         "profile_mean_abs_diff": round(float(np.abs(diff).mean()), 4),
         "profile_max_abs_diff": round(float(np.abs(diff).max()), 4),
         "profile_max_at_height_fraction": round(float(np.abs(diff).argmax() / NB), 2),
         "profile_unit": "width/height", "total_s": round(time.time() - t0, 1),
         "peak_ram_mb": peak_ram_mb(), **cuda_peaks()})


# ----------------------------------------------------------------------------- pose

COCO_SKELETON = [(15, 13), (13, 11), (16, 14), (14, 12), (11, 12), (5, 11), (6, 12), (5, 6), (5, 7), (6, 8),
                 (7, 9), (8, 10), (1, 2), (0, 1), (0, 2), (1, 3), (2, 4), (3, 5), (4, 6)]
KP_NAMES = ["nose", "l_eye", "r_eye", "l_ear", "r_ear", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow",
            "l_wrist", "r_wrist", "l_hip", "r_hip", "l_knee", "r_knee", "l_ankle", "r_ankle"]


def estimate_view(kp, sc, thr=0.3):
    """Rough view from COCO-17 keypoints. Assumes an upright, un-mirrored person.

    Cues: shoulder/hip width relative to torso length (small = side), image-left/right order of the
    person's left and right shoulders (person's left shoulder on image right = facing camera), and
    face-keypoint scores (nose/eyes visible = front; only ears = back/side).
    """
    import numpy as np
    s = sc
    ev = {}
    need = [5, 6, 11, 12]
    if min(s[i] for i in need) < thr:
        return {"view": "unknown", "reason": "shoulders/hips not all visible", "evidence": {}}
    sh_w = abs(kp[5][0] - kp[6][0])
    hip_w = abs(kp[11][0] - kp[12][0])
    torso = float(np.linalg.norm((kp[5] + kp[6]) / 2 - (kp[11] + kp[12]) / 2)) + 1e-6
    width_ratio = max(sh_w, hip_w * 1.2) / torso   # frontal adult is roughly 0.8-1.0 on this measure
    face = float(np.mean([s[0], s[1], s[2]]))
    ears = float(np.mean([s[3], s[4]]))
    order_front = (kp[5][0] - kp[6][0]) > 0 if sh_w > 0.12 * torso else None
    ev.update(shoulder_w_over_torso=round(sh_w / torso, 2), hip_w_over_torso=round(hip_w / torso, 2),
              width_ratio=round(width_ratio, 2), face_score=round(face, 2), ear_score=round(ears, 2),
              left_shoulder_on_image_right=order_front)
    if width_ratio < 0.4:
        view = "side"
    elif width_ratio < 0.7:
        view = "3/4"
    else:
        view = "front" if (order_front if order_front is not None else face >= 0.5) else "back"
    facing = None
    if view in ("3/4", "side"):
        if s[0] >= thr:
            ev["nose_side"] = "image right" if kp[0][0] > (kp[5][0] + kp[6][0]) / 2 else "image left"
        if view == "3/4" and order_front is not None:
            facing = "toward camera" if order_front else "away from camera"
    ev["facing"] = facing
    return {"view": view, "evidence": ev}


def cmd_pose(a):
    import cv2
    import numpy as np
    t0 = time.time()
    try:
        import torch  # noqa: F401  (loads CUDA/cuDNN DLLs that onnxruntime-gpu can reuse)
        import onnxruntime as ort
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls()
    except Exception:
        pass
    os.environ.setdefault("TORCH_HOME", str(_CACHE / "rtmlib"))  # rtmlib caches weights under $TORCH_HOME/hub
    from rtmlib import Body
    import onnxruntime as ort
    # onnxruntime-gpu 1.31 needs the CUDA 13 runtime, which torch cu128 does not ship: default to CPU.
    dev = os.environ.get("VISION_POSE_DEVICE", "cpu")
    body = Body(mode="balanced", backend="onnxruntime", device=dev)
    used = None
    try:
        used = body.pose_model.session.get_providers()[0]
    except Exception:
        pass
    t_ready = proc_start_age()
    im = load_rgb(a.img, max_side=2048)
    bgr = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
    kps, scs = body(bgr)
    if len(kps) == 0:
        fail("no person detected")
    best = int(np.argmax([float(np.mean(s)) * (np.ptp(k[:, 1]) + 1) for k, s in zip(kps, scs)]))
    kp, sc = np.asarray(kps[best], np.float32), np.asarray(scs[best], np.float32)
    view = estimate_view(kp, sc)
    vis = bgr.copy()
    for i, j in COCO_SKELETON:
        if sc[i] > 0.3 and sc[j] > 0.3:
            cv2.line(vis, tuple(int(v) for v in kp[i]), tuple(int(v) for v in kp[j]), (0, 200, 0), 3, cv2.LINE_AA)
    for i, (p, s) in enumerate(zip(kp, sc)):
        if s > 0.3:
            cv2.circle(vis, (int(p[0]), int(p[1])), 5, (0, 0, 255), -1, cv2.LINE_AA)
    fs = max(0.4, min(1.1, vis.shape[1] / 300))
    ty = int(30 * fs) + 4
    cv2.putText(vis, f"view: {view['view']}", (6, ty), cv2.FONT_HERSHEY_SIMPLEX, fs, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(vis, f"view: {view['view']}", (6, ty), cv2.FONT_HERSHEY_SIMPLEX, fs, (0, 255, 255), 2, cv2.LINE_AA)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(a.out), vis)
    res = {"out": str(a.out), "persons": int(len(kps)), "provider": used or dev, "view": view["view"],
           "evidence": view["evidence"], "model_ready_s": round(t_ready, 1), "total_s": round(time.time() - t0, 1),
           "peak_ram_mb": peak_ram_mb()}
    if view.get("reason"):
        res["reason"] = view["reason"]
    if a.json:
        res["keypoints"] = [{"name": KP_NAMES[i], "x": round(float(kp[i][0]), 1), "y": round(float(kp[i][1]), 1),
                             "score": round(float(sc[i]), 3)} for i in range(len(KP_NAMES))]
    out(res)


# ----------------------------------------------------------------------------- track

# BootsTAPIR (PyTorch port) from google-deepmind/tapnet; code and checkpoints are Apache-2.0.
TAPIR_CKPT_URL = "https://storage.googleapis.com/dm-tapnet/bootstap/bootstapir_checkpoint_v2.pt"
TRACK_RES = 256  # the model is trained and evaluated at 256x256


def _tapir_checkpoint():
    import urllib.request
    p = _CACHE / "tapnet" / "bootstapir_checkpoint_v2.pt"
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".part")
        urllib.request.urlretrieve(TAPIR_CKPT_URL, tmp)
        tmp.replace(p)
    return p


def _parse_points(s):
    pts = []
    for tok in s.split(";"):
        tok = tok.strip()
        if tok:
            x, y = tok.split(",")
            pts.append((float(x), float(y)))
    if not pts:
        raise ValueError("no points in --points")
    return pts


def _palette(n):
    import cv2
    import numpy as np
    hsv = np.zeros((max(n, 1), 1, 3), np.uint8)
    hsv[:, 0, 0] = (np.arange(max(n, 1)) * 179 / max(n, 1)).astype(np.uint8)
    hsv[:, 0, 1:] = 255
    return [tuple(int(c) for c in row[0]) for row in cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)]


def cmd_track(a):
    import cv2
    import numpy as np
    import torch
    t0 = time.time()
    dev = require_cuda()
    cap = cv2.VideoCapture(str(a.video))
    if not cap.isOpened():
        fail(f"cannot open video: {a.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n_total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    s_idx = max(0, int(round(a.start * fps))) if a.start else 0
    e_idx = min(n_total, int(round(a.end * fps))) if a.end else n_total
    if e_idx - s_idx > a.max_frames:
        fail(f"{e_idx - s_idx} frames > --max-frames {a.max_frames}; narrow with --start/--end")
    cap.set(cv2.CAP_PROP_POS_FRAMES, s_idx)
    small = []
    for _ in range(s_idx, e_idx):
        ok, bgr = cap.read()
        if not ok:
            break
        small.append(cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (TRACK_RES, TRACK_RES), interpolation=cv2.INTER_AREA))
    cap.release()
    T = len(small)
    if T < 2:
        fail("fewer than 2 frames read")

    if a.points:
        pts = _parse_points(a.points)
    else:
        g = np.linspace(0.1, 0.9, a.grid)
        pts = [(float(gx * W), float(gy * H)) for gy in g for gx in g]
    q = np.array([[0, y * TRACK_RES / H, x * TRACK_RES / W] for x, y in pts], np.float32)  # (t, y, x)

    from tapnet.torch import tapir_model
    model = tapir_model.TAPIR(pyramid_level=1)
    model.load_state_dict(torch.load(_tapir_checkpoint(), map_location="cpu", weights_only=True))
    model = model.to(dev).eval()
    t_ready = proc_start_age()
    torch.cuda.reset_peak_memory_stats()
    frames = torch.from_numpy(np.stack(small)).to(dev).float() / 255 * 2 - 1
    t1 = time.time()
    with torch.inference_mode():
        o = model(frames[None], torch.from_numpy(q).to(dev)[None])
        tr = o["tracks"][0]
        occ, dist = o["occlusion"][0], o["expected_dist"][0]
        vis = ((1 - torch.sigmoid(occ)) * (1 - torch.sigmoid(dist)) > 0.5)
    tr = tr.cpu().numpy().transpose(1, 0, 2)          # (T, N, 2) x,y in 256 space
    vis = vis.cpu().numpy().T                          # (T, N)
    tr = tr * np.array([W / TRACK_RES, H / TRACK_RES], np.float32)
    t_track = time.time() - t1

    outdir = Path(a.out)
    outdir.mkdir(parents=True, exist_ok=True)
    np.savez(outdir / "tracks.npz", tracks=tr.astype(np.float32), visible=vis, fps=np.float32(fps),
             times=((np.arange(T) + s_idx) / fps).astype(np.float32), query_xy=np.array(pts, np.float32),
             start_frame=np.int32(s_idx), width=np.int32(W), height=np.int32(H))

    # frame strip with trajectories drawn
    n_strip = min(6, T)
    sel = sorted(set(np.linspace(0, T - 1, n_strip).round().astype(int).tolist()))
    cap = cv2.VideoCapture(str(a.video))
    cap.set(cv2.CAP_PROP_POS_FRAMES, s_idx)
    cols = _palette(len(pts))
    scale = 360 / H
    tiles = []
    for i in range(T):
        ok, bgr = cap.read()
        if not ok:
            break
        if i not in sel:
            continue
        img = cv2.resize(bgr, (round(W * scale), 360), interpolation=cv2.INTER_AREA)
        draw_n = min(len(pts), 64)
        for n in range(draw_n):
            c = cols[n][::-1]
            for k in range(1, i + 1):
                if vis[k, n] and vis[k - 1, n]:
                    cv2.line(img, tuple(int(v) for v in tr[k - 1, n] * scale), tuple(int(v) for v in tr[k, n] * scale),
                             c, 2, cv2.LINE_AA)
            if vis[i, n]:
                cv2.circle(img, tuple(int(v) for v in tr[i, n] * scale), 5, c, 2, cv2.LINE_AA)
                cv2.circle(img, tuple(int(v) for v in tr[i, n] * scale), 5, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(img, f"t={((i + s_idx) / fps):.2f}s", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(img, f"t={((i + s_idx) / fps):.2f}s", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(img)
    cap.release()
    cv2.imwrite(str(outdir / "strip.png"), np.concatenate(tiles, axis=1))
    out({"tracks": str(outdir / "tracks.npz"), "strip": str(outdir / "strip.png"), "frames": T, "fps": round(fps, 3),
         "points": len(pts), "visible_fraction": round(float(vis.mean()), 3), "model": "BootsTAPIR (torch)",
         "model_ready_s": round(t_ready, 1), "track_s": round(t_track, 1), "total_s": round(time.time() - t0, 1),
         "peak_ram_mb": peak_ram_mb(), **cuda_peaks()})


# ----------------------------------------------------------------------------- dynamics

def _interp_visible(p, vis):
    """Fill invisible frames of a (T,2) track by linear interpolation."""
    import numpy as np
    t = np.arange(len(p))
    if vis.sum() < 2:
        return p
    return np.stack([np.interp(t, t[vis], p[vis, d]) for d in range(2)], 1)


def _shift(p, frames):
    """Return p evaluated at (t - frames) for a (T,2) track, linear interpolation, edge-held."""
    import numpy as np
    t = np.arange(len(p))
    return np.stack([np.interp(t - frames, t, p[:, d]) for d in range(2)], 1)


def _lag_frames(a, b, max_lag=12):
    """Lag k (frames, sub-frame by parabola) maximising corr(a[t], b[t-k]); positive means a lags b."""
    import numpy as np
    a = a - a.mean()
    b = b - b.mean()
    ks = np.arange(-max_lag, max_lag + 1)
    c = []
    for k in ks:
        if k >= 0:
            x, y = a[k:], b[:len(b) - k]
        else:
            x, y = a[:k], b[-k:]
        c.append(float(np.dot(x, y)) / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-12))
    c = np.array(c)
    i = int(np.argmax(c))
    if 0 < i < len(c) - 1:
        d = c[i - 1] - 2 * c[i] + c[i + 1]
        off = 0.5 * (c[i - 1] - c[i + 1]) / d if abs(d) > 1e-12 else 0.0
    else:
        off = 0.0
    return float(ks[i] + off), float(c[i])


def _osc(t, p):
    import numpy as np
    c, a, z, f, ph = p
    w = 2 * np.pi * f
    return c + a * np.exp(-z * w * t) * np.cos(w * np.sqrt(1 - z * z) * t + ph)


def _fit_oscillator(t, y):
    """Fit y = C + a exp(-z w t) cos(w sqrt(1-z^2) t + phi) from the largest excursion onward (w = 2 pi f_natural)."""
    import numpy as np
    from scipy.optimize import least_squares
    c0 = float(np.median(y[-max(3, len(y) // 5):]))
    k0 = int(np.argmax(np.abs(y - c0)))
    tw, yw = t[k0:] - t[k0], y[k0:]
    if len(tw) < 8:
        return None
    dt = float(np.median(np.diff(tw)))
    n = 8 * len(yw)
    spec = np.abs(np.fft.rfft((yw - c0) * np.hanning(len(yw)), n=n))
    fr = np.fft.rfftfreq(n, dt)
    f0 = float(fr[1 + int(np.argmax(spec[1:]))])
    amp = float(yw[0] - c0) or 1.0
    best = None
    for z0 in (0.03, 0.1, 0.25, 0.5):
        for fm in (0.9, 1.0, 1.1):
            for ph0 in (0.0, np.pi / 2, -np.pi / 2):
                try:
                    r = least_squares(lambda p: _osc(tw, p) - yw, [c0, amp, z0, f0 * fm, ph0],
                                      bounds=([-np.inf, -np.inf, 0.001, 0.05, -2 * np.pi],
                                              [np.inf, np.inf, 0.999, 0.45 / dt, 2 * np.pi]))
                except Exception:
                    continue
                if best is None or r.cost < best.cost:
                    best = r
    if best is None:
        return None
    c, am, z, f, ph = best.x
    ss_res = float(np.sum((yw - _osc(tw, best.x)) ** 2))
    ss_tot = float(np.sum((yw - yw.mean()) ** 2)) or 1e-12
    return {"params": best.x, "t0_index": k0, "r2": 1 - ss_res / ss_tot, "zeta": float(z), "f_natural": float(f),
            "f_damped": float(f * np.sqrt(1 - z * z)),
            "overshoot_pct": float(100 * np.exp(-np.pi * z / np.sqrt(1 - z * z))), "amplitude": float(abs(am))}


def cmd_dynamics(a):
    import numpy as np
    d = np.load(a.tracks)
    tr, vis, fps = d["tracks"], d["visible"], float(d["fps"])
    n = tr.shape[1]
    for nm, v in (("--point", a.point), ("--reference", a.reference)):
        if v is not None and not 0 <= v < n:
            fail(f"{nm} {v} out of range 0..{n - 1}")
    P = _interp_visible(tr[:, a.point].astype(np.float64), vis[:, a.point])
    notes = []
    if vis[:, a.point].mean() < 0.8:
        notes.append(f"point visible in only {vis[:, a.point].mean():.0%} of frames")
    t = np.arange(len(P)) / fps
    lag_frames = lag_corr = None
    R = None
    if a.reference is not None:
        R = _interp_visible(tr[:, a.reference].astype(np.float64), vis[:, a.reference])
        if vis[:, a.reference].mean() < 0.8:
            notes.append(f"reference visible in only {vis[:, a.reference].mean():.0%} of frames")
        axis = np.linalg.svd(R - R.mean(0), full_matrices=False)[2][0]
        sa, sb = (P - P.mean(0)) @ axis, (R - R.mean(0)) @ axis
        lag_frames, lag_corr = _lag_frames(sa, sb)

    # Frames whose shifted reference would be extrapolated (edge-held) are dropped.
    m = 0 if R is None else int(np.ceil(abs(lag_frames))) + 1
    lo, hi = (m, len(P)) if (lag_frames or 0) >= 0 else (0, len(P) - m)
    if hi - lo < 8:
        fail("clip too short after lag alignment")
    t = t[lo:hi]

    def rel_of(lf):
        return (P - _shift(R, lf) if R is not None else P)[lo:hi]

    def project(rel):
        q = rel - rel.mean(0)
        ax = np.linalg.svd(q, full_matrices=False)[2][0]
        return q @ ax, ax

    y, ax = project(rel_of(lag_frames))
    fit = _fit_oscillator(t, y)
    if fit is not None and R is not None:
        # Refine the lag with the oscillation removed from the point, then refit once.
        osc = np.zeros_like(y)
        k0 = fit["t0_index"]
        osc[k0:] = _osc(t[k0:] - t[k0], fit["params"]) - fit["params"][0]
        P2 = P.copy()
        P2[lo:hi] -= np.outer(osc, ax)
        lf2, lc2 = _lag_frames((P2 - P2.mean(0)) @ axis, sb)
        if abs(lf2 - lag_frames) > 1e-6:
            lag_frames, lag_corr = lf2, lc2
            y, ax = project(rel_of(lag_frames))
            fit2 = _fit_oscillator(t, y)
            fit = fit2 or fit
    if fit is None:
        fail("not enough samples to fit an oscillator")
    k0 = fit["t0_index"]
    res = {"point": a.point, "reference": a.reference, "fps": fps,
           "frequency_hz": round(fit["f_natural"], 3), "damped_frequency_hz": round(fit["f_damped"], 3),
           "damping_ratio": round(fit["zeta"], 4), "peak_overshoot_pct": round(fit["overshoot_pct"], 1),
           "peak_amplitude_px": round(float(np.abs(y - fit["params"][0]).max()), 2),
           "lag_ms": None if lag_frames is None else round(lag_frames / fps * 1000, 1),
           "lag_correlation": None if lag_corr is None else round(lag_corr, 3),
           "r_squared": round(fit["r2"], 4), "fit_window_s": [round(float(t[k0]), 3), round(float(t[-1]), 3)]}
    if notes:
        res["notes"] = notes

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    out_png = Path(a.plot) if a.plot else Path(a.tracks).with_name(f"dynamics_p{a.point}.png")
    fig, axs = plt.subplots(2, 1, figsize=(9, 6), sharex=True)
    Pv = P[lo:hi]
    axs[0].plot(t, Pv @ ax - (Pv @ ax).mean(), label=f"point {a.point}")
    if R is not None:
        Rv = R[lo:hi]
        axs[0].plot(t, Rv @ ax - (Rv @ ax).mean(), label=f"reference {a.reference}", alpha=0.7)
    axs[0].set_ylabel("position along axis (px)")
    axs[0].legend(loc="upper right")
    axs[1].plot(t, y, ".-", label="relative motion" if R is not None else "motion")
    axs[1].plot(t[k0:], _osc(t[k0:] - t[k0], fit["params"]), "r", label="damped oscillator fit")
    axs[1].axvline(t[k0], color="gray", ls=":")
    axs[1].set_xlabel("time (s)")
    axs[1].set_ylabel("px")
    axs[1].set_title(f"f={res['frequency_hz']} Hz  zeta={res['damping_ratio']}  R2={res['r_squared']}"
                     + (f"  lag={res['lag_ms']} ms" if res["lag_ms"] is not None else ""), fontsize=10)
    axs[1].legend(loc="upper right")
    fig.tight_layout()
    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, dpi=110)
    plt.close(fig)
    res["plot"] = str(out_png)
    out(res)


# ----------------------------------------------------------------------------- setup

NO_DEPS = ["rtmlib==0.0.16", "tapnet @ git+https://github.com/google-deepmind/tapnet.git@730cda1c730877cfedbe01bf87fb1cadb78a565d"]


def cmd_setup(a):
    import subprocess
    req = Path(__file__).with_name("requirements.txt")
    if not _VENV_PY.exists():
        subprocess.run([sys.executable, "-m", "venv", str(_VENV)], check=True)
    pip = [str(_VENV_PY), "-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check", "-q"]
    subprocess.run(pip + ["-r", str(req)], check=True)
    subprocess.run(pip + ["--no-deps"] + NO_DEPS, check=True)
    out({"venv": str(_VENV), "ok": True})


# ----------------------------------------------------------------------------- cli

def main():
    if sys.argv[1:2] != ["setup"] and _VENV_PY.exists() and Path(sys.prefix).resolve() != _VENV.resolve():
        import subprocess
        sys.exit(subprocess.run([str(_VENV_PY), __file__] + sys.argv[1:]).returncode)
    ap = argparse.ArgumentParser(prog="vision", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("setup", help="create the virtual environment and install dependencies")
    p.set_defaults(fn=cmd_setup)

    p = sub.add_parser("index", help="embed images recursively (resumable)")
    p.add_argument("dir")
    p.add_argument("--out", required=True, help="index prefix; writes OUT.npy, OUT.paths.json, OUT.meta.json")
    p.add_argument("--model", choices=list(MODELS), required=True)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(fn=cmd_index)

    p = sub.add_parser("search", help="cosine top-K by image or text")
    p.add_argument("idx")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--image")
    g.add_argument("--text")
    p.add_argument("--top", type=int, default=8)
    p.add_argument("--sheet")
    p.add_argument("--under", help="only images in this folder; a relative path starts at the indexed folder")
    p.add_argument("--all", action="store_true", help="keep duplicates, contact sheets and blank images")
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("normals", help="MoGe-2 normal map")
    p.add_argument("img")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_normals)

    p = sub.add_parser("mask", help="BiRefNet silhouette mask")
    p.add_argument("img")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_mask)

    p = sub.add_parser("compare", help="silhouette comparison of two images")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_compare)

    p = sub.add_parser("pose", help="RTMPose keypoints; the view label is rough, confirm it by looking")
    p.add_argument("img")
    p.add_argument("--out", required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_pose)

    p = sub.add_parser("track", help="BootsTAPIR point tracking in a video")
    p.add_argument("video")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--points", help='"x,y;x,y" in pixels of the first used frame')
    g.add_argument("--grid", type=int, help="N x N grid of points on the first used frame")
    p.add_argument("--start", type=float, default=0.0, help="seconds")
    p.add_argument("--end", type=float, default=0.0, help="seconds (0 = end)")
    p.add_argument("--max-frames", type=int, default=600)
    p.add_argument("--out", required=True, help="output directory (tracks.npz, strip.png)")
    p.set_defaults(fn=cmd_track)

    p = sub.add_parser("dynamics", help="damped-oscillator fit of one tracked point; frequency is the checked output")
    p.add_argument("tracks")
    p.add_argument("--point", type=int, required=True)
    p.add_argument("--reference", type=int)
    p.add_argument("--plot", help="plot PNG path (default: next to tracks file)")
    p.set_defaults(fn=cmd_dynamics)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
