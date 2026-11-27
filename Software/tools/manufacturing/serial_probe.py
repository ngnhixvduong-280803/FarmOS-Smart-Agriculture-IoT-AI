#!/usr/bin/env python3
"""Check a physical FarmOS identity and P-256 signing over enrollment serial."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import secrets
import struct
import time

import serial
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from enrollment_protocol import FrameDecoder, encode_frame, b64url_decode, b64url_encode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--port", required=True)
    parser.add_argument("--expected-mac", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--firmware-image", type=Path, help="verify the running signed application prefix")
    parser.add_argument("--release-plan", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    decoder = FrameDecoder(enforce_sequence=False)
    with serial.Serial(args.port, 115200, timeout=.2) as port:
        port.dtr = False
        port.rts = False
        sequence = 1
        def receive(op, command, frame_type):
            nonlocal sequence
            end = time.monotonic() + 12
            retry = 0
            while time.monotonic() < end:
                if time.monotonic() >= retry:
                    port.write(encode_frame(frame_type, command, sequence))
                    sequence += 1
                    retry = time.monotonic() + 1
                for frame in decoder.feed(port.read(4096)):
                    body = frame.json()
                    if body.get("op") == "ERROR":
                        raise RuntimeError("Firmware: " + str(body.get("message")))
                    if body.get("op") == op:
                        return body
            raise RuntimeError("Serial timeout waiting for " + op)
        hello = receive("HELLO", {"op": "HELLO_REQUEST"}, 2)
        if hello["efuseMac"].lower() != args.expected_mac.lower() or hello["publicKeyFingerprint"] != manifest["publicKeyFingerprint"]:
            raise RuntimeError("Physical MAC or identity public key mismatch")
        nonce = secrets.token_bytes(32)
        challenge = "station-qc-" + secrets.token_hex(12)
        command = {"op": "READBACK_CHALLENGE", "challengeId": challenge, "nonce": b64url_encode(nonce)}
        flash = None
        if args.firmware_image:
            if not args.release_plan:
                raise RuntimeError("Application verification requires a release plan")
            firmware = args.firmware_image.read_bytes()
            flash = {"boardId": "local-station-qc", "jobId": challenge, "releaseId": "local-signed-release-qc",
                     "manifestSha256": hashlib.sha256(args.release_plan.read_bytes()).hexdigest(),
                     "readbackSha256": hashlib.sha256(firmware).hexdigest(), "challenge": secrets.token_hex(24),
                     "readbackLength": len(firmware)}
            command["flashAttestation"] = flash
        response = receive("READBACK_RESPONSE", command, 4)
    if response["deviceId"] != manifest["deviceId"] or response["challengeId"] != challenge or b64url_decode(response["nonce"]) != nonce:
        raise RuntimeError("Signed challenge identity/session mismatch")
    def part(value):
        return struct.pack(">I", len(value)) + value
    transcript = b"".join(part(value) for value in (b"farmos-enrollment-readback-v1", manifest["deviceId"].encode(), challenge.encode(), bytes.fromhex(response["hardwareProof"]), nonce)) + struct.pack(">I", response["keyGeneration"])
    public = base64.b64decode(manifest["publicKey"])
    if base64.b64decode(response["attestationPublicKey"]) != public or hashlib.sha256(public).hexdigest() != manifest["publicKeyFingerprint"]:
        raise RuntimeError("Attestation public key mismatch")
    serialization.load_der_public_key(public).verify(b64url_decode(response["signature"]), transcript, ec.ECDSA(hashes.SHA256()))
    if flash:
        message = response["flashAttestationMessage"]
        expected = {"v": 1, "domain": "farmos-web-serial-flash-attestation", **{k: flash[k] for k in ("boardId", "jobId", "releaseId", "manifestSha256", "readbackSha256", "challenge")}}
        if json.loads(message) != expected or response["readbackLength"] != len(firmware):
            raise RuntimeError("Application readback binding mismatch")
        serialization.load_der_public_key(public).verify(b64url_decode(response["flashAttestationSignature"]), message.encode(), ec.ECDSA(hashes.SHA256()))
    proof = {"deviceId": manifest["deviceId"], "efuseMac": hello["efuseMac"], "identityVersion": hello["identityVersion"], "publicKeyFingerprint": manifest["publicKeyFingerprint"], "challengeSignatureVerified": True, "hello": hello, "response": response}
    if flash:
        proof.update({"applicationPrefixVerified": True, "applicationSha256": flash["readbackSha256"],
                      "applicationVersion": firmware[48:80].split(b"\0", 1)[0].decode(), "localQcOnly": True})
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.output.write_text(json.dumps(proof, indent=2))
    args.output.chmod(0o600)
    print(json.dumps({key: proof[key] for key in ("deviceId", "efuseMac", "identityVersion", "challengeSignatureVerified")}))


if __name__ == "__main__":
    main()
