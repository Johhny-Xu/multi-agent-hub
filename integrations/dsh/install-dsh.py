#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
All-in-One Agent Hub - DeepSeek Harness (DSH) 插件一键安装与适配器
跨平台 (Windows / macOS / Linux)，零外部依赖。
支持：DSH MCP 工具总线 + 8 大原生子代理预设 (Presets) + 原生工作流示例
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
PRESET_IDS = [
    "preset-agenthub-all",
    "preset-agenthub-antigravity",
    "preset-agenthub-codebuddy",
    "preset-agenthub-codebuddy-cn",
    "preset-agenthub-zcode",
    "preset-agenthub-traecode",
    "preset-agenthub-copilot",
    "preset-agenthub-minimaxcode",
    "preset-agenthub-mimocode",
]

def get_dsh_home() -> Path:
    env_home = os.environ.get("DSH_HOME")
    if env_home:
        return Path(env_home).expanduser().resolve()
    return (Path.home() / ".dsh").resolve()

def find_target_patch_file(dsh_home: Path, profile_name: str) -> Path:
    target = dsh_home / "profiles" / profile_name / "cordis.patch.yml"
    if target.exists():
        return target
    profiles_dir = dsh_home / "profiles"
    if profiles_dir.exists():
        for p in profiles_dir.glob("*/cordis.patch.yml"):
            return p
    return target

def load_template_yaml(url: str, token: str = "") -> str:
    tpl_file = Path(__file__).resolve().parent / "cordis.patch.yml"
    if not tpl_file.exists():
        # 兜底
        lines = [
            f"- id: {PLUGIN_ID}",
            f"  name: \"@deepseek-ai/dsh-mcp-client\"",
            f"  config:",
            f"    serverName: {SERVER_NAME}",
            f"    transport: streamable-http",
            f"    url: {url}",
        ]
        if token:
            lines.append("    headers:")
            lines.append(f"      Authorization: \"Bearer {token}\"")
        return "\n".join(lines) + "\n"
    
    content = tpl_file.read_text(encoding="utf-8")
    # 替换 URL
    if url != DEFAULT_URL:
        content = content.replace("url: http://127.0.0.1:8765/mcp", f"url: {url}")
    # 替换 Token
    if token:
        content = content.replace("# headers:\n    #   Authorization: \"Bearer your_token_here\"",
                                  f"headers:\n      Authorization: \"Bearer {token}\"")
    return content

def is_installed(content: str) -> bool:
    return (f"id: {PLUGIN_ID}" in content or 
            f"serverName: {SERVER_NAME}" in content or
            any(pid in content for pid in PRESET_IDS))

def remove_installed(content: str) -> str:
    lines = content.splitlines()
    out = []
    in_managed_block = False
    all_target_ids = [PLUGIN_ID] + PRESET_IDS
    for line in lines:
        stripped = line.strip()
        is_target_entry = any(stripped.startswith(f"- id: {tid}") or stripped.startswith(f"- id: \"{tid}\"") for tid in all_target_ids)
        if is_target_entry:
            in_managed_block = True
            continue
        if in_managed_block:
            if stripped.startswith("- "):
                in_managed_block = False
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
                print("   已启用能力: MCP 工具总线 + 原生子代理预设 (Presets)")
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
        bak = patch_file.with_suffix(f".yml.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(patch_file, bak)
        print(f"🛡️  已自动备份原配置至: {bak.name}")
    else:
        existing_content = "# DSH Cordis profile patch layer\n[]\n"

    # 清理旧版本以实现幂等更新
    clean_content = remove_installed(existing_content)
    clean_lines = [l for l in clean_content.splitlines() if l.strip() != "[]"]
    clean_content = "\n".join(clean_lines).rstrip() + "\n"

    template_payload = load_template_yaml(args.url, args.token)
    final_content = clean_content + "\n\n" + template_payload.strip() + "\n"

    patch_file.write_text(final_content, encoding="utf-8")

    print("==========================================================")
    print("  🎉 All-in-One Agent Hub 插件已成功安装到 DeepSeek Harness！")
    print("==========================================================")
    print(f"  • 宿主环境 : DeepSeek Harness ({patch_file.parent.name})")
    print(f"  • 服务端点 : {args.url}")
    print(f"  • 认证状态 : {'[已配置 Token]' if args.token else '[未启用 Token, 本机回环]'}")
    print("  • 1. 注入 MCP 工具面 :")
    print("      - mcp__agenthub__hub_ask      (单调用直达任意 Agent 并出结果)")
    print("      - mcp__agenthub__hub_dispatch (异步派发)")
    print("      - mcp__agenthub__hub_fetch    (状态与结果轮询)")
    print("      - mcp__agenthub__hub_status   (总线在线状态)")
    print("  • 2. 注入 DSH 原生子代理 (Presets) 全量 8 大通道 :")
    print("      - agenthub-all         (全能协同总线)")
    print("      - agenthub-antigravity (专精算法证明与长思维链 - Gemini/Claude)")
    print("      - agenthub-codebuddy   (专精工业全栈代码 - DeepSeek-V4.1-Flash 国际版)")
    print("      - agenthub-codebuddy-cn(专精国内全栈代码 - DeepSeek-V4.1-Flash 国内版)")
    print("      - agenthub-zcode       (专精 Linux 运维与桌面端 AI - GLM-5.3-Flash)")
    print("      - agenthub-traecode    (专精极速代码审查 - GLM-5.3-FlashX)")
    print("      - agenthub-copilot     (GitHub Copilot Auto)")
    print("      - agenthub-minimaxcode (专精长文本问答与生成 - MiniMax-M3.1-Flash-Preview)")
    print("      - agenthub-mimocode    (小米 MiMo 架构编程代理)")
    print("  • 3. 配套 DSH 原生工作流脚本 :")
    print("      - workflows/hub-fanout.dsh.js       (多代理并发扇出)")
    print("      - workflows/code-audit.dsh.js       (双代理流水线代码审查)")
    print("      - workflows/competitive-solve.dsh.js(多模型交叉解题验证)")
    print("----------------------------------------------------------")
    print("  👉 下一步：启动或完全重启 DeepSeek Harness 客户端即可生效！")
    print("==========================================================")

if __name__ == "__main__":
    main()
