#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mascot_video_frames.py - 看板娘动画素材：白底/纯色幕布视频 -> 透明 RGBA 帧序列。

支持两种背景
------------
- `--key white`  ：白底（带一层浅灰投影也能处理）
- `--key green` / `--key magenta`：纯色幕布，走标准 chroma key + despill（边缘去溢色）
- `--key flat`   ：灰底 / 带速度线的背景（不是纯色），按「低饱和灰 + 与边缘连通」挖
- `--key auto`   ：取四角颜色判断（彩度高 -> 幕布，否则按白底）

输出给 ffmpeg 编 VP9 alpha：
    ffmpeg -framerate 24 -i rgba/%04d.png -c:v libvpx-vp9 -pix_fmt yuva420p \
           -auto-alt-ref 0 -crf 42 -b:v 0 -an mascot-loop.webm

为什么所有帧必须共用同一个裁切
------------------------------
对齐靠裁切本身，逐帧算包围盒会让整段动画左右抖。不给 `--crop` 时脚本会扫若干帧取**并集**
包围盒再加边距，得到一个固定裁切。

只依赖 Pillow + numpy + scipy。
"""

import argparse
import os

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

OUT_W = 800
BAND = 2
SAMPLE_EVERY = 20


def corners_key(rgb):
    h, w, _ = rgb.shape
    k = 12
    patches = [rgb[:k, :k], rgb[:k, -k:], rgb[-k:, :k], rgb[-k:, -k:]]
    cols = np.concatenate([p.reshape(-1, 3) for p in patches], axis=0)
    return np.median(cols, axis=0)


def is_chroma(key):
    return int(key.max() - key.min()) > 60


def alpha_from_key(rgb, key, t0=24.0, t1=140.0):
    d = np.linalg.norm(rgb.astype(np.float32) - key.astype(np.float32), axis=2)
    return np.clip((d - t0) / (t1 - t0), 0.0, 1.0)


def despill(rgb, key):
    """把边缘像素上残留的幕布色压掉：绿色幕布压 G，品红幕布压 R/B。"""
    out = rgb.astype(np.float32).copy()
    r, g, b = out[:, :, 0], out[:, :, 1], out[:, :, 2]
    if key[1] >= max(key[0], key[2]):          # 绿幕：经典 unspill，G 压到 R/B 的均值
        out[:, :, 1] = np.minimum(g, (r + b) * 0.5)
    else:                                       # 品红幕布
        cap = g
        out[:, :, 0] = np.minimum(r, cap)
        out[:, :, 2] = np.minimum(b, cap)
    return out


def alpha_white(rgb, key):
    """白底：四边 flood fill 找背景 + 单独清掉与背景连通的浅灰投影。"""
    a = rgb.astype(np.int16)
    mn = a.min(axis=2)
    mx = a.max(axis=2)
    sat = mx - mn

    cand = (mn > 195) & (sat < 26)
    lab, _ = ndimage.label(cand)
    ids = np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]]))
    ids = ids[ids > 0]
    bg = np.isin(lab, ids) if ids.size else np.zeros_like(cand)

    gray = (mn >= 175) & (mn <= 246) & (sat < 24)
    lab2, _ = ndimage.label(bg | gray)
    ids2 = np.unique(lab2[bg])
    ids2 = ids2[ids2 > 0]
    bg = bg | (np.isin(lab2, ids2) & gray & ~bg)
    return np.where(bg, 0.0, 1.0)


def kill_gray_floor(rgb, alpha):
    """幕布模式下再清一遍「与背景连通的浅灰」：她趴在桌面/地面上，
    红线下面那条灰白桌面阴影不是幕布色，key 不掉，会变成压在她身下的一条灰带。"""
    a = rgb.astype(np.int16)
    mn = a.min(axis=2)
    mx = a.max(axis=2)
    gray = (mn >= 175) & (mn <= 246) & ((mx - mn) < 24)
    bg = alpha < 0.5
    lab, _ = ndimage.label(bg | gray)
    ids = np.unique(lab[bg])
    ids = ids[ids > 0]
    hit = np.isin(lab, ids) & gray
    if hit.any():
        alpha = alpha.copy()
        alpha[hit] = 0.0
    return alpha


def kill_green_floor(rgb, alpha, floor_row):
    """红线以下那条桌沿是「白 + 幕布绿」的混色（g 明显大于 r），key 不掉也 fill 不到，
    会变成压在她身下的一条灰绿带。这一带只保留她自己的袖子（白/粉，r ≥ g），其余按绿边清掉。"""
    if floor_row is None or floor_row >= alpha.shape[0]:
        return alpha
    a = rgb.astype(np.int16)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    greenish = (g > r + 3) & (g > b + 3)
    hit = np.zeros_like(greenish)
    hit[floor_row:, :] = greenish[floor_row:, :]
    if hit.any():
        alpha = alpha.copy()
        alpha[hit] = 0.0
    return alpha


def alpha_flat(rgb, lo=100, hi=216, sat=18, feather=0.7):
    """灰底/带速度线的背景：把「低饱和 + 亮度在 lo~hi」且**与画面边缘连通**的区域当背景挖掉。

    为什么不用 chroma key：这类背景不是纯色，还有一堆白色速度线（亮度 ~184），
    用 RGB 距离要么抠不干净、要么把白衬衫也吃掉。
    白衬衫/白袜子是**被深色描边包住**的，从边缘 flood fill 进不去，所以安全。
    """
    a = rgb.astype(np.int16)
    mn = a.min(axis=2)
    mx = a.max(axis=2)
    grayish = ((mx - mn) < sat) & (mn >= lo) & (mx <= hi)
    lab, _ = ndimage.label(grayish)
    seed = np.zeros_like(grayish)
    seed[0, :] |= grayish[0, :]
    seed[-1, :] |= grayish[-1, :]
    seed[:, 0] |= grayish[:, 0]
    seed[:, -1] |= grayish[:, -1]
    ids = np.unique(lab[seed])
    ids = ids[ids > 0]
    bg = np.isin(lab, ids)
    alpha = np.where(bg, 0.0, 1.0)
    if feather:
        alpha = ndimage.gaussian_filter(alpha, feather)
    return alpha


FLAT_LO = 100
FLAT_HI = 216
FLAT_SAT = 18


def frame_alpha(rgb, key, mode):
    if mode == "white":
        return alpha_white(rgb, key)
    if mode == "flat":
        return alpha_flat(rgb, lo=FLAT_LO, hi=FLAT_HI, sat=FLAT_SAT)
    return alpha_from_key(rgb, key)


def union_bbox(paths, key, mode):
    x0 = y0 = 10 ** 9
    x1 = y1 = -1
    for p in paths:
        rgb = np.asarray(Image.open(p).convert("RGB"))
        a = frame_alpha(rgb, key, mode) > 0.15
        if not a.any():
            continue
        ys, xs = np.where(a)
        x0 = min(x0, int(xs.min()))
        x1 = max(x1, int(xs.max()))
        y0 = min(y0, int(ys.min()))
        y1 = max(y1, int(ys.max()))
    if x1 < 0:
        raise SystemExit("所有帧都是背景，检查 --key 是否匹配")
    return x0, y0, x1 + 1, y1 + 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--key", default="auto", choices=["auto", "white", "green", "magenta", "flat"])
    ap.add_argument("--crop", default="", help="x0,y0,x1,y1；不给就自动算固定裁切")
    ap.add_argument("--margin", type=int, default=18)
    ap.add_argument("--width", type=int, default=OUT_W)
    ap.add_argument("--t0", type=float, default=24.0)
    ap.add_argument("--t1", type=float, default=140.0)
    ap.add_argument("--flat-lo", type=int, default=100, help="flat 模式：可抠除的最低亮度")
    ap.add_argument("--flat-hi", type=int, default=216, help="flat 模式：可抠除的最高亮度（白底可给 255）")
    ap.add_argument("--flat-sat", type=int, default=18, help="flat 模式：可抠除的最大彩度差")
    ap.add_argument("--keep-floor", action="store_true", help="保留红线下方那条桌面灰带")
    ap.add_argument("--floor-y", type=int, default=0, help="红线所在的源图 y；这一行以下按绿边清桌面")
    args = ap.parse_args()
    global FLAT_LO, FLAT_HI, FLAT_SAT
    FLAT_LO, FLAT_HI, FLAT_SAT = args.flat_lo, args.flat_hi, args.flat_sat

    os.makedirs(args.out, exist_ok=True)
    names = sorted(f for f in os.listdir(args.frames) if f.lower().endswith(".png"))
    if not names:
        raise SystemExit("没有帧")
    paths = [os.path.join(args.frames, n) for n in names]

    first = np.asarray(Image.open(paths[0]).convert("RGB"))
    key = corners_key(first).astype(np.float32)
    mode = args.key
    if mode == "auto":
        mode = "chroma" if is_chroma(key) else "white"
        if is_chroma(key):
            mode = "green" if key[1] >= max(key[0], key[2]) else "magenta"
    print(f"背景色 {tuple(int(v) for v in key)} -> 模式 {mode}")

    if args.crop:
        x0, y0, x1, y1 = (int(v) for v in args.crop.split(","))
    else:
        sample = paths[:: max(1, len(paths) // 12)]
        bx0, by0, bx1, by1 = union_bbox(sample, key, mode)
        m = args.margin
        x0, y0 = max(0, bx0 - m), max(0, by0 - m)
        x1 = min(first.shape[1], bx1 + m)
        y1 = min(first.shape[0], by1 + m)
    size = (args.width, round((y1 - y0) * args.width / (x1 - x0)))
    ratio = size[1] / size[0]
    print(f"固定裁切 ({x0},{y0})-({x1},{y1}) -> {size[0]}x{size[1]}，共 {len(names)} 帧")
    print(f"CSS 宽高比要同步改成：--mascot-h: calc(var(--mascot-w) * {ratio:.4f});")

    chroma = mode not in ("white", "flat")
    for i, p in enumerate(paths, 1):
        im = Image.open(p).convert("RGB").crop((x0, y0, x1, y1))
        rgb = np.asarray(im)
        if mode == "flat":
            alpha = alpha_flat(rgb, lo=FLAT_LO, hi=FLAT_HI, sat=FLAT_SAT)
            out_rgb = rgb.astype(np.float32)
        elif chroma:
            alpha = alpha_from_key(rgb, key, args.t0, args.t1)
            if not args.keep_floor:
                alpha = kill_gray_floor(rgb, alpha)
                floor_row = None if args.floor_y <= 0 else round((args.floor_y - y0) * args.width / (x1 - x0))
                alpha = kill_green_floor(rgb, alpha, floor_row)
            out_rgb = despill(rgb, key)
        else:
            alpha = alpha_white(rgb, key)
            out_rgb = rgb.astype(np.float32)
        # 半透明边缘反预乘：去掉背景色混进去的那一层
        safe = np.maximum(alpha, 1e-3)[:, :, None]
        edge = (alpha > 0.02) & (alpha < 0.99)
        out_rgb = np.where(edge[:, :, None],
                           np.clip((out_rgb - (1 - safe) * key.reshape(1, 1, 3)) / safe, 0, 255),
                           out_rgb)
        img = Image.fromarray(
            np.dstack([out_rgb, alpha * 255.0]).astype(np.uint8), "RGBA"
        ).resize(size, Image.LANCZOS)
        img.putalpha(img.split()[3].filter(ImageFilter.GaussianBlur(0.6)))
        img.save(os.path.join(args.out, f"{i:04d}.png"))
        if i % 20 == 0 or i == len(names):
            print(f"  {i}/{len(names)}", flush=True)


if __name__ == "__main__":
    main()
