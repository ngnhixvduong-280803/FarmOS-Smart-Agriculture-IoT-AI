#!/usr/bin/env python3
"""FarmOS factory station CLI.

The station owns the device private attestation key.  It is generated and
stored locally, while only the ECDSA P-256 public key is sent to the manufacturing
API.  The script intentionally has no option that serializes the private key
into an HTTP body or terminal output.

The commands are deliberately split so a station can gate each physical step:

  allocate       allocate a backend identity and create a local key/manifest
  generate       create factory_cfg CSV/image locally
  factory-write  register the public key after physical readback evidence
  readback       read factory_cfg and create signed evidence metadata
  verify         verify local key/identity and readback evidence (optionally backend)
  qc-pass        move a verified device through the backend QC gate
  ready-to-ship  release a fully QC-passed batch for QR issue
  request-qr     issue a signed QR v3 label after backend verification
  print          verify and print a public QR summary
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid


IDENTITY_VERSION = 3
FACTORY_CFG_OFFSET = 0x620000
FACTORY_CFG_SIZE = 0x10000
NODE_RE = re.compile(r"^NODE_([0-9]+)$")
GATEWAY_RE = re.compile(r"^GATEWAY_([0-9]+)$")
NVS_IDENTITY_KEYS = {
    "identity_version": "id_ver",
    "hardware_revision": "hw_rev",
    "firmware_target": "fw_target",
    "cert_fingerprint": "cert_fp",
    "attestation_public_key": "att_pub_key",
    "attestation_private_key": "att_priv_key",
}
if any(len(key) > 15 for key in NVS_IDENTITY_KEYS.values()):
    raise RuntimeError("Factory identity NVS keys must not exceed 15 characters")


class StationError(RuntimeError):
    pass


def die(message: str) -> "NoReturn":
    raise StationError(message)


def ensure_private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def write_private_json(path: Path, value: object) -> None:
    ensure_private_dir(path.parent)
    encoded = json.dumps(value, indent=2, sort_keys=True) + "\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(encoded)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    os.chmod(path, 0o600)


def write_private_bytes(path: Path, value: bytes) -> None:
    ensure_private_dir(path.parent)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    os.chmod(path, 0o600)


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        die(f"cannot read JSON {path}: {error}")
    if not isinstance(value, dict): die(f"{path} must contain a JSON object")
    return value


def validate_node_device_id(device_id: str, radio_id: int | None = None) -> int:
    match = NODE_RE.fullmatch(device_id)
    if not match: die("Node deviceId must be NODE_<numeric radio_id>")
    value = int(match.group(1), 10)
    if value <= 0 or value > 0xFFFFFFFF: die("Node radio_id must be a non-zero u32")
    if radio_id is not None and value != radio_id:
        die(f"Node deviceId suffix {value} does not match radio_id {radio_id}")
    return value


def validate_gateway_device_id(device_id: str) -> int:
    match = GATEWAY_RE.fullmatch(device_id)
    if not match: die("Gateway deviceId must be GATEWAY_<numeric id>")
    value = int(match.group(1), 10)
    if value <= 0 or value > 0xFFFFFFFF: die("Gateway numeric id must be a non-zero u32")
    return value


def validate_device_id(device_id: str, device_type: str, radio_id: int | None = None) -> int | None:
    if device_type == "SENSOR_NODE": return validate_node_device_id(device_id, radio_id)
    if device_type != "GATEWAY": die("type must be SENSOR_NODE or GATEWAY")
    validate_gateway_device_id(device_id)
    return None


def run_checked(command: list[str], input_data: bytes | None = None) -> bytes:
    try:
        result = subprocess.run(command, input=input_data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, check=True)
    except FileNotFoundError:
        die(f"required executable not found: {command[0]}")
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode(errors="replace").strip()
        die(f"command failed ({' '.join(command[:3])}): {detail[-400:]}")
    return result.stdout


def openssl_path() -> str:
    path = shutil.which("openssl")
    if not path: die("openssl is required for local ECDSA P-256 key generation")
    return path


def generate_attestation_keypair(output_dir: Path, device_id: str) -> tuple[Path, Path, str, str]:
    """Generate an ECDSA P-256 keypair and its SPKI SHA-256 fingerprint."""
    ensure_private_dir(output_dir)
    private_path = output_dir / f"{device_id}.attestation.private.der"
    public_path = output_dir / f"{device_id}.attestation.public.der"
    with tempfile.TemporaryDirectory(prefix="farmos-key-", dir=output_dir) as temp:
        temp_dir = Path(temp)
        private_pem = temp_dir / "private.pem"
        public_pem = temp_dir / "public.pem"
        private_der = temp_dir / "private.der"
        public_der = temp_dir / "public.der"
        openssl = openssl_path()
        run_checked([openssl, "genpkey", "-algorithm", "EC", "-pkeyopt",
                     "ec_paramgen_curve:P-256", "-out", str(private_pem)])
        run_checked([openssl, "pkey", "-in", str(private_pem), "-outform", "DER", "-out", str(private_der)])
        run_checked([openssl, "pkey", "-in", str(private_pem), "-pubout", "-out", str(public_pem)])
        run_checked([openssl, "pkey", "-pubin", "-in", str(public_pem), "-outform", "DER", "-out", str(public_der)])
        private_der_bytes = private_der.read_bytes()
        public_der_bytes = public_der.read_bytes()
    # Keep the standard PKCS#8 private DER and SPKI public DER in NVS. The
    # firmware imports these through the supported mbedTLS PK API, while the
    # backend can parse the exact same SPKI bytes.
    if not (32 <= len(private_der_bytes) <= 256) or not (32 <= len(public_der_bytes) <= 160):
        die("openssl returned malformed P-256 DER key material")
    write_private_bytes(private_path, private_der_bytes)
    write_private_bytes(public_path, public_der_bytes)
    fingerprint = hashlib.sha256(public_der_bytes).hexdigest()
    return private_path, public_path, base64.b64encode(public_der_bytes).decode("ascii"), fingerprint


class BackendClient:
    def __init__(self, base_url: str, station_id: str | None, station_token: str | None,
                 bearer_token: str | None, timeout: float = 20.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.headers = {"Accept": "application/json", "Content-Type": "application/json",
                        "User-Agent": "FarmOS-Factory-Station/1.0"}
        if station_id and station_token:
            self.headers.update({"x-farmos-station-id": station_id, "x-farmos-station-token": station_token})
        if bearer_token: self.headers["Authorization"] = f"Bearer {bearer_token}"

    def post(self, path: str, body: dict, idempotency_key: str | None = None) -> dict:
        headers = dict(self.headers)
        headers["Idempotency-Key"] = idempotency_key or f"station-{uuid.uuid4()}"
        request = urllib.request.Request(self.base_url + path,
                                         data=json.dumps(body).encode("utf-8"),
                                         headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            die(f"backend {error.code} {path}: {detail[:500]}")
        except urllib.error.URLError as error:
            die(f"backend unreachable at {self.base_url}: {error.reason}")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            die(f"backend returned non-JSON for {path}")
        if not payload.get("success", True): die(str(payload.get("error", "backend rejected request")))
        return payload


def station_credentials(args: argparse.Namespace) -> dict:
    filename = getattr(args, "credential_file", None) or os.environ.get("FARMOS_STATION_CREDENTIAL_FILE")
    if not filename:
        return {}
    path = Path(filename).expanduser()
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        die("station credential must be a regular private file (chmod 600)")
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        die("cannot read station credential JSON")
    if not isinstance(data, dict) or not all(isinstance(data.get(k), str) and data[k] for k in ("stationId", "stationToken", "baseUrl")):
        die("station credential requires stationId, stationToken and baseUrl")
    if not data["baseUrl"].startswith("https://"):
        die("station credential requires an HTTPS backend")
    return data


def client_from_args(args: argparse.Namespace) -> BackendClient:
    credential = station_credentials(args)
    base_url = args.base_url or credential.get("baseUrl") or os.environ.get("FARMOS_API_BASE_URL", "http://127.0.0.1:3000")
    station_id = args.station_id or station_credentials(args).get("stationId") or os.environ.get("FARMOS_STATION_ID")
    station_token = args.station_token or credential.get("stationToken") or os.environ.get("FARMOS_STATION_TOKEN")
    bearer = args.bearer_token or os.environ.get("FARMOS_BEARER_TOKEN")
    return BackendClient(base_url, station_id, station_token, bearer)


def requested_identities(args: argparse.Namespace) -> list[dict]:
    device_type = args.type.upper()
    firmware_target = args.firmware_target or (
        "ESP32S3_LORA_GATEWAY_V1" if device_type == "GATEWAY" else "ESP32S3_LORA_SENSOR_V1"
    )
    quantity = args.quantity
    if quantity < 1 or quantity > 100000: die("quantity must be between 1 and 100000")
    if args.device_id and quantity != 1: die("--device-id can only be used with quantity=1")
    start = args.radio_id if args.radio_id is not None else 1
    entries: list[dict] = []
    for index in range(quantity):
        numeric = start + index
        if args.device_id:
            device_id = args.device_id
        elif device_type == "SENSOR_NODE":
            device_id = f"NODE_{numeric:06d}"
        else:
            device_id = f"GATEWAY_{numeric:06d}"
        radio_id = validate_device_id(device_id, device_type,
                                      args.radio_id if args.device_id else (numeric if device_type == "SENSOR_NODE" else None))
        entry = {
            "deviceId": device_id,
            "serial": args.serial if args.serial and quantity == 1 else f"{args.serial_prefix}-{numeric:06d}",
            "type": device_type,
            "model": args.model,
            "hardwareRevision": args.hardware_revision,
            "firmwareTarget": firmware_target,
            "partitionScheme": args.partition_scheme,
            "capabilities": (args.capabilities.split(",") if args.capabilities else
                             (["WIFI", "LORA", "GATEWAY", "LOCAL_SENSOR"] if device_type == "GATEWAY"
                              else ["WIFI", "LORA", "SENSOR_DS18B20"])),
        }
        if radio_id is not None: entry["radioId"] = radio_id
        entries.append(entry)
    return entries


def identity_from_response(identity: dict, claim_code: str | None, batch_id: str, output_dir: Path) -> Path:
    device_id = str(identity.get("deviceId") or identity.get("device_id") or "").strip()
    device_type = str(identity.get("type") or "").strip().upper()
    if not device_id or not device_type: die("allocation response omitted deviceId/type")
    radio_id = validate_device_id(device_id, device_type)
    device_dir = ensure_private_dir(output_dir / device_id)
    private_path, public_path, public_key, fingerprint = generate_attestation_keypair(device_dir, device_id)
    manifest = {
        "schemaVersion": 1,
        "identityVersion": IDENTITY_VERSION,
        "batchId": batch_id,
        "deviceId": device_id,
        "serial": str(identity.get("serial") or identity.get("serialNumber") or ""),
        "type": device_type,
        "model": str(identity.get("model") or "unknown"),
        "hardwareRevision": str(identity.get("hardwareRevision") or "REV_A"),
        "firmwareTarget": str(identity.get("firmwareTarget") or ""),
        "partitionScheme": str(identity.get("partitionScheme") or "FARMOS_16M_V1"),
        "capabilities": identity.get("capabilities") or [],
        "radioId": radio_id,
        "publicKeyAlgorithm": "ECDSA-P256",
        "publicKey": public_key,
        "publicKeyFingerprint": fingerprint,
        "privateKeyFile": str(private_path),
        "publicKeyFile": str(public_path),
        "claimCode": claim_code,
        "outputDir": str(device_dir),
    }
    write_private_json(device_dir / "manifest.json", manifest)
    return device_dir / "manifest.json"


def load_manifest(path: Path) -> dict:
    value = read_json(path)
    required = ("deviceId", "serial", "type", "model", "hardwareRevision", "firmwareTarget",
                "identityVersion", "publicKey", "publicKeyFingerprint", "privateKeyFile", "publicKeyFile")
    for key in required:
        if not value.get(key): die(f"manifest missing {key}")
    validate_device_id(value["deviceId"], value["type"], value.get("radioId"))
    if value["identityVersion"] != IDENTITY_VERSION: die("unsupported manifest identityVersion")
    return value


def safe_identity_metadata(manifest: dict) -> dict:
    """Return the complete public identity contract without local secrets."""
    return {
        "identityVersion": manifest["identityVersion"],
        "deviceId": manifest["deviceId"],
        "serial": manifest["serial"],
        "type": manifest["type"],
        "model": manifest["model"],
        "hardwareRevision": manifest["hardwareRevision"],
        "firmwareTarget": manifest["firmwareTarget"],
        "partitionScheme": manifest.get("partitionScheme"),
        "capabilities": manifest.get("capabilities") or [],
        "radioId": manifest.get("radioId"),
        "publicKeyAlgorithm": manifest.get("publicKeyAlgorithm", "ECDSA-P256"),
        "publicKey": manifest["publicKey"],
        "publicKeyFingerprint": manifest["publicKeyFingerprint"],
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        die(f"cannot hash {path}: {error}")
    return digest.hexdigest()


def station_id_from_args(args: argparse.Namespace, required: bool = False) -> str | None:
    station_id = args.station_id or station_credentials(args).get("stationId") or os.environ.get("FARMOS_STATION_ID")
    if required and not station_id:
        die("station id is required; pass --station-id or FARMOS_STATION_ID")
    return station_id


def readback_evidence(manifest: dict, image_path: Path, readback_path: Path,
                      firmware_image: Path | None, station_id: str | None,
                      readback_source: str = "esptool", strict_size: bool = False) -> dict:
    if firmware_image is None:
        die("firmware image is required to bind factory readback evidence")
    if not station_id:
        die("station id is required to bind factory readback evidence")
    if readback_source not in {"esptool", "fixture"}:
        die("readback source must be esptool or fixture")
    if not image_path.is_file() or not readback_path.is_file():
        die("factory_cfg image and readback files are required")
    if strict_size and (image_path.stat().st_size != FACTORY_CFG_SIZE or
                        readback_path.stat().st_size != FACTORY_CFG_SIZE):
        die(f"factory_cfg image and readback must both be exactly 0x{FACTORY_CFG_SIZE:x} bytes")
    image_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()
    readback_hash = sha256_file(readback_path)
    firmware_hash = sha256_file(firmware_image)
    proof_material = {
        "deviceId": manifest["deviceId"],
        "stationId": station_id,
        "factoryCfgHash": image_hash,
        "readbackSha256": readback_hash,
        "firmwareSha256": firmware_hash,
    }
    readback_proof = hashlib.sha256(
        json.dumps(proof_material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    evidence = {
        "evidenceVersion": 1,
        "stationId": station_id,
        "readbackSource": readback_source,
        "identity": safe_identity_metadata(manifest),
        "partitionProof": {
            "name": "factory_cfg",
            "offset": FACTORY_CFG_OFFSET,
            "size": FACTORY_CFG_SIZE,
            "imageSha256": image_hash,
            "readbackSha256": readback_hash,
            "matches": image_hash == readback_hash,
        },
        "firmware": {
            "target": manifest["firmwareTarget"],
            "artifactSha256": firmware_hash,
        },
        # These flat fields are the manufacturing API contract. Keep the
        # detailed nested proof as well so a station operator can audit the
        # exact bytes that were read back from the device.
        "factoryCfgHash": image_hash,
        "firmwareSha256": firmware_hash,
        "readbackProof": readback_proof,
    }
    # The digest covers the exact evidence object sent to the backend, excluding
    # the digest field itself. It proves that identity, partition hashes and the
    # referenced firmware artifact were not changed between station steps.
    canonical = json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode("utf-8")
    evidence["evidenceSha256"] = hashlib.sha256(canonical).hexdigest()
    return evidence


def load_readback_evidence(manifest: dict, require_physical: bool = False) -> dict:
    evidence_path = Path(manifest["outputDir"]) / "readback.json"
    if not evidence_path.is_file():
        die("readback evidence is required; run readback after factory-write")
    evidence_document = read_json(evidence_path)
    # `cmd_readback` prints/stores a convenient top-level deviceId alongside
    # the evidence object. It is an envelope field, not part of the signed
    # evidence digest; accept it only when it agrees with the manifest and
    # remove it before validating the canonical evidence bytes.
    document_device_id = evidence_document.pop("deviceId", None)
    if document_device_id is not None and document_device_id != manifest["deviceId"]:
        die("readback evidence envelope deviceId does not match manifest")
    evidence = evidence_document
    if evidence.get("evidenceVersion") != 1:
        die("unsupported readback evidence version")
    if not isinstance(evidence.get("stationId"), str) or not evidence["stationId"].strip():
        die("readback evidence is missing stationId")
    if evidence.get("readbackSource") not in {"esptool", "fixture"}:
        die("readback evidence is missing a valid readbackSource")
    if require_physical and evidence.get("readbackSource") != "esptool":
        die("backend verification requires an actual serial readback; fixture evidence is not release proof")
    identity = evidence.get("identity")
    if not isinstance(identity, dict) or identity.get("deviceId") != manifest["deviceId"]:
        die("readback evidence identity does not match manifest")
    expected_identity = safe_identity_metadata(manifest)
    for field, expected in expected_identity.items():
        if identity.get(field) != expected:
            die(f"readback evidence identity field does not match manifest: {field}")
    partition = evidence.get("partitionProof")
    if not isinstance(partition, dict) or partition.get("name") != "factory_cfg" or \
            partition.get("offset") != FACTORY_CFG_OFFSET or partition.get("size") != FACTORY_CFG_SIZE:
        die("readback evidence partition proof is invalid")
    if partition.get("matches") is not True or not partition.get("readbackSha256"):
        die("factory_cfg readback evidence is not a matching cryptographic proof")
    image_path = Path(manifest["outputDir"]) / "factory_cfg.bin"
    readback_path = Path(manifest["outputDir"]) / "factory_cfg.readback.bin"
    if not image_path.is_file() or not readback_path.is_file():
        die("factory_cfg image and actual readback files are required")
    if image_path.stat().st_size != FACTORY_CFG_SIZE or readback_path.stat().st_size != FACTORY_CFG_SIZE:
        die(f"factory_cfg image and readback must both be exactly 0x{FACTORY_CFG_SIZE:x} bytes")
    if partition.get("imageSha256") != hashlib.sha256(image_path.read_bytes()).hexdigest() or \
            partition.get("readbackSha256") != sha256_file(readback_path):
        die("readback evidence hashes do not match the local image/readback files")
    if partition.get("imageSha256") != partition.get("readbackSha256"):
        die("factory_cfg image hash and readback hash do not match")
    firmware = evidence.get("firmware")
    if not isinstance(firmware, dict) or firmware.get("target") != manifest["firmwareTarget"] or \
            not isinstance(firmware.get("artifactSha256"), str) or \
            not re.fullmatch(r"[a-f0-9]{64}", firmware["artifactSha256"]):
        die("firmware artifact hash is required in readback evidence")
    if evidence.get("factoryCfgHash") != partition.get("imageSha256") or \
            evidence.get("firmwareSha256") != firmware.get("artifactSha256") or \
            not isinstance(evidence.get("readbackProof"), str) or len(evidence["readbackProof"]) != 64:
        die("readback evidence flat manufacturing fields are invalid")
    proof_material = {
        "deviceId": manifest["deviceId"],
        "stationId": evidence["stationId"],
        "factoryCfgHash": partition["imageSha256"],
        "readbackSha256": partition["readbackSha256"],
        "firmwareSha256": firmware["artifactSha256"],
    }
    expected_proof = hashlib.sha256(
        json.dumps(proof_material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if evidence["readbackProof"] != expected_proof:
        die("readback proof does not bind identity, station, hashes, and physical readback")
    expected_digest = dict(evidence)
    actual_digest = expected_digest.pop("evidenceSha256", None)
    canonical = json.dumps(expected_digest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if not actual_digest or hashlib.sha256(canonical).hexdigest() != actual_digest:
        die("readback evidence digest is invalid")
    return evidence


def factory_write_payload(manifest: dict, evidence: dict | None = None) -> dict:
    # Keep this function intentionally explicit. A regression adding the local
    # privateKeyFile/private material here would violate the station contract.
    payload = {"deviceId": manifest["deviceId"], "publicKey": manifest["publicKey"]}
    if manifest.get("claimCode"): payload["claimCode"] = manifest["claimCode"]
    if evidence is not None:
        payload.update(factory_evidence_payload(manifest, evidence))
    return payload


def factory_evidence_payload(manifest: dict, evidence: dict) -> dict:
    """Flatten the local readback proof into the manufacturing API contract."""
    partition = evidence["partitionProof"]
    firmware = evidence["firmware"]
    return {
        "publicKeyFingerprint": manifest["publicKeyFingerprint"],
        "factoryCfgHash": partition["imageSha256"],
        "firmwareSha256": firmware["artifactSha256"],
        "stationId": evidence["stationId"],
        "readbackProof": evidence["readbackProof"],
    }


def nvs_rows(manifest: dict) -> list[list[str]]:
    private_der = Path(manifest["privateKeyFile"]).read_bytes()
    public_der = Path(manifest["publicKeyFile"]).read_bytes()
    if not (32 <= len(private_der) <= 256 and 32 <= len(public_der) <= 160):
        die("P-256 DER key files have an invalid length")
    rows = [
        ["key", "type", "encoding", "value"],
        ["identity", "namespace", "", ""],
        [NVS_IDENTITY_KEYS["identity_version"], "data", "u32", str(IDENTITY_VERSION)],
        ["role", "data", "string", "NODE" if manifest["type"] == "SENSOR_NODE" else "GATEWAY"],
        ["device_id", "data", "string", manifest["deviceId"]],
        ["serial", "data", "string", manifest["serial"]],
        ["model", "data", "string", manifest["model"]],
        [NVS_IDENTITY_KEYS["hardware_revision"], "data", "string", manifest["hardwareRevision"]],
        [NVS_IDENTITY_KEYS["firmware_target"], "data", "string", manifest["firmwareTarget"]],
        [NVS_IDENTITY_KEYS["cert_fingerprint"], "data", "string", manifest["publicKeyFingerprint"]],
        [NVS_IDENTITY_KEYS["attestation_public_key"], "data", "hex2bin", public_der.hex()],
        [NVS_IDENTITY_KEYS["attestation_private_key"], "data", "hex2bin", private_der.hex()],
    ]
    if manifest["type"] == "SENSOR_NODE": rows.append(["radio_id", "data", "u32", str(manifest["radioId"])])
    return rows


def write_nvs_csv(manifest: dict) -> Path:
    csv_path = Path(manifest["outputDir"]) / "factory_cfg.csv"
    ensure_private_dir(csv_path.parent)
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        csv.writer(handle, lineterminator="\n").writerows(nvs_rows(manifest))
    os.chmod(csv_path, 0o600)
    return csv_path


def nvs_generator_candidates(explicit: str | None) -> list[Path]:
    candidates: list[Path] = []
    if explicit: candidates.append(Path(explicit))
    idf_path = os.environ.get("IDF_PATH")
    if idf_path: candidates.append(Path(idf_path) / "components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py")
    candidates.append(Path.home() / ".platformio/packages/framework-espidf/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py")
    return candidates


def generate_nvs_image(manifest: dict, generator: str | None) -> Path | None:
    csv_path = write_nvs_csv(manifest)
    image_path = Path(manifest["outputDir"]).resolve() / "factory_cfg.bin"
    for candidate in nvs_generator_candidates(generator):
        if not candidate.is_file(): continue
        try:
            run_checked([sys.executable, str(candidate), "generate", str(csv_path), str(image_path), hex(FACTORY_CFG_SIZE)])
            os.chmod(image_path, 0o600)
            return image_path
        except StationError as error:
            # PlatformIO ships the ESP-IDF wrapper but not its optional Python
            # generator module. Continue to another explicit/IDF installation.
            if generator: raise
            print(f"warning: NVS generator unavailable ({error}); CSV was written", file=sys.stderr)
    print("warning: no ESP-IDF NVS generator found; factory_cfg.csv written but factory_cfg.bin was not generated", file=sys.stderr)
    return None


def cmd_allocate(args: argparse.Namespace) -> int:
    output_dir = ensure_private_dir(Path(args.out))
    client = client_from_args(args)
    entries = requested_identities(args)
    firmware_target = args.firmware_target or (
        "ESP32S3_LORA_GATEWAY_V1" if args.type.upper() == "GATEWAY" else "ESP32S3_LORA_SENSOR_V1"
    )
    batch_id = args.batch_id
    if not batch_id:
        batch_number = args.batch_number or f"STATION-{secrets.token_hex(5).upper()}"
        created = client.post("/api/v1/manufacturing/batches", {
            "batchNumber": batch_number, "model": args.model, "type": args.type.upper(),
            "hardwareRevision": args.hardware_revision, "firmwareTarget": firmware_target,
            "quantity": args.quantity, "metadata": {"station": "factory_station.py"},
        })
        batch_id = str(created["data"]["id"])
    allocated = client.post(f"/api/v1/manufacturing/batches/{batch_id}/allocate", {"identities": entries})
    data = allocated.get("data") or {}
    identities = data.get("identities") or []
    station_secrets = {item["deviceId"]: item.get("claimCode") for item in data.get("stationProvisioning", [])}
    if not identities: die("allocation response contained no identities")
    paths = []
    for identity in identities:
        path = identity_from_response(identity, station_secrets.get(identity.get("deviceId")), batch_id, output_dir)
        paths.append(str(path))
    write_private_json(output_dir / "allocation.json", {"batchId": batch_id, "manifests": paths})
    print(json.dumps({"batchId": batch_id, "manifests": paths}, indent=2))
    return 0


def cmd_factory_write(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest)
    manifest = load_manifest(manifest_path)
    # Registration is deliberately gated on an already captured readback. The
    # backend must never enter FACTORY_WRITTEN based only on a CSV or a local
    # pre-flash hash; a technician must first prove that the physical device
    # returned the exact factory_cfg bytes.
    image = Path(manifest["outputDir"]) / "factory_cfg.bin"
    if not image.is_file(): die("factory_cfg.bin is missing; run generate before physical flash/readback")
    evidence = load_readback_evidence(manifest, require_physical=True)
    station_id = station_id_from_args(args, required=True)
    if evidence["stationId"] != station_id:
        die("station id does not match the readback evidence")
    local_verify(manifest)
    client = client_from_args(args)
    payload = factory_write_payload(manifest, evidence)
    response = client.post(f"/api/v1/manufacturing/batches/{manifest['batchId']}/factory-written",
                           payload)
    write_private_json(Path(manifest["outputDir"]) / "factory-write-response.json", response)
    print(json.dumps({"deviceId": manifest["deviceId"], "csv": str(Path(manifest["outputDir"]) / "factory_cfg.csv"),
                      "image": str(image), "readbackEvidenceSha256": evidence["evidenceSha256"],
                      "publicKeyFingerprint": manifest["publicKeyFingerprint"]}, indent=2))
    return 0


def cmd_generate(args: argparse.Namespace) -> int:
    manifest = load_manifest(Path(args.manifest))
    image = generate_nvs_image(manifest, args.nvs_generator)
    result = {"deviceId": manifest["deviceId"],
              "csv": str(Path(manifest["outputDir"]) / "factory_cfg.csv"),
              "image": str(image) if image else None,
              "imageGenerated": image is not None}
    print(json.dumps(result, indent=2))
    return 0 if image is not None else 2


def find_esptool(explicit: str | None) -> Path:
    if explicit: return Path(explicit)
    candidate = Path("/Users/levanduy/.platformio/packages/tool-esptoolpy/esptool.py")
    if candidate.is_file(): return candidate
    die("esptool.py not found; pass --esptool")


def cmd_readback(args: argparse.Namespace) -> int:
    manifest = load_manifest(Path(args.manifest))
    image_path = Path(manifest["outputDir"]) / "factory_cfg.bin"
    if not image_path.is_file(): die("local factory_cfg.bin is missing; run generate first")
    readback_path = Path(args.readback or (Path(manifest["outputDir"]) / "factory_cfg.readback.bin"))
    if args.readback_file:
        shutil.copyfile(args.readback_file, readback_path)
        readback_source = "fixture"
    else:
        if not args.port: die("--port is required for physical readback (or use --readback-file)")
        command = [sys.executable, str(find_esptool(args.esptool)), "--chip", "esp32s3", "--port", args.port, "--after", "no_reset"]
        if args.baud: command += ["--baud", str(args.baud)]
        command += ["read_flash", hex(FACTORY_CFG_OFFSET), hex(FACTORY_CFG_SIZE), str(readback_path)]
        run_checked(command)
        readback_source = "esptool"
    os.chmod(readback_path, 0o600)
    if not args.firmware_image:
        die("--firmware-image is required; backend evidence must bind the exact release artifact")
    evidence = readback_evidence(manifest, image_path, readback_path,
                                 Path(args.firmware_image),
                                 station_id_from_args(args, required=True),
                                 readback_source=readback_source, strict_size=True)
    result = {"deviceId": manifest["deviceId"], **evidence}
    write_private_json(Path(manifest["outputDir"]) / "readback.json", result)
    print(json.dumps(result, indent=2))
    if not evidence["partitionProof"]["matches"]: return 2
    return 0


def local_verify(manifest: dict) -> dict:
    private_der = Path(manifest["privateKeyFile"]).read_bytes()
    public_der = Path(manifest["publicKeyFile"]).read_bytes()
    if not (32 <= len(private_der) <= 256 and 32 <= len(public_der) <= 160):
        die("P-256 DER key length mismatch")
    # OpenSSL does not consistently accept PKCS#8 DER from /dev/stdin across
    # platforms. Keep the transient wrapper inside the private output dir,
    # with restrictive permissions, and remove it before returning.
    with tempfile.NamedTemporaryFile(prefix="verify-", suffix=".der",
                                     dir=manifest["outputDir"], delete=False) as handle:
        private_der_path = Path(handle.name)
        os.chmod(private_der_path, 0o600)
        handle.write(private_der)
    try:
        expected_public = run_checked([openssl_path(), "pkey", "-inform", "DER",
                                       "-in", str(private_der_path), "-pubout", "-outform", "DER"])
    finally:
        private_der_path.unlink(missing_ok=True)
    derived_public = expected_public
    if derived_public != public_der: die("private/public P-256 key mismatch")
    fingerprint = hashlib.sha256(public_der).hexdigest()
    if fingerprint != manifest["publicKeyFingerprint"]: die("public key fingerprint mismatch")
    csv_path = Path(manifest["outputDir"]) / "factory_cfg.csv"
    if csv_path.exists():
        rows = list(csv.reader(csv_path.open(encoding="utf-8")))
        if [row[:3] for row in rows[:1]] != [["key", "type", "encoding"]]: die("factory_cfg.csv header mismatch")
        fields = {row[0]: row[3] for row in rows[2:] if len(row) >= 4}
        if fields.get("device_id") != manifest["deviceId"] or fields.get(NVS_IDENTITY_KEYS["cert_fingerprint"]) != fingerprint:
            die("factory_cfg.csv identity mismatch")
    return {"deviceId": manifest["deviceId"], "type": manifest["type"], "radioId": manifest.get("radioId"),
            "publicKeyAlgorithm": "ECDSA-P256", "publicKeyFingerprint": fingerprint,
            "privateKeyUploaded": False}


def cmd_verify(args: argparse.Namespace) -> int:
    manifest = load_manifest(Path(args.manifest))
    result = local_verify(manifest)
    evidence = load_readback_evidence(manifest, require_physical=args.backend)
    result["readbackEvidenceSha256"] = evidence["evidenceSha256"]
    if args.backend:
        station_id = station_id_from_args(args, required=True)
        if evidence["stationId"] != station_id:
            die("station id does not match the readback evidence")
        client = client_from_args(args)
        response = client.post(f"/api/v1/manufacturing/batches/{manifest['batchId']}/factory-readback",
                               {"deviceId": manifest["deviceId"], "readback": {
                                   "deviceId": manifest["deviceId"], "serial": manifest["serial"],
                                   "type": manifest["type"], "model": manifest["model"],
                                   "hardwareRevision": manifest["hardwareRevision"],
                                   "identityVersion": manifest["identityVersion"],
                                   "publicKey": manifest["publicKey"],
                                   **factory_evidence_payload(manifest, evidence),
                                   # The nested object is the server-verifiable
                                   # proof. Flat fields remain for the stable
                                   # manufacturing API contract and audit CSVs.
                                   "evidence": evidence,
                               }})
        result["backendVerified"] = bool(response.get("success"))
    print(json.dumps(result, indent=2))
    return 0


def cmd_qc_pass(args: argparse.Namespace) -> int:
    manifest = load_manifest(Path(args.manifest))
    batch_id = manifest.get("batchId")
    device_id = manifest.get("deviceId")
    if not batch_id or not device_id:
        die("manifest must contain batchId and deviceId")
    client = client_from_args(args)
    response = client.post(f"/api/v1/manufacturing/batches/{batch_id}/qc-pass",
                           {"deviceIds": [device_id]})
    batch = (response.get("data") or {}).get("status")
    print(json.dumps({"batchId": batch_id, "deviceId": device_id, "batchStatus": batch,
                      "qcPassed": bool(response.get("success"))}, indent=2))
    return 0


def cmd_ready_to_ship(args: argparse.Namespace) -> int:
    manifest = load_manifest(Path(args.manifest))
    batch_id = manifest.get("batchId")
    if not batch_id:
        die("manifest must contain batchId")
    client = client_from_args(args)
    response = client.post(f"/api/v1/manufacturing/batches/{batch_id}/ready-to-ship", {})
    batch = (response.get("data") or {}).get("status")
    print(json.dumps({"batchId": batch_id, "batchStatus": batch,
                      "readyToShip": bool(response.get("success"))}, indent=2))
    return 0


def cmd_request_qr(args: argparse.Namespace) -> int:
    manifest = load_manifest(Path(args.manifest))
    # QR issuance must not be used as a shortcut around physical readback.
    load_readback_evidence(manifest, require_physical=True)
    client = client_from_args(args)
    response = client.post("/api/v1/manufacturing/qr/issue", {"deviceIds": [manifest["deviceId"]]})
    labels = response.get("data") or []
    label = labels[0] if labels else {}
    payload = label.get("payload")
    if not isinstance(payload, dict) or payload.get("v") != 3: die("backend did not return a QR v3 payload")
    qr_path = Path(manifest["outputDir"]) / "qr_v3.json"
    write_private_json(qr_path, payload)
    write_private_json(Path(manifest["outputDir"]) / "qr-response.json", response)
    print(json.dumps({"deviceId": manifest["deviceId"], "qrId": payload.get("qrId"), "payloadFile": str(qr_path)}, indent=2))
    return 0


def cmd_print(args: argparse.Namespace) -> int:
    manifest = load_manifest(Path(args.manifest))
    payload = read_json(Path(args.qr))
    required = ("v", "issuer", "qrId", "deviceId", "serial", "type", "model", "hardwareRevision", "kid", "sig")
    if set(payload) != set(required) or payload["v"] != 3 or not payload["sig"]:
        die("QR payload must contain exactly the signed public v3 fields")
    if payload["deviceId"] != manifest["deviceId"] or payload["serial"] != manifest["serial"]:
        die("QR payload does not match the local manifest")
    try:
        import qrcode
    except ImportError:
        die("QR image support is missing; install tools/manufacturing/requirements.txt")
    from io import BytesIO
    qr_text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    qr_image = qrcode.make(qr_text, error_correction=qrcode.constants.ERROR_CORRECT_Q,
                           box_size=10, border=4)
    png_buffer = BytesIO()
    qr_image.save(png_buffer, format="PNG")
    png_path = Path(args.png_output) if args.png_output else Path(manifest["outputDir"]) / "qr_v3.png"
    write_private_bytes(png_path, png_buffer.getvalue())
    summary = {"qrId": payload["qrId"], "deviceId": payload["deviceId"], "serial": payload["serial"],
               "type": payload["type"], "model": payload["model"], "hardwareRevision": payload["hardwareRevision"],
               "version": payload["v"], "signaturePresent": bool(payload["sig"]), "privateKeyUploaded": False,
               "pngFile": str(png_path)}
    if args.show_payload: summary["payload"] = payload
    print(json.dumps(summary, indent=2))
    if args.confirm:
        client = client_from_args(args)
        response = client.post(f"/api/v1/manufacturing/qr/{payload['qrId']}/print-confirm", {})
        print(json.dumps({"printConfirmed": bool(response.get("success"))}, indent=2))
    return 0


def add_backend_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--credential-file", default=None, help="private station credential JSON; avoids token in process arguments")
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--station-id", default=None)
    parser.add_argument("--station-token", default=None)
    parser.add_argument("--bearer-token", default=None)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="FarmOS factory station identity/QR v3 tool")
    sub = parser.add_subparsers(dest="command", required=True)
    allocate = sub.add_parser("allocate", help="allocate identities and generate local keys")
    add_backend_options(allocate)
    allocate.add_argument("--out", default="./factory-output")
    allocate.add_argument("--batch-id")
    allocate.add_argument("--batch-number")
    allocate.add_argument("--quantity", type=int, default=1)
    allocate.add_argument("--type", choices=["SENSOR_NODE", "GATEWAY"], default="SENSOR_NODE")
    allocate.add_argument("--device-id")
    allocate.add_argument("--radio-id", type=int)
    allocate.add_argument("--serial")
    allocate.add_argument("--serial-prefix", default="FARMOS")
    allocate.add_argument("--model", default="FARMOS_ESP32S3")
    allocate.add_argument("--hardware-revision", default="REV_A")
    allocate.add_argument("--firmware-target", default=None,
                          help="firmware target (defaults by type: sensor/gateway)")
    allocate.add_argument("--partition-scheme", default="FARMOS_16M_V1")
    allocate.add_argument("--capabilities")
    allocate.set_defaults(func=cmd_allocate)

    write = sub.add_parser("factory-write", help="register public key after physical factory_cfg readback")
    add_backend_options(write)
    write.add_argument("manifest")
    write.set_defaults(func=cmd_factory_write)

    generate = sub.add_parser("generate", help="generate local factory_cfg CSV/image")
    generate.add_argument("manifest")
    generate.add_argument("--nvs-generator")
    generate.set_defaults(func=cmd_generate)

    readback = sub.add_parser("readback", help="read/compare factory_cfg")
    readback.add_argument("manifest")
    readback.add_argument("--port")
    readback.add_argument("--baud", type=int)
    readback.add_argument("--esptool")
    readback.add_argument("--readback-file")
    readback.add_argument("--readback")
    readback.add_argument("--station-id", default=None)
    readback.add_argument("--firmware-image", default=None,
                          help="release firmware image whose SHA-256 is recorded in evidence")
    readback.set_defaults(func=cmd_readback)

    verify = sub.add_parser("verify", help="verify local key/CSV and optionally backend state")
    add_backend_options(verify)
    verify.add_argument("manifest")
    verify.add_argument("--backend", action="store_true")
    verify.set_defaults(func=cmd_verify)

    qc = sub.add_parser("qc-pass", help="pass a verified device through the backend QC gate")
    add_backend_options(qc)
    qc.add_argument("manifest")
    qc.set_defaults(func=cmd_qc_pass)

    release = sub.add_parser("ready-to-ship", help="release a fully QC-passed manufacturing batch")
    add_backend_options(release)
    release.add_argument("manifest")
    release.set_defaults(func=cmd_ready_to_ship)

    qr = sub.add_parser("request-qr", help="issue QR v3 after backend verification")
    add_backend_options(qr)
    qr.add_argument("manifest")
    qr.set_defaults(func=cmd_request_qr)

    print_qr = sub.add_parser("print", help="verify and print a QR v3 summary")
    add_backend_options(print_qr)
    print_qr.add_argument("manifest")
    print_qr.add_argument("--qr", required=True)
    print_qr.add_argument("--show-payload", action="store_true")
    print_qr.add_argument("--png-output", help="output path for the scannable QR v3 PNG")
    print_qr.add_argument("--confirm", action="store_true")
    print_qr.set_defaults(func=cmd_print)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except StationError as error:
        print(f"factory-station: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
