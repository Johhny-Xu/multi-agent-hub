#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_demo.py - Package multi-agent-hub console into a standalone, zero-dependency interactive demo HTML.
"""

import base64
import mimetypes
import os
import re

# 前端里引用的本地图片（如看板娘 mascot/*.webp）在 demo 里必须内联成 data URI，
# 否则双击打开 demo.html 时相对路径失效、图片全空。
LOCAL_ASSET_RE = re.compile(r'src="((?!https?:|data:|//)[^"]+\.(?:webp|png|jpe?g|gif|svg|webm|mp4))"')


def inline_local_assets(html, client_dir):
    def repl(match):
        rel = match.group(1)
        path = os.path.join(client_dir, *rel.split('/'))
        if not os.path.isfile(path):
            print(f"[WARN] demo asset missing: {rel}")
            return match.group(0)
        mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        with open(path, 'rb') as fh:
            encoded = base64.b64encode(fh.read()).decode('ascii')
        return f'src="data:{mime};base64,{encoded}"'

    return LOCAL_ASSET_RE.sub(repl, html)


def build_demo():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    src_html_path = os.path.join(repo_root, 'console', 'client', 'index.html')
    engine_js_path = os.path.join(repo_root, 'scripts', 'demo_engine.js')
    
    with open(src_html_path, 'r', encoding='utf-8') as f:
        html = f.read()

    html = inline_local_assets(html, os.path.dirname(src_html_path))

    with open(engine_js_path, 'r', encoding='utf-8') as f:
        engine_js = f.read()

    mock_script_tag = f'\n<script id="demo-mock-engine">\n{engine_js}\n</script>\n'

    # Inject mock engine right after <head> without regex escape corruption
    head_idx = html.lower().find('<head>')
    if head_idx != -1:
        insert_pos = head_idx + 6
        demo_html = html[:insert_pos] + mock_script_tag + html[insert_pos:]
    else:
        demo_html = mock_script_tag + '\n' + html

    # Write output to demo/index.html and root demo.html
    demo_dir = os.path.join(repo_root, 'demo')
    os.makedirs(demo_dir, exist_ok=True)
    demo_index_path = os.path.join(demo_dir, 'index.html')
    with open(demo_index_path, 'w', encoding='utf-8') as f:
        f.write(demo_html)
    print(f"[OK] Generated {demo_index_path} ({os.path.getsize(demo_index_path)} bytes)")

    # Also copy to root demo.html
    root_demo_path = os.path.join(repo_root, 'demo.html')
    with open(root_demo_path, 'w', encoding='utf-8') as f:
        f.write(demo_html)
    print(f"[OK] Generated {root_demo_path} ({os.path.getsize(root_demo_path)} bytes)")

    # Also copy to user Desktop for convenience
    user_desktop = os.path.expanduser(r'~\Desktop')
    if os.path.exists(user_desktop):
        desktop_demo_path = os.path.join(user_desktop, 'multi-agent-hub-demo.html')
        with open(desktop_demo_path, 'w', encoding='utf-8') as f:
            f.write(demo_html)
        print(f"[OK] Generated {desktop_demo_path} ({os.path.getsize(desktop_demo_path)} bytes)")

if __name__ == '__main__':
    build_demo()
