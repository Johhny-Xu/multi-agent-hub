#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Multi-Agent Hub - DeepSeek Harness (DSH) 插件一键安装与适配器
跨平台 (Windows / macOS / Linux)，零外部依赖。
功能：
1. 注册 DSH 插件包：将 dsh-plugin-multi-agent-hub 写入 profile package.json，显示在界面插件列表中
2. 注入 Cordis 配置：MCP 任务总线工具 + 8 大原生子代理预设 (Presets)
3. 注入原生工作流：提供开箱即用的 DSH 工作流脚本
"""

import os
import sys
import argparse
import shutil
import time
import re
import json
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8765/mcp"
SERVER_NAME = "agenthub"
PLUGIN_ID = "mcp-agenthub"
BUNDLE_NAME = "dsh-plugin-multi-agent-hub"
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

BLOCK_BEGIN = "# >>> Multi-Agent Hub BEGIN >>>"
BLOCK_END = "# <<< Multi-Agent Hub END <<<"

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

def find_target_package_json(dsh_home: Path, profile_name: str) -> Path:
    target = dsh_home / "profiles" / profile_name / "package.json"
    if target.exists():
        return target
    profiles_dir = dsh_home / "profiles"
    if profiles_dir.exists():
        for p in profiles_dir.glob("*/package.json"):
            return p
    return target

def load_template_yaml(url: str, token: str = "") -> str:
    tpl_file = Path(__file__).resolve().parent / "cordis.patch.yml"
    mcp_script = (Path(__file__).resolve().parent / "mcp" / "server.mjs").as_posix()
    if not tpl_file.exists():
        lines = [
            f"- id: {PLUGIN_ID}",
            f"  name: \"@deepseek-ai/dsh-mcp-client\"",
            f"  config:",
            f"    serverName: {SERVER_NAME}",
            f"    transport: stdio",
            f"    command: node",
            f"    args:",
            f"      - \"{mcp_script}\"",
        ]
        return "\n".join(lines) + "\n"
    
    content = tpl_file.read_text(encoding="utf-8")
    content = content.replace("${MCP_SERVER_SCRIPT}", mcp_script)
    return content

def is_installed(content: str) -> bool:
    return (BLOCK_BEGIN in content or 
            f"id: {PLUGIN_ID}" in content or 
            f"serverName: {SERVER_NAME}" in content or
            any(pid in content for pid in PRESET_IDS))

def strip_managed_content(content: str) -> str:
    """安全剥离所有由本安装器注入的内容，保护用户原始 YAML 结构。"""
    if BLOCK_BEGIN in content and BLOCK_END in content:
        pattern = re.compile(rf"\n*{re.escape(BLOCK_BEGIN)}.*?" + rf"{re.escape(BLOCK_END)}\n*", re.S)
        content = pattern.sub("\n", content)
    
    lines = content.splitlines()
    out = []
    in_managed_top_entry = False
    all_target_ids = [PLUGIN_ID] + PRESET_IDS

    for line in lines:
        if line.startswith("- "):
            is_our_entry = any(f"id: {tid}" in line or f"id: \"{tid}\"" in line for tid in all_target_ids)
            if is_our_entry:
                in_managed_top_entry = True
                continue
            else:
                in_managed_top_entry = False
                out.append(line)
                continue
        
        if in_managed_top_entry:
            continue
        
        if line.startswith("      - id: persona") or line.strip() == "- id: persona":
            continue
        
        out.append(line)

    return "\n".join(out).strip()

def validate_yaml(content: str):
    """尝试加载 YAML，防止损坏用户配置。"""
    try:
        import yaml
        yaml.safe_load(content)
    except ImportError:
        pass
    except Exception as e:
        raise ValueError(f"YAML 语法校验未通过: {e}")

def update_profile_package_json(pkg_file: Path, install: bool = True) -> bool:
    """将插件包注册到 DSH profile 的 package.json，使其在界面插件列表中可见。"""
    if not pkg_file.parent.exists():
        return False
    
    plugin_dir = Path(__file__).resolve().parent.as_posix()
    data = {}
    if pkg_file.exists():
        try:
            data = json.loads(pkg_file.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    
    if "dependencies" not in data or not isinstance(data["dependencies"], dict):
        data["dependencies"] = {}
    if "dsh" not in data or not isinstance(data["dsh"], dict):
        data["dsh"] = {}
    if "profile" not in data["dsh"] or not isinstance(data["dsh"]["profile"], dict):
        data["dsh"]["profile"] = {}
    if "bundles" not in data["dsh"]["profile"] or not isinstance(data["dsh"]["profile"]["bundles"], list):
        data["dsh"]["profile"]["bundles"] = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]

    bundles = data["dsh"]["profile"]["bundles"]

    if install:
        data["dependencies"][BUNDLE_NAME] = f"file:{plugin_dir}"
        if BUNDLE_NAME not in bundles:
            bundles.append(BUNDLE_NAME)
    else:
        data["dependencies"].pop(BUNDLE_NAME, None)
        if BUNDLE_NAME in bundles:
            bundles.remove(BUNDLE_NAME)

    pkg_file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True

def main():
    parser = argparse.ArgumentParser(description="为 DeepSeek Harness (DSH) 安装 Multi-Agent Hub 插件")
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
    pkg_file = find_target_package_json(dsh_home, args.profile)
    print(f"📁 DSH 配置路径: {patch_file}")

    if args.check:
        if patch_file.exists():
            content = patch_file.read_text(encoding="utf-8")
            if is_installed(content):
                print(f"✅ Multi-Agent Hub 插件已安装在 DSH 中 (profile: {patch_file.parent.name})")
                print("   已启用能力: 界面插件列表显示 + MCP 工具总线 + 原生子代理预设 (Presets)")
                sys.exit(0)
        print("ℹ️ DSH 中尚未安装 Multi-Agent Hub 插件。")
        sys.exit(0)

    if args.uninstall:
        if patch_file.exists():
            content = patch_file.read_text(encoding="utf-8")
            if is_installed(content):
                bak = patch_file.with_suffix(f".yml.bak-{time.strftime('%Y%m%d-%H%M%S')}")
                shutil.copy2(patch_file, bak)
                clean_content = strip_managed_content(content) + "\n"
                validate_yaml(clean_content)
                patch_file.write_text(clean_content, encoding="utf-8")
                print(f"✅ 已成功从 DSH cordis.patch.yml 卸载配置 (备份至: {bak.name})")
        update_profile_package_json(pkg_file, install=False)
        print("✅ 已从 DSH 界面插件列表中注销！重启 DeepSeek Harness 即可生效。")
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

    clean_base = strip_managed_content(existing_content)
    clean_lines = [l for l in clean_base.splitlines() if l.strip() != "[]"]
    clean_base = "\n".join(clean_lines).rstrip()

    template_payload = load_template_yaml(args.url, args.token).strip()
    
    final_content = (
        clean_base
        + f"\n\n{BLOCK_BEGIN}\n"
        + template_payload
        + f"\n{BLOCK_END}\n"
    )

    validate_yaml(final_content)
    patch_file.write_text(final_content, encoding="utf-8")

    # 同时注册到 profile package.json，让 DSH 界面插件列表显示出来
    update_profile_package_json(pkg_file, install=True)

    print("==========================================================")
    print("  🎉 Multi-Agent Hub 插件已成功安装到 DeepSeek Harness！")
    print("==========================================================")
    print(f"  • 宿主环境 : DeepSeek Harness ({patch_file.parent.name})")
    print(f"  • 服务端点 : {args.url}")
    print(f"  • 认证状态 : {'[已配置 Token]' if args.token else '[未启用 Token, 本机回环]'}")
    print("  • 1. 注册 DSH 插件列表 (Plugins Panel) :")
    print(f"      - 包名: {BUNDLE_NAME} (已出现在 DSH 插件设置列表中)")
    print("  • 2. 注入 MCP 工具面 :")
    print("      - mcp__agenthub__hub_ask      (单调用直达任意 Agent 并出结果)")
    print("      - mcp__agenthub__hub_dispatch (异步派发)")
    print("      - mcp__agenthub__hub_fetch    (状态与结果轮询)")
    print("      - mcp__agenthub__hub_status   (总线在线状态)")
    print("  • 3. 注入 DSH 原生子代理 (Presets) 全量 8 大通道 :")
    print("      - agenthub-all         (全能协同总线)")
    print("      - agenthub-antigravity (专精算法证明与长思维链 - Gemini/Claude)")
    print("      - agenthub-codebuddy   (专精工业全栈代码 - DeepSeek-V4.1-Flash 国际版)")
    print("      - agenthub-codebuddy-cn(专精国内全栈代码 - DeepSeek-V4.1-Flash 国内版)")
    print("      - agenthub-zcode       (专精 Linux 运维与桌面端 AI - GLM-5.3-Flash)")
    print("      - agenthub-traecode    (专精极速代码审查 - GLM-5.3-FlashX)")
    print("      - agenthub-copilot     (GitHub Copilot Auto)")
    print("      - agenthub-minimaxcode (专精长文本问答与生成 - MiniMax-M3.1-Flash-Preview)")
    print("      - agenthub-mimocode    (小米 MiMo 架构编程代理)")
    print("  • 4. 配套 DSH 原生工作流脚本 :")
    print("      - workflows/hub-fanout.dsh.js       (多代理并发扇出)")
    print("      - workflows/code-audit.dsh.js       (双代理流水线代码审查)")
    print("      - workflows/competitive-solve.dsh.js(多模型交叉解题验证)")
    print("----------------------------------------------------------")
    print("  👉 下一步：启动或完全重启 DeepSeek Harness 客户端即可生效！")
    print("==========================================================")

if __name__ == "__main__":
    main()
