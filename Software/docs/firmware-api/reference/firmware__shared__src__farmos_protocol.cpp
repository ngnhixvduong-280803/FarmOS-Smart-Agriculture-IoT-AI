#include "farmos_protocol.h"

#include <cstddef>
#include <cstring>

#include "psa/crypto.h"

namespace farmos::protocol {
namespace {

template <typename Frame>
std::uint32_t frame_crc(const Frame& frame) {
    return crc32(&frame, sizeof(Frame) - sizeof(frame.crc32));
}

template <typename Frame>
bool has_valid_envelope(const Frame& frame, MessageType expected_type) {
    return frame.magic == kMagic && frame.version == kVersion &&
           frame.type == static_cast<std::uint8_t>(expected_type);
}

template <typename Frame>
bool write_auth_tag(Frame& frame, const std::uint8_t key[16]) {
    std::uint8_t digest[32]{};
    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_MESSAGE);
    psa_set_key_algorithm(&attributes, PSA_ALG_HMAC(PSA_ALG_SHA_256));
    psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC);
    psa_set_key_bits(&attributes, 128);
    psa_key_id_t key_id = 0;
    if (psa_crypto_init() != PSA_SUCCESS ||
        psa_import_key(&attributes, key, 16, &key_id) != PSA_SUCCESS) {
        psa_reset_key_attributes(&attributes);
        return false;
    }
    std::size_t digest_length = 0;
    const psa_status_t status = psa_mac_compute(
        key_id, PSA_ALG_HMAC(PSA_ALG_SHA_256),
        reinterpret_cast<const std::uint8_t*>(&frame), offsetof(Frame, auth_tag),
        digest, sizeof(digest), &digest_length);
    psa_destroy_key(key_id);
    psa_reset_key_attributes(&attributes);
    if (status != PSA_SUCCESS || digest_length < sizeof(frame.auth_tag)) return false;
    std::memcpy(frame.auth_tag, digest, sizeof(frame.auth_tag));
    return true;
}

template <typename Frame>
bool has_valid_auth_tag(const Frame& frame, const std::uint8_t key[16]) {
    Frame expected = frame;
    if (!write_auth_tag(expected, key)) return false;
    std::uint8_t difference = 0;
    for (std::size_t i = 0; i < sizeof(frame.auth_tag); ++i) {
        difference |= frame.auth_tag[i] ^ expected.auth_tag[i];
    }
    return difference == 0;
}

}  // namespace

std::uint32_t crc32(const void* data, std::size_t length) {
    const auto* bytes = static_cast<const std::uint8_t*>(data);
    std::uint32_t crc = 0xFFFFFFFFU;
    for (std::size_t index = 0; index < length; ++index) {
        crc ^= bytes[index];
        for (int bit = 0; bit < 8; ++bit) {
            const std::uint32_t mask = 0U - (crc & 1U);
            crc = (crc >> 1U) ^ (0xEDB88320U & mask);
        }
    }
    return ~crc;
}

void finalize(TelemetryFrame& frame) {
    frame.crc32 = 0;
    frame.crc32 = frame_crc(frame);
}

void finalize(AckFrame& frame) {
    frame.crc32 = 0;
    frame.crc32 = frame_crc(frame);
}

void finalize(PairRequestFrame& frame) {
    frame.crc32 = 0;
    frame.crc32 = frame_crc(frame);
}

void finalize(PairAcceptFrame& frame) {
    frame.crc32 = 0;
    frame.crc32 = frame_crc(frame);
}

bool authenticate(TelemetryFrame& frame, const std::uint8_t key[16]) {
    frame.crc32 = 0;
    if (!write_auth_tag(frame, key)) return false;
    finalize(frame);
    return true;
}

bool authenticate(AckFrame& frame, const std::uint8_t key[16]) {
    frame.crc32 = 0;
    if (!write_auth_tag(frame, key)) return false;
    finalize(frame);
    return true;
}

bool authenticate(PairRequestFrame& frame, const std::uint8_t key[16]) {
    if (!write_auth_tag(frame, key)) return false;
    finalize(frame);
    return true;
}

bool authenticate(PairAcceptFrame& frame, const std::uint8_t key[16]) {
    if (!write_auth_tag(frame, key)) return false;
    finalize(frame);
    return true;
}

bool validate_authenticated(const PairRequestFrame& frame, const std::uint8_t key[16]) {
    return validate(frame) && has_valid_auth_tag(frame, key);
}

bool validate_authenticated(const PairAcceptFrame& frame, const std::uint8_t key[16]) {
    return validate(frame) && has_valid_auth_tag(frame, key);
}

bool validate(const TelemetryFrame& frame) {
    return has_valid_envelope(frame, MessageType::kTelemetry) &&
           frame.crc32 == frame_crc(frame);
}

bool validate(const AckFrame& frame) {
    return has_valid_envelope(frame, MessageType::kAck) &&
           frame.crc32 == frame_crc(frame);
}

bool validate_authenticated(const TelemetryFrame& frame, const std::uint8_t key[16]) {
    return validate(frame) && has_valid_auth_tag(frame, key);
}

bool validate_authenticated(const AckFrame& frame, const std::uint8_t key[16]) {
    return validate(frame) && has_valid_auth_tag(frame, key);
}

bool validate(const PairRequestFrame& frame) {
    return has_valid_envelope(frame, MessageType::kPairRequest) &&
           frame.crc32 == frame_crc(frame);
}

bool validate(const PairAcceptFrame& frame) {
    return has_valid_envelope(frame, MessageType::kPairAccept) &&
           frame.crc32 == frame_crc(frame);
}

}  // namespace farmos::protocol
