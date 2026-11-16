"""Tests for .github/scripts/bundle_manifest.py (code identity check of deploy-central)."""
import io
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / ".github" / "scripts" / "bundle_manifest.py"


def run(*args):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True)


def make_zip(path, members):
    with zipfile.ZipFile(path, "w") as z:
        for name, data, mode in members:
            zi = zipfile.ZipInfo(name)
            zi.external_attr = mode << 16
            z.writestr(zi, data)


class BundleManifest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.bundle = self.tmp / "b"
        (self.bundle / "pkg").mkdir(parents=True)
        (self.bundle / "index.mjs").write_text("x")
        (self.bundle / "pkg" / "a.py").write_text("y")
        self.mdir = self.tmp / "m"
        self.mdir.mkdir()
        self.assertEqual(run("manifest", str(self.bundle), str(self.mdir / "one.sha256")).returncode, 0)

    def test_manifest_is_sha256sum_format_and_checks(self):
        lines = (self.mdir / "one.sha256").read_text().splitlines()
        self.assertEqual([ln.split("  ")[1] for ln in lines], ["./index.mjs", "./pkg/a.py"])
        self.assertEqual(len(lines[0].split("  ")[0]), 64)
        self.assertEqual(run("check-dir", str(self.bundle), str(self.mdir / "one.sha256")).returncode, 0)
        (self.bundle / "index.mjs").write_text("changed")
        self.assertEqual(run("check-dir", str(self.bundle), str(self.mdir / "one.sha256")).returncode, 1)

    def test_symlink_in_directory_rejected(self):
        os.symlink("/etc/passwd", self.bundle / "link")
        self.assertEqual(run("manifest", str(self.bundle), str(self.tmp / "o")).returncode, 1)

    def test_zip_matching_and_mismatch(self):
        z = self.tmp / "ok.zip"
        make_zip(z, [("pkg/a.py", "y", 0o100644), ("index.mjs", "x", 0o100755), ("pkg/", "", 0o40755)])
        r = run("check-zip", str(z), str(self.mdir))
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "one"))
        bad = self.tmp / "bad.zip"
        make_zip(bad, [("pkg/a.py", "y", 0o100644), ("index.mjs", "EVIL", 0o100644)])
        self.assertEqual(run("check-zip", str(bad), str(self.mdir)).returncode, 1)
        extra = self.tmp / "extra.zip"
        make_zip(extra, [("pkg/a.py", "y", 0o100644), ("index.mjs", "x", 0o100644), ("more.py", "z", 0o100644)])
        self.assertEqual(run("check-zip", str(extra), str(self.mdir)).returncode, 1)

    def test_zip_symlink_traversal_and_dir_with_data_rejected(self):
        for members in (
            [("index.mjs", "x", 0o100644), ("pkg/a.py", "y", 0o100644), ("evil", "/etc/passwd", 0o120777)],
            [("../x", "x", 0o100644)],
            [("/abs", "x", 0o100644)],
            [("d/", "data", 0o40755), ("index.mjs", "x", 0o100644)],
        ):
            z = self.tmp / "t.zip"
            make_zip(z, members)
            self.assertEqual(run("check-zip", str(z), str(self.mdir)).returncode, 1, members)

    def test_not_a_zip(self):
        p = self.tmp / "n.zip"
        p.write_bytes(b"nope")
        self.assertEqual(run("check-zip", str(p), str(self.mdir)).returncode, 1)


if __name__ == "__main__":
    unittest.main()
