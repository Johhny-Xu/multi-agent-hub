#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
inline_mascot.py - 把看板娘素材内联进 console/client/index.html（幂等，可反复跑）。

为什么必须内联
--------------
控制台是**单文件前端**：`console/server.mjs` 只把 `index.html` 的字节吐给 `/`，
没有静态资源路由；线上部署也是 `scp console/client/index.html miniapp/client/`。
所以 `src="mascot/xxx.webm"` 这种相对路径在服务器上必然 404 —— 表现为「看板娘不显示」。

两种形态都支持：
- 还没内联：`src="mascot/mascot-loop.webm"` -> 换成 data URI
- 已经内联过：`src="data:video/webm;base64,..."` -> 用磁盘上的新素材替换掉

用法
----
    python scripts/inline_mascot.py            # 内联 / 刷新（幂等）
    python scripts/inline_mascot.py --check    # 只检查有没有漏内联的素材
"""

import argparse
import base64
import mimetypes
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = ROOT / "console" / "client" / "index.html"
CLIENT = ROOT / "console" / "client"

VIDEO_FILE = CLIENT / "mascot" / "mascot-loop.webm"
FALL_FILE = CLIENT / "mascot" / "mascot-fall.webm"
HANG_FILE = CLIENT / "mascot" / "mascot-hang.webm"
WIPE_FILE = CLIENT / "mascot" / "mascot-wipe.webm"
POSTER_FILE = CLIENT / "mascot" / "mascot-poster.webp"

# 还没内联的相对路径
REL_RE = re.compile(r'src="(mascot/[^"]+\.(?:webm|webp|png|jpe?g|gif|svg))"')
# 已经内联过的两处（按 id / type 精确定位，避免误伤别的 data URI）
POSTER_RE = re.compile(r'(<img class="mascot-poster" id="mascot-poster" src=")data:image/[a-z]+;base64,[^"]*(")')
VIDEO_RE = re.compile(r'(<source data-asset="loop" src=")data:video/[a-z0-9]+;base64,[^"]*(" type="video/webm")')
FALL_RE = re.compile(r'(<source data-asset="fall" src=")data:video/[a-z0-9]+;base64,[^"]*(" type="video/webm")')
HANG_RE = re.compile(r'(<source data-asset="hang" src=")data:video/[a-z0-9]+;base64,[^"]*(" type="video/webm")')
WIPE_RE = re.compile(r'(<source data-asset="wipe" src=")data:video/[a-z0-9]+;base64,[^"]*(" type="video/webm")')


def data_uri(path):
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查有没有漏内联的素材")
    args = ap.parse_args()

    html = HTML.read_text(encoding="utf-8")
    changed = 0

    # 1) 相对路径 -> data URI
    for rel in set(REL_RE.findall(html)):
        path = CLIENT / rel
        if not path.is_file():
            print(f"[FAIL] 素材不存在：{path}")
            return 2
        if args.check:
            print(f"[WARN] 还没内联：{rel}")
            changed += 1
            continue
        html = html.replace(f'src="{rel}"', f'src="{data_uri(path)}"')
        print(f"[OK] {rel} -> data URI")
        changed += 1

    # 2) 已经内联过 -> 用磁盘上的最新素材刷新
    for regex, path, label in (
        (POSTER_RE, POSTER_FILE, "封面"),
        (VIDEO_RE, VIDEO_FILE, "动画"),
        (HANG_RE, HANG_FILE, "被拎着挣扎"),
        (FALL_RE, FALL_FILE, "坠落"),
        (WIPE_RE, WIPE_FILE, "落地擦汗"),
    ):
        if not path.is_file():
            print(f"[FAIL] 素材不存在：{path}")
            return 2
        new_html, n = regex.subn(lambda m: m.group(1) + data_uri(path) + m.group(2), html)
        if n:
            html = new_html
            if args.check:
                print(f"[INFO] {label} 已内联（{path.stat().st_size} B）")
            else:
                print(f"[OK] 刷新{label} -> {path.name}（{path.stat().st_size} B）")
                changed += 1

    if args.check:
        return 0

    if not changed:
        print("[OK] 无需改动")
        return 0

    HTML.write_text(html, encoding="utf-8")
    print(f"[OK] 写回 {HTML}（{len(html)} chars）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
