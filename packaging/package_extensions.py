#!/usr/bin/env python3
"""Build VSIX and CARTS extension packages for CodeArts IDE & VS Code.

Produces:
- multi-agent-hub-0.9.9.vsix (Standard VS Code extension)
- multi-agent-hub-0.9.9.carts (Huawei CodeArts IDE extension)
- multi-agent-hub-0.9.9.cloudide (Huawei CloudIDE extension)
"""

import hashlib
import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

CONTENT_TYPES_XML = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="mjs" ContentType="application/javascript" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="xml" ContentType="text/xml" />
</Types>
"""

def generate_manifest(name, display_name, version, publisher, description):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Id="{name}" Version="{version}" Language="en-US" Publisher="{publisher}" />
    <DisplayName>{display_name}</DisplayName>
    <Description>{description}</Description>
    <Flags>Public</Flags>
    <Categories>AI, Programming Languages, Other</Categories>
    <Icon>extension/resources/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Icon" Path="extension/resources/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
"""

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def build_extension(source_dir: Path, output_dirs: list[Path]):
    pkg_json_file = source_dir / "package.json"
    if not pkg_json_file.exists():
        raise FileNotFoundError(f"Missing package.json in {source_dir}")

    with open(pkg_json_file, "r", encoding="utf-8") as f:
        pkg = json.load(f)

    name = pkg.get("name", "multi-agent-hub")
    display_name = pkg.get("displayName", "Multi-Agent Hub")
    version = pkg.get("version", "0.9.9")
    publisher = pkg.get("publisher", "agenthub")
    description = pkg.get("description", "Multi-agent orchestration and Hub bridge for CodeArts IDE & VS Code")

    manifest_xml = generate_manifest(name, display_name, version, publisher, description)

    # Primary vsix file
    vsix_filename = f"{name}-{version}.vsix"
    carts_filename = f"{name}-{version}.carts"
    cloudide_filename = f"{name}-{version}.cloudide"

    dist_dir = source_dir / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)
    temp_vsix = dist_dir / vsix_filename

    # Build zip archive according to VSIX OPC specification
    with zipfile.ZipFile(temp_vsix, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # 1. Root files
        zf.writestr("[Content_Types].xml", CONTENT_TYPES_XML.strip())
        zf.writestr("extension.vsixmanifest", manifest_xml.strip())

        # 2. Extension files under extension/
        for root, dirs, files in os.walk(source_dir):
            rel_root = Path(root).relative_to(source_dir)
            if "dist" in rel_root.parts or ".git" in rel_root.parts:
                continue
            for file in files:
                src_path = Path(root) / file
                arc_name = Path("extension") / rel_root / file
                zf.write(src_path, str(arc_name).replace("\\", "/"))

    # Create .carts and .cloudide as identical copies
    temp_carts = dist_dir / carts_filename
    temp_cloudide = dist_dir / cloudide_filename
    shutil.copyfile(temp_vsix, temp_carts)
    shutil.copyfile(temp_vsix, temp_cloudide)

    results = []
    for target_dir in output_dirs:
        target_dir.mkdir(parents=True, exist_ok=True)
        out_vsix = target_dir / vsix_filename
        out_carts = target_dir / carts_filename
        out_cloudide = target_dir / cloudide_filename
        if temp_vsix.resolve() != out_vsix.resolve():
            shutil.copyfile(temp_vsix, out_vsix)
        if temp_carts.resolve() != out_carts.resolve():
            shutil.copyfile(temp_carts, out_carts)
        if temp_cloudide.resolve() != out_cloudide.resolve():
            shutil.copyfile(temp_cloudide, out_cloudide)

        for p in (out_vsix, out_carts, out_cloudide):
            results.append({
                "path": str(p),
                "name": p.name,
                "size_bytes": p.stat().st_size,
                "sha256": sha256_file(p)
            })

    # Save release manifest
    manifest_report = dist_dir / "extension-release-manifest.json"
    with open(manifest_report, "w", encoding="utf-8") as f:
        json.dump({
            "version": version,
            "publisher": publisher,
            "artifacts": results
        }, f, indent=2, ensure_ascii=False)

    return results

def main():
    repo_root = Path(__file__).resolve().parent.parent
    source_dir = repo_root / "integrations" / "vscode"

    output_dirs = [source_dir / "dist"]
    user_releases = Path.home() / "Desktop" / "agenthub-releases"
    if user_releases.exists():
        output_dirs.append(user_releases)

    print(f"Building VSIX and CARTS from {source_dir}...")
    results = build_extension(source_dir, output_dirs)

    print(f"Build complete! Generated {len(results)} package files:")
    for r in results:
        print(f"  [{r['name']}] ({r['size_bytes']:,} bytes) -> {r['path']}")
        print(f"    SHA256: {r['sha256']}")

if __name__ == "__main__":
    main()
