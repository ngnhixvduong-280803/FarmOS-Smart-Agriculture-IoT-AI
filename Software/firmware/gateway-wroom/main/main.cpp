#include <algorithm>
#include <array>
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>

#include "ble_provisioning.h"
#include "board_config.h"
#include "device_reset.h"
#include "factory_attestation.h"
#include "serial_enrollment.h"
#include "cJSON.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "farmos_protocol.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gateway_cloud.h"
#include "gateway_ota.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sx1278_radio.h"

namespace {

constexpr char kTag[] = "farmos_gateway";
constexpr std::size_t kMaxNodes = 32;
// Persist immediately when a Node changes boot epoch, then at a bounded
// cadence. Writing every five-second telemetry frame would wear NVS far more
// quickly than the field hardware can tolerate.
constexpr std::uint32_t kReplayCheckpointEvery = 16;

struct NodeBinding {
    std::uint32_t node_id{0};
    char device_id[40]{};
    std::uint8_t radio_token[16]{};
    std::uint32_t last_boot_id{0};
    std::uint32_t last_sequence{0};
    bool sequence_initialized{false};
    farmos::gateway::PairingGrant pending_grant{};
};

std::array<NodeBinding, kMaxNodes> g_bindings{};
std::size_t g_binding_count{0};
std::array<std::uint32_t, kMaxNodes> g_persisted_boot_ids{};
std::array<std::uint32_t, kMaxNodes> g_persisted_sequences{};
farmos::identity::BleAttestation g_attestation;

constexpr farmos::onboarding::BleUuids kBleUuids{
    .service = {0x53, 0x4f, 0x4d, 0x52, 0x41, 0x46, 0x01, 0xa0, 0x10, 0x4f, 0x10, 0x9f, 0x01, 0x00, 0x51, 0x7f},
    .identity_characteristic = {0x53, 0x4f, 0x4d, 0x52, 0x41, 0x46, 0x01, 0xa0, 0x10, 0x4f, 0x10, 0x9f, 0x02, 0x00, 0x51, 0x7f},
    .config_characteristic = {0x53, 0x4f, 0x4d, 0x52, 0x41, 0x46, 0x01, 0xa0, 0x10, 0x4f, 0x10, 0x9f, 0x03, 0x00, 0x51, 0x7f},
    .auth_characteristic = {0x53, 0x4f, 0x4d, 0x52, 0x41, 0x46, 0x01, 0xa0, 0x10, 0x4f, 0x10, 0x9f, 0x04, 0x00, 0x51, 0x7f},
};

void initialize_nvs() {
    esp_err_t error = nvs_flash_init();
    // Preserve credentials for explicit recovery instead of erasing NVS.
    ESP_ERROR_CHECK(error);
}

void load_bindings() {
    nvs_handle_t handle = 0;
    if (nvs_open("farmos_nodes", NVS_READONLY, &handle) != ESP_OK) return;
    std::size_t size = sizeof(g_bindings);
    if (nvs_get_blob(handle, "bindings_v3", g_bindings.data(), &size) == ESP_OK &&
        size % sizeof(NodeBinding) == 0) {
        g_binding_count = std::min(size / sizeof(NodeBinding), kMaxNodes);
        for (std::size_t index = 0; index < g_binding_count; ++index) {
            g_persisted_boot_ids[index] = g_bindings[index].last_boot_id;
            g_persisted_sequences[index] = g_bindings[index].last_sequence;
        }
    }
    nvs_close(handle);
}

bool save_bindings() {
    nvs_handle_t handle = 0;
    if (nvs_open("farmos_nodes", NVS_READWRITE, &handle) != ESP_OK) return false;
    const bool saved = nvs_set_blob(handle, "bindings_v3", g_bindings.data(),
                                    g_binding_count * sizeof(NodeBinding)) == ESP_OK &&
                       nvs_commit(handle) == ESP_OK;
    nvs_close(handle);
    return saved;
}

std::string identity_document() {
    cJSON* root = cJSON_CreateObject();
    if (root == nullptr) return {};
    const std::string public_key = farmos::identity::public_key_base64(farmos::gateway::config::kIdentity);
    cJSON_AddNumberToObject(root, "version", 3);
    cJSON_AddStringToObject(root, "type", "GATEWAY");
    cJSON_AddStringToObject(root, "id", farmos::gateway::config::kDeviceId);
    cJSON_AddStringToObject(root, "serialNumber", farmos::gateway::config::kSerialNumber);
    cJSON_AddNumberToObject(root, "identityVersion",
                            static_cast<double>(farmos::gateway::config::kIdentity.identity_version));
    cJSON_AddStringToObject(root, "model", farmos::gateway::config::kIdentity.model);
    cJSON_AddStringToObject(root, "hardwareRevision", farmos::gateway::config::kIdentity.hardware_revision);
    cJSON_AddStringToObject(root, "firmwareTarget", farmos::gateway::config::kIdentity.firmware_target);
    cJSON_AddStringToObject(root, "attestationPublicKey", public_key.c_str());
    cJSON_AddStringToObject(root, "certFingerprint", farmos::gateway::config::kIdentity.cert_fingerprint);
    cJSON_AddStringToObject(root, "firmwareVersion", farmos::gateway::config::kFirmwareVersion);
    cJSON* capabilities = cJSON_AddArrayToObject(root, "capabilities");
    cJSON_AddItemToArray(capabilities, cJSON_CreateString("WIFI"));
    cJSON_AddItemToArray(capabilities, cJSON_CreateString("LORA"));
    cJSON_AddItemToArray(capabilities, cJSON_CreateString("GATEWAY"));
    cJSON_AddStringToObject(root, "currentMode", "GATEWAY");
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
    cJSON_AddStringToObject(root, "possessionCode", farmos::gateway::config::kFactoryClaimCode);
#endif
    char* rendered = cJSON_PrintUnformatted(root);
    std::string result = rendered != nullptr ? rendered : "";
    if (rendered != nullptr) cJSON_free(rendered);
    cJSON_Delete(root);
    return result;
}

NodeBinding* find_binding(std::uint32_t node_id) {
    for (std::size_t index = 0; index < g_binding_count; ++index) {
        if (g_bindings[index].node_id == node_id) return &g_bindings[index];
    }
    return nullptr;
}

bool parse_hex_token(const char* input, std::uint8_t output[16]) {
    if (input == nullptr || std::strlen(input) != 32) return false;
    for (std::size_t index = 0; index < 16; ++index) {
        unsigned value = 0;
        if (std::sscanf(input + index * 2, "%2x", &value) != 1) return false;
        output[index] = static_cast<std::uint8_t>(value);
    }
    return true;
}

bool node_number(const char* device_id, std::uint32_t* output) {
    if (device_id == nullptr || output == nullptr ||
        std::strncmp(device_id, "NODE_", std::strlen("NODE_")) != 0) return false;
    const char* separator = std::strrchr(device_id, '_');
    if (separator == nullptr || separator[1] == '\0') return false;
    char* end = nullptr;
    const unsigned long value = std::strtoul(separator + 1, &end, 10);
    if (*end != '\0' || value == 0 || value > UINT32_MAX) return false;
    *output = static_cast<std::uint32_t>(value);
    return true;
}

bool is_duplicate(const farmos::protocol::TelemetryFrame& frame, const NodeBinding& binding) {
    if (!binding.sequence_initialized) return false;
    // Node boot IDs are durably monotonic. Accepting a lower epoch after the
    // Gateway restarts would let a captured authenticated frame be replayed.
    return frame.boot_id < binding.last_boot_id ||
           (frame.boot_id == binding.last_boot_id && frame.sequence <= binding.last_sequence);
}

bool checkpoint_replay_state(NodeBinding* binding) {
    const std::size_t index = static_cast<std::size_t>(binding - g_bindings.data());
    const bool epoch_changed = binding->last_boot_id != g_persisted_boot_ids[index];
    const bool sequence_due = binding->last_sequence >= g_persisted_sequences[index] + kReplayCheckpointEvery;
    if (!epoch_changed && !sequence_due) return true;
    if (!save_bindings()) {
        ESP_LOGW(kTag, "Could not persist LoRa replay checkpoint for node %" PRIu32, binding->node_id);
        return false;
    }
    g_persisted_boot_ids[index] = binding->last_boot_id;
    g_persisted_sequences[index] = binding->last_sequence;
    return true;
}

farmos::protocol::AckFrame make_ack(const farmos::protocol::TelemetryFrame& telemetry,
                                    farmos::protocol::AckStatus status,
                                    const std::uint8_t token[16]) {
    using namespace farmos::protocol;
    AckFrame ack{
        .magic = kMagic,
        .version = kVersion,
        .type = static_cast<std::uint8_t>(MessageType::kAck),
        .node_id = telemetry.node_id,
        .boot_id = telemetry.boot_id,
        .sequence = telemetry.sequence,
        .status = static_cast<std::uint8_t>(status),
        .reserved = {0, 0, 0},
        .auth_tag = {},
        .crc32 = 0,
    };
    authenticate(ack, token);
    return ack;
}

void handle_pair_request(farmos::radio::Sx1278Radio& radio,
                         const farmos::protocol::PairRequestFrame& request,
                         const farmos::radio::ReceiveMetadata& metadata,
                         farmos::gateway::GatewayCloud& cloud) {
    if (!farmos::protocol::validate(request)) return;
    farmos::gateway::PairingGrant grant{};
    std::uint32_t expected_node_id = 0;
    std::uint8_t expected_token[16]{};
    if (!cloud.current_pairing(&grant) || !node_number(grant.node_id, &expected_node_id) ||
        !parse_hex_token(grant.radio_token_hex, expected_token) ||
        request.node_id != expected_node_id ||
        !farmos::protocol::validate_authenticated(request, expected_token)) {
        std::printf("[GATEWAY] PAIR REJECT | node=%" PRIu32 " | no matching app approval\n",
                    request.node_id);
        return;
    }

    NodeBinding* binding = find_binding(request.node_id);
    NodeBinding previous{};
    bool had_previous = binding != nullptr;
    if (binding != nullptr) previous = *binding;
    if (binding == nullptr) {
        if (g_binding_count >= kMaxNodes) {
            std::printf("[GATEWAY] PAIR REJECT | capacity=%u nodes\n",
                        static_cast<unsigned>(kMaxNodes));
            return;
        }
        binding = &g_bindings[g_binding_count++];
    }
    *binding = {};
    binding->node_id = request.node_id;
    std::snprintf(binding->device_id, sizeof(binding->device_id), "%s", grant.node_id);
    std::memcpy(binding->radio_token, expected_token, sizeof(binding->radio_token));
    binding->pending_grant = grant;
    if (!save_bindings()) {
        if (had_previous) *binding = previous;
        else --g_binding_count;
        ESP_LOGW(kTag, "PAIR REJECT | could not persist binding for node %" PRIu32, request.node_id);
        return;
    }
    const std::size_t binding_index = static_cast<std::size_t>(binding - g_bindings.data());
    g_persisted_boot_ids[binding_index] = binding->last_boot_id;
    g_persisted_sequences[binding_index] = binding->last_sequence;

    farmos::protocol::PairAcceptFrame response{
        .magic = farmos::protocol::kMagic,
        .version = farmos::protocol::kVersion,
        .type = static_cast<std::uint8_t>(farmos::protocol::MessageType::kPairAccept),
        .node_id = request.node_id,
        .nonce = request.nonce,
        .status = 0,
        .reserved = {0, 0, 0},
        .auth_tag = {},
        .crc32 = 0,
    };
    if (!farmos::protocol::authenticate(response, expected_token)) return;
    vTaskDelay(pdMS_TO_TICKS(farmos::gateway::config::kAckTurnaroundMs));
    if (radio.send(&response, sizeof(response), 1000) == ESP_OK) {
        std::printf("[GATEWAY] PAIR ACCEPT SENT | %s | RSSI=%d | SNR=%.2f\n",
                    grant.node_id, metadata.rssi_dbm, metadata.snr_db);
    }
}

void handle_telemetry(farmos::radio::Sx1278Radio& radio,
                      const farmos::protocol::TelemetryFrame& telemetry,
                      const farmos::radio::ReceiveMetadata& metadata,
                      farmos::gateway::GatewayCloud& cloud) {
    NodeBinding* binding = find_binding(telemetry.node_id);
    if (binding == nullptr ||
        !farmos::protocol::validate_authenticated(telemetry, binding->radio_token)) {
        std::printf("[GATEWAY] RX REJECT | node=%" PRIu32
                    " | not paired or invalid signature\n", telemetry.node_id);
        return;
    }
    const bool duplicate = is_duplicate(telemetry, *binding);
    const bool temperature_valid =
        (telemetry.sensor_valid_mask & farmos::protocol::kDs18b20FirstValid) != 0;
    if (!duplicate && (telemetry.sensor_valid_mask & (farmos::protocol::kDs18b20FirstValid | farmos::protocol::kAirTemperatureValid | farmos::protocol::kAirHumidityValid))) {
        farmos::gateway::TelemetryUpload upload{};
        std::snprintf(upload.node_id, sizeof(upload.node_id), "%s", binding->device_id);
        upload.boot_id = telemetry.boot_id;
        upload.sequence = telemetry.sequence;
        upload.temperature_centi_c = telemetry.probe_temperature_1_centi_c;
        upload.quality = telemetry.quality;
        upload.sensor_mask = telemetry.sensor_valid_mask;
        upload.air_temperature_centi_c = telemetry.air_temperature_centi_c;
        upload.air_humidity_centi_pct = telemetry.air_humidity_centi_pct;
        if (!cloud.enqueue_telemetry(upload)) {
            ESP_LOGW(kTag, "Outbox full or storage error; withholding ACK so Node retries");
            return;
        }
    }
    if (!duplicate) {
        const NodeBinding previous = *binding;
        binding->last_boot_id = telemetry.boot_id;
        binding->last_sequence = telemetry.sequence;
        binding->sequence_initialized = true;
        if (!checkpoint_replay_state(binding)) {
            *binding = previous;
            // Do not ACK an accepted frame whose replay watermark could not
            // be saved on a new epoch/checkpoint boundary. The Node will retry.
            return;
        }
    }
    if (binding->pending_grant.available) {
        // Authentication and persisted replay state prove the radio link.
        // Missing measurements must not prevent an otherwise valid pairing.
        // When temperature exists, its outbox write above must still succeed.
        // Duplicate frames retry the idempotent cloud confirmation.
        cloud.confirm_pairing(binding->pending_grant, metadata.rssi_dbm, metadata.snr_db);
    }
    const auto ack = make_ack(telemetry,
                              duplicate ? farmos::protocol::AckStatus::kDuplicate
                                        : farmos::protocol::AckStatus::kAccepted,
                              binding->radio_token);
    vTaskDelay(pdMS_TO_TICKS(farmos::gateway::config::kAckTurnaroundMs));
    const esp_err_t ack_error = radio.send(&ack, sizeof(ack), 1000);
    std::printf("[GATEWAY] RX #%-4" PRIu32 " | %s | temp=",
                telemetry.sequence, binding->device_id);
    if (temperature_valid) {
        std::printf("%.2f C", telemetry.probe_temperature_1_centi_c / 100.0F);
    } else {
        std::printf("null");
    }
    std::printf(" | air_temperature=");
    if (telemetry.sensor_valid_mask & farmos::protocol::kAirTemperatureValid) std::printf("%.2f", telemetry.air_temperature_centi_c / 100.0); else std::printf("null");
    std::printf(" | air_humidity=");
    if (telemetry.sensor_valid_mask & farmos::protocol::kAirHumidityValid) std::printf("%.2f", telemetry.air_humidity_centi_pct / 100.0); else std::printf("null");
    std::printf(" | soil_moisture=null");
    std::printf(" | RSSI=%d | SNR=%.2f | %s%s\n", metadata.rssi_dbm, metadata.snr_db,
                ack_error == ESP_OK ? "ACK" : "ACK ERROR",
                duplicate ? " | duplicate" : "");
}

}  // namespace

extern "C" void app_main() {
    initialize_nvs();
    farmos::gateway::GatewayOta::init();
    farmos::reset::consume(true);
    const esp_err_t identity_status = farmos::identity::load(farmos::gateway::config::kIdentity, "GATEWAY");
    bool development_identity_fallback = false;
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
    // A compile-time bench fixture is not a manufactured identity.
    development_identity_fallback = identity_status == ESP_OK &&
                                    std::strcmp(farmos::gateway::config::kIdentity.cert_fingerprint, "development-only") == 0;
    if (development_identity_fallback) farmos::gateway::config::kIdentity = {};
#endif
    const bool identity_usable = identity_status == ESP_OK &&
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
                                 !development_identity_fallback;
#else
                                 farmos::identity::has_attestation_key(farmos::gateway::config::kIdentity);
#endif
    if (identity_status != ESP_OK && identity_status != ESP_ERR_NVS_NOT_FOUND && identity_status != ESP_ERR_INVALID_ARG) {
        ESP_ERROR_CHECK(identity_status);
    }
    // SerialEnrollment owns a 2 KiB protocol payload buffer. Keep it out of
    // app_main's small FreeRTOS stack for the process lifetime.
    static farmos::enrollment::SerialEnrollment serial_enrollment(
        "GATEWAY", &farmos::gateway::config::kIdentity,
        [identity_usable](const farmos::identity::Identity& updated, const std::uint8_t* ticket_hash, std::size_t ticket_hash_len) {
            // A new factory identity must never inherit the previous board setup.
            if (!identity_usable && !farmos::reset::store_action(2)) return ESP_FAIL;
            const esp_err_t error = farmos::identity::store(updated, "GATEWAY", ticket_hash, ticket_hash_len);
            if (error == ESP_OK) farmos::gateway::config::kIdentity = updated;
            return error;
        });
    if (!identity_usable) {
        // UART0 carries the binary FO enrollment protocol.  Finish this
        // human-readable console line before its task can write HELLO, or it
        // can be inserted in the middle of the JSON frame on a shared USB-UART
        // bridge and make the browser reject the frame.
        std::printf("[GATEWAY] ENROLLMENT REQUIRED | use browser Web Serial; factory identity is not erased\n");
        std::fflush(stdout);
    }
    ESP_ERROR_CHECK(serial_enrollment.begin());
    if (!identity_usable) {
        while (!serial_enrollment.enrolled()) vTaskDelay(pdMS_TO_TICKS(250));
        vTaskDelay(pdMS_TO_TICKS(2000));
        esp_restart();
    }
    load_bindings();
    farmos::gateway::GatewayCloud cloud;
    ESP_ERROR_CHECK(cloud.begin());

    const std::string identity = identity_document();
    const char* id = farmos::gateway::config::kDeviceId;
    const auto id_length = std::strlen(id);
    const std::string ble_name = std::string("FG") + (id_length > 6 ? id + id_length - 6 : id);
    auto ble = std::make_unique<farmos::onboarding::BleProvisioningServer>(
        ble_name, identity, kBleUuids,
        [&cloud](const std::string& json) {
            if (!g_attestation.authorize_config(
                    farmos::gateway::config::kIdentity, json,
                    static_cast<std::uint64_t>(esp_timer_get_time() / 1000))) {
                return false;
            }
            return cloud.accept_ble_config(json);
        });
    ble->set_auth_handlers(
        [](const std::string& request) {
            return g_attestation.handle_challenge(
                farmos::gateway::config::kIdentity, request,
                static_cast<std::uint64_t>(esp_timer_get_time() / 1000));
        },
        []() { return g_attestation.response(); });
    ESP_ERROR_CHECK(ble->begin());
    farmos::reset::start_button();

    farmos::radio::Sx1278Radio radio(farmos::gateway::config::kRadioPins);
    const bool radio_ready = radio.begin(farmos::gateway::config::kFrequencyHz) == ESP_OK;
    if (!radio_ready) std::printf("[GATEWAY] lora=null | BLE/USB/Wi-Fi remain available\n");
    std::printf("[GATEWAY] READY | id=%s | LoRa=433 MHz | nodes=%u | BLE setup available\n",
                farmos::gateway::config::kDeviceId,
                static_cast<unsigned>(g_binding_count));

    std::array<std::uint8_t, sizeof(farmos::protocol::TelemetryFrame)> buffer{};
    while (true) {
        if (!radio_ready) { std::printf("[GATEWAY] RX | node=null | soil_temperature=null | air_temperature=null | air_humidity=null | soil_moisture=null | lora=null\n"); vTaskDelay(pdMS_TO_TICKS(5000)); continue; }
        std::size_t length = 0;
        farmos::radio::ReceiveMetadata metadata{};
        const esp_err_t error = radio.receive(
            buffer.data(), buffer.size(), &length, &metadata,
            farmos::gateway::config::kReceiveWindowMs);
        if (error == ESP_ERR_TIMEOUT) { std::printf("[GATEWAY] RX | node=null | soil_temperature=null | air_temperature=null | air_humidity=null | soil_moisture=null\n"); continue; }
        if (error != ESP_OK) {
            ESP_LOGW(kTag, "LoRa receive error: %s", esp_err_to_name(error));
            continue;
        }
        if (length < 4) continue;
        const auto type = static_cast<farmos::protocol::MessageType>(buffer[3]);
        if (type == farmos::protocol::MessageType::kPairRequest &&
            length == sizeof(farmos::protocol::PairRequestFrame)) {
            farmos::protocol::PairRequestFrame request{};
            std::memcpy(&request, buffer.data(), sizeof(request));
            handle_pair_request(radio, request, metadata, cloud);
        } else if (type == farmos::protocol::MessageType::kTelemetry &&
                   length == sizeof(farmos::protocol::TelemetryFrame)) {
            farmos::protocol::TelemetryFrame telemetry{};
            std::memcpy(&telemetry, buffer.data(), sizeof(telemetry));
            handle_telemetry(radio, telemetry, metadata, cloud);
        } else {
            std::printf("[GATEWAY] RX REJECT | malformed frame (%u bytes)\n",
                        static_cast<unsigned>(length));
        }
    }
}
