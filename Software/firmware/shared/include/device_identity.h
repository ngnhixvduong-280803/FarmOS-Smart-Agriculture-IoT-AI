#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

#include "esp_err.h"
#include "sdkconfig.h"

namespace farmos::identity {
struct Identity {
    std::uint32_t identity_version{0};
    std::uint32_t key_generation{0};
    char device_id[40]{};
    char serial[64]{};
    char model[48]{};
    char hardware_revision[32]{};
    char firmware_target[64]{};
    char cert_fingerprint[65]{};
    std::uint8_t attestation_public_key[160]{};
    std::uint16_t attestation_public_key_len{0};
    std::uint8_t attestation_private_key[256]{};
    std::uint16_t attestation_private_key_len{0};
    std::uint8_t last_ticket_hash[32]{};
    std::uint16_t last_ticket_hash_len{0};
    std::uint32_t radio_id{0};
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
    // Legacy bench-only claim value. Production builds do not carry or read
    // this field, and it must never be rendered in the BLE identity.
    char setup_secret[96]{};
#endif
};

// Factory data is read only at runtime. User reset must never erase it.
esp_err_t load(Identity& output, const char* role);

// Store only the identity namespace in the dedicated factory partition. This
// is an upsert, never a partition erase: normal firmware reflash and runtime
// reset preserve the factory identity and its anti-replay record.
esp_err_t store(const Identity& identity, const char* role,
                const std::uint8_t* ticket_hash = nullptr,
                std::size_t ticket_hash_len = 0);

bool has_attestation_key(const Identity& identity);

// The public key is intentionally the only key material exposed to callers
// that construct a BLE identity document.
std::string public_key_base64(const Identity& identity);

// Node radio assignment is part of the manufactured identity contract. A
// valid Node must be NODE_<numeric radio_id>; leading zeroes are allowed.
bool valid_node_device_id(const char* device_id, std::uint32_t radio_id);

// Gateways also use an immutable decimal numeric suffix so the same identity
// grammar is enforced by firmware, the factory station, and the backend.
bool valid_gateway_device_id(const char* device_id);
}
