#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_demo.py - Package multi-agent-hub console into a standalone, zero-dependency interactive demo HTML.
"""

import os
import re

def build_demo():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    src_html_path = os.path.join(repo_root, 'console', 'client', 'index.html')
    engine_js_path = os.path.join(repo_root, 'scripts', 'demo_engine.js')
    
    with open(src_html_path, 'r', encoding='utf-8') as f:
        html = f.read()

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
