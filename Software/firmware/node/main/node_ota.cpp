#include "node_ota.h"
#include "sdkconfig.h"
#if !defined(CONFIG_FARMOS_DEVELOPMENT_IDENTITY) && !defined(CONFIG_SECURE_SIGNED_APPS)
#error "Production Node OTA requires ESP-IDF signed application verification."
#endif

#include <atomic>
#include <cstdio>
#include <cstring>
#include <string>

#include "board_config.h"
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "psa/crypto.h"

namespace farmos::node {
namespace {

constexpr char kTag[] = "farmos_node_ota";
constexpr std::int64_t kSessionTimeoutMs = 30'000;

enum class OtaState {
    kIdle,
    kReceiving,
    kVerifying,
    kSuccess,
    kError,
};

OtaState g_state = OtaState::kIdle;
esp_ota_handle_t g_ota_handle = 0;
const esp_partition_t* g_update_partition = nullptr;
std::size_t g_total_bytes = 0;
std::size_t g_written_bytes = 0;
char g_target_version[32]{};
char g_error_message[64]{};
std::uint8_t g_expected_sha256[32]{};
psa_hash_operation_t g_sha256 = PSA_HASH_OPERATION_INIT;
bool g_sha256_active = false;
std::atomic_bool g_boot_pending_verification{false};
std::atomic_bool g_post_ota_health_observed{false};
std::int64_t g_last_activity_ms = 0;
SemaphoreHandle_t g_ota_mutex = nullptr;

class OtaLock {
public:
    OtaLock() {
        if (g_ota_mutex != nullptr) xSemaphoreTake(g_ota_mutex, portMAX_DELAY);
    }
    ~OtaLock() {
        if (g_ota_mutex != nullptr) xSemaphoreGive(g_ota_mutex);
    }
};

std::int64_t now_ms() {
    return esp_timer_get_time() / 1000;
}

bool parse_sha256(const char* value, std::uint8_t output[32]) {
    if (value == nullptr || std::strlen(value) != 64) return false;
    for (std::size_t i = 0; i < 32; ++i) {
        unsigned byte = 0;
        if (std::sscanf(value + i * 2, "%2x", &byte) != 1) return false;
        output[i] = static_cast<std::uint8_t>(byte);
    }
    return true;
}

bool newer_version(const char* candidate, const char* current) {
    unsigned a = 0, b = 0, c = 0, x = 0, y = 0, z = 0;
    if (std::sscanf(candidate, "%u.%u.%u", &a, &b, &c) != 3 ||
        std::sscanf(current, "%u.%u.%u", &x, &y, &z) != 3) return false;
    return a != x ? a > x : b != y ? b > y : c > z;
}

void close_hash() {
    if (g_sha256_active) psa_hash_abort(&g_sha256);
    g_sha256 = PSA_HASH_OPERATION_INIT;
    g_sha256_active = false;
}

void abort_active_ota(const char* reason) {
    if (g_ota_handle != 0) {
        const esp_err_t error = esp_ota_abort(g_ota_handle);
        if (error != ESP_OK) ESP_LOGW(kTag, "esp_ota_abort failed: %d", error);
        g_ota_handle = 0;
    }
    close_hash();
    // Do not expose stale progress or target metadata after a timeout/client
    // abort. A fresh START must begin with a clean session in both the
    // transport and the status characteristic.
    g_update_partition = nullptr;
    g_total_bytes = 0;
    g_written_bytes = 0;
    g_target_version[0] = '\0';
    std::memset(g_expected_sha256, 0, sizeof(g_expected_sha256));
    g_last_activity_ms = 0;
    g_state = OtaState::kIdle;
    std::snprintf(g_error_message, sizeof(g_error_message), "OTA aborted: %s", reason);
    ESP_LOGW(kTag, "%s", g_error_message);
}

void restart_task(void*) {
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();
}

}  // namespace

void NodeOta::init() {
    if (g_ota_mutex == nullptr) g_ota_mutex = xSemaphoreCreateMutex();
    const esp_partition_t* running = esp_ota_get_running_partition();
    if (running == nullptr) return;

    esp_ota_img_states_t ota_state;
    if (esp_ota_get_state_partition(running, &ota_state) == ESP_OK) {
        if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
            g_boot_pending_verification = true;
            ESP_LOGW(kTag, "New Node firmware is pending peripheral health verification");
        }
    }
}

void NodeOta::confirm_running_image() {
    const esp_partition_t* running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (running != nullptr && esp_ota_get_state_partition(running, &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_ERROR_CHECK_WITHOUT_ABORT(esp_ota_mark_app_valid_cancel_rollback());
        ESP_LOGI(kTag, "BLE, radio and sensor initialized; running firmware marked valid");
    }
}

bool NodeOta::in_progress() {
    OtaLock lock;
    const bool active = g_state == OtaState::kReceiving || g_state == OtaState::kVerifying;
    if (active && g_last_activity_ms > 0 && now_ms() - g_last_activity_ms > kSessionTimeoutMs) {
        abort_active_ota("client timeout");
        return false;
    }
    return active;
}

bool NodeOta::boot_pending_verification() {
    return g_boot_pending_verification.load();
}

bool NodeOta::post_ota_health_observed() {
    return g_post_ota_health_observed.load();
}

bool NodeOta::handle_write(const std::uint8_t* data, std::size_t len) {
    if (data == nullptr || len == 0) return false;
    OtaLock lock;

    // Check if packet is a JSON control command (starts with '{')
    if (data[0] == '{') {
        cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(data), len);
        if (root == nullptr) {
            ESP_LOGW(kTag, "Malformed JSON command");
            return false;
        }

        const cJSON* cmd_item = cJSON_GetObjectItemCaseSensitive(root, "cmd");
        if (!cJSON_IsString(cmd_item) || cmd_item->valuestring == nullptr) {
            cJSON_Delete(root);
            return false;
        }

        const std::string cmd = cmd_item->valuestring;

        if (cmd == "START") {
            if (g_state == OtaState::kSuccess) {
                std::snprintf(g_error_message, sizeof(g_error_message), "OTA reboot is pending");
                cJSON_Delete(root);
                return false;
            }
            if (g_state == OtaState::kReceiving || g_state == OtaState::kVerifying) {
                std::snprintf(g_error_message, sizeof(g_error_message), "OTA already in progress");
                cJSON_Delete(root);
                return false;
            }
            const cJSON* size_item = cJSON_GetObjectItemCaseSensitive(root, "size");
            const cJSON* ver_item = cJSON_GetObjectItemCaseSensitive(root, "version");
            const cJSON* sha_item = cJSON_GetObjectItemCaseSensitive(root, "sha256");
            const std::size_t size = (size_item && cJSON_IsNumber(size_item)) ? static_cast<std::size_t>(size_item->valuedouble) : 0;
            const char* ver = (ver_item && cJSON_IsString(ver_item)) ? ver_item->valuestring : "unknown";

            if (!newer_version(ver, config::kFirmwareVersion)) {
                std::snprintf(g_error_message, sizeof(g_error_message), "OTA version must be newer");
                g_state = OtaState::kError;
                cJSON_Delete(root);
                return false;
            }

            std::snprintf(g_target_version, sizeof(g_target_version), "%s", ver);
            g_total_bytes = size;
            g_written_bytes = 0;
            g_error_message[0] = '\0';
            g_last_activity_ms = 0;

            g_update_partition = esp_ota_get_next_update_partition(nullptr);
            if (g_update_partition == nullptr) {
                std::snprintf(g_error_message, sizeof(g_error_message), "No OTA partition found");
                g_state = OtaState::kError;
                cJSON_Delete(root);
                return false;
            }
            if (size == 0 || size > g_update_partition->size || !cJSON_IsString(sha_item) ||
                !parse_sha256(sha_item->valuestring, g_expected_sha256)) {
                std::snprintf(g_error_message, sizeof(g_error_message), "Invalid OTA size or SHA-256");
                g_state = OtaState::kError;
                cJSON_Delete(root);
                return false;
            }

            esp_err_t err = esp_ota_begin(g_update_partition, size > 0 ? size : OTA_SIZE_UNKNOWN, &g_ota_handle);
            if (err != ESP_OK) {
                std::snprintf(g_error_message, sizeof(g_error_message), "esp_ota_begin failed: %d", err);
                g_state = OtaState::kError;
                cJSON_Delete(root);
                return false;
            }
            close_hash();
            if (psa_hash_setup(&g_sha256, PSA_ALG_SHA_256) != PSA_SUCCESS) {
                esp_ota_abort(g_ota_handle);
                g_ota_handle = 0;
                std::snprintf(g_error_message, sizeof(g_error_message), "Cannot initialize SHA-256");
                g_state = OtaState::kError;
                cJSON_Delete(root);
                return false;
            }
            g_sha256_active = true;

            g_state = OtaState::kReceiving;
            g_last_activity_ms = now_ms();
            ESP_LOGI(kTag, "OTA START: target=v%s, size=%u bytes, partition=%s",
                     g_target_version, static_cast<unsigned>(g_total_bytes), g_update_partition->label);
            cJSON_Delete(root);
            return true;
        }

        if (cmd == "FINISH") {
            if (g_state != OtaState::kReceiving) {
                std::snprintf(g_error_message, sizeof(g_error_message), "FINISH called while not in receiving state");
                cJSON_Delete(root);
                return false;
            }

            g_state = OtaState::kVerifying;
            g_last_activity_ms = now_ms();
            if (g_written_bytes != g_total_bytes) {
                esp_ota_abort(g_ota_handle);
                g_ota_handle = 0;
                close_hash();
                std::snprintf(g_error_message, sizeof(g_error_message), "Firmware size mismatch");
                g_state = OtaState::kError;
                cJSON_Delete(root);
                return false;
            }
            std::uint8_t actual_sha256[32]{};
            std::size_t actual_length = 0;
            if (!g_sha256_active || psa_hash_finish(&g_sha256, actual_sha256, sizeof(actual_sha256), &actual_length) != PSA_SUCCESS ||
                actual_length != sizeof(actual_sha256) ||
                std::memcmp(actual_sha256, g_expected_sha256, sizeof(actual_sha256)) != 0) {
                esp_ota_abort(g_ota_handle);
                g_ota_handle = 0;
                close_hash();
                std::snprintf(g_error_message, sizeof(g_error_message), "Firmware SHA-256 mismatch");
                g_state = OtaState::kError;
                cJSON_Delete(root);
                return false;
            }
            g_sha256_active = false;
            g_sha256 = PSA_HASH_OPERATION_INIT;
            const esp_ota_handle_t finished_handle = g_ota_handle;
            esp_err_t err = esp_ota_end(finished_handle);
            g_ota_handle = 0;
            if (err != ESP_OK) {
                // esp_ota_end can fail before consuming the handle (for
                // example when the image is incomplete). Best-effort abort
                // prevents an OTA session from remaining open indefinitely.
                (void)esp_ota_abort(finished_handle);
                std::snprintf(g_error_message, sizeof(g_error_message), "esp_ota_end failed: %d", err);
                g_state = OtaState::kError;
                cJSON_Delete(root);
                return false;
            }

            esp_app_desc_t description{};
            if (esp_ota_get_partition_description(g_update_partition, &description) != ESP_OK ||
                std::strcmp(description.project_name, "farmos_node") != 0 ||
                std::strcmp(description.version, g_target_version) != 0) {
                std::snprintf(g_error_message, sizeof(g_error_message), "Firmware target/version mismatch");
                g_state = OtaState::kError;
                cJSON_Delete(root);
                return false;
            }

            err = esp_ota_set_boot_partition(g_update_partition);
            if (err != ESP_OK) {
                std::snprintf(g_error_message, sizeof(g_error_message), "esp_ota_set_boot_partition failed: %d", err);
                g_state = OtaState::kError;
                cJSON_Delete(root);
                return false;
            }

            g_state = OtaState::kSuccess;
            ESP_LOGI(kTag, "OTA SUCCESS: Upgraded to v%s. Rebooting in 1.5s...", g_target_version);
            cJSON_Delete(root);

            xTaskCreate(restart_task, "ota_restart", 2048, nullptr, 5, nullptr);
            return true;
        }

        if (cmd == "ABORT") {
            // FINISH schedules a reboot after the new boot partition is set.
            // Do not overwrite a successful state if a late best-effort ABORT
            // arrives while the BLE link is being torn down.
            if (g_state == OtaState::kSuccess) {
                cJSON_Delete(root);
                return true;
            }
            abort_active_ota("client request");
            cJSON_Delete(root);
            return true;
        }

        cJSON_Delete(root);
        return false;
    }

    // Binary chunk write
    if (g_state != OtaState::kReceiving) {
        ESP_LOGW(kTag, "Chunk received but not in receiving state");
        return false;
    }

    if (g_written_bytes + len > g_total_bytes) {
        abort_active_ota("firmware exceeds declared size");
        std::snprintf(g_error_message, sizeof(g_error_message), "Firmware exceeds declared size");
        g_state = OtaState::kError;
        return false;
    }
    esp_err_t err = esp_ota_write(g_ota_handle, data, len);
    if (err != ESP_OK) {
        abort_active_ota("esp_ota_write failed");
        std::snprintf(g_error_message, sizeof(g_error_message), "esp_ota_write failed: %d", err);
        g_state = OtaState::kError;
        return false;
    }
    if (!g_sha256_active || psa_hash_update(&g_sha256, data, len) != PSA_SUCCESS) {
        abort_active_ota("SHA-256 update failed");
        std::snprintf(g_error_message, sizeof(g_error_message), "SHA-256 update failed");
        g_state = OtaState::kError;
        return false;
    }

    g_written_bytes += len;
    g_last_activity_ms = now_ms();
    return true;
}

std::string NodeOta::handle_read() {
    OtaLock lock;
    const char* state_str = "IDLE";
    switch (g_state) {
        case OtaState::kIdle: state_str = "IDLE"; break;
        case OtaState::kReceiving: state_str = "RECEIVING"; break;
        case OtaState::kVerifying: state_str = "VERIFYING"; break;
        case OtaState::kSuccess: state_str = "SUCCESS"; break;
        case OtaState::kError: state_str = "ERROR"; break;
    }

    const int progress = (g_total_bytes > 0)
                             ? static_cast<int>((g_written_bytes * 100) / g_total_bytes)
                             : (g_state == OtaState::kSuccess ? 100 : 0);

    bool health_confirmed = true;
    const esp_partition_t* running = esp_ota_get_running_partition();
    esp_ota_img_states_t image_state{};
    if (running && esp_ota_get_state_partition(running, &image_state) == ESP_OK) {
        health_confirmed = image_state != ESP_OTA_IMG_PENDING_VERIFY;
    }
    if (g_boot_pending_verification && health_confirmed) {
        // Mobile has now observed both the rebooted version and its health proof.
        // main.cpp may safely stop the temporary post-OTA advertisement.
        g_post_ota_health_observed = true;
    }
    char buf[320]{};
    std::snprintf(buf, sizeof(buf),
                  "{\"state\":\"%s\",\"progress\":%d,\"written\":%u,\"total\":%u,\"version\":\"%s\",\"healthConfirmed\":%s,\"error\":\"%s\"}",
                  state_str, progress, static_cast<unsigned>(g_written_bytes),
                  static_cast<unsigned>(g_total_bytes),
                  g_target_version[0] ? g_target_version : config::kFirmwareVersion,
                  health_confirmed ? "true" : "false",
                  g_error_message);

    return std::string(buf);
}

}  // namespace farmos::node
