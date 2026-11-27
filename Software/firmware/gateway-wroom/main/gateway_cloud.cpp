#include "gateway_cloud.h"
#include "gateway_ota.h"
#include "telemetry_outbox.h"

#include <algorithm>
#include <cinttypes>
#include <ctime>
#include <cstdio>
#include <cstring>
#include <string>

#include "board_config.h"
#include "device_reset.h"
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs.h"
#include "sdkconfig.h"

namespace farmos::gateway {
namespace {

constexpr EventBits_t kWifiConnected = BIT0;
constexpr std::size_t kHttpResponseLimit = 4096;
constexpr std::int8_t kWifiTxPowerQuarterDbm = 52;  // 13 dBm

struct HttpResponse {
    std::string body;
};

struct CloudSettings {
    char ssid[33]{};
    char password[65]{};
    char api_base[160]{};
    char session_id[48]{};
    char provisioning_token[128]{};
    char gateway_token[128]{};
};

esp_err_t http_event(esp_http_client_event_t* event) {
    auto* response = static_cast<HttpResponse*>(event->user_data);
    if (event->event_id == HTTP_EVENT_ON_DATA && response != nullptr && event->data_len > 0 &&
        response->body.size() + static_cast<std::size_t>(event->data_len) <= kHttpResponseLimit) {
        response->body.append(static_cast<const char*>(event->data), event->data_len);
    }
    return ESP_OK;
}

bool json_string(cJSON* root, const char* key, char* output, std::size_t size) {
    const cJSON* item = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsString(item) || item->valuestring == nullptr || std::strlen(item->valuestring) >= size) return false;
    std::snprintf(output, size, "%s", item->valuestring);
    return true;
}

void wifi_event(void* arg, esp_event_base_t base, std::int32_t id, void*) {
    auto* events = static_cast<EventGroupHandle_t*>(arg);
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(*events, kWifiConnected);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(*events, kWifiConnected);
        esp_wifi_connect();
    }
}

}  // namespace

struct GatewayCloud::Impl : CloudSettings {
    QueueHandle_t settings_queue{xQueueCreate(1, sizeof(CloudSettings))};
    bool configured{false};
    bool authenticated{false};
    bool wifi_started{false};
    EventGroupHandle_t wifi_events{xEventGroupCreate()};
    TelemetryOutbox outbox;
    QueueHandle_t confirmations{xQueueCreate(8, sizeof(PairingGrant))};
    PairingGrant pairing{};
    std::int64_t pairing_deadline_ms{0};
    portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;

    void load() {
        nvs_handle_t handle = 0;
        if (nvs_open("farmos_cloud", NVS_READONLY, &handle) != ESP_OK) return;
        CloudSettings saved{};
        std::size_t saved_size = sizeof(saved);
        if (nvs_get_blob(handle, "settings_v1", &saved, &saved_size) == ESP_OK &&
            saved_size == sizeof(saved)) {
            *static_cast<CloudSettings*>(this) = saved;
            configured = ssid[0] != 0 && api_base[0] != 0;
            authenticated = gateway_token[0] != 0;
            nvs_close(handle);
            return;
        }
        auto read = [&](const char* key, char* target, std::size_t capacity) {
            std::size_t length = capacity;
            return nvs_get_str(handle, key, target, &length) == ESP_OK;
        };
        configured = read("ssid", ssid, sizeof(ssid)) && read("api", api_base, sizeof(api_base));
        read("password", password, sizeof(password));
        authenticated = read("gw_token", gateway_token, sizeof(gateway_token));
        if (!authenticated) {
            read("session", session_id, sizeof(session_id));
            read("prov_token", provisioning_token, sizeof(provisioning_token));
        }
        nvs_close(handle);
    }

    void save_config() {
        nvs_handle_t handle = 0;
        ESP_ERROR_CHECK(nvs_open("farmos_cloud", NVS_READWRITE, &handle));
        ESP_ERROR_CHECK(nvs_set_blob(handle, "settings_v1",
                                    static_cast<const CloudSettings*>(this), sizeof(CloudSettings)));
        ESP_ERROR_CHECK(nvs_commit(handle));
        nvs_close(handle);
    }

    void save_gateway_token() {
        provisioning_token[0] = '\0';
        session_id[0] = '\0';
        save_config();
    }

    bool start_wifi() {
        if (!wifi_started) {
            ESP_ERROR_CHECK(esp_netif_init());
            ESP_ERROR_CHECK(esp_event_loop_create_default());
            esp_netif_create_default_wifi_sta();
            wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
            ESP_ERROR_CHECK(esp_wifi_init(&init));
            ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
            ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, &wifi_events));
            ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, &wifi_events));
            ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
            ESP_ERROR_CHECK(esp_wifi_start());
            ESP_ERROR_CHECK(esp_wifi_set_max_tx_power(kWifiTxPowerQuarterDbm));
            ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_MIN_MODEM));
            wifi_started = true;
        }
        wifi_config_t config{};
        std::memcpy(config.sta.ssid, ssid,
                    std::min(std::strlen(ssid), sizeof(config.sta.ssid)));
        std::memcpy(config.sta.password, password,
                    std::min(std::strlen(password), sizeof(config.sta.password)));
        config.sta.threshold.authmode = std::strlen(password) == 0 ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
        xEventGroupClearBits(wifi_events, kWifiConnected);
        esp_wifi_disconnect();
        if (esp_wifi_set_config(WIFI_IF_STA, &config) != ESP_OK) return false;
        // DISCONNECTED handler may already have requested a connection.
        const esp_err_t connect_error = esp_wifi_connect();
        if (connect_error != ESP_OK && connect_error != ESP_ERR_WIFI_CONN) return false;
        return (xEventGroupWaitBits(wifi_events, kWifiConnected, pdFALSE, pdFALSE, pdMS_TO_TICKS(20'000)) & kWifiConnected) != 0;
    }

    bool http(const char* method, const std::string& path, const std::string& body,
              std::string* response_body, bool gateway_auth) {
        const std::string url = std::string(api_base) + "/api/v1/onboarding" + path;
        HttpResponse response{};
        esp_http_client_config_t config{};
        config.url = url.c_str();
        config.event_handler = http_event;
        config.user_data = &response;
        config.timeout_ms = 12'000;
        if (url.rfind("https://", 0) == 0) config.crt_bundle_attach = esp_crt_bundle_attach;
        esp_http_client_handle_t client = esp_http_client_init(&config);
        if (client == nullptr) return false;
        esp_http_client_set_method(client, std::strcmp(method, "GET") == 0 ? HTTP_METHOD_GET : HTTP_METHOD_POST);
        esp_http_client_set_header(client, "Accept", "application/json");
        if (gateway_auth) {
            esp_http_client_set_header(client, "x-farmos-gateway-id", config::kDeviceId);
            esp_http_client_set_header(client, "x-farmos-gateway-token", gateway_token);
        }
        if (!body.empty()) {
            esp_http_client_set_header(client, "Content-Type", "application/json");
            esp_http_client_set_post_field(client, body.data(), body.size());
        }
        const esp_err_t error = esp_http_client_perform(client);
        const int status = esp_http_client_get_status_code(client);
        esp_http_client_cleanup(client);
        if (status == 401 && gateway_auth && response.body.find("GATEWAY_REVOKED") != std::string::npos) {
            std::printf("[GATEWAY] REVOKED BY SERVER | Triggering factory unbind reset\n");
            farmos::reset::finish_release();
        }
        if (response_body != nullptr) *response_body = std::move(response.body);
        return error == ESP_OK && status >= 200 && status < 300;
    }

    bool redeem() {
        char body[512]{};
        std::snprintf(body, sizeof(body),
                      "{\"gatewayId\":\"%s\",\"sessionId\":\"%s\",\"provisioningToken\":\"%s\",\"firmwareVersion\":\"%s\"}",
                      config::kDeviceId, session_id, provisioning_token, config::kFirmwareVersion);
        std::string response;
        if (!http("POST", "/devices/redeem", body, &response, false)) return false;
        cJSON* root = cJSON_Parse(response.c_str());
        cJSON* data = root ? cJSON_GetObjectItemCaseSensitive(root, "data") : nullptr;
        const bool ok = cJSON_IsObject(data) && json_string(data, "gatewayAccessToken", gateway_token, sizeof(gateway_token));
        cJSON_Delete(root);
        if (ok) {
            authenticated = true;
            save_gateway_token();
            std::printf("[GATEWAY] CLOUD READY | account binding completed\n");
        }
        return ok;
    }

    bool heartbeat() {
        char body[128]{};
        std::snprintf(body, sizeof(body), "{\"firmwareVersion\":\"%s\"}", config::kFirmwareVersion);
        return http("POST", "/gateway/status", body, nullptr, true);
    }

    void poll_pairing() {
        std::string response;
        if (!http("GET", "/gateway/pairing-sessions/next", {}, &response, true)) return;
        cJSON* root = cJSON_Parse(response.c_str());
        cJSON* data = root ? cJSON_GetObjectItemCaseSensitive(root, "data") : nullptr;
        PairingGrant next{};
        const cJSON* ttl = data ? cJSON_GetObjectItemCaseSensitive(data, "ttlMs") : nullptr;
        next.available = cJSON_IsObject(data) &&
                         cJSON_IsNumber(ttl) && ttl->valuedouble > 0 && ttl->valuedouble <= 300000 &&
                         json_string(data, "pairingId", next.pairing_id, sizeof(next.pairing_id)) &&
                         json_string(data, "nodeId", next.node_id, sizeof(next.node_id)) &&
                         json_string(data, "radioToken", next.radio_token_hex, sizeof(next.radio_token_hex));
        portENTER_CRITICAL(&lock);
        pairing = next;
        pairing_deadline_ms = next.available ? esp_timer_get_time() / 1000 + static_cast<std::int64_t>(ttl->valuedouble) : 0;
        portEXIT_CRITICAL(&lock);
        cJSON_Delete(root);
    }

    void poll_release_command() {
        char pending[48]{};
        if (farmos::reset::pending_release(pending, sizeof(pending))) {
            const std::string base = std::string("/device-commands/") + pending;
            if (http("POST", base + "/applied", "{}", nullptr, true)) {
                farmos::reset::finish_release();
                return;
            }
        }
        std::string response;
        if (!http("GET", "/device-commands/next", {}, &response, true)) return;
        cJSON* root = cJSON_Parse(response.c_str());
        cJSON* data = root ? cJSON_GetObjectItemCaseSensitive(root, "data") : nullptr;
        char command_id[48]{};
        char type[32]{};
        const bool release = cJSON_IsObject(data) && json_string(data, "commandId", command_id, sizeof(command_id)) &&
                             json_string(data, "type", type, sizeof(type)) && std::strcmp(type, "RELEASE_ACCOUNT") == 0;
        if (pending[0] && cJSON_IsNull(data)) farmos::reset::forget_release();
        cJSON_Delete(root);
        if (!release) return;
        const std::string base = std::string("/device-commands/") + command_id;
        if (!http("POST", base + "/ack", "{}", nullptr, true)) return;
        if (!farmos::reset::remember_release(command_id)) return;
        if (http("POST", base + "/applied", "{}", nullptr, true)) farmos::reset::finish_release();
    }

    void post_confirmation(const PairingGrant& grant) {
        char body[256]{};
        std::snprintf(body, sizeof(body),
                      "{\"radioToken\":\"%s\",\"rssi\":%d,\"snr\":%.2f}",
                      grant.radio_token_hex, grant.rssi_dbm, grant.snr_centi_db / 100.0);
        const std::string path = std::string("/gateway/pairing-sessions/") + grant.pairing_id + "/confirm";
        if (http("POST", path, body, nullptr, true)) {
            portENTER_CRITICAL(&lock);
            if (std::strcmp(pairing.pairing_id, grant.pairing_id) == 0) pairing = {};
            portEXIT_CRITICAL(&lock);
            std::printf("[GATEWAY] PAIRING ACTIVE | node=%s | server confirmed\n", grant.node_id);
        }
    }

    bool post_telemetry(const TelemetryUpload& item) {
        cJSON* packet=cJSON_CreateObject();
        if (!packet) return false;
        char event[96]{}; std::snprintf(event,sizeof(event),"%s-%" PRIu32 "-%" PRIu32,item.node_id,item.boot_id,item.sequence);
        cJSON_AddStringToObject(packet,"eventId",event);
        cJSON_AddStringToObject(packet,"nodeId",item.node_id);
        cJSON_AddNumberToObject(packet,"timestamp",static_cast<double>(time(nullptr)));
        cJSON_AddNumberToObject(packet,"quality",item.quality);
        if(item.sensor_mask & 4) cJSON_AddNumberToObject(packet,"soil_temp",item.temperature_centi_c/100.0);
        if(item.sensor_mask & 1) cJSON_AddNumberToObject(packet,"air_temp",item.air_temperature_centi_c/100.0);
        if(item.sensor_mask & 2) cJSON_AddNumberToObject(packet,"air_humidity",item.air_humidity_centi_pct/100.0);
        char* body=cJSON_PrintUnformatted(packet); cJSON_Delete(packet);
        if(!body) return false;
        std::string body_string(body); cJSON_free(body);
        std::string response;
        if (!http("POST", "/gateway/telemetry", body_string.c_str(), &response, true)) return false;
        cJSON* root = cJSON_Parse(response.c_str());
        cJSON* data = root ? cJSON_GetObjectItemCaseSensitive(root, "data") : nullptr;
        const bool persisted = data && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(data, "persisted"));
        cJSON_Delete(root);
        if (persisted) std::printf("[GATEWAY] CLOUD SAVED | %s #%-4" PRIu32 "\n", item.node_id, item.sequence);
        return persisted;
    }

    static void task(void* arg) {
        auto* self = static_cast<Impl*>(arg);
        std::int64_t last_heartbeat = 0;
        std::int64_t last_pair_poll = 0;
        std::int64_t last_release_poll = 0;
        std::int64_t last_ota_check = 0;
        while (true) {
            CloudSettings candidate{};
            if (xQueueReceive(self->settings_queue, &candidate, 0) == pdTRUE) {
                const CloudSettings previous = *static_cast<CloudSettings*>(self);
                *static_cast<CloudSettings*>(self) = candidate;
                if (self->start_wifi()) {
                    self->configured = true;
                    self->authenticated = false;
                    self->save_config();
                    std::printf("[GATEWAY] WIFI CONNECTED | configuration saved\n");
                } else {
                    *static_cast<CloudSettings*>(self) = previous;
                    std::printf("[GATEWAY] WIFI FAILED | previous configuration preserved\n");
                    if (self->configured) self->start_wifi();
                }
            }
            if (!self->configured) { vTaskDelay(pdMS_TO_TICKS(500)); continue; }
            if ((xEventGroupGetBits(self->wifi_events) & kWifiConnected) == 0 && !self->start_wifi()) {
                std::printf("[GATEWAY] WIFI ERROR | retrying\n");
                vTaskDelay(pdMS_TO_TICKS(5000));
                continue;
            }
            if (!self->authenticated && !self->redeem()) {
                std::printf("[GATEWAY] CLOUD ERROR | provisioning retry\n");
                vTaskDelay(pdMS_TO_TICKS(5000));
                continue;
            }
            const std::int64_t now = esp_timer_get_time() / 1000;
            if (now - last_heartbeat >= 30'000) {
                if (self->heartbeat()) GatewayOta::confirm_running_image(self->api_base, self->gateway_token);
                last_heartbeat = now;
            }
            if (now - last_pair_poll >= 2'000) { self->poll_pairing(); last_pair_poll = now; }
            if (now - last_release_poll >= 2'000) { self->poll_release_command(); last_release_poll = now; }
            if (last_ota_check == 0 || now - last_ota_check >= 6 * 60 * 60'000) {
                GatewayOta::check_and_perform_update(self->api_base, self->gateway_token);
                last_ota_check = now;
            }
            PairingGrant confirmation{};
            if (xQueueReceive(self->confirmations, &confirmation, 0) == pdTRUE) self->post_confirmation(confirmation);
            TelemetryUpload telemetry{};
            std::size_t index = 0;
            if (self->outbox.peek(&telemetry, &index) && self->post_telemetry(telemetry)) self->outbox.acknowledge(index);
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
};

GatewayCloud::GatewayCloud() : impl_(new Impl()) {}

esp_err_t GatewayCloud::begin() {
    ESP_RETURN_ON_ERROR(impl_->outbox.begin(), "outbox", "Cannot open persistent outbox");
    impl_->load();
    xTaskCreate(Impl::task, "gateway_cloud", 12288, impl_, 5, nullptr);
    return ESP_OK;
}

bool GatewayCloud::accept_ble_config(const std::string& json) {
    cJSON* root = cJSON_ParseWithLength(json.data(), json.size());
    if (root == nullptr) return false;
    char gateway_id[40]{};
    CloudSettings candidate{};
    const bool has_id = json_string(root, "deviceId", gateway_id, sizeof(gateway_id)) ||
                        json_string(root, "gatewayId", gateway_id, sizeof(gateway_id));
    const bool valid = has_id &&
                       std::strcmp(gateway_id, config::kDeviceId) == 0 &&
                       json_string(root, "ssid", candidate.ssid, sizeof(candidate.ssid)) && candidate.ssid[0] &&
                       json_string(root, "password", candidate.password, sizeof(candidate.password)) &&
                       json_string(root, "apiBaseUrl", candidate.api_base, sizeof(candidate.api_base)) &&
                       json_string(root, "sessionId", candidate.session_id, sizeof(candidate.session_id)) &&
                       json_string(root, "provisioningToken", candidate.provisioning_token, sizeof(candidate.provisioning_token));
    cJSON_Delete(root);
    if (!valid) return false;
    if (std::strncmp(candidate.api_base, "https://", 8) != 0) {
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
        if (std::strncmp(candidate.api_base, "http://", 7) != 0) return false;
#else
        return false;
#endif
    }
    // The network worker owns settings. BLE callbacks never mutate live strings
    // concurrently with HTTP requests or NVS commits.
    return xQueueSend(impl_->settings_queue, &candidate, 0) == pdTRUE;
}

bool GatewayCloud::online() const {
    return impl_->authenticated && (xEventGroupGetBits(impl_->wifi_events) & kWifiConnected) != 0;
}

bool GatewayCloud::current_pairing(PairingGrant* output) const {
    if (output == nullptr) return false;
    portENTER_CRITICAL(&impl_->lock);
    *output = impl_->pairing;
    if (esp_timer_get_time() / 1000 >= impl_->pairing_deadline_ms) output->available = false;
    portEXIT_CRITICAL(&impl_->lock);
    return output->available;
}

void GatewayCloud::confirm_pairing(const PairingGrant& grant, int rssi_dbm, float snr_db) {
    PairingGrant confirmation = grant;
    confirmation.rssi_dbm = static_cast<std::int16_t>(rssi_dbm);
    confirmation.snr_centi_db = static_cast<std::int16_t>(snr_db * 100.0F);
    xQueueSendToBack(impl_->confirmations, &confirmation, 0);
}

bool GatewayCloud::enqueue_telemetry(const TelemetryUpload& telemetry) {
    return impl_->outbox.put(telemetry);
}

}  // namespace farmos::gateway
