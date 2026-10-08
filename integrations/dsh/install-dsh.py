#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
All-in-One Agent Hub - DeepSeek Harness (DSH) 插件一键安装与适配器
跨平台 (Windows / macOS / Linux)，零外部依赖。
"""

import os
import sys
import argparse
import shutil
import time
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8765/mcp"
SERVER_NAME = "agenthub"
PLUGIN_ID = "mcp-agenthub"
PLUGIN_PACKAGE = "@deepseek-ai/dsh-mcp-client"

def get_dsh_home() -> Path:
    env_home = os.environ.get("DSH_HOME")
    if env_home:
        return Path(env_home).expanduser().resolve()
    return (Path.home() / ".dsh").resolve()

def find_target_patch_file(dsh_home: Path, profile_name: str) -> Path:
    target = dsh_home / "profiles" / profile_name / "cordis.patch.yml"
    if target.exists():
        return target
    # 尝试在 profiles 下搜寻其他存在的 cordis.patch.yml
    profiles_dir = dsh_home / "profiles"
    if profiles_dir.exists():
        for p in profiles_dir.glob("*/cordis.patch.yml"):
            return p
    return target

def build_entry_yaml(url: str, token: str = "") -> str:
    lines = [
        f"- id: {PLUGIN_ID}",
        f"  name: \"{PLUGIN_PACKAGE}\"",
        f"  config:",
        f"    serverName: {SERVER_NAME}",
        f"    transport: streamable-http",
        f"    url: {url}",
    ]
    if token:
        lines.append("    headers:")
        lines.append(f"      Authorization: \"Bearer {token}\"")
    return "\n".join(lines) + "\n"

def is_installed(content: str) -> bool:
    return f"id: {PLUGIN_ID}" in content or f"serverName: {SERVER_NAME}" in content

def remove_installed(content: str) -> str:
    lines = content.splitlines()
    out = []
    in_entry = False
    for line in lines:
        if line.strip().startswith(f"- id: {PLUGIN_ID}") or line.strip().startswith(f"- id: \"{PLUGIN_ID}\""):
            in_entry = True
            continue
        if in_entry:
            # 如果遇到新的顶级列表项 (- id:)，说明旧条目结束
            if line.strip().startswith("- "):
                in_entry = False
                out.append(line)
            continue
        out.append(line)
    return "\n".join(out).strip() + "\n"

def main():
    parser = argparse.ArgumentParser(description="为 DeepSeek Harness (DSH) 安装 All-in-One Agent Hub 插件")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"Agent Hub 任务总线地址 (默认: {DEFAULT_URL})")
    parser.add_argument("--token", default="", help="Hub 认证 Token (如有)")
    parser.add_argument("--profile", default="desktop", help="DSH profile 名称 (默认: desktop)")
    parser.add_argument("--uninstall", action="store_true", help="从 DSH 中卸载 Agent Hub 插件")
    parser.add_argument("--check", action="store_true", help="检查当前 DSH 集成状态")
    args = parser.parse_args()

    dsh_home = get_dsh_home()
    if not dsh_home.exists():
        print(f"❌ 未找到 DSH 数据目录: {dsh_home}")
        print("请确认本机已安装并至少运行过一次 DeepSeek Harness。")
        sys.exit(1)

    patch_file = find_target_patch_file(dsh_home, args.profile)
    print(f"📁 DSH 配置路径: {patch_file}")

    if args.check:
        if patch_file.exists():
            content = patch_file.read_text(encoding="utf-8")
            if is_installed(content):
                print(f"✅ All-in-One Agent Hub 插件已安装在 DSH 中 (profile: {patch_file.parent.name})")
                sys.exit(0)
        print("ℹ️ DSH 中尚未安装 All-in-One Agent Hub 插件。")
        sys.exit(0)

    if args.uninstall:
        if not patch_file.exists():
            print("配置文件不存在，无需卸载。")
            return
        content = patch_file.read_text(encoding="utf-8")
        if not is_installed(content):
            print("DSH 中未发现 Agent Hub 配置，无需卸载。")
            return
        # 备份并清理
        bak = patch_file.with_suffix(f".yml.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(patch_file, bak)
        new_content = remove_installed(content)
        patch_file.write_text(new_content, encoding="utf-8")
        print(f"✅ 已成功从 DSH 卸载 Agent Hub 插件！")
        print(f"   原配置已备份至: {bak}")
        print("   重启 DeepSeek Harness 客户端即可生效。")
        return

    # 安装 / 更新
    patch_file.parent.mkdir(parents=True, exist_ok=True)
    existing_content = ""
    if patch_file.exists():
        existing_content = patch_file.read_text(encoding="utf-8")
        # 备份
        bak = patch_file.with_suffix(f".yml.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(patch_file, bak)
        print(f"🛡️  已自动备份原配置至: {bak.name}")
    else:
        existing_content = "# DSH Cordis profile patch layer\n[]\n"

    # 清理旧版本以实现幂等更新
    clean_content = remove_installed(existing_content)
    # 如果文件末尾是空数组 []，去除以支持追加列表项
    clean_lines = [l for l in clean_content.splitlines() if l.strip() != "[]"]
    clean_content = "\n".join(clean_lines).rstrip() + "\n"

    entry = build_entry_yaml(args.url, args.token)
    final_content = clean_content + "\n" + entry

    patch_file.write_text(final_content, encoding="utf-8")

    print("==========================================================")
    print("  🎉 All-in-One Agent Hub 插件已成功安装到 DeepSeek Harness！")
    print("==========================================================")
    print(f"  • 宿主环境 : DeepSeek Harness ({patch_file.parent.name})")
    print(f"  • 服务端点 : {args.url}")
    print(f"  • 认证状态 : {'[已配置 Token]' if args.token else '[未启用 Token, 本机回环]'}")
    print("  • 注入工具 :")
    print("      - mcp__agenthub__hub_ask      (单调用直达任意 Agent 并出结果)")
    print("      - mcp__agenthub__hub_dispatch (异步派发)")
    print("      - mcp__agenthub__hub_fetch    (状态与结果轮询)")
    print("      - mcp__agenthub__hub_status   (总线在线状态)")
    print("----------------------------------------------------------")
    print("  👉 下一步：启动或完全重启 DeepSeek Harness 客户端即可生效！")
    print("==========================================================")

if __name__ == "__main__":
    main()
