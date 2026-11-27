#include "serial_enrollment.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <cmath>
#include <string>
#include <vector>

#include "cJSON.h"
#include "driver/uart.h"
#ifdef CONFIG_FARMOS_ENROLLMENT_USB_SERIAL_JTAG
#include "driver/usb_serial_jtag.h"
#endif
#include "esp_chip_info.h"
#include "esp_mac.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "factory_attestation.h"
#include "mbedtls/base64.h"
#include "mbedtls/ecp.h"
#include "mbedtls/pk.h"
#include "psa/crypto.h"

namespace farmos::enrollment {
namespace {

esp_err_t install_enrollment_transport() {
#ifdef CONFIG_FARMOS_ENROLLMENT_USB_SERIAL_JTAG
    if (usb_serial_jtag_is_driver_installed()) return ESP_OK;
    usb_serial_jtag_driver_config_t config{.tx_buffer_size = 4096, .rx_buffer_size = 4096};
    return usb_serial_jtag_driver_install(&config);
#else
    return uart_driver_install(UART_NUM_0, 4096, 0, 0, nullptr, 0);
#endif
}

int read_enrollment_transport(void* buffer, std::size_t size) {
#ifdef CONFIG_FARMOS_ENROLLMENT_USB_SERIAL_JTAG
    return usb_serial_jtag_read_bytes(buffer, size, pdMS_TO_TICKS(50));
#else
    return uart_read_bytes(UART_NUM_0, buffer, size, pdMS_TO_TICKS(50));
#endif
}

int write_enrollment_transport(const void* buffer, std::size_t size) {
#ifdef CONFIG_FARMOS_ENROLLMENT_USB_SERIAL_JTAG
    return usb_serial_jtag_write_bytes(buffer, size, pdMS_TO_TICKS(1000));
#else
    return uart_write_bytes(UART_NUM_0, buffer, size);
#endif
}

void flush_enrollment_transport(std::uint32_t milliseconds) {
#ifdef CONFIG_FARMOS_ENROLLMENT_USB_SERIAL_JTAG
    usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(milliseconds));
#else
    uart_wait_tx_done(UART_NUM_0, pdMS_TO_TICKS(milliseconds));
#endif
}

constexpr std::uint8_t kSync0 = 'F';
constexpr std::uint8_t kSync1 = 'O';
constexpr std::size_t kHeaderLength = 8;  // version, type, length, sequence
constexpr std::uint64_t kFrameTimeoutMs = 2'000;
constexpr std::uint64_t kMaxTicketTtlMs = 300'000;
constexpr std::size_t kMaxSignature = 160;
constexpr char kHardwareDomain[] = "farmos-enrollment-hardware-v1";
constexpr char kReadbackDomain[] = "farmos-enrollment-readback-v1";
constexpr char kReadbackPartition[] = "ota_0";
constexpr std::uint32_t kReadbackPartitionAddress = 0x20000;

#ifndef CONFIG_FARMOS_ENROLLMENT_SERVER_PUBLIC_KEY
#define CONFIG_FARMOS_ENROLLMENT_SERVER_PUBLIC_KEY ""
#endif

std::uint32_t crc32_update(std::uint32_t crc, const std::uint8_t* data, std::size_t length) {
    for (std::size_t index = 0; index < length; ++index) {
        crc ^= data[index];
        for (int bit = 0; bit < 8; ++bit) {
            const std::uint32_t mask = 0U - (crc & 1U);
            crc = (crc >> 1U) ^ (0xEDB88320U & mask);
        }
    }
    return crc;
}

std::uint32_t crc32(const std::uint8_t* data, std::size_t length) {
    return ~crc32_update(0xFFFFFFFFU, data, length);
}

bool decode_base64url(const char* input, std::size_t input_len,
                      std::uint8_t* output, std::size_t capacity,
                      std::size_t* output_len) {
    if (input == nullptr || input_len == 0 || output == nullptr || output_len == nullptr) return false;
    std::vector<char> normalized(input_len + 5, '\0');
    std::size_t normalized_len = 0;
    for (std::size_t index = 0; index < input_len; ++index) {
        const char character = input[index];
        if (character == '-') normalized[normalized_len++] = '+';
        else if (character == '_') normalized[normalized_len++] = '/';
        else if (std::isalnum(static_cast<unsigned char>(character)) || character == '+' ||
                 character == '/' || character == '=') normalized[normalized_len++] = character;
        else return false;
    }
    while ((normalized_len % 4U) != 0U) normalized[normalized_len++] = '=';
    std::size_t decoded = 0;
    if (mbedtls_base64_decode(output, capacity, &decoded,
                              reinterpret_cast<const unsigned char*>(normalized.data()),
                              normalized_len) != 0) return false;
    *output_len = decoded;
    return decoded > 0;
}

std::string encode_base64url(const std::uint8_t* input, std::size_t input_len) {
    std::array<unsigned char, 512> encoded{};
    std::size_t encoded_len = 0;
    if (input == nullptr || input_len == 0 || input_len > 384 ||
        mbedtls_base64_encode(encoded.data(), encoded.size(), &encoded_len, input, input_len) != 0) {
        return {};
    }
    std::string result(reinterpret_cast<const char*>(encoded.data()), encoded_len);
    std::replace(result.begin(), result.end(), '+', '-');
    std::replace(result.begin(), result.end(), '/', '_');
    while (!result.empty() && result.back() == '=') result.pop_back();
    return result;
}

void hex_encode(const std::uint8_t* input, std::size_t input_len, char* output, std::size_t capacity) {
    static constexpr char kHex[] = "0123456789abcdef";
    if (output == nullptr || capacity < input_len * 2 + 1) return;
    for (std::size_t index = 0; index < input_len; ++index) {
        output[index * 2] = kHex[input[index] >> 4U];
        output[index * 2 + 1] = kHex[input[index] & 0x0FU];
    }
    output[input_len * 2] = '\0';
}

bool string_value(const cJSON* root, const char* key, std::string* output, std::size_t maximum,
                  bool required = true) {
    const cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsString(value) || value->valuestring == nullptr) return !required;
    const std::size_t length = std::strlen(value->valuestring);
    if (length == 0 || length > maximum) return false;
    *output = value->valuestring;
    return true;
}

bool u32_value(const cJSON* root, const char* key, std::uint32_t* output, bool required = true) {
    const cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsNumber(value) || value->valuedouble < 0 || value->valuedouble > UINT32_MAX ||
        std::floor(value->valuedouble) != value->valuedouble) return !required;
    *output = static_cast<std::uint32_t>(value->valuedouble);
    return true;
}

bool bool_value(const cJSON* root, const char* key, bool* output, bool required = true) {
    const cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsBool(value)) return !required;
    *output = cJSON_IsTrue(value);
    return true;
}

bool safe_identifier(const std::string& value, std::size_t maximum) {
    return !value.empty() && value.size() <= maximum && std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == ':';
    });
}

bool lower_hex_digest(const std::string& value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

bool firmware_target_requires_p256(const std::string& target) {
    if (target.empty()) return false;
    std::string normalized = target;
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char c) {
        return static_cast<char>(std::toupper(c));
    });
    if (normalized.find("ED25519") != std::string::npos) return false;
    return normalized.find("ECDSA") != std::string::npos ||
           normalized.find("P256") != std::string::npos ||
           normalized.rfind("ESP32S3_LORA_", 0) == 0;
}

void append_u32(std::vector<std::uint8_t>* output, std::uint32_t value) {
    output->push_back(static_cast<std::uint8_t>((value >> 24U) & 0xffU));
    output->push_back(static_cast<std::uint8_t>((value >> 16U) & 0xffU));
    output->push_back(static_cast<std::uint8_t>((value >> 8U) & 0xffU));
    output->push_back(static_cast<std::uint8_t>(value & 0xffU));
}

void append_bytes(std::vector<std::uint8_t>* output, const std::uint8_t* data, std::size_t length) {
    append_u32(output, static_cast<std::uint32_t>(length));
    output->insert(output->end(), data, data + length);
}

void append_string(std::vector<std::uint8_t>* output, const std::string& value) {
    append_bytes(output, reinterpret_cast<const std::uint8_t*>(value.data()), value.size());
}

bool sha256(const std::uint8_t* input, std::size_t input_len, std::array<std::uint8_t, 32>* output) {
    std::size_t output_len = 0;
    return input != nullptr && output != nullptr && psa_crypto_init() == PSA_SUCCESS &&
           psa_hash_compute(PSA_ALG_SHA_256, input, input_len, output->data(), output->size(), &output_len) == PSA_SUCCESS &&
           output_len == output->size();
}

bool running_partition_is_readback_target() {
    const esp_partition_t* partition = esp_ota_get_running_partition();
    return partition != nullptr && partition->type == ESP_PARTITION_TYPE_APP &&
           partition->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_0 &&
           partition->address == kReadbackPartitionAddress &&
           std::strncmp(partition->label, kReadbackPartition, sizeof(partition->label)) == 0;
}

bool hash_running_image_prefix(std::uint32_t length, std::array<std::uint8_t, 32>* output) {
    if (length == 0 || output == nullptr || psa_crypto_init() != PSA_SUCCESS) return false;
    const esp_partition_t* partition = esp_ota_get_running_partition();
    if (partition == nullptr || length > partition->size) return false;
    psa_hash_operation_t operation = PSA_HASH_OPERATION_INIT;
    if (psa_hash_setup(&operation, PSA_ALG_SHA_256) != PSA_SUCCESS) return false;
    std::array<std::uint8_t, 1024> chunk{};
    for (std::uint32_t offset = 0; offset < length;) {
        const std::size_t count = std::min<std::size_t>(chunk.size(), length - offset);
        if (esp_partition_read(partition, offset, chunk.data(), count) != ESP_OK ||
            psa_hash_update(&operation, chunk.data(), count) != PSA_SUCCESS) {
            psa_hash_abort(&operation);
            return false;
        }
        offset += static_cast<std::uint32_t>(count);
    }
    std::size_t output_len = 0;
    const psa_status_t finish = psa_hash_finish(&operation, output->data(), output->size(), &output_len);
    return finish == PSA_SUCCESS && output_len == output->size();
}

bool make_key(identity::Identity* identity) {
    if (identity == nullptr) return false;
    if (psa_crypto_init() != PSA_SUCCESS) return false;
    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
    psa_set_key_bits(&attributes, 256);
    psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_HASH | PSA_KEY_USAGE_EXPORT);
    psa_set_key_algorithm(&attributes, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
    mbedtls_svc_key_id_t key_id = 0;
    const psa_status_t generated = psa_generate_key(&attributes, &key_id);
    psa_reset_key_attributes(&attributes);
    if (generated != PSA_SUCCESS) return false;

    mbedtls_pk_context key;
    mbedtls_pk_init(&key);
    int status = mbedtls_pk_wrap_psa(&key, key_id);
    std::array<unsigned char, 512> private_der{};
    std::array<unsigned char, 256> public_der{};
    int private_len = status == 0 ? mbedtls_pk_write_key_der(&key, private_der.data(), private_der.size()) : 0;
    int public_len = status == 0 ? mbedtls_pk_write_pubkey_der(&key, public_der.data(), public_der.size()) : 0;
    bool success = status == 0 && private_len >= 32 && private_len <= static_cast<int>(sizeof(identity->attestation_private_key)) &&
                   public_len >= 32 && public_len <= static_cast<int>(sizeof(identity->attestation_public_key));
    if (success) {
        std::memcpy(identity->attestation_private_key,
                    private_der.data() + private_der.size() - private_len, private_len);
        identity->attestation_private_key_len = static_cast<std::uint16_t>(private_len);
        std::memcpy(identity->attestation_public_key,
                    public_der.data() + public_der.size() - public_len, public_len);
        identity->attestation_public_key_len = static_cast<std::uint16_t>(public_len);
    }
    std::fill(private_der.begin(), private_der.end(), 0);
    mbedtls_pk_free(&key);
    psa_destroy_key(key_id);
    return success;
}

bool verify_server_signature(const std::string& payload_base64, const std::string& signature_text) {
    std::vector<std::uint8_t> key_der(512, 0);
    std::size_t key_len = 0;
    if (std::strlen(CONFIG_FARMOS_ENROLLMENT_SERVER_PUBLIC_KEY) == 0 ||
        !decode_base64url(CONFIG_FARMOS_ENROLLMENT_SERVER_PUBLIC_KEY,
                          std::strlen(CONFIG_FARMOS_ENROLLMENT_SERVER_PUBLIC_KEY),
                          key_der.data(), key_der.size(), &key_len)) return false;
    std::array<std::uint8_t, kMaxSignature> signature{};
    std::size_t signature_len = 0;
    if (!decode_base64url(signature_text.data(), signature_text.size(), signature.data(), signature.size(), &signature_len)) return false;
    std::vector<std::uint8_t> decoded_payload(kMaxPayload, 0);
    std::size_t decoded_length = 0;
    if (!decode_base64url(payload_base64.data(), payload_base64.size(), decoded_payload.data(), decoded_payload.size(), &decoded_length)) return false;
    std::array<std::uint8_t, 32> digest{};
    if (!sha256(decoded_payload.data(), decoded_length, &digest)) return false;
    mbedtls_pk_context public_key;
    mbedtls_pk_init(&public_key);
    const int parse_status = mbedtls_pk_parse_public_key(&public_key, key_der.data(), key_len);
    // The enrollment trust anchor is deliberately narrower than the generic
    // mbedTLS public-key parser. A production ticket must be issued by the
    // configured ECDSA P-256 server key; accepting RSA or another EC curve
    // here would silently weaken the ticket contract even though device
    // identity keys are always generated as P-256.
    //
    // Do not test this with a hard-coded PSA_ALG_ECDSA policy. Depending on the
    // mbedTLS configuration, an imported EC key can carry the equivalent
    // MBEDTLS_PK_ALG_ECDSA policy (deterministic ECDSA for signing), causing a
    // false rejection before verification. Instead, derive the parsed key's
    // attributes, enforce an EC public key with exactly 256 bits, and let
    // mbedtls_pk_verify() perform the authoritative ECDSA-SHA256 operation. It
    // also converts the DER ECDSA signature from Node.js to PSA's raw format.
    psa_key_attributes_t server_key_attributes = PSA_KEY_ATTRIBUTES_INIT;
    const int attributes_status = parse_status == 0
        ? mbedtls_pk_get_psa_attributes(&public_key,
                                        PSA_KEY_USAGE_VERIFY_HASH,
                                        &server_key_attributes)
        : MBEDTLS_ERR_PK_TYPE_MISMATCH;
    const psa_key_type_t server_key_type = psa_get_key_type(&server_key_attributes);
    const bool server_key_is_p256 = parse_status == 0 &&
                                    attributes_status == 0 &&
                                    PSA_KEY_TYPE_IS_ECC_PUBLIC_KEY(server_key_type) &&
                                    psa_get_key_bits(&server_key_attributes) == 256;
    const int verify_status = server_key_is_p256
        ? mbedtls_pk_verify(&public_key, MBEDTLS_MD_SHA256, digest.data(), digest.size(), signature.data(), signature_len)
        : MBEDTLS_ERR_PK_TYPE_MISMATCH;
    psa_reset_key_attributes(&server_key_attributes);
    mbedtls_pk_free(&public_key);
    std::fill(key_der.begin(), key_der.end(), 0);
    return verify_status == 0;
}

bool make_hardware_proof(const char* chip_family, const std::uint8_t mac[6],
                         const std::uint8_t* nonce, std::size_t nonce_len,
                         std::array<std::uint8_t, 32>* proof) {
    std::vector<std::uint8_t> transcript;
    append_string(&transcript, kHardwareDomain);
    append_string(&transcript, chip_family == nullptr ? "" : chip_family);
    append_bytes(&transcript, mac, 6);
    append_bytes(&transcript, nonce, nonce_len);
    return sha256(transcript.data(), transcript.size(), proof);
}

bool make_readback_transcript(const identity::Identity& identity, const std::string& challenge_id,
                              const std::array<std::uint8_t, 32>& hardware_proof,
                              const std::uint8_t* nonce, std::size_t nonce_len,
                              std::vector<std::uint8_t>* transcript) {
    if (transcript == nullptr) return false;
    transcript->clear();
    append_string(transcript, kReadbackDomain);
    append_string(transcript, identity.device_id);
    append_string(transcript, challenge_id);
    append_bytes(transcript, hardware_proof.data(), hardware_proof.size());
    append_bytes(transcript, nonce, nonce_len);
    append_u32(transcript, identity.key_generation);
    return transcript->size() <= kMaxPayload;
}

}  // namespace

SerialEnrollment::SerialEnrollment(const char* role, identity::Identity* identity,
                                   CommitCallback commit_callback)
    : role_(role), identity_(identity), commit_callback_(std::move(commit_callback)) {}

esp_err_t SerialEnrollment::begin() {
    if (role_ == nullptr || identity_ == nullptr || commit_callback_ == nullptr) return ESP_ERR_INVALID_ARG;
    active_ = true;
    // UART interrupt allocation and PSA crypto both require scheduler-backed
    // runtime services. Do not invoke either from app_main.
    return xTaskCreate(&SerialEnrollment::task_entry, "serial_enroll", 24576, this, 4, nullptr) == pdPASS
        ? ESP_OK : ESP_ERR_NO_MEM;
}

bool SerialEnrollment::prepare_session() {
    if (std::strcmp(role_, "NODE") != 0 && std::strcmp(role_, "GATEWAY") != 0) return false;
    // A stored device id is already an identity boundary even when an older
    // fixture is missing its attestation key.  Treating that case as a fresh
    // ENROLL would let a recovery overwrite the immutable id/QR with a
    // generation-one ticket.  Instead, preserve the fields and require the
    // signed physical recovery path to install a replacement key.
    has_identity_ = identity_->device_id[0] != '\0';
    pending_identity_ = *identity_;
    if (!has_identity_) {
        pending_identity_ = {};
        pending_identity_.identity_version = 3;
        pending_identity_.key_generation = 1;
        if (!generate_attestation_key(&pending_identity_)) return false;
    } else if (pending_identity_.key_generation == 0) {
        pending_identity_.key_generation = 1;
    }
    // A fresh HELLO has a fresh nonce, so any REFLASH ticket from an older
    // session is invalid anyway. Clear the in-memory duplicate guard here to
    // keep the guard scoped to one physical serial session.
    last_reflash_ticket_hash_.fill(0);
    last_reflash_ticket_hash_len_ = 0;
    const bool generated_recovery_key = has_identity_ && !identity::has_attestation_key(*identity_);
    if (generated_recovery_key && !generate_attestation_key(&pending_identity_)) return false;
    esp_fill_random(session_nonce_.data(), session_nonce_.size());
    session_nonce_len_ = session_nonce_.size();
    session_started_ms_ = static_cast<std::uint64_t>(esp_timer_get_time() / 1000);
    ticket_deadline_ms_ = session_started_ms_ + kMaxTicketTtlMs;

    esp_chip_info_t chip{};
    esp_chip_info(&chip);
    const char* family = chip.model == CHIP_ESP32S3 ? "ESP32-S3" : "ESP32";
    std::snprintf(chip_family_.data(), chip_family_.size(), "%s", family);
    std::uint8_t mac[6]{};
    if (esp_efuse_mac_get_default(mac) != ESP_OK) return false;
    std::snprintf(efuse_mac_.data(), efuse_mac_.size(), "%02x:%02x:%02x:%02x:%02x:%02x",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    if (!make_hardware_proof(chip_family_.data(), mac, session_nonce_.data(), session_nonce_len_, &hardware_proof_)) return false;
    hex_encode(hardware_proof_.data(), hardware_proof_.size(), hardware_proof_hex_.data(), hardware_proof_hex_.size());
    // Derive the HELLO fingerprint from the key actually offered by this
    // session.  Stored cert_fingerprint is metadata and must not be trusted to
    // bind a recovery ticket when a legacy fixture generated a replacement.
    std::array<std::uint8_t, 32> fingerprint{};
    if (!sha256(pending_identity_.attestation_public_key, pending_identity_.attestation_public_key_len, &fingerprint)) return false;
    hex_encode(fingerprint.data(), fingerprint.size(), current_key_fingerprint_.data(), current_key_fingerprint_.size());
    return true;
}

bool SerialEnrollment::generate_attestation_key(identity::Identity* identity) {
    return make_key(identity);
}

void SerialEnrollment::task_entry(void* arg) {
    static_cast<SerialEnrollment*>(arg)->task_loop();
}

void SerialEnrollment::task_loop() {
    const esp_err_t install = install_enrollment_transport();
    if (install != ESP_OK && install != ESP_ERR_INVALID_STATE) {
        std::fprintf(stderr, "[ENROLL] transport installation failed: %s\n", esp_err_to_name(install));
        active_ = false;
        vTaskDelete(nullptr);
        return;
    }
    if (!prepare_session()) {
        std::fprintf(stderr, "[ENROLL] cannot prepare physical enrollment session\n");
        active_ = false;
        vTaskDelete(nullptr);
        return;
    }
    send_hello();
    std::array<std::uint8_t, 256> buffer{};
    while (true) {
        const int length = read_enrollment_transport(buffer.data(), buffer.size());
        if (length > 0) consume_bytes(buffer.data(), static_cast<std::size_t>(length));
        if (parse_state_ != ParseState::kSync0 &&
            static_cast<std::uint64_t>(esp_timer_get_time() / 1000) > frame_started_ms_ + kFrameTimeoutMs) {
            reset_parser();
            send_error(ErrorCode::kTimeout, "serial frame timeout");
        }
        if (identity_committed_at_ms_ > 0 && !enrolled_ &&
            static_cast<std::uint64_t>(esp_timer_get_time() / 1000) > identity_committed_at_ms_ + 30'000) {
            enrolled_ = true;
        }
    }
}

void SerialEnrollment::reset_parser() {
    parse_state_ = ParseState::kSync0;
    header_length_ = 0;
    payload_length_ = 0;
    crc_length_ = 0;
}

void SerialEnrollment::handle_cli_command(const char* cmd) {
    if (cmd == nullptr || std::strlen(cmd) == 0) return;
    const char* id_str = (identity_ && std::strlen(identity_->device_id) > 0)
                             ? identity_->device_id
                             : "CHUA_ENROLL";
    const unsigned uptime_sec = static_cast<unsigned>(esp_timer_get_time() / 1000000);

    if (strcasecmp(cmd, "ping") == 0) {
        std::printf("\r\n[ESP32] PONG! Thiet bi dang hoat dong tot | id=%s | uptime=%u s\r\n", id_str, uptime_sec);
    } else if (strcasecmp(cmd, "status") == 0) {
        std::printf("\r\n[ESP32] STATUS: ACTIVE | role=%s | id=%s | uptime=%u s | heap=%u B\r\n",
                    role_ ? role_ : "UNKNOWN", id_str, uptime_sec,
                    static_cast<unsigned>(esp_get_free_heap_size()));
    } else {
        std::printf("\r\n[ESP32] PHAN HOI: Da nhan lenh \"%s\" | id=%s | status=OK\r\n", cmd, id_str);
    }
}

void SerialEnrollment::consume_bytes(const std::uint8_t* data, std::size_t length) {
    if (data == nullptr) return;
    for (std::size_t index = 0; index < length; ++index) {
        const std::uint8_t byte = data[index];
        if (parse_state_ == ParseState::kSync0) {
            if (byte == kSync0) {
                parse_state_ = ParseState::kSync1;
                frame_started_ms_ = static_cast<std::uint64_t>(esp_timer_get_time() / 1000);
                cli_idx_ = 0;
            } else if (byte == '\r' || byte == '\n') {
                if (cli_idx_ > 0) {
                    cli_buf_[cli_idx_] = '\0';
                    handle_cli_command(cli_buf_.data());
                    cli_idx_ = 0;
                }
            } else if (cli_idx_ < cli_buf_.size() - 1 && byte >= 32 && byte <= 126) {
                cli_buf_[cli_idx_++] = static_cast<char>(byte);
            }
            continue;
        }
        if (parse_state_ == ParseState::kSync1) {
            if (byte == kSync1) {
                parse_state_ = ParseState::kHeader;
                header_length_ = 0;
            } else if (byte != kSync0) {
                reset_parser();
            }
            continue;
        }
        if (parse_state_ == ParseState::kHeader) {
            header_[header_length_++] = byte;
            if (header_length_ != kHeaderLength) continue;
            const std::uint16_t declared_length = static_cast<std::uint16_t>(header_[2] << 8U | header_[3]);
            if (header_[0] != kProtocolVersion || declared_length > kMaxPayload) {
                reset_parser();
                send_error(ErrorCode::kBadFrame, "invalid frame header");
                continue;
            }
            payload_length_ = declared_length;
            rx_sequence_ = static_cast<std::uint32_t>(header_[4]) << 24U |
                           static_cast<std::uint32_t>(header_[5]) << 16U |
                           static_cast<std::uint32_t>(header_[6]) << 8U |
                           static_cast<std::uint32_t>(header_[7]);
            parse_state_ = payload_length_ == 0 ? ParseState::kCrc : ParseState::kPayload;
            crc_length_ = 0;
            continue;
        }
        if (parse_state_ == ParseState::kPayload) {
            // The payload cursor is kept in header_length_ once the header is
            // complete, avoiding another unbounded integer in the parser.
            const std::size_t cursor = header_length_ - kHeaderLength;
            payload_[cursor] = byte;
            header_length_++;
            if (cursor + 1 >= payload_length_) parse_state_ = ParseState::kCrc;
            continue;
        }
        crc_[crc_length_++] = byte;
        if (crc_length_ < crc_.size()) continue;
        std::uint32_t crc_calc = crc32_update(0xFFFFFFFFU, header_.data(), kHeaderLength);
        if (payload_length_ > 0) crc_calc = crc32_update(crc_calc, payload_.data(), payload_length_);
        const std::uint32_t expected = ~crc_calc;
        const std::uint32_t supplied = static_cast<std::uint32_t>(crc_[0]) << 24U |
                                        static_cast<std::uint32_t>(crc_[1]) << 16U |
                                        static_cast<std::uint32_t>(crc_[2]) << 8U |
                                        static_cast<std::uint32_t>(crc_[3]);
        const FrameType type = static_cast<FrameType>(header_[1]);
        const std::uint32_t sequence = rx_sequence_;
        const bool valid = expected == supplied;
        if (valid) handle_frame(type, sequence, payload_.data(), payload_length_);
        else send_error(ErrorCode::kBadFrame, "frame checksum mismatch");
        reset_parser();
    }
}

bool SerialEnrollment::send_json(FrameType type, const std::string& json) {
    if (json.empty() || json.size() > kMaxPayload) return false;
    std::array<std::uint8_t, kHeaderLength> header{};
    header[0] = kProtocolVersion;
    header[1] = static_cast<std::uint8_t>(type);
    header[2] = static_cast<std::uint8_t>((json.size() >> 8U) & 0xffU);
    header[3] = static_cast<std::uint8_t>(json.size() & 0xffU);
    const std::uint32_t sequence = sequence_++;
    header[4] = static_cast<std::uint8_t>((sequence >> 24U) & 0xffU);
    header[5] = static_cast<std::uint8_t>((sequence >> 16U) & 0xffU);
    header[6] = static_cast<std::uint8_t>((sequence >> 8U) & 0xffU);
    header[7] = static_cast<std::uint8_t>(sequence & 0xffU);
    std::uint32_t crc_calc = crc32_update(0xFFFFFFFFU, header.data(), header.size());
    crc_calc = crc32_update(crc_calc, reinterpret_cast<const std::uint8_t*>(json.data()), json.size());
    const std::uint32_t checksum = ~crc_calc;
    std::array<std::uint8_t, 4> crc_bytes{
        static_cast<std::uint8_t>((checksum >> 24U) & 0xffU), static_cast<std::uint8_t>((checksum >> 16U) & 0xffU),
        static_cast<std::uint8_t>((checksum >> 8U) & 0xffU), static_cast<std::uint8_t>(checksum & 0xffU)};
    // Submit a complete frame in one write so console messages cannot be
    // inserted between the sync/header/payload/checksum writes.
    std::vector<std::uint8_t> frame;
    frame.reserve(2 + header.size() + json.size() + crc_bytes.size());
    frame.push_back(kSync0);
    frame.push_back(kSync1);
    frame.insert(frame.end(), header.begin(), header.end());
    frame.insert(frame.end(), json.begin(), json.end());
    frame.insert(frame.end(), crc_bytes.begin(), crc_bytes.end());
    // USB console and enrollment share a physical transport. Hold the stdio
    // lock until the queued frame drains, so printf cannot split its payload.
    flockfile(stdout);
    std::fflush(stdout);
    const bool written = write_enrollment_transport(frame.data(), frame.size()) == static_cast<int>(frame.size());
    flush_enrollment_transport(1000);
    funlockfile(stdout);
    return written;
}

void SerialEnrollment::send_error(ErrorCode code, const char* message) {
    cJSON* root = cJSON_CreateObject();
    if (root == nullptr) return;
    cJSON_AddStringToObject(root, "op", "ERROR");
    cJSON_AddNumberToObject(root, "code", static_cast<double>(code));
    cJSON_AddStringToObject(root, "message", message == nullptr ? "error" : message);
    char* rendered = cJSON_PrintUnformatted(root);
    if (rendered != nullptr) {
        send_json(FrameType::kError, rendered);
        cJSON_free(rendered);
    }
    cJSON_Delete(root);
}

void SerialEnrollment::send_progress(const char* stage, std::uint8_t percent) {
    cJSON* root = cJSON_CreateObject();
    if (root == nullptr) return;
    cJSON_AddStringToObject(root, "op", "PROGRESS");
    cJSON_AddStringToObject(root, "stage", stage == nullptr ? "UNKNOWN" : stage);
    cJSON_AddNumberToObject(root, "percent", percent);
    char* rendered = cJSON_PrintUnformatted(root);
    if (rendered != nullptr) {
        send_json(FrameType::kProgress, rendered);
        cJSON_free(rendered);
    }
    cJSON_Delete(root);
}

void SerialEnrollment::send_hello() {
    cJSON* root = cJSON_CreateObject();
    if (root == nullptr) return;
    const std::string nonce = encode_base64url(session_nonce_.data(), session_nonce_len_);
    const std::string public_key = identity::public_key_base64(pending_identity_);
    const esp_partition_t* running_partition = esp_ota_get_running_partition();
    cJSON_AddStringToObject(root, "op", "HELLO");
    cJSON_AddNumberToObject(root, "protocolVersion", kProtocolVersion);
    cJSON_AddStringToObject(root, "role", role_);
    cJSON_AddStringToObject(root, "chipFamily", chip_family_.data());
    cJSON_AddStringToObject(root, "efuseMac", efuse_mac_.data());
    cJSON_AddStringToObject(root, "hardwareProof", hardware_proof_hex_.data());
    cJSON_AddStringToObject(root, "nonce", nonce.c_str());
    cJSON_AddNumberToObject(root, "identityVersion", pending_identity_.identity_version);
    cJSON_AddNumberToObject(root, "keyGeneration", pending_identity_.key_generation);
    cJSON_AddStringToObject(root, "attestationPublicKey", public_key.c_str());
    cJSON_AddStringToObject(root, "publicKeyFingerprint", current_key_fingerprint_.data());
    cJSON_AddBoolToObject(root, "identityPresent", has_identity_);
    cJSON_AddStringToObject(root, "runningPartition",
                            running_partition == nullptr ? "" : running_partition->label);
    cJSON_AddNumberToObject(root, "runningPartitionAddress",
                            running_partition == nullptr ? 0 : running_partition->address);
    cJSON_AddStringToObject(root, "readbackPartition", kReadbackPartition);
    cJSON_AddNumberToObject(root, "readbackAddress", kReadbackPartitionAddress);
    cJSON_AddBoolToObject(root, "readbackTargetReady", running_partition_is_readback_target());
    cJSON* capabilities = cJSON_AddArrayToObject(root, "capabilities");
    cJSON_AddItemToArray(capabilities, cJSON_CreateString("SERIAL_ENROLLMENT"));
    cJSON_AddItemToArray(capabilities, cJSON_CreateString("ECDSA_P256_ATTESTATION"));
    cJSON_AddItemToArray(capabilities, cJSON_CreateString(std::strcmp(role_, "NODE") == 0 ? "LORA" : "GATEWAY"));
    char* rendered = cJSON_PrintUnformatted(root);
    if (rendered != nullptr) {
        send_json(FrameType::kHello, rendered);
        cJSON_free(rendered);
    }
    cJSON_Delete(root);
}

void SerialEnrollment::handle_frame(FrameType type, std::uint32_t sequence,
                                    const std::uint8_t* payload, std::size_t length) {
    if (sequence == 0 || (last_rx_sequence_ != 0 && sequence <= last_rx_sequence_)) {
        send_error(ErrorCode::kTicketReplay, "command sequence replay");
        return;
    }
    last_rx_sequence_ = sequence;
    if (payload == nullptr || length == 0 || length > kMaxPayload) {
        send_error(ErrorCode::kBadJson, "empty or oversized JSON payload");
        return;
    }
    const std::string json(reinterpret_cast<const char*>(payload), length);
    if (type == FrameType::kHelloRequest) {
        // A browser may reconnect after the previous bounded session expired.
        // Rebuild the nonce/proof (and a recovery key for a legacy identity)
        // instead of replaying an already-expired HELLO transcript.
        if (!prepare_session()) {
            send_error(ErrorCode::kCommitFailed, "cannot create a fresh enrollment session");
            return;
        }
        send_hello();
        return;
    }
    if (type == FrameType::kEnrollmentTicket) {
        if (static_cast<std::uint64_t>(esp_timer_get_time() / 1000) > ticket_deadline_ms_) {
            send_error(ErrorCode::kTimeout, "enrollment session expired; request HELLO again");
            return;
        }
        identity::Identity candidate = pending_identity_;
        std::array<std::uint8_t, 32> ticket_hash{};
        bool rotation = false;
        bool reflash = false;
        send_progress("VERIFY_TICKET", 25);
        if (!verify_ticket(json, &candidate, &ticket_hash, &rotation, &reflash)) return;
        send_progress(reflash ? "AUTHORIZE_REFLASH" : "COMMIT_IDENTITY", 70);
        if (!reflash) {
            const esp_err_t committed = commit_callback_(candidate, ticket_hash.data(), ticket_hash.size());
            if (committed != ESP_OK) {
                send_error(ErrorCode::kCommitFailed, esp_err_to_name(committed));
                return;
            }
            pending_identity_ = candidate;
            *identity_ = candidate;
            has_identity_ = true;
            current_key_fingerprint_.fill(0);
            std::snprintf(current_key_fingerprint_.data(), current_key_fingerprint_.size(), "%s", candidate.cert_fingerprint);
        } else {
            // A normal reflash must never rewrite factory_cfg, rotate the
            // attestation key, or advance the identity generation. The
            // signed ticket only authorizes this firmware/readback session;
            // backend completion remains the source of FlashJob truth.
            has_identity_ = true;
        }
        cJSON* response = cJSON_CreateObject();
        if (response != nullptr) {
            cJSON_AddStringToObject(response, "op", "ENROLLMENT_COMMITTED");
            cJSON_AddStringToObject(response, "operation", reflash ? "REFLASH" : (rotation ? "ROTATE_KEY" : "ENROLL"));
            cJSON_AddStringToObject(response, "deviceId", candidate.device_id);
            cJSON_AddNumberToObject(response, "keyGeneration", candidate.key_generation);
            cJSON_AddStringToObject(response, "publicKeyFingerprint", candidate.cert_fingerprint);
            cJSON_AddBoolToObject(response, "keyRotated", rotation);
            cJSON_AddBoolToObject(response, "identityPreserved", reflash);
            char* rendered = cJSON_PrintUnformatted(response);
            if (rendered != nullptr) {
                send_json(FrameType::kResponse, rendered);
                cJSON_free(rendered);
            }
            cJSON_Delete(response);
        }
        send_progress("READY_FOR_READBACK", 100);
        flush_enrollment_transport(500);
        identity_committed_at_ms_ = static_cast<std::uint64_t>(esp_timer_get_time() / 1000);
        return;
    }
    if (type == FrameType::kReadbackChallenge) {
        handle_readback(json);
        return;
    }
    send_error(ErrorCode::kUnsupported, "unsupported serial enrollment frame");
}

bool SerialEnrollment::verify_ticket(const std::string& outer_json,
                                     identity::Identity* candidate,
                                     std::array<std::uint8_t, 32>* ticket_hash,
                                     bool* committed_rotation,
                                     bool* reflash_authorized) {
    if (reflash_authorized != nullptr) *reflash_authorized = false;
    cJSON* outer = cJSON_ParseWithLength(outer_json.data(), outer_json.size());
    if (outer == nullptr) {
        send_error(ErrorCode::kBadJson, "ticket envelope is not JSON");
        return false;
    }
    std::string payload_text;
    std::string signature_text;
    bool ok = string_value(outer, "payload", &payload_text, 2200) &&
              string_value(outer, "signature", &signature_text, 240);
    if (!ok || !verify_server_signature(payload_text, signature_text)) {
        cJSON_Delete(outer);
        send_error(ErrorCode::kTicketInvalid, "server ticket signature invalid");
        return false;
    }
    std::vector<std::uint8_t> decoded_payload(kMaxPayload, 0);
    std::size_t decoded_length = 0;
    if (!decode_base64url(payload_text.data(), payload_text.size(), decoded_payload.data(), decoded_payload.size(), &decoded_length)) {
        cJSON_Delete(outer);
        send_error(ErrorCode::kTicketInvalid, "ticket payload encoding invalid");
        return false;
    }
    const std::string payload(reinterpret_cast<const char*>(decoded_payload.data()), decoded_length);
    cJSON* ticket = cJSON_ParseWithLength(payload.data(), payload.size());
    if (ticket == nullptr) {
        cJSON_Delete(outer);
        send_error(ErrorCode::kTicketInvalid, "ticket payload is not JSON");
        return false;
    }
    if (!sha256(reinterpret_cast<const std::uint8_t*>(payload.data()), payload.size(), ticket_hash)) {
        cJSON_Delete(ticket); cJSON_Delete(outer);
        send_error(ErrorCode::kTicketInvalid, "ticket digest failed");
        return false;
    }
    std::string op, role, ticket_id, nonce, proof;
    std::uint32_t protocol = 0, generation = 0, identity_version = 0, ttl_ms = 0;
    bool physical_serial = false;
    ok = u32_value(ticket, "protocolVersion", &protocol) && protocol == kProtocolVersion &&
         string_value(ticket, "operation", &op, 16) && safe_identifier(op, 16) &&
         string_value(ticket, "ticketId", &ticket_id, 96) && safe_identifier(ticket_id, 96) &&
         string_value(ticket, "role", &role, 16) && role == role_ &&
         string_value(ticket, "nonce", &nonce, 128) &&
         string_value(ticket, "hardwareProof", &proof, 64) && proof == hardware_proof_hex_.data() &&
         u32_value(ticket, "ttlMs", &ttl_ms) && ttl_ms > 0 && ttl_ms <= kMaxTicketTtlMs &&
         u32_value(ticket, "generation", &generation) && generation > 0 &&
         u32_value(ticket, "identityVersion", &identity_version) && identity_version >= 3 &&
         bool_value(ticket, "physicalSerial", &physical_serial);
    const std::string expected_nonce = encode_base64url(session_nonce_.data(), session_nonce_len_);
    if (ok && nonce != expected_nonce) ok = false;
    if (ok && ticket_hash->size() == pending_identity_.last_ticket_hash_len &&
        pending_identity_.last_ticket_hash_len == 32 &&
        std::memcmp(ticket_hash->data(), pending_identity_.last_ticket_hash, 32) == 0) {
        cJSON_Delete(ticket); cJSON_Delete(outer);
        send_error(ErrorCode::kTicketReplay, "ticket was already committed");
        return false;
    }
    if (ok) {
        const std::uint64_t now = static_cast<std::uint64_t>(esp_timer_get_time() / 1000);
        ticket_deadline_ms_ = now + ttl_ms;
        const std::time_t wall = std::time(nullptr);
        const cJSON* expires_at = cJSON_GetObjectItemCaseSensitive(ticket, "expiresAt");
        if (cJSON_IsNumber(expires_at) && wall > 1'700'000'000 && expires_at->valuedouble <= static_cast<double>(wall)) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kTicketExpired, "server ticket expired");
            return false;
        }
    }
    if (!ok) {
        cJSON_Delete(ticket); cJSON_Delete(outer);
        send_error(ErrorCode::kTicketInvalid, "ticket fields do not match this physical session");
        return false;
    }
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
    const bool rotation = has_identity_ && op != "ENROLL";
#else
    const bool rotation = has_identity_;
#endif
    if (has_identity_ && op == "REFLASH") {
        // Normal reflash is intentionally not an enrollment or key-rotation
        // operation. It is valid only for an already complete identity and
        // the exact key/generation that was advertised in HELLO. In
        // particular, do not accept the generated recovery key held in
        // pending_identity_ when the stored identity has no usable key.
        if (!physical_serial || !identity::has_attestation_key(*identity_) ||
            !identity::has_attestation_key(pending_identity_) ||
            pending_identity_.key_generation == 0 ||
            generation != pending_identity_.key_generation ||
            identity_version != pending_identity_.identity_version ||
            std::strcmp(pending_identity_.cert_fingerprint, current_key_fingerprint_.data()) != 0) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kIdentityInvalid, "REFLASH requires the current valid identity generation and key");
            return false;
        }

        std::string public_fingerprint;
        std::string current_fingerprint;
        if (!string_value(ticket, "publicKeyFingerprint", &public_fingerprint, 64) ||
            !lower_hex_digest(public_fingerprint) ||
            public_fingerprint != current_key_fingerprint_.data() ||
            !string_value(ticket, "currentPublicKeyFingerprint", &current_fingerprint, 64) ||
            !lower_hex_digest(current_fingerprint) ||
            current_fingerprint != current_key_fingerprint_.data()) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kHardwareMismatch, "REFLASH does not bind the current device key");
            return false;
        }

        auto matches_identity_field = [&](const char* key, const char* expected, std::size_t maximum) {
            std::string supplied;
            return expected != nullptr && expected[0] != '\0' &&
                   string_value(ticket, key, &supplied, maximum) && supplied == expected;
        };
        if (!matches_identity_field("deviceId", pending_identity_.device_id, sizeof(pending_identity_.device_id) - 1) ||
            !matches_identity_field("serial", pending_identity_.serial, sizeof(pending_identity_.serial) - 1) ||
            !matches_identity_field("model", pending_identity_.model, sizeof(pending_identity_.model) - 1) ||
            !matches_identity_field("hardwareRevision", pending_identity_.hardware_revision, sizeof(pending_identity_.hardware_revision) - 1) ||
            !matches_identity_field("firmwareTarget", pending_identity_.firmware_target, sizeof(pending_identity_.firmware_target) - 1) ||
            !firmware_target_requires_p256(pending_identity_.firmware_target)) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kIdentityInvalid, "REFLASH identity fields do not match the stored board");
            return false;
        }

        if (std::strcmp(role_, "NODE") == 0) {
            std::uint32_t radio_id = 0;
            if (!u32_value(ticket, "radioId", &radio_id) || radio_id != pending_identity_.radio_id ||
                !identity::valid_node_device_id(pending_identity_.device_id, pending_identity_.radio_id)) {
                cJSON_Delete(ticket); cJSON_Delete(outer);
                send_error(ErrorCode::kIdentityInvalid, "REFLASH Node identity must use the current numeric radio id");
                return false;
            }
        } else if (!identity::valid_gateway_device_id(pending_identity_.device_id)) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kIdentityInvalid, "REFLASH Gateway identity must use the current numeric id");
            return false;
        }

        if (last_reflash_ticket_hash_len_ == 32 && ticket_hash != nullptr &&
            std::memcmp(last_reflash_ticket_hash_.data(), ticket_hash->data(), 32) == 0) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kTicketReplay, "REFLASH ticket was already authorized in this serial session");
            return false;
        }
        if (ticket_hash == nullptr) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kTicketInvalid, "REFLASH ticket digest is missing");
            return false;
        }

        // Keep the replay marker volatile. Persisting it through the factory
        // identity callback would turn a firmware authorization into an
        // identity write and would make a crash between flash and backend
        // completion indistinguishable from a new generation.
        std::copy(ticket_hash->begin(), ticket_hash->end(), last_reflash_ticket_hash_.begin());
        last_reflash_ticket_hash_len_ = ticket_hash->size();
        *candidate = pending_identity_;
        if (committed_rotation != nullptr) *committed_rotation = false;
        if (reflash_authorized != nullptr) *reflash_authorized = true;
        cJSON_Delete(ticket);
        cJSON_Delete(outer);
        return true;
    }
    if (!rotation && (op != "ENROLL" || generation != 1)) {
        cJSON_Delete(ticket); cJSON_Delete(outer);
        send_error(ErrorCode::kIdentityInvalid, "first enrollment requires generation one");
        return false;
    }
    if (rotation && ((op != "ROTATE_KEY" && op != "RECOVER") || !physical_serial ||
                     generation <= std::max<std::uint32_t>(1, pending_identity_.key_generation))) {
        cJSON_Delete(ticket); cJSON_Delete(outer);
        send_error(ErrorCode::kIdentityInvalid, "rotation requires a newer generation and physical serial");
        return false;
    }
    if (rotation) {
        std::string current_fingerprint;
        if (!string_value(ticket, "currentPublicKeyFingerprint", &current_fingerprint, 64) ||
            current_fingerprint != current_key_fingerprint_.data()) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kHardwareMismatch, "rotation does not bind the current device key");
            return false;
        }
        *candidate = pending_identity_;
        if (!generate_attestation_key(candidate)) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kCommitFailed, "cannot generate replacement P-256 key");
            return false;
        }
    } else {
        std::string expected_fingerprint;
        if (!string_value(ticket, "publicKeyFingerprint", &expected_fingerprint, 64) ||
            expected_fingerprint != current_key_fingerprint_.data()) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kHardwareMismatch, "ticket public key does not match HELLO");
            return false;
        }
        *candidate = pending_identity_;
    }
    auto copy_field = [&](const char* key, char* destination, std::size_t capacity, bool required) {
        std::string value;
        if (!string_value(ticket, key, &value, capacity - 1, required)) return false;
        if (!value.empty()) std::snprintf(destination, capacity, "%s", value.c_str());
        return true;
    };
    std::string device_id;
    std::string serial;
    if (!copy_field("deviceId", candidate->device_id, sizeof(candidate->device_id), true) ||
        !copy_field("serial", candidate->serial, sizeof(candidate->serial), true) ||
        !copy_field("model", candidate->model, sizeof(candidate->model), true) ||
        !copy_field("hardwareRevision", candidate->hardware_revision, sizeof(candidate->hardware_revision), true) ||
        !copy_field("firmwareTarget", candidate->firmware_target, sizeof(candidate->firmware_target), true)) {
        cJSON_Delete(ticket); cJSON_Delete(outer);
        send_error(ErrorCode::kIdentityInvalid, "ticket identity fields are incomplete");
        return false;
    }
    if (!firmware_target_requires_p256(candidate->firmware_target)) {
        cJSON_Delete(ticket); cJSON_Delete(outer);
        send_error(ErrorCode::kIdentityInvalid, "firmware target does not permit ECDSA P-256");
        return false;
    }
    if (rotation && std::strcmp(candidate->device_id, pending_identity_.device_id) != 0) {
        cJSON_Delete(ticket); cJSON_Delete(outer);
        send_error(ErrorCode::kIdentityInvalid, "recovery cannot change device identity");
        return false;
    }
    candidate->identity_version = identity_version;
    candidate->key_generation = generation;
    std::memset(candidate->cert_fingerprint, 0, sizeof(candidate->cert_fingerprint));
    std::array<std::uint8_t, 32> fingerprint{};
    if (!sha256(candidate->attestation_public_key, candidate->attestation_public_key_len, &fingerprint)) {
        cJSON_Delete(ticket); cJSON_Delete(outer);
        send_error(ErrorCode::kIdentityInvalid, "public key fingerprint failed");
        return false;
    }
    hex_encode(fingerprint.data(), fingerprint.size(), candidate->cert_fingerprint, sizeof(candidate->cert_fingerprint));
    if (std::strcmp(role_, "NODE") == 0) {
        std::uint32_t radio_id = 0;
        if (!u32_value(ticket, "radioId", &radio_id) || !identity::valid_node_device_id(candidate->device_id, radio_id)) {
            cJSON_Delete(ticket); cJSON_Delete(outer);
            send_error(ErrorCode::kIdentityInvalid, "Node identity must use NODE_<numeric radio id>");
            return false;
        }
        candidate->radio_id = radio_id;
    } else if (!identity::valid_gateway_device_id(candidate->device_id)) {
        cJSON_Delete(ticket); cJSON_Delete(outer);
        send_error(ErrorCode::kIdentityInvalid, "Gateway identity must use GATEWAY_<numeric id>");
        return false;
    }
    candidate->last_ticket_hash_len = 32;
    std::memcpy(candidate->last_ticket_hash, ticket_hash->data(), ticket_hash->size());
    if (committed_rotation != nullptr) *committed_rotation = rotation;
    cJSON_Delete(ticket);
    cJSON_Delete(outer);
    return true;
}

bool SerialEnrollment::handle_readback(const std::string& json) {
    if (!has_identity_ || !identity::has_attestation_key(*identity_)) {
        send_error(ErrorCode::kIdentityInvalid, "enroll identity before readback");
        return false;
    }
    cJSON* root = cJSON_ParseWithLength(json.data(), json.size());
    if (root == nullptr) {
        send_error(ErrorCode::kBadJson, "readback challenge is not JSON");
        return false;
    }
    std::string operation, challenge_id, nonce_text;
    bool ok = string_value(root, "op", &operation, 32) && operation == "READBACK_CHALLENGE" &&
              string_value(root, "challengeId", &challenge_id, 96) && safe_identifier(challenge_id, 96) &&
              string_value(root, "nonce", &nonce_text, 128);
    std::array<std::uint8_t, 64> nonce{};
    std::size_t nonce_len = 0;
    if (ok) ok = decode_base64url(nonce_text.data(), nonce_text.size(), nonce.data(), nonce.size(), &nonce_len) &&
                 nonce_len >= 16 && nonce_len <= 32;
    std::vector<std::uint8_t> transcript;
    if (ok) ok = make_readback_transcript(*identity_, challenge_id, hardware_proof_, nonce.data(), nonce_len, &transcript);
    std::array<std::uint8_t, kMaxSignature> signature{};
    std::size_t signature_len = 0;
    if (ok) ok = sign_attestation_message(*identity_, transcript.data(), transcript.size(), signature.data(), signature.size(), &signature_len);

    // The backend flash completion route verifies a second, intentionally
    // boring JSON transcript.  Keep the enrollment readback proof above for
    // the browser protocol, while accepting an optional nested object that
    // lets the same response complete an existing FlashJob without making the
    // browser reconstruct JSON key ordering or sign with a private key.
    std::string flash_message;
    std::array<std::uint8_t, kMaxSignature> flash_signature{};
    std::size_t flash_signature_len = 0;
    std::uint32_t flash_readback_length = 0;
    const cJSON* flash = cJSON_GetObjectItemCaseSensitive(root, "flashAttestation");
    if (ok && flash != nullptr) {
        // The signed release plan writes ota_0 first and commits
        // ota_data_initial last.  A post-flash attestation is accepted only
        // after that commit selected the exact partition whose APP image the
        // manifest hashes; otherwise a board still booting ota_1 could attest
        // an older image while the browser reports the new ota_0 bytes.
        if (!running_partition_is_readback_target()) {
            cJSON_Delete(root);
            send_error(ErrorCode::kChallengeInvalid,
                       "web-flash readback requires running ota_0");
            return false;
        }
        std::string board_id;
        std::string job_id;
        std::string release_id;
        std::string manifest_sha256;
        std::string readback_sha256;
        std::string challenge;
        std::uint32_t readback_length = 0;
        ok = cJSON_IsObject(flash) &&
             string_value(flash, "boardId", &board_id, 128) && safe_identifier(board_id, 128) &&
             string_value(flash, "jobId", &job_id, 128) && safe_identifier(job_id, 128) &&
             string_value(flash, "releaseId", &release_id, 128) && safe_identifier(release_id, 128) &&
             string_value(flash, "manifestSha256", &manifest_sha256, 64) && lower_hex_digest(manifest_sha256) &&
             string_value(flash, "readbackSha256", &readback_sha256, 64) && lower_hex_digest(readback_sha256) &&
             string_value(flash, "challenge", &challenge, 512) && safe_identifier(challenge, 512) &&
             u32_value(flash, "readbackLength", &readback_length) && readback_length > 0;
        if (ok) {
            flash_readback_length = readback_length;
            std::array<std::uint8_t, 32> actual_readback{};
            char actual_readback_hex[65]{};
            ok = hash_running_image_prefix(readback_length, &actual_readback);
            if (ok) {
                hex_encode(actual_readback.data(), actual_readback.size(), actual_readback_hex, sizeof(actual_readback_hex));
                ok = readback_sha256 == actual_readback_hex;
            }
        }
        if (ok) {
            cJSON* message = cJSON_CreateObject();
            if (message == nullptr ||
                !cJSON_AddNumberToObject(message, "v", 1) ||
                !cJSON_AddStringToObject(message, "domain", "farmos-web-serial-flash-attestation") ||
                !cJSON_AddStringToObject(message, "boardId", board_id.c_str()) ||
                !cJSON_AddStringToObject(message, "jobId", job_id.c_str()) ||
                !cJSON_AddStringToObject(message, "releaseId", release_id.c_str()) ||
                !cJSON_AddStringToObject(message, "manifestSha256", manifest_sha256.c_str()) ||
                !cJSON_AddStringToObject(message, "readbackSha256", readback_sha256.c_str()) ||
                !cJSON_AddStringToObject(message, "challenge", challenge.c_str())) {
                if (message != nullptr) cJSON_Delete(message);
                ok = false;
            } else {
                char* rendered = cJSON_PrintUnformatted(message);
                if (rendered == nullptr) {
                    ok = false;
                } else {
                    flash_message = rendered;
                    cJSON_free(rendered);
                    ok = sign_attestation_message(*identity_,
                                                   reinterpret_cast<const std::uint8_t*>(flash_message.data()),
                                                   flash_message.size(), flash_signature.data(),
                                                   flash_signature.size(), &flash_signature_len);
                }
                cJSON_Delete(message);
            }
        }
    }
    cJSON_Delete(root);
    if (!ok) {
        send_error(ErrorCode::kChallengeInvalid, "cannot sign readback challenge");
        return false;
    }
    cJSON* response = cJSON_CreateObject();
    if (response == nullptr) return false;
    const std::string signature_text = encode_base64url(signature.data(), signature_len);
    const std::string public_key = identity::public_key_base64(*identity_);
    cJSON_AddStringToObject(response, "op", "READBACK_RESPONSE");
    cJSON_AddStringToObject(response, "challengeId", challenge_id.c_str());
    cJSON_AddStringToObject(response, "nonce", nonce_text.c_str());
    cJSON_AddStringToObject(response, "deviceId", identity_->device_id);
    cJSON_AddStringToObject(response, "hardwareProof", hardware_proof_hex_.data());
    cJSON_AddNumberToObject(response, "keyGeneration", identity_->key_generation);
    cJSON_AddStringToObject(response, "publicKeyFingerprint", identity_->cert_fingerprint);
    cJSON_AddStringToObject(response, "attestationPublicKey", public_key.c_str());
    cJSON_AddStringToObject(response, "signatureFormat", "ecdsa-p256-sha256-der-base64url");
    cJSON_AddStringToObject(response, "signature", signature_text.c_str());
    if (!flash_message.empty() && flash_signature_len > 0) {
        const std::string flash_signature_text = encode_base64url(flash_signature.data(), flash_signature_len);
        cJSON_AddStringToObject(response, "flashAttestationMessage", flash_message.c_str());
        cJSON_AddStringToObject(response, "flashAttestationSignature", flash_signature_text.c_str());
        cJSON_AddStringToObject(response, "readbackPartition", kReadbackPartition);
        cJSON_AddNumberToObject(response, "readbackAddress", kReadbackPartitionAddress);
        cJSON_AddNumberToObject(response, "readbackLength", flash_readback_length);
    }
    char* rendered = cJSON_PrintUnformatted(response);
    if (rendered != nullptr && std::strlen(rendered) <= kMaxPayload) {
        send_json(FrameType::kResponse, rendered);
    } else if (rendered == nullptr || std::strlen(rendered) > kMaxPayload) {
        if (rendered != nullptr) cJSON_free(rendered);
        cJSON_Delete(response);
        send_error(ErrorCode::kBadJson, "readback response exceeds protocol bound");
        return false;
    }
    if (rendered != nullptr) {
        cJSON_free(rendered);
    }
    cJSON_Delete(response);
    flush_enrollment_transport(1000);
    enrolled_ = true;
    return true;
}

}  // namespace farmos::enrollment
