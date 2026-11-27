#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

#include "device_identity.h"

namespace farmos::identity {

// Sign/verify an enrollment or readback transcript with the immutable
// device-local ECDSA P-256 key. The message is hashed once with SHA-256 and
// encoded as a DER ECDSA signature, matching the backend attestation contract.
bool sign_attestation_message(const Identity& identity, const std::uint8_t* message,
                              std::size_t message_len, std::uint8_t* signature,
                              std::size_t signature_capacity, std::size_t* signature_len);
bool verify_attestation_message(const Identity& identity, const std::uint8_t* message,
                                std::size_t message_len, const std::uint8_t* signature,
                                std::size_t signature_len);

// Application-layer authentication for the custom BLE provisioning channel.
// The BLE link may still be encrypted by NimBLE Secure Connections, but the
// provisioning claim is independently bound to the factory identity, session,
// nonce, and short expiry so a captured write cannot be replayed.
class BleAttestation {
public:
    bool handle_challenge(const Identity& identity, const std::string& request,
                          std::uint64_t now_ms);
    bool authorize_config(const Identity& identity, const std::string& config,
                          std::uint64_t now_ms);

    std::string response() const { return response_json_; }
    bool has_active_challenge(std::uint64_t now_ms) const;

private:
    static constexpr std::size_t kNonceSize = 32;
    static constexpr std::size_t kDigestSize = 32;
    static constexpr std::size_t kMaxSignatureSize = 160;

    void clear_state();

    bool active_{false};
    std::uint64_t expires_at_ms_{0};
    std::size_t nonce_len_{0};
    std::array<std::uint8_t, kNonceSize> nonce_{};
    std::array<std::uint8_t, kDigestSize> token_digest_{};
    std::string session_id_;
    std::string nonce_text_;
    std::string response_json_{"{\"status\":\"IDLE\"}"};
};

}  // namespace farmos::identity
