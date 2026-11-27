#include <array>
#include <cinttypes>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

#include "ble_provisioning.h"
#include "node_ota.h"
#include "node_cloud.h"
#include "pump_control.h"
#include "board_config.h"
#include "cJSON.h"
#include "ds18b20_bus.h"
#include "node_peripherals.h"
#include "device_reset.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "factory_attestation.h"
#include "serial_enrollment.h"
#include "farmos_protocol.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sx1278_radio.h"

namespace {

struct EnvironmentalReadings {
    std::int16_t probe_temperature_1_centi_c{farmos::protocol::kInvalidTemperatureCentiC};
    std::int16_t air_temperature{farmos::protocol::kInvalidTemperatureCentiC};
    std::uint16_t air_humidity{farmos::protocol::kInvalidHumidityCentiPct};
    std::int16_t soil_moisture_centi_pct{-1};
    bool soil_test_calibration{false};
    std::uint8_t valid_mask{0};
};

struct PairingState {
    bool paired{false};
    bool pending{false};
    char gateway_id[40]{};
    char pairing_id[48]{};
    std::uint8_t radio_token[16]{};
    std::uint32_t nonce{0};
};

PairingState g_pairing{};
std::int64_t g_pending_deadline_ms{0};
portMUX_TYPE g_pairing_lock = portMUX_INITIALIZER_UNLOCKED;
std::unique_ptr<farmos::onboarding::BleProvisioningServer> g_ble;
farmos::node::NodeCloud* g_cloud{nullptr};
farmos::identity::BleAttestation g_attestation;

constexpr farmos::onboarding::BleUuids kBleUuids{
    .service = {0x53, 0x4f, 0x4d, 0x52, 0x41, 0x46, 0x01, 0xa0, 0x10, 0x4f, 0x10, 0x9f, 0x01, 0x00, 0x52, 0x7f},
    .identity_characteristic = {0x53, 0x4f, 0x4d, 0x52, 0x41, 0x46, 0x01, 0xa0, 0x10, 0x4f, 0x10, 0x9f, 0x02, 0x00, 0x52, 0x7f},
    .config_characteristic = {0x53, 0x4f, 0x4d, 0x52, 0x41, 0x46, 0x01, 0xa0, 0x10, 0x4f, 0x10, 0x9f, 0x03, 0x00, 0x52, 0x7f},
    .ota_characteristic = {0x53, 0x4f, 0x4d, 0x52, 0x41, 0x46, 0x01, 0xa0, 0x10, 0x4f, 0x10, 0x9f, 0x04, 0x00, 0x52, 0x7f},
    .auth_characteristic = {0x53, 0x4f, 0x4d, 0x52, 0x41, 0x46, 0x01, 0xa0, 0x10, 0x4f, 0x10, 0x9f, 0x05, 0x00, 0x52, 0x7f},
};

void initialize_nvs() {
    esp_err_t error = nvs_flash_init();
    // A storage error must not silently erase ownership and radio credentials.
    ESP_ERROR_CHECK(error);
}

bool parse_hex_token(const char* input, std::uint8_t output[16]) {
    if (input == nullptr || std::strlen(input) != 32) return false;
    for (std::size_t i = 0; i < 16; ++i) {
        unsigned value = 0;
        if (std::sscanf(input + i * 2, "%2x", &value) != 1) return false;
        output[i] = static_cast<std::uint8_t>(value);
    }
    return true;
}

void load_pairing() {
    nvs_handle_t handle = 0;
    if (nvs_open("farmos_pair", NVS_READONLY, &handle) != ESP_OK) return;
    PairingState saved{};
    std::size_t saved_size = sizeof(saved);
    if (nvs_get_blob(handle, "binding_v1", &saved, &saved_size) == ESP_OK &&
        saved_size == sizeof(saved) && saved.paired &&
        std::memchr(saved.gateway_id, '\0', sizeof(saved.gateway_id)) != nullptr) {
        g_pairing = saved;
        g_pairing.pending = false;
        nvs_close(handle);
        return;
    }
    std::uint8_t paired = 0;
    std::size_t gateway_size = sizeof(g_pairing.gateway_id);
    std::size_t token_size = sizeof(g_pairing.radio_token);
    if (nvs_get_u8(handle, "paired", &paired) == ESP_OK && paired == 1 &&
        nvs_get_str(handle, "gateway", g_pairing.gateway_id, &gateway_size) == ESP_OK &&
        nvs_get_blob(handle, "token", g_pairing.radio_token, &token_size) == ESP_OK && token_size == 16) {
        g_pairing.paired = true;
    }
    nvs_close(handle);
}

void save_pairing(const PairingState& state) {
    nvs_handle_t handle = 0;
    ESP_ERROR_CHECK(nvs_open("farmos_pair", NVS_READWRITE, &handle));
    // One NVS item prevents mixed old/new credentials after interrupted writes.
    ESP_ERROR_CHECK(nvs_set_blob(handle, "binding_v1", &state, sizeof(state)));
    ESP_ERROR_CHECK(nvs_commit(handle));
    nvs_close(handle);
}

void commit_standalone_mode_binding() {
    // The NodeCloud task has already completed the Wi-Fi + server probe and
    // durable cloud-settings write. Clear the old LoRa binding as one NVS
    // blob only after that commit; a failed probe leaves the old binding
    // available for rollback.
    PairingState cleared{};
    portENTER_CRITICAL(&g_pairing_lock);
    g_pairing = cleared;
    portEXIT_CRITICAL(&g_pairing_lock);
    save_pairing(cleared);
    std::printf("[NODE] MODE COMMITTED | LEAF_NODE -> STANDALONE_NODE | old binding cleared\n");
}

std::uint32_t next_boot_id() {
    nvs_handle_t handle = 0;
    ESP_ERROR_CHECK(nvs_open("farmos", NVS_READWRITE, &handle));
    std::uint32_t boot_id = 0;
    if (nvs_get_u32(handle, "boot_id", &boot_id) != ESP_OK) boot_id = esp_random();
    ++boot_id;
    ESP_ERROR_CHECK(nvs_set_u32(handle, "boot_id", boot_id));
    ESP_ERROR_CHECK(nvs_commit(handle));
    nvs_close(handle);
    return boot_id;
}

bool accept_pairing_config(const std::string& json) {
    if (!g_ble || !g_ble->advertising_enabled() || g_pairing.paired) return false;
    cJSON* root = cJSON_ParseWithLength(json.data(), json.size());
    if (root == nullptr) return false;
    const cJSON* node = cJSON_GetObjectItemCaseSensitive(root, "nodeId");
    const cJSON* gateway = cJSON_GetObjectItemCaseSensitive(root, "gatewayId");
    const cJSON* pairing = cJSON_GetObjectItemCaseSensitive(root, "pairingId");
    const cJSON* token = cJSON_GetObjectItemCaseSensitive(root, "radioToken");
    const cJSON* ttl = cJSON_GetObjectItemCaseSensitive(root, "ttlMs");
    PairingState pending{};
    pending.pending = cJSON_IsString(node) && cJSON_IsString(gateway) &&
                      cJSON_IsString(pairing) && cJSON_IsString(token) &&
                      std::strcmp(node->valuestring, farmos::node::config::kDeviceId) == 0 &&
                      parse_hex_token(token->valuestring, pending.radio_token) &&
                      cJSON_IsNumber(ttl) && ttl->valuedouble > 0 && ttl->valuedouble <= 300000;
    if (pending.pending) {
        std::snprintf(pending.gateway_id, sizeof(pending.gateway_id), "%s", gateway->valuestring);
        std::snprintf(pending.pairing_id, sizeof(pending.pairing_id), "%s", pairing->valuestring);
        pending.nonce = esp_random();
        portENTER_CRITICAL(&g_pairing_lock);
        g_pairing.pending = true;
        std::memcpy(g_pairing.gateway_id, pending.gateway_id, sizeof(g_pairing.gateway_id));
        std::memcpy(g_pairing.pairing_id, pending.pairing_id, sizeof(g_pairing.pairing_id));
        std::memcpy(g_pairing.radio_token, pending.radio_token, sizeof(g_pairing.radio_token));
        g_pairing.nonce = pending.nonce;
        g_pending_deadline_ms = esp_timer_get_time() / 1000 + static_cast<std::int64_t>(ttl->valuedouble);
        portEXIT_CRITICAL(&g_pairing_lock);
        if (g_cloud) g_cloud->pause_for_pairing();
        std::printf("[NODE] PAIRING | app approved gateway=%s\n", pending.gateway_id);
    }
    cJSON_Delete(root);
    return pending.pending;
}

bool pair_with_gateway(farmos::radio::Sx1278Radio& radio) {
    PairingState pending{};
    portENTER_CRITICAL(&g_pairing_lock);
    pending = g_pairing;
    portEXIT_CRITICAL(&g_pairing_lock);
    if (!pending.pending) return false;
    if (esp_timer_get_time() / 1000 >= g_pending_deadline_ms) {
        portENTER_CRITICAL(&g_pairing_lock);
        g_pairing = {};
        portEXIT_CRITICAL(&g_pairing_lock);
        load_pairing();
        if (g_cloud) g_cloud->resume_after_pairing_failure();
        std::printf("[NODE] PAIRING EXPIRED | previous saved binding restored when available\n");
        return false;
    }

    farmos::protocol::PairRequestFrame request{
        .magic = farmos::protocol::kMagic,
        .version = farmos::protocol::kVersion,
        .type = static_cast<std::uint8_t>(farmos::protocol::MessageType::kPairRequest),
        .node_id = farmos::node::config::kNodeId,
        .nonce = pending.nonce,
        .auth_tag = {},
        .crc32 = 0,
    };
    if (!farmos::protocol::authenticate(request, pending.radio_token)) return false;
    if (radio.send(&request, sizeof(request), 1000) != ESP_OK) return false;

    farmos::protocol::PairAcceptFrame response{};
    std::size_t length = 0;
    if (radio.receive(&response, sizeof(response), &length, nullptr, 2000) != ESP_OK ||
        length != sizeof(response) || !farmos::protocol::validate_authenticated(response, pending.radio_token) ||
        response.node_id != request.node_id || response.nonce != request.nonce ||
        response.status != 0) {
        std::printf("[NODE] PAIRING | waiting for selected Gateway\n");
        return false;
    }

    pending.paired = true;
    pending.pending = false;
    save_pairing(pending);
    portENTER_CRITICAL(&g_pairing_lock);
    g_pairing = pending;
    portEXIT_CRITICAL(&g_pairing_lock);
    g_ble->set_advertising(false);
    if (g_cloud) g_cloud->clear_after_pairing();
    std::printf("[NODE] PAIRED | gateway=%s | binding saved\n", pending.gateway_id);
    return true;
}

bool accept_device_config(const std::string& json) {
    if (!g_attestation.authorize_config(farmos::node::config::kIdentity, json,
                                        static_cast<std::uint64_t>(esp_timer_get_time() / 1000))) {
        return false;
    }
    cJSON* root = cJSON_ParseWithLength(json.data(), json.size());
    if (!root) return false;
    const cJSON* mode = cJSON_GetObjectItemCaseSensitive(root, "deploymentMode");
    if (!cJSON_IsString(mode)) mode = cJSON_GetObjectItemCaseSensitive(root, "mode");
    const bool standalone = cJSON_IsString(mode) && std::strcmp(mode->valuestring, "STANDALONE_NODE") == 0;
    cJSON_Delete(root);
    return standalone && g_cloud ? g_cloud->accept_ble_config(json) : accept_pairing_config(json);
}

std::string identity_document(const farmos::node::NodeCloud& cloud) {
    cJSON* root = cJSON_CreateObject();
    if (root == nullptr) return {};
    const std::string public_key = farmos::identity::public_key_base64(farmos::node::config::kIdentity);
    cJSON_AddNumberToObject(root, "version", 3);
    cJSON_AddStringToObject(root, "type", "SENSOR_NODE");
    cJSON_AddStringToObject(root, "id", farmos::node::config::kDeviceId);
    cJSON_AddStringToObject(root, "serialNumber", farmos::node::config::kSerialNumber);
    cJSON_AddNumberToObject(root, "identityVersion",
                            static_cast<double>(farmos::node::config::kIdentity.identity_version));
    cJSON_AddStringToObject(root, "model", farmos::node::config::kIdentity.model);
    cJSON_AddStringToObject(root, "hardwareRevision", farmos::node::config::kIdentity.hardware_revision);
    cJSON_AddStringToObject(root, "firmwareTarget", farmos::node::config::kIdentity.firmware_target);
    cJSON_AddStringToObject(root, "attestationPublicKey", public_key.c_str());
    cJSON_AddStringToObject(root, "certFingerprint", farmos::node::config::kIdentity.cert_fingerprint);
    cJSON_AddStringToObject(root, "firmwareVersion", farmos::node::config::kFirmwareVersion);
    cJSON* capabilities = cJSON_AddArrayToObject(root, "capabilities");
    cJSON_AddItemToArray(capabilities, cJSON_CreateString("WIFI"));
    cJSON_AddItemToArray(capabilities, cJSON_CreateString("LORA"));
    cJSON_AddItemToArray(capabilities, cJSON_CreateString("SENSOR_DS18B20"));
    const auto mode = cloud.mode();
    const char* connection_mode = mode == farmos::node::ConnectionMode::WIFI ? "WIFI" :
                                   mode == farmos::node::ConnectionMode::LORA_GATEWAY ? "LORA_GATEWAY" :
                                   "UNCONFIGURED";
    cJSON_AddStringToObject(root, "connectionMode", connection_mode);
    cJSON_AddStringToObject(root, "currentMode",
                            mode == farmos::node::ConnectionMode::WIFI ? "STANDALONE_NODE" :
                            mode == farmos::node::ConnectionMode::LORA_GATEWAY ? "LEAF_NODE" :
                            "UNCONFIGURED");
    cJSON_AddBoolToObject(root, "pairingMode", !g_pairing.paired);
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
    cJSON_AddStringToObject(root, "possessionCode", farmos::node::config::kFactoryClaimCode);
#endif
    char* rendered = cJSON_PrintUnformatted(root);
    std::string result = rendered != nullptr ? rendered : "";
    if (rendered != nullptr) cJSON_free(rendered);
    cJSON_Delete(root);
    return result;
}

bool discover_probe(farmos::sensors::Ds18b20Bus& bus,
                    farmos::sensors::OneWireRom* probe) {
    std::array<farmos::sensors::OneWireRom, farmos::sensors::Ds18b20Bus::kMaxDevices> devices{};
    std::size_t count = 0;
    if (bus.discover(&devices, &count) != ESP_OK || count == 0) {
        std::printf("[NODE] SENSOR | soil_temperature=null | DS18B20 GPIO%d\n", farmos::node::config::kDs18b20Pin);
        return false;
    }
    *probe = devices[0];
    std::printf("[NODE] SENSOR READY | DS18B20 GPIO%d | ROM=%016" PRIX64 "\n",
                farmos::node::config::kDs18b20Pin, farmos::sensors::Ds18b20Bus::rom_as_u64(*probe));
    return true;
}

EnvironmentalReadings read_environment(farmos::sensors::Ds18b20Bus& bus,
                                       const farmos::sensors::OneWireRom* probe) {
    EnvironmentalReadings readings{};
    if (probe == nullptr || bus.start_conversion() != ESP_OK) return readings;
    vTaskDelay(pdMS_TO_TICKS(750));
    float value = 0;
    if (bus.read_temperature(*probe, &value) == ESP_OK) {
        readings.probe_temperature_1_centi_c = static_cast<std::int16_t>(std::lround(value * 100.0F));
        readings.valid_mask = farmos::protocol::kDs18b20FirstValid;
    }
    return readings;
}

farmos::protocol::TelemetryFrame make_telemetry(std::uint32_t boot_id,
                                                std::uint32_t sequence,
                                                const EnvironmentalReadings& readings) {
    using namespace farmos::protocol;
    TelemetryFrame frame{
        .magic = kMagic, .version = kVersion,
        .type = static_cast<std::uint8_t>(MessageType::kTelemetry),
        .node_id = farmos::node::config::kNodeId, .boot_id = boot_id,
        .sequence = sequence,
        .uptime_ms = static_cast<std::uint32_t>(esp_timer_get_time() / 1000),
        .soil_moisture_centi_pct = readings.soil_moisture_centi_pct,
        .air_temperature_centi_c = readings.air_temperature,
        .air_humidity_centi_pct = readings.air_humidity,
        .probe_temperature_1_centi_c = readings.probe_temperature_1_centi_c,
        .probe_temperature_2_centi_c = kInvalidTemperatureCentiC,
        .sensor_valid_mask = readings.valid_mask,
        .quality = static_cast<std::uint8_t>(readings.valid_mask ? Quality::kValid : Quality::kInvalid),
        .reserved = {0, 0}, .auth_tag = {}, .crc32 = 0,
    };
    PairingState pairing{};
    portENTER_CRITICAL(&g_pairing_lock);
    pairing = g_pairing;
    portEXIT_CRITICAL(&g_pairing_lock);
    authenticate(frame, pairing.radio_token);
    return frame;
}

bool wait_for_ack(farmos::radio::Sx1278Radio& radio,
                  const farmos::protocol::TelemetryFrame& telemetry,
                  farmos::radio::ReceiveMetadata* metadata) {
    farmos::protocol::AckFrame ack{};
    std::size_t length = 0;
    return radio.receive(&ack, sizeof(ack), &length, metadata,
                         farmos::node::config::kAckTimeoutMs) == ESP_OK &&
           length == sizeof(ack) && farmos::protocol::validate_authenticated(ack, g_pairing.radio_token) &&
           ack.node_id == telemetry.node_id && ack.boot_id == telemetry.boot_id &&
           ack.sequence == telemetry.sequence &&
           (ack.status == static_cast<std::uint8_t>(farmos::protocol::AckStatus::kAccepted) ||
            ack.status == static_cast<std::uint8_t>(farmos::protocol::AckStatus::kDuplicate));
}

}  // namespace

extern "C" void app_main() {
    gpio_set_level(farmos::node::config::kRelayPin, 0);
    gpio_set_direction(farmos::node::config::kRelayPin, GPIO_MODE_OUTPUT);
    gpio_set_level(farmos::node::config::kRelayPin, 0);
    initialize_nvs();
    farmos::node::NodeOta::init();
    const unsigned reset_action = farmos::reset::consume(false);
    const bool service_mode = reset_action == 1;
    const esp_err_t identity_status = farmos::identity::load(farmos::node::config::kIdentity, "NODE");
    bool development_identity_fallback = false;
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
    // A compile-time bench fixture is not a manufactured identity and must
    // enter the first signed ENROLL flow rather than a key-rotation flow.
    development_identity_fallback = identity_status == ESP_OK &&
                                    std::strcmp(farmos::node::config::kIdentity.cert_fingerprint, "development-only") == 0;
    if (development_identity_fallback) farmos::node::config::kIdentity = {};
#endif
    const bool identity_usable = identity_status == ESP_OK &&
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
                                 !development_identity_fallback;
#else
                                 farmos::identity::has_attestation_key(farmos::node::config::kIdentity);
#endif
    if (identity_status != ESP_OK && identity_status != ESP_ERR_NVS_NOT_FOUND && identity_status != ESP_ERR_INVALID_ARG) {
        ESP_ERROR_CHECK(identity_status);
    }
    // SerialEnrollment owns a 2 KiB protocol payload buffer. Keep it out of
    // app_main's small FreeRTOS stack for the process lifetime.
    static farmos::enrollment::SerialEnrollment serial_enrollment(
        "NODE", &farmos::node::config::kIdentity,
        [identity_usable](const farmos::identity::Identity& updated, const std::uint8_t* ticket_hash, std::size_t ticket_hash_len) {
            // A new factory identity must never inherit the previous board setup.
            if (!identity_usable && !farmos::reset::store_action(2)) return ESP_FAIL;
            const esp_err_t error = farmos::identity::store(updated, "NODE", ticket_hash, ticket_hash_len);
            if (error == ESP_OK) farmos::node::config::kIdentity = updated;
            return error;
        });
    if (!identity_usable) {
        // UART0 carries the binary FO enrollment protocol.  Finish this
        // human-readable console line before its task can write HELLO, or it
        // can be inserted in the middle of the JSON frame on a shared USB-UART
        // bridge and make the browser reject the frame.
        std::printf("[NODE] ENROLLMENT REQUIRED | use browser Web Serial; factory identity is not erased\n");
        std::fflush(stdout);
    }
    ESP_ERROR_CHECK(serial_enrollment.begin());
    if (!identity_usable) {
        while (!serial_enrollment.enrolled()) vTaskDelay(pdMS_TO_TICKS(250));
        vTaskDelay(pdMS_TO_TICKS(2000));
        esp_restart();
    }
    load_pairing();
    farmos::sensors::NodePeripherals peripherals;
    peripherals.begin(farmos::node::config::kSoilMoisturePin, farmos::node::config::kFloatPin, farmos::node::config::kRelayPin, farmos::node::config::kI2cSdaPin, farmos::node::config::kI2cSclPin);
    farmos::node::NodeCloud cloud;
    g_cloud = &cloud;
    ESP_ERROR_CHECK(cloud.begin());
    if (g_pairing.paired && service_mode) {
        // Keep the old binding in NVS as rollback. A successful new pairing
        // atomically replaces it; a reboot restores it if this attempt fails.
        g_pairing.paired = false;
        std::printf("[NODE] PAIRING MODE | BOOT held for 3 seconds\n");
    }
    cloud.set_lora_gateway_mode(g_pairing.paired);
    const std::uint32_t boot_id = next_boot_id();

    const std::string identity = identity_document(cloud);
    char short_name[9]{};
    std::snprintf(short_name, sizeof(short_name), "FN%06" PRIX32,
                  farmos::node::config::kNodeId & 0xFFFFFFU);
    const std::string ble_name = short_name;
    g_ble = std::make_unique<farmos::onboarding::BleProvisioningServer>(ble_name, identity, kBleUuids, accept_device_config);
    if (service_mode || reset_action == 2) g_ble->allow_bond_repair();
    g_ble->set_auth_handlers(
        [](const std::string& request) {
            return g_attestation.handle_challenge(
                farmos::node::config::kIdentity, request,
                static_cast<std::uint64_t>(esp_timer_get_time() / 1000));
        },
        []() { return g_attestation.response(); });
    const bool post_ota_service = farmos::node::NodeOta::boot_pending_verification();
    const bool ble_service_open = service_mode || post_ota_service ||
                                  (!cloud.standalone_active() && !g_pairing.paired);
    if (ble_service_open) {
        g_ble->set_ota_handlers(farmos::node::NodeOta::handle_write, farmos::node::NodeOta::handle_read);
    }
    ESP_ERROR_CHECK(g_ble->begin());
    if (!ble_service_open) g_ble->set_advertising(false);
    farmos::reset::start_button();

    farmos::radio::Sx1278Radio radio(farmos::node::config::kRadioPins);
    const bool radio_ready = radio.begin(farmos::node::config::kFrequencyHz) == ESP_OK;
    if (!radio_ready) std::printf("[NODE] lora=null | BLE/USB remain available\n");
    farmos::sensors::Ds18b20Bus ds18b20(farmos::node::config::kDs18b20Pin);
    bool ds_bus_ready = ds18b20.begin() == ESP_OK;
    farmos::sensors::OneWireRom probe{};
    bool probe_detected = ds_bus_ready && discover_probe(ds18b20, &probe);
    if (!service_mode && !cloud.standalone_active() && !g_pairing.paired && probe_detected) {
        farmos::node::NodeOta::confirm_running_image();
    }
    std::printf("[NODE] READY | id=%s | LoRa=433 MHz | DS18B20=GPIO%d | %s | BLE service=%s\n",
                farmos::node::config::kDeviceId, farmos::node::config::kDs18b20Pin,
                g_pairing.paired ? "paired" : "pairing open", ble_service_open ? "open" : "closed");

    std::uint32_t sequence = 1;
    bool station_received = false;
    while (true) {
        static std::uint32_t s_last_heartbeat_ms = 0;
        const std::uint32_t now_ms = static_cast<std::uint32_t>(esp_timer_get_time() / 1000);
        if (now_ms - s_last_heartbeat_ms >= 4000) {
            s_last_heartbeat_ms = now_ms;
            std::printf("[NODE] HEARTBEAT | uptime=%u s | id=%s | status=HOAT_DONG_TOT | state=%s\n",
                        static_cast<unsigned>(now_ms / 1000), farmos::node::config::kDeviceId,
                        g_pairing.paired ? "PAIRED" : "WAITING_GATEWAY");
        }

        if (post_ota_service && g_ble->advertising_enabled() &&
            farmos::node::NodeOta::post_ota_health_observed()) {
            g_ble->set_advertising(false);
            std::printf("[NODE] POST-OTA BLE | health observed by mobile; service closed\n");
        }
        if (farmos::node::NodeOta::in_progress()) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        if (cloud.consume_standalone_mode_commit()) commit_standalone_mode_binding();

        static std::uint32_t last_probe_ms = 0;
        if (!probe_detected && now_ms - last_probe_ms >= 5000) {
            last_probe_ms = now_ms;
            if (!ds_bus_ready) ds_bus_ready = ds18b20.begin() == ESP_OK;
            probe_detected = ds_bus_ready && discover_probe(ds18b20, &probe);
        }
        auto readings = read_environment(ds18b20, probe_detected ? &probe : nullptr);
        if (probe_detected && !(readings.valid_mask & farmos::protocol::kDs18b20FirstValid)) probe_detected = false;
        const bool needs_setup = !cloud.standalone_active() && !g_pairing.paired;
        const bool show_setup = needs_setup || (service_mode && g_ble->advertising_enabled());
        const char* connection_status = show_setup
            ? (needs_setup ? "CHUA CAI WI-FI" : "CAI DAT FARMOS")
            : cloud.standalone_active() ? "Che do Wi-Fi" :
            !radio_ready ? "Kiem tra LoRa" :
            !g_pairing.paired ? "Cai dat qua BLE" :
            station_received ? "Tram da nhan" : "Dang ket noi";
        const float soil_temperature = readings.valid_mask & farmos::protocol::kDs18b20FirstValid
            ? readings.probe_temperature_1_centi_c / 100.0f : NAN;
        // Read the same Preferences keys as noteessp32s3.ino; no defaults
        // become valid unless both flags and measured endpoints exist.
        std::int32_t dry = 0, wet = 0; std::uint8_t dry_ok = 0, wet_ok = 0;
        nvs_handle_t calibration{};
        if (nvs_open("farmos-rise", NVS_READONLY, &calibration) == ESP_OK) {
            const bool complete = nvs_get_i32(calibration, "dry", &dry) == ESP_OK &&
                nvs_get_i32(calibration, "wet", &wet) == ESP_OK &&
                nvs_get_u8(calibration, "dryok", &dry_ok) == ESP_OK &&
                nvs_get_u8(calibration, "wetok", &wet_ok) == ESP_OK;
            if (!complete) { dry_ok = 0; wet_ok = 0; }
            nvs_close(calibration);
        }
        // Temporary bench test for this one authorized node only. The two
        // endpoints are sample values from the supplied Arduino sketch, not
        // a measured calibration; suspect quality prevents agronomic advice.
        const bool test_calibration = cloud.standalone_active() &&
            std::strcmp(farmos::node::config::kDeviceId, "NODE_1339402427") == 0 && !(dry_ok == 1 && wet_ok == 1);
        if (test_calibration) { dry = 0; wet = 1280; dry_ok = 1; wet_ok = 1; }
        const auto extra = peripherals.read(connection_status, soil_temperature, show_setup, dry, wet, dry_ok == 1, wet_ok == 1, test_calibration);
        readings.soil_test_calibration = test_calibration;
        if (extra.soil_moisture_centi_pct >= 0) { readings.soil_moisture_centi_pct = static_cast<std::int16_t>(extra.soil_moisture_centi_pct); readings.valid_mask |= farmos::protocol::kSoilMoistureValid; }
        if (extra.air_temperature_valid) { readings.air_temperature = std::lround(extra.air_temperature * 100); readings.valid_mask |= farmos::protocol::kAirTemperatureValid; }
        if (extra.air_humidity_valid) { readings.air_humidity = std::lround(extra.air_humidity * 100); readings.valid_mask |= farmos::protocol::kAirHumidityValid; }
        char soil[24] = "null", soil_moisture[24] = "null", air[24] = "null", humidity[24] = "null", raw[24] = "null", contact[16] = "null";
        if (readings.valid_mask & farmos::protocol::kDs18b20FirstValid) std::snprintf(soil,sizeof(soil),"%.2f",readings.probe_temperature_1_centi_c/100.0);
        if (extra.air_temperature_valid) std::snprintf(air,sizeof(air),"%.2f",extra.air_temperature);
        if (extra.air_humidity_valid) std::snprintf(humidity,sizeof(humidity),"%.2f",extra.air_humidity);
        if (extra.soil_raw >= 0) std::snprintf(raw,sizeof(raw),"%d",extra.soil_raw);
        if (extra.soil_moisture_centi_pct >= 0) std::snprintf(soil_moisture,sizeof(soil_moisture),"%.2f",extra.soil_moisture_centi_pct / 100.0);
        if (extra.float_contact >= 0) std::snprintf(contact,sizeof(contact),"%d",extra.float_contact);
        std::printf("[NODE] DATA | soil_temperature=%s | soil_moisture=%s | soil_adc=%s | air_temperature=%s | air_humidity=%s | float_contact=%s | water_level=null | relay_command=%s | lcd=%s | lora=%s\n",soil,soil_moisture,raw,air,humidity,contact,farmos::node::pump::output_on() ? "ON" : "OFF",extra.lcd_present ? "ready" : "null",radio_ready ? "ready" : "null");
        if (!cloud.standalone_active() && (!g_pairing.paired || !radio_ready)) {
            if (radio_ready) pair_with_gateway(radio);
            vTaskDelay(pdMS_TO_TICKS(5000));
            continue;
        }

        if (cloud.standalone_active()) {
            if (readings.valid_mask) {
                farmos::node::DirectTelemetry direct{boot_id, sequence, readings.probe_temperature_1_centi_c,
                    static_cast<std::uint8_t>(readings.soil_test_calibration ? farmos::protocol::Quality::kSuspect : farmos::protocol::Quality::kValid),
                    readings.valid_mask, readings.air_temperature, readings.air_humidity, readings.soil_moisture_centi_pct};
                if (!cloud.enqueue(direct)) std::printf("[NODE] DIRECT CLOUD OUTBOX FULL | packet #%-4" PRIu32 "\n", sequence);
            }
            ++sequence;
            vTaskDelay(pdMS_TO_TICKS(farmos::node::config::kSendIntervalMs));
            continue;
        }
        const auto telemetry = make_telemetry(boot_id, sequence, readings);
        bool acknowledged = false;
        for (int attempt = 1; attempt <= farmos::node::config::kMaxAttempts; ++attempt) {
            farmos::radio::ReceiveMetadata metadata{};
            if (radio.send(&telemetry, sizeof(telemetry), 1000) == ESP_OK && wait_for_ack(radio, telemetry, &metadata)) {
                if (readings.valid_mask & farmos::protocol::kDs18b20FirstValid) {
                    std::printf("[NODE] TX #%-4" PRIu32 " | temp=%.2f C | try=%d | ACK | RSSI=%d | SNR=%.2f\n",
                                sequence, readings.probe_temperature_1_centi_c / 100.0F,
                                attempt, metadata.rssi_dbm, metadata.snr_db);
                } else {
                    std::printf("[NODE] TX #%-4" PRIu32 " | temp=null | try=%d | ACK | RSSI=%d | SNR=%.2f\n",
                                sequence, attempt, metadata.rssi_dbm, metadata.snr_db);
                }
                acknowledged = true;
                if (readings.valid_mask & farmos::protocol::kDs18b20FirstValid) farmos::node::NodeOta::confirm_running_image();
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(150 * attempt));
        }
        station_received = acknowledged;
        if (!acknowledged) std::printf("[NODE] LINK ERROR | packet #%-4" PRIu32 " | no ACK\n", sequence);
        ++sequence;
        vTaskDelay(pdMS_TO_TICKS(farmos::node::config::kSendIntervalMs));
    }
}
