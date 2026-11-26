"""Publish a self-contained desktop build and package it for the target OS."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RIDS = ("win-x64", "win-arm64", "osx-x64", "osx-arm64", "linux-x64", "linux-arm64")


def package(rid, output, configuration):
    output = output.resolve()
    stage = output / ("HelloTodo-" + rid)
    # Never recursively remove user-supplied paths. Publish into a new directory.
    stage.mkdir(parents=True, exist_ok=False)
    app = stage / "HelloTodo.app" if rid.startswith("osx-") else None
    publish = app / "Contents" / "MacOS" if app else stage
    env = dict(os.environ, MSBuildEnableWorkloadResolver="false", DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE="true")
    subprocess.run([
        "dotnet", "publish", str(ROOT / "native/HelloTodo.Desktop/HelloTodo.Desktop.csproj"),
        "-c", configuration, "-r", rid, "--self-contained", "true",
        "-p:PublishSingleFile=false", "-p:PublishTrimmed=false", "-o", str(publish),
    ], check=True, env=env)
    executable = publish / ("HelloTodo.Desktop.exe" if rid.startswith("win-") else "HelloTodo.Desktop")
    if not executable.is_file():
        raise RuntimeError("Published app executable is missing: " + str(executable))
    if not rid.startswith("win-"):
        executable.chmod(0o755)
    if app:
        resources=app / "Contents/Resources"
        resources.mkdir(exist_ok=True)
        shutil.copyfile(ROOT / "native/HelloTodo/Assets/app.icns",resources / "HelloTodo.icns")
        with (app / "Contents/Info.plist").open("wb") as file:
            plistlib.dump({
                "CFBundleName": "HelloTodo",
                "CFBundleDisplayName": "HelloTodo",
                "CFBundleIdentifier": "com.hellotodo.desktop",
                "CFBundleExecutable": "HelloTodo.Desktop",
                "CFBundleIconFile": "HelloTodo.icns",
                "CFBundlePackageType": "APPL",
                "CFBundleShortVersionString": "0.1.0",
                "CFBundleVersion": "1",
                "NSHighResolutionCapable": True,
                "LSMinimumSystemVersion": "10.15",
            }, file)
        (app / "Contents/PkgInfo").write_bytes(b"APPL????")
        # Ad-hoc signing allows the complete locally built bundle to run on Apple Silicon.
        # Public distribution still needs a developer certificate and notarization.
        if sys.platform == "darwin" and shutil.which("codesign"):
            subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app)], check=True)
    if rid.startswith("linux-"):
        launcher = stage / "HelloTodo.sh"
        launcher.write_text('#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec ./HelloTodo.Desktop "$@"\n', encoding="utf-8", newline="\n")
        launcher.chmod(0o755)
    (stage / "README.txt").write_text(
        "HelloTodo desktop\n"
        + ("Open HelloTodo.app. This is an ad-hoc signed build, not notarized.\n" if app else
           "Run ./HelloTodo.sh (graphical desktop, fontconfig and system browser required).\n" if rid.startswith("linux-") else
           "Run HelloTodo.Desktop.exe.\n")
        + "Microsoft sign-in redirect URI: http://localhost (Mobile and desktop applications).\n"
        + "The .NET runtime is included. Keep all files in this directory together.\n", encoding="utf-8")
    archive = output / (stage.name + (".zip" if rid.startswith("win-") else ".tar.gz"))
    if archive.exists():
        raise FileExistsError(archive)
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as file:
            for path in stage.rglob("*"):
                if path.is_file():
                    file.write(path, path.relative_to(output))
    else:
        def permissions(member):
            # Windows cannot persist POSIX execute bits; set them in the archive itself.
            member.mode = 0o755 if member.isdir() or member.name.endswith(("/HelloTodo.Desktop", "/HelloTodo.sh")) else 0o644
            return member
        with tarfile.open(archive, "x:gz") as file:
            file.add(stage, arcname=stage.name, filter=permissions)
    print(archive)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rid", choices=RIDS, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/desktop")
    parser.add_argument("--configuration", default="Release")
    args = parser.parse_args()
    package(args.rid, args.output, args.configuration)
