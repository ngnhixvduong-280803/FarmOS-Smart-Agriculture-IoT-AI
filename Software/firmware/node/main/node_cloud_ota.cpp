#include "node_cloud_ota.h"

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
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "psa/crypto.h"

namespace farmos::node {
namespace {
constexpr char kTag[] = "node_cloud_ota";
constexpr std::size_t kResponseLimit = 4096;
std::string g_device_token;

struct Response { std::string body; };

esp_err_t response_event(esp_http_client_event_t* event) {
    auto* response = static_cast<Response*>(event->user_data);
    if (event->event_id == HTTP_EVENT_ON_DATA && response && event->data_len > 0 &&
        response->body.size() + static_cast<std::size_t>(event->data_len) <= kResponseLimit) {
        response->body.append(static_cast<const char*>(event->data), event->data_len);
    }
    return ESP_OK;
}

void add_device_headers(esp_http_client_handle_t client, const std::string& token) {
    esp_http_client_set_header(client, "x-farmos-device-id", config::kDeviceId);
    esp_http_client_set_header(client, "x-farmos-device-token", token.c_str());
}

esp_err_t ota_client_init(esp_http_client_handle_t client) {
    add_device_headers(client, g_device_token);
    return ESP_OK;
}

bool parse_sha256(const char* value, std::uint8_t output[32]) {
    if (!value || std::strlen(value) != 64) return false;
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
    if (!partition || !size || size > partition->size) return false;
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
    std::size_t actual = 0;
    return psa_hash_finish(&operation, output, 32, &actual) == PSA_SUCCESS && actual == 32;
}

bool report(const std::string& api_base, const std::string& token, const std::string& version,
            const char* status, int progress, const char* job_id, const char* error) {
    const std::string url = api_base + "/api/v1/ota/status";
    char body[640]{};
    std::snprintf(body, sizeof(body),
        "{\"deviceId\":\"%s\",%s%s%s\"deviceType\":\"SENSOR_NODE\",\"targetVersion\":\"%s\","
        "\"status\":\"%s\",\"progress\":%d%s%s%s}",
        config::kDeviceId, job_id ? "\"jobId\":\"" : "", job_id ? job_id : "", job_id ? "\"," : "",
        version.c_str(), status, progress, error ? ",\"error\":\"" : "", error ? error : "", error ? "\"" : "");
    esp_http_client_config_t http_cfg{};
    http_cfg.url = url.c_str();
    http_cfg.timeout_ms = 10000;
    if (url.rfind("https://", 0) == 0) http_cfg.crt_bundle_attach = esp_crt_bundle_attach;
    auto* client = esp_http_client_init(&http_cfg);
    if (!client) return false;
    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    add_device_headers(client, token);
    esp_http_client_set_post_field(client, body, std::strlen(body));
    const esp_err_t result = esp_http_client_perform(client);
    const int code = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    return result == ESP_OK && code >= 200 && code < 300;
}
}  // namespace

bool NodeCloudOta::confirm_running_image(const std::string& api_base, const std::string& device_token) {
    const esp_partition_t* running = esp_ota_get_running_partition();
    esp_ota_img_states_t state{};
    if (!running || esp_ota_get_state_partition(running, &state) != ESP_OK || state != ESP_OTA_IMG_PENDING_VERIFY) return true;
    if (!report(api_base, device_token, config::kFirmwareVersion, "BOOT_CONFIRMED", 100, nullptr, nullptr)) return false;
    return esp_ota_mark_app_valid_cancel_rollback() == ESP_OK;
}

bool NodeCloudOta::check_and_perform_update(const std::string& api_base, const std::string& device_token) {
    const std::string check_url = api_base + "/api/v1/ota/check?deviceType=SENSOR_NODE&currentVersion=" + config::kFirmwareVersion;
    Response response{};
    esp_http_client_config_t check_cfg{};
    check_cfg.url = check_url.c_str();
    check_cfg.event_handler = response_event;
    check_cfg.user_data = &response;
    check_cfg.timeout_ms = 10000;
    if (check_url.rfind("https://", 0) == 0) check_cfg.crt_bundle_attach = esp_crt_bundle_attach;
    auto* client = esp_http_client_init(&check_cfg);
    if (!client) return false;
    esp_http_client_set_method(client, HTTP_METHOD_GET);
    add_device_headers(client, device_token);
    const esp_err_t request = esp_http_client_perform(client);
    const int code = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (request != ESP_OK || code < 200 || code >= 300) return false;

    cJSON* root = cJSON_Parse(response.body.c_str());
    cJSON* data = root ? cJSON_GetObjectItemCaseSensitive(root, "data") : nullptr;
    cJSON* release = data ? cJSON_GetObjectItemCaseSensitive(data, "latestRelease") : nullptr;
    const cJSON* available = data ? cJSON_GetObjectItemCaseSensitive(data, "updateAvailable") : nullptr;
    const cJSON* download = data ? cJSON_GetObjectItemCaseSensitive(data, "downloadUrl") : nullptr;
    const cJSON* job = data ? cJSON_GetObjectItemCaseSensitive(data, "jobId") : nullptr;
    const cJSON* version = release ? cJSON_GetObjectItemCaseSensitive(release, "version") : nullptr;
    const cJSON* sha = release ? cJSON_GetObjectItemCaseSensitive(release, "sha256") : nullptr;
    const cJSON* size = release ? cJSON_GetObjectItemCaseSensitive(release, "sizeBytes") : nullptr;
    if (!cJSON_IsTrue(available)) { cJSON_Delete(root); return false; }
    if (!cJSON_IsString(download) || !cJSON_IsString(job) || !cJSON_IsString(version) ||
        !cJSON_IsString(sha) || !cJSON_IsNumber(size) || size->valuedouble <= 0) {
        cJSON_Delete(root); return false;
    }
    const std::string target_version = version->valuestring;
    const std::string job_id = job->valuestring;
    const std::string relative_url = download->valuestring;
    const std::size_t expected_size = static_cast<std::size_t>(size->valuedouble);
    std::uint8_t expected_hash[32]{};
    if (!parse_sha256(sha->valuestring, expected_hash) ||
        !newer_version(target_version.c_str(), config::kFirmwareVersion)) { cJSON_Delete(root); return false; }
    cJSON_Delete(root);

    const std::string download_url = relative_url.rfind("http", 0) == 0 ? relative_url : api_base + relative_url;
    if (!report(api_base, device_token, target_version, "DOWNLOADING", 10, job_id.c_str(), nullptr)) return false;
    esp_http_client_config_t download_cfg{};
    download_cfg.url = download_url.c_str();
    download_cfg.timeout_ms = 40000;
    download_cfg.keep_alive_enable = true;
    if (download_url.rfind("https://", 0) == 0) download_cfg.crt_bundle_attach = esp_crt_bundle_attach;
    esp_https_ota_config_t ota_cfg{};
    ota_cfg.http_config = &download_cfg;
    g_device_token = device_token;
    ota_cfg.http_client_init_cb = ota_client_init;
    if (!report(api_base, device_token, target_version, "FLASHING", 50, job_id.c_str(), nullptr)) return false;
    const esp_partition_t* previous = esp_ota_get_running_partition();
    const esp_partition_t* update = esp_ota_get_next_update_partition(nullptr);
    const esp_err_t result = esp_https_ota(&ota_cfg);
    if (result != ESP_OK) {
        (void)report(api_base, device_token, target_version, "FAILED", 0, job_id.c_str(), esp_err_to_name(result));
        return false;
    }
    std::uint8_t actual_hash[32]{};
    if (!partition_sha256(update, expected_size, actual_hash) || std::memcmp(actual_hash, expected_hash, 32) != 0) {
        if (previous) esp_ota_set_boot_partition(previous);
        (void)report(api_base, device_token, target_version, "FAILED", 0, job_id.c_str(), "SHA-256 mismatch");
        return false;
    }
    esp_app_desc_t description{};
    if (esp_ota_get_partition_description(update, &description) != ESP_OK ||
        std::strcmp(description.project_name, "farmos_node") != 0 ||
        std::strcmp(description.version, target_version.c_str()) != 0) {
        if (previous) esp_ota_set_boot_partition(previous);
        (void)report(api_base, device_token, target_version, "FAILED", 0, job_id.c_str(), "Firmware target/version mismatch");
        return false;
    }
    if (!report(api_base, device_token, target_version, "FLASHED", 100, job_id.c_str(), nullptr)) {
        if (previous) esp_ota_set_boot_partition(previous);
        return false;
    }
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();
    return true;
}

}  // namespace farmos::node
