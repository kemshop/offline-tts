"""Download the translator files listed in translator/sources.json and check their hashes."""
import hashlib, json, pathlib, urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
for f in json.loads((root / "translator/sources.json").read_text())["files"]:
    dest = root / f["dest"]
    if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest() == f["sha256"]:
        print("ok (already present)", f["dest"])
        continue
    data = urllib.request.urlopen(f["url"], timeout=120).read()
    got = hashlib.sha256(data).hexdigest()
    if got != f["sha256"]:
        raise SystemExit(f"hash mismatch for {f['dest']}: {got}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    print("downloaded", f["dest"], len(data), "bytes")
