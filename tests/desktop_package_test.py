import importlib.util
from pathlib import Path
import plistlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("desktop_package", Path(__file__).resolve().parents[1] / "tools/package-desktop.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class DesktopPackageTests(unittest.TestCase):
    @staticmethod
    def fake_publish(command, **kwargs):
        destination = Path(command[command.index("-o") + 1])
        destination.mkdir(parents=True, exist_ok=True)
        rid = command[command.index("-r") + 1]
        (destination / ("HelloTodo.Desktop.exe" if rid.startswith("win-") else "HelloTodo.Desktop")).write_bytes(b"test executable")
        (destination / "HelloTodo.dll").write_bytes(b"test library")

    def test_linux_launcher_and_archive_are_executable_with_unix_newlines(self):
        with tempfile.TemporaryDirectory(prefix="hellotodo-package-") as folder:
            with patch.object(packager.subprocess, "run", side_effect=self.fake_publish):
                packager.package("linux-x64", Path(folder), "Release")
            with tarfile.open(Path(folder) / "HelloTodo-linux-x64.tar.gz") as archive:
                for name in ("HelloTodo.Desktop", "HelloTodo.sh"):
                    self.assertEqual(archive.getmember("HelloTodo-linux-x64/" + name).mode, 0o755)
                script = archive.extractfile("HelloTodo-linux-x64/HelloTodo.sh").read()
                self.assertNotIn(b"\r", script)
                self.assertTrue(script.startswith(b"#!/bin/sh\n"))

    def test_macos_bundle_points_to_executable_and_preserves_mode(self):
        with tempfile.TemporaryDirectory(prefix="hellotodo-package-") as folder:
            with patch.object(packager.subprocess, "run", side_effect=self.fake_publish), patch.object(packager.sys, "platform", "win32"):
                packager.package("osx-arm64", Path(folder), "Release")
            with tarfile.open(Path(folder) / "HelloTodo-osx-arm64.tar.gz") as archive:
                root = "HelloTodo-osx-arm64/HelloTodo.app/Contents/"
                info = plistlib.loads(archive.extractfile(root + "Info.plist").read())
                self.assertEqual(info["CFBundleExecutable"], "HelloTodo.Desktop")
                self.assertEqual(archive.getmember(root + "MacOS/HelloTodo.Desktop").mode, 0o755)

    def test_windows_zip_and_existing_output_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix="hellotodo-package-") as folder:
            with patch.object(packager.subprocess, "run", side_effect=self.fake_publish):
                packager.package("win-x64", Path(folder), "Release")
                with self.assertRaises(FileExistsError):
                    packager.package("win-x64", Path(folder), "Release")
            with zipfile.ZipFile(Path(folder) / "HelloTodo-win-x64.zip") as archive:
                self.assertIn("HelloTodo-win-x64/HelloTodo.Desktop.exe", archive.namelist())


if __name__ == "__main__":
    unittest.main()
