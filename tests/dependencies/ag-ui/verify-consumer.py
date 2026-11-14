import base64
import gzip
import hashlib
import json
import platform
import sys
import tarfile
from pathlib import Path


root = Path(__file__).resolve().parents[3]
revision = "ed2c1d5b63299d3f08676a1418cc2640bbe55fd1"
artifacts = root / "vendor/ag-ui" / revision
provenance = json.loads((artifacts / "provenance.json").read_text())
assert provenance["sourceRevision"] == revision
assert provenance["sourceBranch"] == "matt.spurlin/typescript-sdks"
assert provenance["sourcePullRequest"] == "https://github.com/mattsp1290/ag-ui/pull/49"
expected = {}
for artifact in provenance["artifacts"]:
    archive = artifacts / artifact["artifact"]
    assert archive.parent == artifacts
    body = archive.read_bytes()
    assert len(body) == artifact["bytes"], archive
    assert hashlib.sha256(body).hexdigest() == artifact["sha256"], archive
    assert hashlib.sha512(body).hexdigest() == artifact["sha512"], archive
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(body).digest()).decode()
    assert integrity == artifact["npmIntegrity"], archive
    with tarfile.open(archive) as packed:
        assert packed.getnames() == artifact["members"], archive
        manifest = json.load(packed.extractfile("package/package.json"))
        assert manifest == artifact["packedManifest"], archive
        assert "workspace:" not in json.dumps(manifest), archive
        assert manifest["license"] == "MIT", archive
        notice = packed.extractfile("package/LICENSE").read()
        prefix = artifact["package"].replace("@", "").replace("/", "-")
        assert manifest == json.loads((artifacts / "manifests" / (prefix + ".json")).read_text())
        assert notice == (artifacts / "notices" / (prefix + ".LICENSE")).read_bytes()
        assert b"MIT License" in notice, archive
        if manifest["name"] == "@ag-ui/pi":
            assert b"Copyright (c) 2026 YS-BW" in notice, archive
            donor = packed.extractfile("package/PROVENANCE.md").read()
            assert donor == (artifacts / "notices/ag-ui-pi.PROVENANCE.md").read_bytes()
            assert b"ee810dfb9ad3fe81d8854e9121b84ddee4c59148" in donor, archive
    expected[artifact["package"]] = (archive.name, integrity, manifest)
assert set(expected) == {"@ag-ui/" + name for name in ("core", "proto", "encoder", "client", "codex-sdk", "pi")}
for evidence in provenance["evidence"]:
    packed = (artifacts / evidence["path"]).read_bytes()
    assert len(packed) == evidence["compressedBytes"]
    assert hashlib.sha256(packed).hexdigest() == evidence["compressedSha256"]
    raw = gzip.decompress(packed)
    assert len(raw) == evidence["rawBytes"] == evidence["retainedBytes"]
    assert hashlib.sha256(raw).hexdigest() == evidence["rawSha256"] == evidence["retainedSha256"]
assert hashlib.sha256(gzip.decompress((artifacts / "evidence/source-pnpm-lock.yaml.gz").read_bytes())).hexdigest() == provenance["sourceLockSha256"]
fixtures = json.loads((artifacts / "qualification-fixtures/provenance.json").read_text())
assert hashlib.sha256((artifacts / provenance["qualification"]["fixtureProvenance"]).read_bytes()).hexdigest() == provenance["qualification"]["fixtureProvenanceSha256"]
assert fixtures["sourceRevision"] == revision and fixtures["unchangedSourceCopies"]
for fixture in fixtures["files"]:
    body = (artifacts / fixture["path"]).read_bytes()
    assert hashlib.sha256(body).hexdigest() == fixture["sha256"]
    assert len(body) == fixture["bytes"] and len(body.splitlines()) == fixture["rawLines"]

consumer = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).parent / "consumer"
assert hashlib.sha256((consumer / "package-lock.json").read_bytes()).hexdigest() == provenance["qualification"]["consumerLockSha256"]
assert hashlib.sha256((consumer / "package.json").read_bytes()).hexdigest() == provenance["qualification"]["consumerPackageSha256"]
lock = json.loads((consumer / "package-lock.json").read_text())
manifest = json.loads((consumer / "package.json").read_text())
assert lock["packages"][""]["dependencies"] == manifest["dependencies"]
seen = set()
for path, entry in lock["packages"].items():
    if "/node_modules/@ag-ui/" not in "/" + path:
        continue
    name = "@ag-ui/" + path.rsplit("/@ag-ui/", 1)[1]
    assert name in expected and name not in seen, path
    assert path == "node_modules/" + name, path
    filename, integrity, packed_manifest = expected[name]
    assert entry["resolved"] == "file:../artifacts/" + filename, path
    assert manifest["dependencies"][name] == entry["resolved"], path
    assert entry["integrity"] == integrity, path
    seen.add(name)
assert seen == set(expected), seen
native_versions = {
    "@openai/codex-sdk": "0.167.1", "@openai/codex": "0.167.1",
    "@earendil-works/pi-agent-core": "1.5.0", "@earendil-works/pi-ai": "1.5.0",
    "@earendil-works/pi-coding-agent": "1.5.0", "zod": "3.25.76",
}
for name, version in native_versions.items():
    assert lock["packages"]["node_modules/" + name]["version"] == manifest["dependencies"][name] == version
for target_os in ("darwin", "linux", "win32"):
    for arch in ("arm64", "x64"):
        entry = lock["packages"][f"node_modules/@openai/codex-{target_os}-{arch}"]
        assert entry["optional"] and entry["version"] == f"0.167.1-{target_os}-{arch}"
if len(sys.argv) > 1:
    installed = set()
    for file in (consumer / "node_modules").rglob("package.json"):
        name = json.loads(file.read_text()).get("name", "")
        if not name.startswith("@ag-ui/"):
            continue
        assert name in expected and name not in installed, file
        assert file == consumer / "node_modules" / name / "package.json", file
        assert json.loads(file.read_text()) == expected[name][2], file
        installed.add(name)
    assert installed == seen
    for name, version in native_versions.items():
        assert json.loads((consumer / "node_modules" / name / "package.json").read_text())["version"] == version
    arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64"}[platform.machine()]
    native_cli = consumer / "node_modules/@openai" / f"codex-{sys.platform}-{arch}"
    assert json.loads((native_cli / "package.json").read_text())["version"] == f"0.167.1-{sys.platform}-{arch}"
    assert list((native_cli / "vendor").rglob("codex")), "optional native Codex CLI payload absent"
print(json.dumps({"result": "PASS", "sourceRevision": revision, "localAguiArchives": len(seen), "installed": len(sys.argv) > 1, "nativeVersions": native_versions}))
