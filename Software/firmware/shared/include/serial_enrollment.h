#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

#include "device_identity.h"
#include "esp_err.h"

namespace farmos::enrollment {

// Browser Web Serial uses this small binary envelope around bounded JSON
// messages. Logs may still be present on UART0; the two-byte sync marker lets
// the parser resynchronise without ever treating an arbitrary log line as a
// command.
constexpr std::uint8_t kProtocolVersion = 1;
constexpr std::size_t kMaxPayload = 2048;

enum class FrameType : std::uint8_t {
    kHello = 1,
    kHelloRequest = 2,
    kEnrollmentTicket = 3,
    kReadbackChallenge = 4,
    kProgress = 0x80,
    kResponse = 0x81,
    kError = 0x82,
};

enum class ErrorCode : std::uint8_t {
    kBadFrame = 1,
    kBadJson = 2,
    kBusy = 3,
    kTicketInvalid = 4,
    kTicketExpired = 5,
    kTicketReplay = 6,
    kHardwareMismatch = 7,
    kIdentityInvalid = 8,
    kCommitFailed = 9,
    kChallengeInvalid = 10,
    kTimeout = 11,
    kUnsupported = 12,
};

using CommitCallback = std::function<esp_err_t(const identity::Identity&,
                                               const std::uint8_t* ticket_hash,
                                               std::size_t ticket_hash_len)>;

class SerialEnrollment {
public:
    SerialEnrollment(const char* role, identity::Identity* identity,
                     CommitCallback commit_callback);

    // Starts a bounded UART0 parser task and emits HELLO immediately. The
    // caller must keep this object alive for the lifetime of the application.
    esp_err_t begin();

    bool enrolled() const { return enrolled_; }
    bool active() const { return active_; }

    // Used by tests/diagnostics to emit a fresh HELLO after a browser retry.
    void send_hello();

private:
    static void task_entry(void* arg);
    void task_loop();
    void consume_bytes(const std::uint8_t* data, std::size_t length);
    void reset_parser();
    void handle_frame(FrameType type, std::uint32_t sequence,
                      const std::uint8_t* payload, std::size_t length);

    bool prepare_session();
    bool generate_attestation_key(identity::Identity* identity);
    bool verify_ticket(const std::string& outer_json,
                       identity::Identity* candidate,
                       std::array<std::uint8_t, 32>* ticket_hash,
                       bool* committed_rotation,
                       bool* reflash_authorized);
    bool handle_readback(const std::string& json);
    bool send_json(FrameType type, const std::string& json);
    void send_progress(const char* stage, std::uint8_t percent);
    void send_error(ErrorCode code, const char* message);
    void handle_cli_command(const char* cmd);

    std::array<char, 64> cli_buf_{};
    std::size_t cli_idx_{0};

    const char* role_;
    identity::Identity* identity_;
    CommitCallback commit_callback_;
    identity::Identity pending_identity_{};
    std::array<std::uint8_t, 24> session_nonce_{};
    std::size_t session_nonce_len_{0};
    std::array<std::uint8_t, 32> hardware_proof_{};
    std::array<char, 65> hardware_proof_hex_{};
    std::array<char, 65> current_key_fingerprint_{};
    // REFLASH authorizes a firmware/readback operation without changing the
    // factory identity. Keep its digest only for this bounded serial session
    // so a duplicate command with a fresh frame sequence cannot be replayed;
    // no NVS identity write is performed for this operation.
    std::array<std::uint8_t, 32> last_reflash_ticket_hash_{};
    std::size_t last_reflash_ticket_hash_len_{0};
    std::array<char, 32> chip_family_{};
    std::array<char, 18> efuse_mac_{};
    std::uint32_t sequence_{1};
    std::uint32_t rx_sequence_{0};
    std::uint32_t last_rx_sequence_{0};
    std::uint64_t session_started_ms_{0};
    std::uint64_t ticket_deadline_ms_{0};
    bool active_{false};
    bool enrolled_{false};
    bool has_identity_{false};
    std::uint64_t identity_committed_at_ms_{0};

    enum class ParseState : std::uint8_t { kSync0, kSync1, kHeader, kPayload, kCrc };
    ParseState parse_state_{ParseState::kSync0};
    std::array<std::uint8_t, 8> header_{};
    std::size_t header_length_{0};
    std::array<std::uint8_t, kMaxPayload> payload_{};
    std::size_t payload_length_{0};
    std::array<std::uint8_t, 4> crc_{};
    std::size_t crc_length_{0};
    std::uint64_t frame_started_ms_{0};
};

}  // namespace farmos::enrollment
