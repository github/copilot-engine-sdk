"""Build a CFS receipt from the release tarball, without executing package code."""

import base64
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath

PACKAGE = "@github/copilot-engine-sdk"
PROVENANCE = "https://slsa.dev/provenance/v1"
UUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")


def receipt(version, archive, registry):
    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha512")
    integrity = "sha512-" + base64.b64encode(digest.digest()).decode("ascii")
    if (registry["name"], registry["version"], registry["dist"]["integrity"]) != (PACKAGE, version, integrity):
        raise ValueError("The release tarball does not match the exact npm version and SHA-512.")
    if registry.get("deprecated") or registry["dist"]["attestations"]["provenance"]["predicateType"] != PROVENANCE:
        raise ValueError("The npm version is deprecated or does not advertise SLSA v1 provenance.")
    publisher = registry["_npmUser"]["trustedPublisher"]
    oidc_id = publisher["oidcConfigId"].removeprefix("oidc:")
    if publisher["id"] != "github" or not UUID.fullmatch(oidc_id):
        raise ValueError("npm did not record GitHub trusted publishing for this version.")

    manifest = None
    with tarfile.open(archive, "r:gz") as packed:
        for entry in packed:
            parts = PurePosixPath(entry.name).parts
            if (not parts or parts[0] != "package" or ".." in parts or "\\" in entry.name
                    or not (entry.isfile() or entry.isdir())):
                raise ValueError("The packed tarball has an unexpected entry.")
            if any(part.lower() == "node_modules" for part in parts) or (
                len(parts) == 2 and parts[1].lower() == "binding.gyp"
            ):
                raise ValueError("The packed tarball contains bundled dependencies or binding.gyp.")
            if len(parts) == 2 and parts[1].lower() == "package.json":
                if manifest is not None or not entry.isfile() or parts[1] != "package.json":
                    raise ValueError("Expected one regular package/package.json.")
                with packed.extractfile(entry) as source:
                    manifest = json.load(source)
    if not isinstance(manifest, dict) or (manifest.get("name"), manifest.get("version")) != (PACKAGE, version):
        raise ValueError("The packed manifest is not the expected package and version.")
    scripts = manifest.get("scripts", {})
    if (not isinstance(scripts, dict) or {"preinstall", "install", "postinstall"} & scripts.keys()
            or manifest.get("gypfile") or manifest.get("bundledDependencies") or manifest.get("bundleDependencies")):
        raise ValueError("The packed manifest declares an install hook or bundled dependencies.")

    return {
        "schema": 1,
        "versions": [{
            "ecosystem": "npm",
            "name": PACKAGE,
            "version": version,
            "artifacts": [{"file": archive.name, "algorithm": "sha512", "digest": digest.hexdigest()}],
            "npm": {"noInstallHooks": True, "publishedWithTrustedPublishing": True, "oidcConfigId": oidc_id},
        }],
    }


if __name__ == "__main__":
    version, archive, registry = sys.argv[1:]
    try:
        print(json.dumps(receipt(version, Path(archive), json.loads(Path(registry).read_text(encoding="utf-8")))))
    except (OSError, KeyError, TypeError, ValueError, tarfile.TarError) as error:
        sys.exit(f"Could not produce CFS receipt: {error}")
