#include "gateway_ota.h"
#include "sdkconfig.h"
#if !defined(CONFIG_FARMOS_DEVELOPMENT_IDENTITY) && !defined(CONFIG_SECURE_SIGNED_APPS)
#error "Production Gateway OTA requires ESP-IDF signed application verification."
#endif

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>

#include "board_config.h"
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "psa/crypto.h"

namespace farmos::gateway {
namespace {

constexpr char kTag[] = "farmos_ota";
constexpr std::size_t kResponseBufLimit = 4096;

struct HttpResponseBuf {
    std::string body;
};

std::string g_ota_gateway_id;
std::string g_ota_gateway_token;

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

bool partition_sha256(const esp_partition_t* partition, std::size_t size, std::uint8_t output[32]) {
    if (partition == nullptr || size == 0 || size > partition->size) return false;
    psa_hash_operation_t operation = PSA_HASH_OPERATION_INIT;
    if (psa_hash_setup(&operation, PSA_ALG_SHA_256) != PSA_SUCCESS) return false;
    std::uint8_t buffer[4096];
    for (std::size_t offset = 0; offset < size;) {
        const std::size_t length = std::min(sizeof(buffer), size - offset);
        if (esp_partition_read(partition, offset, buffer, length) != ESP_OK ||
            psa_hash_update(&operation, buffer, length) != PSA_SUCCESS) {
            psa_hash_abort(&operation);
            return false;
        }
        offset += length;
    }
    std::size_t output_length = 0;
    const bool ok = psa_hash_finish(&operation, output, 32, &output_length) == PSA_SUCCESS && output_length == 32;
    if (!ok) psa_hash_abort(&operation);
    return ok;
}

esp_err_t ota_client_init(esp_http_client_handle_t client) {
    esp_http_client_set_header(client, "x-farmos-gateway-id", g_ota_gateway_id.c_str());
    esp_http_client_set_header(client, "x-farmos-gateway-token", g_ota_gateway_token.c_str());
    return ESP_OK;
}

esp_err_t ota_http_event(esp_http_client_event_t* event) {
    auto* response = static_cast<HttpResponseBuf*>(event->user_data);
    if (event->event_id == HTTP_EVENT_ON_DATA && response != nullptr && event->data_len > 0 &&
        response->body.size() + static_cast<std::size_t>(event->data_len) <= kResponseBufLimit) {
        response->body.append(static_cast<const char*>(event->data), event->data_len);
    }
    return ESP_OK;
}

bool report_ota_status(const std::string& api_base, const std::string& target_ver,
                       const std::string& gateway_token, const char* status,
                       int progress, const char* error_msg, const char* job_id) {
    const std::string url = api_base + "/api/v1/ota/status";
    char body[512]{};
    std::snprintf(body, sizeof(body),
                  "{\"deviceId\":\"%s\",%s%s%s\"deviceType\":\"GATEWAY\",\"targetVersion\":\"%s\"," 
                  "\"status\":\"%s\",\"progress\":%d%s%s%s}",
                  config::kDeviceId, job_id ? "\"jobId\":\"" : "", job_id ? job_id : "", job_id ? "\"," : "",
                  target_ver.c_str(), status, progress,
                  error_msg ? ",\"error\":\"" : "", error_msg ? error_msg : "", error_msg ? "\"" : "");

    esp_http_client_config_t config{};
    config.url = url.c_str();
    config.timeout_ms = 8000;
    if (url.rfind("https://", 0) == 0) config.crt_bundle_attach = esp_crt_bundle_attach;

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == nullptr) return false;

    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "x-farmos-gateway-id", config::kDeviceId);
    esp_http_client_set_header(client, "x-farmos-gateway-token", gateway_token.c_str());
    esp_http_client_set_post_field(client, body, std::strlen(body));

    const esp_err_t result = esp_http_client_perform(client);
    const int status_code = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    return result == ESP_OK && status_code >= 200 && status_code < 300;
}

}  // namespace

void GatewayOta::init() {
    const esp_partition_t* running = esp_ota_get_running_partition();
    if (running == nullptr) return;

    esp_ota_img_states_t ota_state;
    if (esp_ota_get_state_partition(running, &ota_state) == ESP_OK) {
        if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
            ESP_LOGW(kTag, "New firmware is pending health verification");
        }
    }
}

void GatewayOta::confirm_running_image(const std::string& api_base, const std::string& gateway_token) {
    const esp_partition_t* running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (running != nullptr && esp_ota_get_state_partition(running, &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        if (!report_ota_status(api_base, config::kFirmwareVersion, gateway_token,
                               "BOOT_CONFIRMED", 100, nullptr, nullptr)) {
            ESP_LOGW(kTag, "Cannot confirm new firmware with server yet");
            return;
        }
        ESP_ERROR_CHECK_WITHOUT_ABORT(esp_ota_mark_app_valid_cancel_rollback());
        ESP_LOGI(kTag, "Cloud heartbeat succeeded; running firmware marked valid");
    }
}

bool GatewayOta::check_and_perform_update(const std::string& api_base, const std::string& gateway_token) {
    if (api_base.empty()) return false;

    const std::string check_url = api_base + "/api/v1/ota/check?deviceType=GATEWAY&currentVersion=" + config::kFirmwareVersion;
    HttpResponseBuf response{};

    esp_http_client_config_t config{};
    config.url = check_url.c_str();
    config.event_handler = ota_http_event;
    config.user_data = &response;
    config.timeout_ms = 10000;
    if (check_url.rfind("https://", 0) == 0) config.crt_bundle_attach = esp_crt_bundle_attach;

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == nullptr) {
        ESP_LOGE(kTag, "Failed to initialize HTTP client for OTA check");
        return false;
    }

    esp_http_client_set_method(client, HTTP_METHOD_GET);
    esp_http_client_set_header(client, "Accept", "application/json");
    if (!gateway_token.empty()) {
        esp_http_client_set_header(client, "x-farmos-gateway-id", config::kDeviceId);
        esp_http_client_set_header(client, "x-farmos-gateway-token", gateway_token.c_str());
    }

    const esp_err_t err = esp_http_client_perform(client);
    const int status_code = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);

    if (err != ESP_OK || status_code < 200 || status_code >= 300) {
        ESP_LOGD(kTag, "OTA check HTTP error: %s (status=%d)", esp_err_to_name(err), status_code);
        return false;
    }

    cJSON* root = cJSON_Parse(response.body.c_str());
    if (root == nullptr) {
        ESP_LOGW(kTag, "Invalid JSON in OTA check response");
        return false;
    }

    cJSON* data = cJSON_GetObjectItemCaseSensitive(root, "data");
    const cJSON* update_avail = data ? cJSON_GetObjectItemCaseSensitive(data, "updateAvailable") : nullptr;
    if (!cJSON_IsTrue(update_avail)) {
        cJSON_Delete(root);
        return false;
    }

    const cJSON* download_url_item = cJSON_GetObjectItemCaseSensitive(data, "downloadUrl");
    const cJSON* latest_rel = cJSON_GetObjectItemCaseSensitive(data, "latestRelease");
    const cJSON* version_item = latest_rel ? cJSON_GetObjectItemCaseSensitive(latest_rel, "version") : nullptr;
    const cJSON* sha_item = latest_rel ? cJSON_GetObjectItemCaseSensitive(latest_rel, "sha256") : nullptr;
    const cJSON* size_item = latest_rel ? cJSON_GetObjectItemCaseSensitive(latest_rel, "sizeBytes") : nullptr;
    const cJSON* job_item = cJSON_GetObjectItemCaseSensitive(data, "jobId");

    if (!cJSON_IsString(download_url_item) || !cJSON_IsString(version_item) ||
        !cJSON_IsString(sha_item) || std::strlen(sha_item->valuestring) != 64 ||
        !cJSON_IsNumber(size_item) || size_item->valuedouble <= 0 || !cJSON_IsString(job_item)) {
        ESP_LOGW(kTag, "Incomplete OTA release metadata");
        cJSON_Delete(root);
        return false;
    }

    const std::string target_ver = version_item->valuestring;
    const std::string job_id = job_item->valuestring;
    const std::string rel_download_url = download_url_item->valuestring;
    const std::size_t expected_size = static_cast<std::size_t>(size_item->valuedouble);
    std::uint8_t expected_sha256[32]{};
    if (!parse_sha256(sha_item->valuestring, expected_sha256)) {
        cJSON_Delete(root);
        return false;
    }
    if (!newer_version(target_ver.c_str(), config::kFirmwareVersion)) { cJSON_Delete(root); return false; }
    cJSON_Delete(root);

    const std::string full_download_url = (rel_download_url.rfind("http", 0) == 0)
                                              ? rel_download_url
                                              : (api_base + rel_download_url);

    std::printf("[GATEWAY OTA] New version available: v%s (Current: v%s)\n",
                target_ver.c_str(), config::kFirmwareVersion);
    std::printf("[GATEWAY OTA] Downloading binary from: %s\n", full_download_url.c_str());

    if (!report_ota_status(api_base, target_ver, gateway_token, "DOWNLOADING", 10, nullptr, job_id.c_str())) return false;

    esp_http_client_config_t ota_http_config{};
    ota_http_config.url = full_download_url.c_str();
    ota_http_config.timeout_ms = 40000;
    ota_http_config.keep_alive_enable = true;
    if (full_download_url.rfind("https://", 0) == 0) {
        ota_http_config.crt_bundle_attach = esp_crt_bundle_attach;
    }

    esp_https_ota_config_t ota_config{};
    ota_config.http_config = &ota_http_config;
    g_ota_gateway_id = config::kDeviceId;
    g_ota_gateway_token = gateway_token;
    ota_config.http_client_init_cb = ota_client_init;

    if (!report_ota_status(api_base, target_ver, gateway_token, "FLASHING", 50, nullptr, job_id.c_str())) return false;

    const esp_partition_t* previous_partition = esp_ota_get_running_partition();
    const esp_partition_t* update_partition = esp_ota_get_next_update_partition(nullptr);
    const esp_err_t ota_ret = esp_https_ota(&ota_config);
    if (ota_ret == ESP_OK) {
        std::uint8_t actual_sha256[32]{};
        if (!partition_sha256(update_partition, expected_size, actual_sha256) ||
            std::memcmp(actual_sha256, expected_sha256, sizeof(actual_sha256)) != 0) {
            if (previous_partition != nullptr) esp_ota_set_boot_partition(previous_partition);
            ESP_LOGE(kTag, "Downloaded firmware SHA-256 does not match release manifest");
            (void)report_ota_status(api_base, target_ver, gateway_token, "FAILED", 0, "SHA-256 mismatch", job_id.c_str());
            return false;
        }
        esp_app_desc_t description{};
        if (esp_ota_get_partition_description(update_partition, &description) != ESP_OK ||
            std::strcmp(description.project_name, "farmos_gateway") != 0 ||
            std::strcmp(description.version, target_ver.c_str()) != 0) {
            if (previous_partition != nullptr) esp_ota_set_boot_partition(previous_partition);
            (void)report_ota_status(api_base, target_ver, gateway_token, "FAILED", 0,
                                    "Firmware target/version mismatch", job_id.c_str());
            return false;
        }
        std::printf("[GATEWAY OTA] FLASH SUCCESS! Upgrade to v%s complete. Rebooting...\n", target_ver.c_str());
        if (!report_ota_status(api_base, target_ver, gateway_token, "FLASHED", 100, nullptr, job_id.c_str())) {
            if (previous_partition != nullptr) esp_ota_set_boot_partition(previous_partition);
            return false;
        }
        vTaskDelay(pdMS_TO_TICKS(1500));
        esp_restart();
        return true;
    } else {
        ESP_LOGE(kTag, "esp_https_ota failed: %s", esp_err_to_name(ota_ret));
        (void)report_ota_status(api_base, target_ver, gateway_token, "FAILED", 0, esp_err_to_name(ota_ret), job_id.c_str());
        return false;
    }
}

}  // namespace farmos::gateway
