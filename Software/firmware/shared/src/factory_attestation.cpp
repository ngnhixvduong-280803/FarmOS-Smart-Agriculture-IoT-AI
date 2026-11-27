#include "factory_attestation.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

#include "cJSON.h"
#include "mbedtls/base64.h"
#include "mbedtls/pk.h"
#include "psa/crypto.h"

namespace farmos::identity {
namespace {

constexpr char kDomain[] = "farmos-ble-provision-v3";
constexpr std::size_t kMaxTokenLength = 128;
constexpr std::size_t kMaxSessionLength = 63;
constexpr std::size_t kMaxJsonLength = 768;
constexpr std::size_t kDigestLength = 32;

const cJSON* field(const cJSON* root, const char* key) {
    if (root == nullptr) return nullptr;
    const cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    if (value != nullptr) return value;
    const cJSON* attestation = cJSON_GetObjectItemCaseSensitive(root, "attestation");
    return cJSON_IsObject(attestation) ? cJSON_GetObjectItemCaseSensitive(attestation, key) : nullptr;
}

bool string_field(const cJSON* root, const char* key, std::string* output,
                  std::size_t maximum, bool required) {
    const cJSON* value = field(root, key);
    if (!cJSON_IsString(value) || value->valuestring == nullptr) return !required;
    const std::size_t length = std::strlen(value->valuestring);
    if (length == 0 || length > maximum) return false;
    *output = value->valuestring;
    return true;
}

bool is_safe_identifier(const std::string& value) {
    return !value.empty() && std::all_of(value.begin(), value.end(), [](unsigned char character) {
        return std::isalnum(character) || character == '-' || character == '_' || character == '.' || character == ':';
    });
}

bool decode_base64url(const std::string& input, std::uint8_t* output,
                     std::size_t capacity, std::size_t* output_len) {
    if (input.empty() || output == nullptr || output_len == nullptr) return false;
    std::string normalized;
    normalized.reserve(input.size() + 3);
    for (const char character : input) {
        if (character == '-') normalized.push_back('+');
        else if (character == '_') normalized.push_back('/');
        else if (std::isalnum(static_cast<unsigned char>(character)) || character == '+' ||
                 character == '/' || character == '=') normalized.push_back(character);
        else return false;
    }
    if (normalized.find('=') != std::string::npos && normalized.back() != '=') return false;
    while ((normalized.size() % 4U) != 0U) normalized.push_back('=');
    std::size_t decoded = 0;
    if (mbedtls_base64_decode(output, capacity, &decoded,
                              reinterpret_cast<const unsigned char*>(normalized.data()),
                              normalized.size()) != 0) {
        return false;
    }
    *output_len = decoded;
    return decoded != 0;
}

std::string encode_base64url(const std::uint8_t* input, std::size_t input_len) {
    unsigned char encoded[256]{};
    std::size_t encoded_len = 0;
    if (input == nullptr || input_len == 0 ||
        mbedtls_base64_encode(encoded, sizeof(encoded), &encoded_len, input, input_len) != 0) {
        return {};
    }
    std::string result(reinterpret_cast<const char*>(encoded), encoded_len);
    std::replace(result.begin(), result.end(), '+', '-');
    std::replace(result.begin(), result.end(), '/', '_');
    while (!result.empty() && result.back() == '=') result.pop_back();
    return result;
}

void append_u32(std::vector<std::uint8_t>* transcript, std::uint32_t value) {
    transcript->push_back(static_cast<std::uint8_t>((value >> 24U) & 0xffU));
    transcript->push_back(static_cast<std::uint8_t>((value >> 16U) & 0xffU));
    transcript->push_back(static_cast<std::uint8_t>((value >> 8U) & 0xffU));
    transcript->push_back(static_cast<std::uint8_t>(value & 0xffU));
}

void append_bytes(std::vector<std::uint8_t>* transcript, const std::uint8_t* data, std::size_t length) {
    append_u32(transcript, static_cast<std::uint32_t>(length));
    transcript->insert(transcript->end(), data, data + length);
}

void append_string(std::vector<std::uint8_t>* transcript, const std::string& value) {
    append_bytes(transcript, reinterpret_cast<const std::uint8_t*>(value.data()), value.size());
}

bool digest_transcript(const Identity& identity, const std::string& session_id,
                       const std::uint8_t token_digest[32], const std::uint8_t* nonce,
                       std::size_t nonce_len, std::array<std::uint8_t, 32>* digest) {
    std::vector<std::uint8_t> transcript;
    transcript.reserve(128);
    append_string(&transcript, kDomain);
    append_string(&transcript, identity.device_id);
    append_string(&transcript, session_id);
    append_bytes(&transcript, token_digest, 32);
    append_bytes(&transcript, nonce, nonce_len);
    append_u32(&transcript, identity.identity_version);
    std::size_t digest_len = 0;
    return psa_crypto_init() == PSA_SUCCESS &&
           psa_hash_compute(PSA_ALG_SHA_256, transcript.data(), transcript.size(),
                            digest->data(), digest->size(), &digest_len) == PSA_SUCCESS &&
           digest_len == digest->size();
}

bool hash_token(const std::string& token, std::array<std::uint8_t, 32>* digest) {
    std::size_t digest_len = 0;
    return psa_crypto_init() == PSA_SUCCESS &&
           psa_hash_compute(PSA_ALG_SHA_256,
                            reinterpret_cast<const std::uint8_t*>(token.data()), token.size(),
                            digest->data(), digest->size(), &digest_len) == PSA_SUCCESS &&
           digest_len == digest->size();
}

bool equal_bytes(const std::uint8_t* left, const std::uint8_t* right, std::size_t length) {
    std::uint8_t difference = 0;
    for (std::size_t index = 0; index < length; ++index) difference |= left[index] ^ right[index];
    return difference == 0;
}

bool hash_message(const std::uint8_t* message, std::size_t message_len,
                  std::array<std::uint8_t, kDigestLength>* digest) {
    if (message == nullptr || message_len == 0 || digest == nullptr) return false;
    std::size_t digest_len = 0;
    return psa_crypto_init() == PSA_SUCCESS &&
           psa_hash_compute(PSA_ALG_SHA_256, message, message_len, digest->data(), digest->size(),
                            &digest_len) == PSA_SUCCESS && digest_len == digest->size();
}

bool sign_message(const Identity& identity, const std::uint8_t* message, std::size_t message_len,
                  std::array<std::uint8_t, 160>* signature, std::size_t* signature_len) {
    if (message == nullptr || message_len == 0 || signature == nullptr || signature_len == nullptr) {
        return false;
    }
    std::array<std::uint8_t, kDigestLength> digest{};
    if (!hash_message(message, message_len, &digest)) return false;
    mbedtls_pk_context private_key;
    mbedtls_pk_init(&private_key);
    const int parse_status = mbedtls_pk_parse_key(&private_key, identity.attestation_private_key,
                                                  identity.attestation_private_key_len, nullptr, 0);
    const int sign_status = parse_status == 0
        ? mbedtls_pk_sign(&private_key, MBEDTLS_MD_SHA256, digest.data(), digest.size(),
                          signature->data(), signature->size(), signature_len)
        : parse_status;
    mbedtls_pk_free(&private_key);
    return sign_status == 0 && *signature_len > 0 && *signature_len <= signature->size();
}

bool verify_message(const Identity& identity, const std::uint8_t* message, std::size_t message_len,
                    const std::uint8_t* signature, std::size_t signature_len) {
    if (message == nullptr || message_len == 0 || signature == nullptr || signature_len == 0) {
        return false;
    }
    std::array<std::uint8_t, kDigestLength> digest{};
    if (!hash_message(message, message_len, &digest)) return false;
    mbedtls_pk_context public_key;
    mbedtls_pk_init(&public_key);
    const int parse_status = mbedtls_pk_parse_public_key(&public_key, identity.attestation_public_key,
                                                         identity.attestation_public_key_len);
    const int verify_status = parse_status == 0
        ? mbedtls_pk_verify(&public_key, MBEDTLS_MD_SHA256, digest.data(), digest.size(),
                            signature, signature_len)
        : parse_status;
    mbedtls_pk_free(&public_key);
    return verify_status == 0;
}

bool configured_device_matches(const cJSON* root, const Identity& identity) {
    const auto matches = [root](const char* key, const char* expected) {
        const cJSON* value = field(root, key);
        return value == nullptr || (cJSON_IsString(value) && value->valuestring != nullptr &&
                                    std::strcmp(value->valuestring, expected) == 0);
    };
    // deviceId/nodeId identify the BLE device itself. A Node pairing payload
    // also carries the *target* gatewayId, which must not be compared to the
    // Node's own identity.
    if (!matches("deviceId", identity.device_id) || !matches("nodeId", identity.device_id)) {
        return false;
    }
    const cJSON* gateway = cJSON_GetObjectItemCaseSensitive(root, "gatewayId");
    if (gateway == nullptr) return true;
    if (!cJSON_IsString(gateway) || gateway->valuestring == nullptr) return false;
    if (std::strncmp(identity.device_id, "GATEWAY_", 8) == 0) {
        return std::strcmp(gateway->valuestring, identity.device_id) == 0;
    }
    // Node pairing must still receive a syntactically valid gateway target;
    // the backend-issued session/token remains the authorization boundary.
    return std::strncmp(gateway->valuestring, "GATEWAY_", 8) == 0 &&
           std::strlen(gateway->valuestring) < sizeof(identity.device_id);
}

}  // namespace

bool sign_attestation_message(const Identity& identity, const std::uint8_t* message,
                              std::size_t message_len, std::uint8_t* signature,
                              std::size_t signature_capacity, std::size_t* signature_len) {
    constexpr std::size_t kMaxAttestationSignature = 160;
    if (signature == nullptr || signature_len == nullptr || signature_capacity == 0 ||
        signature_capacity > kMaxAttestationSignature) {
        return false;
    }
    std::array<std::uint8_t, kMaxAttestationSignature> encoded{};
    std::size_t encoded_len = 0;
    if (!sign_message(identity, message, message_len, &encoded, &encoded_len) ||
        encoded_len > signature_capacity) {
        return false;
    }
    std::memcpy(signature, encoded.data(), encoded_len);
    *signature_len = encoded_len;
    return true;
}

bool verify_attestation_message(const Identity& identity, const std::uint8_t* message,
                                std::size_t message_len, const std::uint8_t* signature,
                                std::size_t signature_len) {
    return verify_message(identity, message, message_len, signature, signature_len);
}

void BleAttestation::clear_state() {
    active_ = false;
    expires_at_ms_ = 0;
    nonce_len_ = 0;
    nonce_.fill(0);
    token_digest_.fill(0);
    session_id_.clear();
    nonce_text_.clear();
}

bool BleAttestation::has_active_challenge(std::uint64_t now_ms) const {
    return active_ && now_ms < expires_at_ms_;
}

bool BleAttestation::handle_challenge(const Identity& identity, const std::string& request,
                                     std::uint64_t now_ms) {
    response_json_ = "{\"status\":\"CHALLENGE_REJECTED\"}";
    if (request.empty() || request.size() > kMaxJsonLength) return false;
    cJSON* root = cJSON_ParseWithLength(request.data(), request.size());
    if (root == nullptr) return false;

    std::string operation;
    std::string device_id;
    std::string session_id;
    std::string token;
    std::string nonce_text;
    const cJSON* ttl = cJSON_GetObjectItemCaseSensitive(root, "ttlMs");
    const bool has_optional_challenge = field(root, "challenge") != nullptr;
    bool valid = string_field(root, "op", &operation, 16, true) && operation == "CHALLENGE" &&
                 string_field(root, "deviceId", &device_id, sizeof(identity.device_id) - 1, true) &&
                 device_id == identity.device_id &&
                 string_field(root, "sessionId", &session_id, kMaxSessionLength, true) &&
                 is_safe_identifier(session_id) &&
                 string_field(root, "nonce", &nonce_text, 128, true) &&
                 cJSON_IsNumber(ttl) && std::isfinite(ttl->valuedouble) &&
                 std::floor(ttl->valuedouble) == ttl->valuedouble && ttl->valuedouble >= 1 &&
                 ttl->valuedouble <= 300000;
    // The backend claim session exposes the challenge as the short-lived
    // provisioningToken. It is always required for the canonical transcript;
    // an optional duplicate `challenge` field is accepted only when it is the
    // same value, and never changes the bytes that are signed.
    if (valid) valid = string_field(root, "provisioningToken", &token, kMaxTokenLength, true);
    if (valid && has_optional_challenge) {
        std::string challenge;
        valid = string_field(root, "challenge", &challenge, kMaxTokenLength, true) &&
                challenge == token && is_safe_identifier(challenge);
    }
    std::array<std::uint8_t, kNonceSize> nonce{};
    std::size_t nonce_len = 0;
    if (valid) valid = decode_base64url(nonce_text, nonce.data(), nonce.size(), &nonce_len) &&
                       nonce_len >= 16 && nonce_len <= kNonceSize;
    std::array<std::uint8_t, kDigestSize> token_digest{};
    if (valid) valid = hash_token(token, &token_digest);
    std::array<std::uint8_t, kDigestSize> digest{};
    if (valid) valid = digest_transcript(identity, session_id, token_digest.data(),
                                         nonce.data(), nonce_len, &digest);
    std::array<std::uint8_t, kMaxSignatureSize> signature{};
    std::size_t signature_len = 0;
    std::vector<std::uint8_t> signed_message;
    if (valid) {
        // sign_message hashes this digest once before ECDSA signing. This is
        // the same ECDSA-P256-SHA256 operation as backend verify("sha256",
        // attestationMessage(...), key, signature).
        signed_message.assign(digest.begin(), digest.end());
        valid = !signed_message.empty() &&
                sign_message(identity, signed_message.data(), signed_message.size(),
                             &signature, &signature_len) &&
                verify_message(identity, signed_message.data(), signed_message.size(),
                               signature.data(), signature_len);
    }
    if (!valid) {
        cJSON_Delete(root);
        return false;
    }

    active_ = true;
    expires_at_ms_ = now_ms + static_cast<std::uint64_t>(ttl->valuedouble);
    nonce_len_ = nonce_len;
    std::copy(nonce.begin(), nonce.end(), nonce_.begin());
    std::copy(token_digest.begin(), token_digest.end(), token_digest_.begin());
    session_id_ = session_id;
    nonce_text_ = nonce_text;
    const std::string signature_text = encode_base64url(signature.data(), signature_len);
    const std::string public_key = public_key_base64(identity);
    char response[768]{};
    std::snprintf(response, sizeof(response),
                  "{\"status\":\"CHALLENGE_ACCEPTED\",\"deviceId\":\"%s\"," 
                  "\"identityVersion\":%lu,\"sessionId\":\"%s\","
                  "\"signatureFormat\":\"transcript-v1\",\"nonce\":\"%s\"," 
                  "\"expiresAtMs\":%llu,\"signature\":\"%s\",\"publicKey\":\"%s\"," 
                  "\"certFingerprint\":\"%s\"}",
                  identity.device_id, static_cast<unsigned long>(identity.identity_version),
                  session_id.c_str(), nonce_text.c_str(),
                  static_cast<unsigned long long>(expires_at_ms_),
                  signature_text.c_str(), public_key.c_str(), identity.cert_fingerprint);
    response_json_ = response;
    cJSON_Delete(root);
    return true;
}

bool BleAttestation::authorize_config(const Identity& identity, const std::string& config,
                                      std::uint64_t now_ms) {
    if (config.empty() || config.size() > kMaxJsonLength) return false;
    cJSON* root = cJSON_ParseWithLength(config.data(), config.size());
    if (root == nullptr || !configured_device_matches(root, identity)) {
        cJSON_Delete(root);
        return false;
    }
    const bool has_any_auth_field = field(root, "sessionId") != nullptr ||
                                    field(root, "provisioningToken") != nullptr ||
                                    field(root, "nonce") != nullptr || field(root, "signature") != nullptr;
    if (!has_any_auth_field) {
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
        // Legacy claim-code BLE is deliberately restricted to explicit bench
        // builds. Production configs must carry the attestation proof.
        cJSON_Delete(root);
        return true;
#else
        cJSON_Delete(root);
        return false;
#endif
    }
    if (!has_active_challenge(now_ms)) {
        clear_state();
        cJSON_Delete(root);
        return false;
    }

    std::string session_id;
    std::string token;
    std::string nonce_text;
    std::string signature_text;
    const bool has_provisioning_token = field(root, "provisioningToken") != nullptr;
    bool valid = string_field(root, "sessionId", &session_id, kMaxSessionLength, true) &&
                 string_field(root, "nonce", &nonce_text, 128, true) &&
                 string_field(root, "signature", &signature_text, 256, true) &&
                 session_id == session_id_ && nonce_text == nonce_text_ &&
                 is_safe_identifier(session_id);
    if (valid) {
        valid = string_field(root, "provisioningToken", &token, kMaxTokenLength, true);
    }
    // There is one production attestation transcript. A config carrying an
    // alternate challenge-only field must not silently select another mode.
    if (valid && field(root, "challenge") != nullptr) valid = false;
    std::array<std::uint8_t, kDigestSize> token_digest{};
    if (valid && has_provisioning_token) {
        valid = hash_token(token, &token_digest) &&
                equal_bytes(token_digest.data(), token_digest_.data(), token_digest.size());
    }
    std::array<std::uint8_t, kNonceSize> decoded_nonce{};
    std::size_t decoded_nonce_len = 0;
    if (valid) valid = decode_base64url(nonce_text, decoded_nonce.data(), decoded_nonce.size(), &decoded_nonce_len) &&
                       decoded_nonce_len == nonce_len_ && equal_bytes(decoded_nonce.data(), nonce_.data(), nonce_len_);
    std::array<std::uint8_t, kMaxSignatureSize> signature{};
    std::size_t signature_len = 0;
    if (valid) valid = decode_base64url(signature_text, signature.data(), signature.size(), &signature_len) &&
                       signature_len > 0 && signature_len <= signature.size();
    std::array<std::uint8_t, kDigestSize> digest{};
    if (valid) {
        valid = digest_transcript(identity, session_id_, token_digest_.data(), nonce_.data(), nonce_len_, &digest) &&
                verify_message(identity, digest.data(), digest.size(), signature.data(), signature_len);
    }
    cJSON_Delete(root);
    if (!valid) return false;
    clear_state();
    response_json_ = "{\"status\":\"CONFIG_AUTHORIZED\"}";
    return true;
}

}  // namespace farmos::identity
