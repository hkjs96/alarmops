"""sha256 manifests of the Lambda code bundles (deploy-central.yml). Standard library only; run as `python3 -I`.

  manifest   <dir> <out>        write `<sha256>  ./<path>` lines (sorted by path, sha256sum format) for a bundle directory
  check-dir  <dir> <manifest>   recompute and compare; exit 1 on any difference
  check-zip  <zip> <manifest-dir>   verify a Lambda code zip WITHOUT extracting it; print the name of the one
                                bundle (<name>.sha256 in the directory) whose manifest equals the zip content

A bundle may contain regular files and directories only. Anything else (symlink, device, fifo, ...) is an error, in a
directory and in a zip (a zip entry is a symlink when its unix mode says so). Zip entries with an absolute path or `..`
are errors, and a directory entry must carry no data. Nothing here executes or unpacks code.
"""
import hashlib
import os
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath


class BundleError(Exception):
    pass


def _lines(entries):
    return [f"{h}  ./{p}" for p, h in sorted(entries, key=lambda e: e[0].encode("utf-8"))]


def _sha(fobj):
    d = hashlib.sha256()
    for chunk in iter(lambda: fobj.read(1 << 20), b""):
        d.update(chunk)
    return d.hexdigest()


def dir_lines(root):
    root = Path(root)
    entries = []
    for cur, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            p = Path(cur, name)
            mode = os.lstat(p).st_mode
            if stat.S_ISDIR(mode):
                continue
            if not stat.S_ISREG(mode):
                raise BundleError(f"not a regular file or directory: {p.relative_to(root)}")
            with open(p, "rb") as f:
                entries.append((p.relative_to(root).as_posix(), _sha(f)))
    if not entries:
        raise BundleError("empty bundle")
    return _lines(entries)


def zip_lines(path):
    entries = []
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            name = info.filename
            parts = PurePosixPath(name).parts
            if name.startswith("/") or ".." in parts or "\\" in name:
                raise BundleError(f"unsafe path in zip: {name!r}")
            mode = (info.external_attr >> 16) & 0xFFFF
            if info.is_dir():
                if info.file_size:
                    raise BundleError(f"directory entry with data: {name!r}")
                continue
            if mode and not stat.S_ISREG(mode):
                raise BundleError(f"zip entry is not a regular file (symlink or special): {name!r}")
            with z.open(info) as f:
                entries.append((name, _sha(f)))
    if not entries:
        raise BundleError("empty zip")
    if len({e[0] for e in entries}) != len(entries):
        raise BundleError("duplicate paths in zip")
    return _lines(entries)


def read_manifest(path):
    return Path(path).read_text(encoding="utf-8").splitlines()


def main(argv):
    try:
        cmd = argv[1]
        if cmd == "manifest":
            lines = dir_lines(argv[2])
            Path(argv[3]).write_text("\n".join(lines) + "\n", encoding="utf-8")
        elif cmd == "check-dir":
            if dir_lines(argv[2]) != read_manifest(argv[3]):
                raise BundleError(f"{argv[2]} does not match {argv[3]}")
        elif cmd == "check-zip":
            got = zip_lines(argv[2])
            hits = [m.stem for m in sorted(Path(argv[3]).glob("*.sha256")) if m.name != "MANIFEST.sha256" and read_manifest(m) == got]
            if len(hits) != 1:
                raise BundleError(f"zip matches {len(hits)} bundles, expected exactly 1")
            print(hits[0])
        else:
            raise BundleError("unknown command")
    except (BundleError, zipfile.BadZipFile, OSError, IndexError) as e:
        print(f"::error::bundle check failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
