#include "device_identity.h"

#include <cctype>
#include <cstdio>
#include <cstring>

#include "mbedtls/base64.h"
#include "nvs.h"
#include "nvs_flash.h"

#if !defined(CONFIG_FARMOS_DEVELOPMENT_IDENTITY) && !defined(CONFIG_FARMOS_FACTORY_PLAIN_FLASH) && !defined(CONFIG_NVS_ENCRYPTION)
#error "Manufactured FarmOS builds require NVS encryption"
#endif

namespace farmos::identity {
namespace {

constexpr std::uint32_t kFactoryIdentityVersion = 3;
constexpr char kIdentityVersionKey[] = "id_ver";
constexpr char kKeyGenerationKey[] = "key_gen";
constexpr char kHardwareRevisionKey[] = "hw_rev";
constexpr char kFirmwareTargetKey[] = "fw_target";
constexpr char kCertFingerprintKey[] = "cert_fp";
constexpr char kAttestationPublicKey[] = "att_pub_key";
constexpr char kAttestationPrivateKey[] = "att_priv_key";
constexpr char kLastTicketHashKey[] = "last_tkt_hash";

static_assert(sizeof(kIdentityVersionKey) <= NVS_KEY_NAME_MAX_SIZE &&
              sizeof(kKeyGenerationKey) <= NVS_KEY_NAME_MAX_SIZE &&
              sizeof(kHardwareRevisionKey) <= NVS_KEY_NAME_MAX_SIZE &&
              sizeof(kFirmwareTargetKey) <= NVS_KEY_NAME_MAX_SIZE &&
              sizeof(kCertFingerprintKey) <= NVS_KEY_NAME_MAX_SIZE &&
              sizeof(kAttestationPublicKey) <= NVS_KEY_NAME_MAX_SIZE &&
              sizeof(kAttestationPrivateKey) <= NVS_KEY_NAME_MAX_SIZE &&
              sizeof(kLastTicketHashKey) <= NVS_KEY_NAME_MAX_SIZE,
              "Factory identity NVS keys must fit ESP-IDF's 15-character limit");

bool read_string(nvs_handle_t handle, const char* key, char* value, std::size_t capacity) {
    if (value == nullptr || capacity == 0) return false;
    std::size_t size = capacity;
    return nvs_get_str(handle, key, value, &size) == ESP_OK && value[0] != '\0';
}

bool read_blob(nvs_handle_t handle, const char* key, std::uint8_t* value,
               std::size_t capacity, std::uint16_t* length) {
    if (value == nullptr || length == nullptr || capacity == 0) return false;
    std::size_t size = capacity;
    const esp_err_t error = nvs_get_blob(handle, key, value, &size);
    if (error != ESP_OK || size == 0 || size > capacity) return false;
    *length = static_cast<std::uint16_t>(size);
    return true;
}

bool decimal_radio_suffix(const char* suffix, std::uint32_t* value) {
    if (suffix == nullptr || *suffix == '\0' || value == nullptr) return false;
    std::uint32_t parsed = 0;
    for (const unsigned char* cursor = reinterpret_cast<const unsigned char*>(suffix);
         *cursor != '\0'; ++cursor) {
        if (!std::isdigit(*cursor)) return false;
        const std::uint32_t digit = static_cast<std::uint32_t>(*cursor - '0');
        if (parsed > (UINT32_MAX - digit) / 10U) return false;
        parsed = parsed * 10U + digit;
    }
    if (parsed == 0) return false;
    *value = static_cast<std::uint32_t>(parsed);
    return true;
}

bool complete_identity(const Identity& identity, const char* role) {
    if (identity.identity_version < kFactoryIdentityVersion ||
        identity.device_id[0] == '\0' || identity.serial[0] == '\0' ||
        identity.model[0] == '\0' || identity.hardware_revision[0] == '\0' ||
        identity.firmware_target[0] == '\0' || identity.cert_fingerprint[0] == '\0' ||
        identity.attestation_public_key_len < 32 ||
        identity.attestation_public_key_len > sizeof(identity.attestation_public_key) ||
        identity.attestation_private_key_len < 32 ||
        identity.attestation_private_key_len > sizeof(identity.attestation_private_key)) {
        return false;
    }
    if (std::strcmp(role, "NODE") == 0) {
        return identity.radio_id != 0 && valid_node_device_id(identity.device_id, identity.radio_id);
    }
    return std::strcmp(role, "GATEWAY") == 0 && valid_gateway_device_id(identity.device_id);
}

esp_err_t init_factory_partition() {
#ifdef CONFIG_NVS_ENCRYPTION
    // Default NVS has already registered its configured protection scheme.
    // Factory ciphertext must be provisioned with the device-specific keys.
    nvs_sec_cfg_t security{};
    auto* scheme = nvs_flash_get_default_security_scheme();
    if (scheme == nullptr) return ESP_ERR_INVALID_STATE;
    esp_err_t error = nvs_flash_read_security_cfg_v2(scheme, &security);
    if (error == ESP_OK) error = nvs_flash_secure_init_partition("factory_cfg", &security);
    volatile unsigned char* bytes = reinterpret_cast<volatile unsigned char*>(&security);
    for (std::size_t index = 0; index < sizeof(security); ++index) bytes[index] = 0;
#else
    esp_err_t error = nvs_flash_init_partition("factory_cfg");
#endif
    return error;
}

}  // namespace

bool valid_node_device_id(const char* device_id, std::uint32_t radio_id) {
    constexpr char kPrefix[] = "NODE_";
    if (device_id == nullptr || radio_id == 0 || std::strncmp(device_id, kPrefix, sizeof(kPrefix) - 1) != 0) {
        return false;
    }
    std::uint32_t suffix_value = 0;
    if (!decimal_radio_suffix(device_id + sizeof(kPrefix) - 1, &suffix_value)) return false;
    return suffix_value == radio_id;
}

bool valid_gateway_device_id(const char* device_id) {
    constexpr char kPrefix[] = "GATEWAY_";
    if (device_id == nullptr || std::strncmp(device_id, kPrefix, sizeof(kPrefix) - 1) != 0) {
        return false;
    }
    std::uint32_t suffix_value = 0;
    return decimal_radio_suffix(device_id + sizeof(kPrefix) - 1, &suffix_value);
}

std::string public_key_base64(const Identity& identity) {
    if (identity.attestation_public_key_len == 0) return {};
    unsigned char encoded[256]{};
    std::size_t encoded_len = 0;
    if (mbedtls_base64_encode(encoded, sizeof(encoded), &encoded_len,
                              identity.attestation_public_key,
                              identity.attestation_public_key_len) != 0) {
        return {};
    }
    return std::string(reinterpret_cast<const char*>(encoded), encoded_len);
}

esp_err_t load(Identity& output, const char* role) {
    if (role == nullptr || (std::strcmp(role, "NODE") != 0 && std::strcmp(role, "GATEWAY") != 0)) {
        return ESP_ERR_INVALID_ARG;
    }

    Identity candidate{};
    esp_err_t error = init_factory_partition();

    nvs_handle_t handle = 0;
    if (error == ESP_OK) error = nvs_open_from_partition("factory_cfg", "identity", NVS_READONLY, &handle);
    if (error == ESP_OK) {
        char stored_role[16]{};
        error = read_string(handle, "role", stored_role, sizeof(stored_role)) ? ESP_OK : ESP_ERR_INVALID_ARG;
        if (error == ESP_OK && std::strcmp(stored_role, role) != 0) error = ESP_ERR_INVALID_ARG;
        if (error == ESP_OK && nvs_get_u32(handle, kIdentityVersionKey, &candidate.identity_version) != ESP_OK) {
            error = ESP_ERR_INVALID_ARG;
        }
        // These fields were added for serial enrollment/recovery. Older
        // factory manifests remain readable; their first rotation starts at
        // generation one and has no previous ticket hash.
        if (error == ESP_OK) {
            (void)nvs_get_u32(handle, kKeyGenerationKey, &candidate.key_generation);
            std::size_t ticket_hash_size = sizeof(candidate.last_ticket_hash);
            if (nvs_get_blob(handle, kLastTicketHashKey, candidate.last_ticket_hash,
                             &ticket_hash_size) == ESP_OK && ticket_hash_size <= sizeof(candidate.last_ticket_hash)) {
                candidate.last_ticket_hash_len = static_cast<std::uint16_t>(ticket_hash_size);
            }
        }
        if (error == ESP_OK && !read_string(handle, "device_id", candidate.device_id, sizeof(candidate.device_id))) {
            error = ESP_ERR_INVALID_ARG;
        }
        if (error == ESP_OK && !read_string(handle, "serial", candidate.serial, sizeof(candidate.serial))) {
            error = ESP_ERR_INVALID_ARG;
        }
        if (error == ESP_OK && !read_string(handle, "model", candidate.model, sizeof(candidate.model))) {
            error = ESP_ERR_INVALID_ARG;
        }
        if (error == ESP_OK && !read_string(handle, kHardwareRevisionKey, candidate.hardware_revision,
                                             sizeof(candidate.hardware_revision))) {
            error = ESP_ERR_INVALID_ARG;
        }
        if (error == ESP_OK && !read_string(handle, kFirmwareTargetKey, candidate.firmware_target,
                                             sizeof(candidate.firmware_target))) {
            error = ESP_ERR_INVALID_ARG;
        }
        if (error == ESP_OK && !read_string(handle, kCertFingerprintKey, candidate.cert_fingerprint,
                                             sizeof(candidate.cert_fingerprint))) {
            error = ESP_ERR_INVALID_ARG;
        }
        if (error == ESP_OK && !read_blob(handle, kAttestationPublicKey,
                                          candidate.attestation_public_key,
                                          sizeof(candidate.attestation_public_key),
                                          &candidate.attestation_public_key_len)) {
            error = ESP_ERR_INVALID_ARG;
        }
        if (error == ESP_OK && !read_blob(handle, kAttestationPrivateKey,
                                          candidate.attestation_private_key,
                                          sizeof(candidate.attestation_private_key),
                                          &candidate.attestation_private_key_len)) {
            error = ESP_ERR_INVALID_ARG;
        }
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
        // Development images may still read the legacy value for old bench
        // fixtures, but it is never part of the public identity document.
        if (error == ESP_OK) {
            std::size_t legacy_size = sizeof(candidate.setup_secret);
            (void)nvs_get_str(handle, "setup_secret", candidate.setup_secret, &legacy_size);
        }
#endif
        if (error == ESP_OK && std::strcmp(role, "NODE") == 0) {
            error = nvs_get_u32(handle, "radio_id", &candidate.radio_id);
            if (error == ESP_OK && !valid_node_device_id(candidate.device_id, candidate.radio_id)) {
                error = ESP_ERR_INVALID_ARG;
            }
        }
        nvs_close(handle);
        if (error == ESP_OK && !complete_identity(candidate, role)) error = ESP_ERR_INVALID_ARG;
        if (error == ESP_OK) {
            output = candidate;
            return ESP_OK;
        }
        // Never hide a corrupt, incomplete, or wrong-role factory identity with defaults.
        return error;
    }
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
    if (error != ESP_ERR_NVS_NOT_FOUND && error != ESP_ERR_NOT_FOUND) return error;
    const bool node = std::strcmp(role, "NODE") == 0;
    candidate.identity_version = kFactoryIdentityVersion;
    std::snprintf(candidate.device_id, sizeof(candidate.device_id), "%s_000001", node ? "NODE" : "GATEWAY");
    std::snprintf(candidate.serial, sizeof(candidate.serial), "SN-FOS-%s-000001", node ? "N" : "GW");
    std::snprintf(candidate.model, sizeof(candidate.model), "%s_DEV", node ? "NODE" : "GATEWAY");
    std::snprintf(candidate.hardware_revision, sizeof(candidate.hardware_revision), "REV_DEV");
    std::snprintf(candidate.firmware_target, sizeof(candidate.firmware_target), "%s_DEV", node ? "NODE" : "GATEWAY");
    std::snprintf(candidate.cert_fingerprint, sizeof(candidate.cert_fingerprint), "development-only");
    std::snprintf(candidate.setup_secret, sizeof(candidate.setup_secret), "DEV-%s-000001", node ? "NODE" : "GATEWAY");
    candidate.radio_id = node ? 1 : 0;
    output = candidate;
    std::printf("[IDENTITY] DEVELOPMENT ONLY | factory identity missing\n");
    return ESP_OK;
#else
    return error;
#endif
}

bool has_attestation_key(const Identity& identity) {
    return identity.attestation_public_key_len >= 32 &&
           identity.attestation_public_key_len <= sizeof(identity.attestation_public_key) &&
           identity.attestation_private_key_len >= 32 &&
           identity.attestation_private_key_len <= sizeof(identity.attestation_private_key);
}

esp_err_t store(const Identity& identity, const char* role,
                const std::uint8_t* ticket_hash, std::size_t ticket_hash_len) {
    if (role == nullptr || (std::strcmp(role, "NODE") != 0 && std::strcmp(role, "GATEWAY") != 0) ||
        !complete_identity(identity, role) || !has_attestation_key(identity) ||
        (ticket_hash != nullptr && ticket_hash_len != 32)) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t error = init_factory_partition();
    if (error != ESP_OK) return error;
    nvs_handle_t handle = 0;
    error = nvs_open_from_partition("factory_cfg", "identity", NVS_READWRITE, &handle);
    if (error != ESP_OK) return error;
    auto set_string = [&](const char* key, const char* value) {
        return nvs_set_str(handle, key, value == nullptr ? "" : value);
    };
    error = set_string("role", role);
    if (error == ESP_OK) error = nvs_set_u32(handle, kIdentityVersionKey, identity.identity_version);
    if (error == ESP_OK) error = nvs_set_u32(handle, kKeyGenerationKey, identity.key_generation);
    if (error == ESP_OK) error = set_string("device_id", identity.device_id);
    if (error == ESP_OK) error = set_string("serial", identity.serial);
    if (error == ESP_OK) error = set_string("model", identity.model);
    if (error == ESP_OK) error = set_string(kHardwareRevisionKey, identity.hardware_revision);
    if (error == ESP_OK) error = set_string(kFirmwareTargetKey, identity.firmware_target);
    if (error == ESP_OK) error = set_string(kCertFingerprintKey, identity.cert_fingerprint);
    if (error == ESP_OK) error = nvs_set_blob(handle, kAttestationPublicKey,
                                               identity.attestation_public_key,
                                               identity.attestation_public_key_len);
    if (error == ESP_OK) error = nvs_set_blob(handle, kAttestationPrivateKey,
                                               identity.attestation_private_key,
                                               identity.attestation_private_key_len);
    if (error == ESP_OK && std::strcmp(role, "NODE") == 0) {
        error = nvs_set_u32(handle, "radio_id", identity.radio_id);
    } else if (error == ESP_OK) {
        (void)nvs_erase_key(handle, "radio_id");
    }
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
    if (error == ESP_OK && identity.setup_secret[0] != '\0') {
        error = set_string("setup_secret", identity.setup_secret);
    }
#endif
    if (error == ESP_OK) {
        if (ticket_hash != nullptr) {
            error = nvs_set_blob(handle, kLastTicketHashKey, ticket_hash, ticket_hash_len);
        } else if (identity.last_ticket_hash_len == 32) {
            error = nvs_set_blob(handle, kLastTicketHashKey, identity.last_ticket_hash,
                                 identity.last_ticket_hash_len);
        }
    }
    if (error == ESP_OK) error = nvs_commit(handle);
    nvs_close(handle);
    return error;
}
}  // namespace farmos::identity
