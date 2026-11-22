# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 cnmoro

"""Build standalone Local Wisp packages with the Go toolchain on PATH."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def go(*args, env=None):
    return subprocess.check_output(["go", *args], cwd=HERE, env=env, text=True)


def package(output, target, arch, notices):
    release = f"unkernel-local-wisp-{target}-{arch}"
    with tempfile.TemporaryDirectory() as temp:
        folder = Path(temp) / release
        folder.mkdir()
        binary = folder / ("Unkernel Local Wisp.exe" if target == "windows" else "unkernel-local-wisp")
        if target == "darwin":
            contents = folder / "Unkernel Local Wisp.app" / "Contents"
            binary = contents / "MacOS" / binary.name
            binary.parent.mkdir(parents=True)
            (contents / "Info.plist").write_bytes(plistlib.dumps({
                "CFBundleExecutable": binary.name,
                "CFBundleIdentifier": "br.com.kinetiq.unkernel.local-wisp",
                "CFBundleName": "Unkernel Local Wisp",
                "CFBundlePackageType": "APPL",
                "CFBundleShortVersionString": "1.0.0",
                "LSUIElement": True,
            }))
        env = dict(os.environ, CGO_ENABLED="0", GOOS=target, GOARCH=arch)
        go("build", "-trimpath", "-buildvcs=false", "-o", str(binary), ".", env=env)
        binary.chmod(0o755)
        shutil.copyfile(HERE / "README.md", folder / "README.md")
        for name, path in notices.items():
            shutil.copyfile(path, folder / name)
        if target == "linux":
            archive = output / f"{release}.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(folder, arcname=folder.name)
        else:
            archive = output / f"{release}.zip"
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zip_file:
                for file in sorted(folder.rglob("*")):
                    if file.is_file():
                        zip_file.write(file, file.relative_to(folder.parent))
    return archive


def main():
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    gorilla = json.loads(go("mod", "download", "-json", "github.com/gorilla/websocket"))
    notices = {
        "LICENSE": ROOT / "LICENSE",
        "LICENSE-Go": Path(go("env", "GOROOT").strip()) / "LICENSE",
        "LICENSE-Gorilla-WebSocket": Path(gorilla["Dir"]) / "LICENSE",
    }
    checksums = []
    for target in ("windows", "linux", "darwin"):
        for arch in ("amd64", "arm64"):
            archive = package(output, target, arch, notices)
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            checksums.append(f"{digest}  {archive.name}\n")
            print(archive, flush=True)
    (output / "SHA256SUMS").write_text("".join(checksums), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
