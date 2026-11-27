#include "node_cloud.h"
#include "node_cloud_ota.h"
#include "pump_control.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <string>

#include "board_config.h"
#include "device_reset.h"
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"

namespace farmos::node {
namespace {
constexpr EventBits_t kWifiConnected = BIT0;
constexpr TickType_t kWifiConnectWait = pdMS_TO_TICKS(20000);
constexpr TickType_t kWifiProvisioningWait = pdMS_TO_TICKS(45000);
constexpr std::size_t kResponseLimit = 4096;
constexpr int kPumpRequestTimeoutMs = 12000;
constexpr std::int64_t kPumpMaxDeliveryUs = 12'000'000;
constexpr std::int64_t kPumpFeedbackBudgetMs = 1500;

struct CloudSettings {
    char mode[24]{};
    char ssid[33]{};
    char password[65]{};
    char api_base[160]{};
    char session_id[48]{};
    char provisioning_token[128]{};
    char device_token[128]{};
};

struct HttpResponse { std::string body; };

// A direct-cloud Node must tolerate Wi-Fi/server outages without silently
// losing every queued sample on reboot. Each slot is committed independently,
// so recovery does not depend on a separately maintained head/tail record.
class DirectTelemetryOutbox {
 public:
    esp_err_t begin() {
        mutex_ = xSemaphoreCreateMutex();
        if (!mutex_) return ESP_ERR_NO_MEM;
        esp_err_t error = nvs_open("farmos_outbox", NVS_READWRITE, &handle_);
        if (error != ESP_OK) return error;
        for (std::size_t i = 0; i < slots_.size(); ++i) {
            char key[8]{};
            key_for(i, key);
            struct LegacyTelemetry {
                std::uint32_t boot_id, sequence;
                std::int16_t temperature_centi_c;
                std::uint8_t quality;
            };
            struct PreviousTelemetry {
                std::uint32_t boot_id, sequence;
                std::int16_t temperature_centi_c;
                std::uint8_t quality, sensor_mask;
                std::int16_t air_temperature_centi_c;
                std::uint16_t air_humidity_centi_pct;
            };
            static_assert(sizeof(PreviousTelemetry) == 16, "Previous outbox layout changed");
            std::size_t size = 0;
            error = nvs_get_blob(handle_, key, nullptr, &size);
            if (error == ESP_ERR_NVS_NOT_FOUND) continue;
            if (error != ESP_OK) return error;
            if (size == sizeof(LegacyTelemetry)) {
                LegacyTelemetry old{};
                if (nvs_get_blob(handle_, key, &old, &size) != ESP_OK) return ESP_FAIL;
                slots_[i].value = {old.boot_id, old.sequence, old.temperature_centi_c, old.quality};
            } else if (size == sizeof(PreviousTelemetry)) {
                PreviousTelemetry old{};
                if (nvs_get_blob(handle_, key, &old, &size) != ESP_OK) return ESP_FAIL;
                slots_[i].value = {old.boot_id, old.sequence, old.temperature_centi_c, old.quality,
                    old.sensor_mask, old.air_temperature_centi_c, old.air_humidity_centi_pct, -1};
            } else if (size == sizeof(DirectTelemetry)) {
                if (nvs_get_blob(handle_, key, &slots_[i].value, &size) != ESP_OK) return ESP_FAIL;
            } else return ESP_FAIL;
            slots_[i].used = true;
        }
        return ESP_OK;
    }

    bool put(const DirectTelemetry& value) {
        xSemaphoreTake(mutex_, portMAX_DELAY);
        for (const auto& slot : slots_) {
            if (slot.used && slot.value.boot_id == value.boot_id && slot.value.sequence == value.sequence) {
                xSemaphoreGive(mutex_);
                return true;
            }
        }
        bool saved = false;
        for (std::size_t i = 0; i < slots_.size(); ++i) {
            if (slots_[i].used) continue;
            char key[8]{};
            key_for(i, key);
            if (nvs_set_blob(handle_, key, &value, sizeof(value)) == ESP_OK && nvs_commit(handle_) == ESP_OK) {
                slots_[i] = {true, value};
                saved = true;
            }
            break;
        }
        xSemaphoreGive(mutex_);
        return saved;
    }

    bool peek(DirectTelemetry* value, std::size_t* index) {
        xSemaphoreTake(mutex_, portMAX_DELAY);
        for (std::size_t count = 0; count < slots_.size(); ++count) {
            const std::size_t i = (cursor_ + count) % slots_.size();
            if (!slots_[i].used) continue;
            *value = slots_[i].value;
            *index = i;
            cursor_ = (i + 1) % slots_.size();
            xSemaphoreGive(mutex_);
            return true;
        }
        xSemaphoreGive(mutex_);
        return false;
    }

    bool acknowledge(std::size_t index) {
        xSemaphoreTake(mutex_, portMAX_DELAY);
        char key[8]{};
        key_for(index, key);
        const bool ok = nvs_erase_key(handle_, key) == ESP_OK && nvs_commit(handle_) == ESP_OK;
        if (ok) slots_[index] = {};
        xSemaphoreGive(mutex_);
        return ok;
    }

    bool clear() {
        xSemaphoreTake(mutex_, portMAX_DELAY);
        const bool ok = nvs_erase_all(handle_) == ESP_OK && nvs_commit(handle_) == ESP_OK;
        if (ok) {
            slots_ = {};
            cursor_ = 0;
        }
        xSemaphoreGive(mutex_);
        return ok;
    }

 private:
    static void key_for(std::size_t index, char* key) {
        std::snprintf(key, 8, "d%02u", static_cast<unsigned>(index));
    }
    struct Slot { bool used{false}; DirectTelemetry value{}; };
    std::array<Slot, 32> slots_{};
    std::size_t cursor_{0};
    nvs_handle_t handle_{};
    SemaphoreHandle_t mutex_{};
};

bool json_string(const cJSON* root, const char* key, char* output, std::size_t size) {
    const cJSON* item = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsString(item) || !item->valuestring || std::strlen(item->valuestring) >= size) return false;
    std::snprintf(output, size, "%s", item->valuestring);
    return true;
}

esp_err_t http_event(esp_http_client_event_t* event) {
    auto* response = static_cast<HttpResponse*>(event->user_data);
    if (event->event_id == HTTP_EVENT_ON_DATA && response && event->data_len > 0 &&
        response->body.size() + event->data_len <= kResponseLimit) {
        response->body.append(static_cast<const char*>(event->data), event->data_len);
    }
    return ESP_OK;
}

void wifi_event(void* arg, esp_event_base_t base, std::int32_t id, void* event_data) {
    static unsigned last_disconnect_reason = 0;
    auto* events = static_cast<EventGroupHandle_t*>(arg);
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        last_disconnect_reason = 0;
        std::printf("[NODE] WIFI GOT IP\n");
        xEventGroupSetBits(*events, kWifiConnected);
    }
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        const auto* disconnected = static_cast<const wifi_event_sta_disconnected_t*>(event_data);
        if (disconnected && disconnected->reason != last_disconnect_reason) {
            last_disconnect_reason = disconnected->reason;
            std::printf("[NODE] WIFI DISCONNECTED | reason=%u\n", last_disconnect_reason);
        }
        xEventGroupClearBits(*events, kWifiConnected);
        esp_wifi_connect();
    }
}
}  // namespace

struct NodeCloud::Impl : CloudSettings {
    QueueHandle_t settings_queue{xQueueCreate(1, sizeof(CloudSettings))};
    DirectTelemetryOutbox telemetry_outbox{};
    EventGroupHandle_t wifi_events{xEventGroupCreate()};
    bool configured{false};
    bool authenticated{false};
    bool wifi_started{false};
    bool paused{false};
    ConnectionMode connection_mode{ConnectionMode::UNCONFIGURED};
    // A LEAF_NODE -> STANDALONE_NODE transition is only complete after the
    // server has redeemed the short-lived provisioning ticket and the
    // resulting device credential has been durably written.  Keep this bit
    // separate from connection_mode so a reboot can retry an interrupted
    // redeem without treating a stale g_pairing blob as authoritative.
    bool standalone_mode_transition_pending{false};
    std::atomic_bool standalone_mode_commit_pending{false};

    void load() {
        nvs_handle_t handle{};
        if (nvs_open("farmos_cloud", NVS_READONLY, &handle) != ESP_OK) return;
        CloudSettings saved{};
        std::size_t size = sizeof(saved);
        if (nvs_get_blob(handle, "node_cloud_v1", &saved, &size) == ESP_OK && size == sizeof(saved) &&
            std::strcmp(saved.mode, "STANDALONE_NODE") == 0) {
            *static_cast<CloudSettings*>(this) = saved;
            configured = ssid[0] && api_base[0];
            authenticated = device_token[0];
            connection_mode = configured ? ConnectionMode::WIFI : ConnectionMode::UNCONFIGURED;
            standalone_mode_transition_pending = configured && !authenticated && session_id[0] && provisioning_token[0];
        }
        nvs_close(handle);
    }

    bool save() {
        nvs_handle_t handle{};
        if (nvs_open("farmos_cloud", NVS_READWRITE, &handle) != ESP_OK) return false;
        const bool ok = nvs_set_blob(handle, "node_cloud_v1", static_cast<CloudSettings*>(this), sizeof(CloudSettings)) == ESP_OK &&
                        nvs_commit(handle) == ESP_OK;
        nvs_close(handle);
        return ok;
    }

    bool start_wifi(TickType_t wait = kWifiConnectWait) {
        if (!wifi_started) {
            if (esp_netif_init() != ESP_OK || esp_event_loop_create_default() != ESP_OK) return false;
            esp_netif_create_default_wifi_sta();
            wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
            if (esp_wifi_init(&init) != ESP_OK) return false;
            ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
            esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, &wifi_events);
            esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, &wifi_events);
            esp_wifi_set_mode(WIFI_MODE_STA);
            esp_wifi_start();
            esp_wifi_set_max_tx_power(52);
            esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
            wifi_started = true;
        }
        wifi_config_t value{};
        std::memcpy(value.sta.ssid, ssid, std::min(std::strlen(ssid), sizeof(value.sta.ssid)));
        std::memcpy(value.sta.password, password, std::min(std::strlen(password), sizeof(value.sta.password)));
        value.sta.threshold.authmode = password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
        xEventGroupClearBits(wifi_events, kWifiConnected);
        esp_wifi_disconnect();
        if (esp_wifi_set_config(WIFI_IF_STA, &value) != ESP_OK) return false;
        const esp_err_t connect = esp_wifi_connect();
        if (connect != ESP_OK && connect != ESP_ERR_WIFI_CONN) return false;
        return xEventGroupWaitBits(wifi_events, kWifiConnected, pdFALSE, pdFALSE, wait) & kWifiConnected;
    }

    bool probe_server() {
        if (api_base[0] == '\0') return false;
        const std::string url = std::string(api_base) + "/health";
        HttpResponse response{};
        esp_http_client_config_t config{};
        config.url = url.c_str();
        config.timeout_ms = 8'000;
        config.event_handler = http_event;
        config.user_data = &response;
        if (url.rfind("https://", 0) == 0) config.crt_bundle_attach = esp_crt_bundle_attach;
        auto* client = esp_http_client_init(&config);
        if (!client) return false;
        esp_http_client_set_method(client, HTTP_METHOD_GET);
        esp_http_client_set_header(client, "Accept", "application/json");
        const esp_err_t error = esp_http_client_perform(client);
        const int status = esp_http_client_get_status_code(client);
        esp_http_client_cleanup(client);
        // A reachable 4xx endpoint is not a valid committed configuration:
        // it commonly means the URL points at the wrong service or path.
        // Keep the transition pending until the health probe is successful.
        return error == ESP_OK && status >= 200 && status < 300;
    }

    bool http(const char* path, const std::string& body, std::string* output, bool auth, int timeout_ms = 12000) {
        const std::string url = std::string(api_base) + "/api/v1/onboarding" + path;
        HttpResponse response{};
        esp_http_client_config_t config{};
        config.url = url.c_str(); config.timeout_ms = timeout_ms; config.event_handler = http_event; config.user_data = &response;
        if (url.rfind("https://", 0) == 0) config.crt_bundle_attach = esp_crt_bundle_attach;
        auto* client = esp_http_client_init(&config);
        if (!client) return false;
        esp_http_client_set_method(client, HTTP_METHOD_POST);
        esp_http_client_set_header(client, "Accept", "application/json");
        esp_http_client_set_header(client, "Content-Type", "application/json");
        if (auth) {
            esp_http_client_set_header(client, "x-farmos-device-id", config::kDeviceId);
            esp_http_client_set_header(client, "x-farmos-device-token", device_token);
        }
        esp_http_client_set_post_field(client, body.data(), body.size());
        const esp_err_t error = esp_http_client_perform(client);
        const int status = esp_http_client_get_status_code(client);
        esp_http_client_cleanup(client);
        if (status == 401 && auth) pump::stop();
        if (status == 401 && auth && response.body.find("GATEWAY_REVOKED") != std::string::npos) {
            std::printf("[NODE] REVOKED BY SERVER | clearing local deployment\n");
            farmos::reset::finish_release();
        }
        if (output) *output = std::move(response.body);
        return error == ESP_OK && status >= 200 && status < 300;
    }

    bool redeem() {
        char body[512]{};
        std::snprintf(body, sizeof(body),
            "{\"deviceId\":\"%s\",\"sessionId\":\"%s\",\"provisioningToken\":\"%s\",\"firmwareVersion\":\"%s\"}",
            config::kDeviceId, session_id, provisioning_token, config::kFirmwareVersion);
        std::string response;
        if (!http("/devices/redeem", body, &response, false)) return false;
        cJSON* root = cJSON_Parse(response.c_str());
        cJSON* data = root ? cJSON_GetObjectItemCaseSensitive(root, "data") : nullptr;
        char redeemed_token[sizeof(device_token)]{};
        const bool ok = cJSON_IsObject(data) && json_string(data, "deviceAccessToken", redeemed_token, sizeof(redeemed_token));
        cJSON_Delete(root);
        if (ok) {
            // Persist the server-issued credential before signalling the main
            // loop to clear the old LoRa binding.  If NVS fails, retain the
            // ticket fields so the next loop/reboot can retry the idempotent
            // redeem instead of creating a half-switched device.
            const CloudSettings before = *static_cast<CloudSettings*>(this);
            const bool mode_transition = standalone_mode_transition_pending;
            std::snprintf(device_token, sizeof(device_token), "%s", redeemed_token);
            authenticated = true;
            provisioning_token[0] = 0;
            session_id[0] = 0;
            if (!save()) {
                *static_cast<CloudSettings*>(this) = before;
                authenticated = before.device_token[0];
                return false;
            }
            standalone_mode_transition_pending = false;
            if (mode_transition) standalone_mode_commit_pending.store(true);
            std::printf("[NODE] DIRECT CLOUD READY | account binding completed\n");
        }
        return ok;
    }

    bool upload(const DirectTelemetry& item) {
        cJSON* packet = cJSON_CreateObject();
        if (!packet) return false;
        char event_id[96]{};
        std::snprintf(event_id, sizeof(event_id), "%s-%lu-%lu", config::kDeviceId,
            static_cast<unsigned long>(item.boot_id), static_cast<unsigned long>(item.sequence));
        cJSON_AddStringToObject(packet, "eventId", event_id);
        cJSON_AddStringToObject(packet, "nodeId", config::kDeviceId);
        cJSON_AddNumberToObject(packet, "quality", item.quality);
        if (item.sensor_mask & 4) cJSON_AddNumberToObject(packet, "soil_temp", item.temperature_centi_c / 100.0);
        if (item.sensor_mask & 1) cJSON_AddNumberToObject(packet, "air_temp", item.air_temperature_centi_c / 100.0);
        if (item.sensor_mask & 2) cJSON_AddNumberToObject(packet, "air_humidity", item.air_humidity_centi_pct / 100.0);
        if ((item.sensor_mask & 16) && item.soil_moisture_centi_pct >= 0 && item.soil_moisture_centi_pct <= 10000) cJSON_AddNumberToObject(packet, "soil_moisture", item.soil_moisture_centi_pct / 100.0);
        char* body = cJSON_PrintUnformatted(packet);
        cJSON_Delete(packet);
        if (!body) return false;
        std::string response;
        const bool ok = http("/device/telemetry", body, &response, true);
        cJSON_free(body);
        if (!ok) return false;
        cJSON* root = cJSON_Parse(response.c_str());
        const cJSON* data = cJSON_GetObjectItemCaseSensitive(root, "data");
        const bool persisted = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(data, "persisted"));
        cJSON_Delete(root);
        return persisted;
    }

    void poll_pump_command() {
        if (!pump::ready() || std::strncmp(api_base, "https://", 8) != 0) return;
        if (!pump_result_path.empty()) {
            http(pump_result_path.c_str(), pump_result_body, nullptr, true, kPumpRequestTimeoutMs);
            pump_result_path.clear();
        }
        std::string response;
        const auto started = esp_timer_get_time();
        const bool received = http("/pump/next", "{}", &response, true, kPumpRequestTimeoutMs);
        const auto elapsed = esp_timer_get_time() - started;
        if (!received || elapsed > kPumpMaxDeliveryUs) {
            if (++pump_poll_failures == 1 || pump_poll_failures % 10 == 0) {
                std::printf("[NODE] PUMP POLL WAIT | response=%s | elapsed_ms=%lld\n",
                            received ? "late" : "failed", static_cast<long long>(elapsed / 1000));
            }
            return;
        }
        if (pump_poll_failures != 0) {
            std::printf("[NODE] PUMP POLL RECOVERED | elapsed_ms=%lld\n", static_cast<long long>(elapsed / 1000));
            pump_poll_failures = 0;
        }
        cJSON* root = cJSON_Parse(response.c_str());
        const auto* data = cJSON_GetObjectItemCaseSensitive(root, "data");
        const auto* on = cJSON_GetObjectItemCaseSensitive(data, "on");
        const auto* duration = cJSON_GetObjectItemCaseSensitive(data, "runSeconds");
        const auto* ttl = cJSON_GetObjectItemCaseSensitive(data, "expiresInMs");
        char command_id[37]{};
        const bool valid = json_string(data, "commandId", command_id, sizeof(command_id)) &&
            std::strlen(command_id) == 36 && std::strspn(command_id, "0123456789abcdef-") == 36 &&
            cJSON_IsBool(on) && cJSON_IsNumber(duration) && cJSON_IsNumber(ttl) &&
            ttl->valueint > elapsed / 1000 + kPumpFeedbackBudgetMs;
        if (valid && !paused && connection_mode == ConnectionMode::WIFI) {
            const auto result = pump::apply(cJSON_IsTrue(on), duration->valueint);
            char body[110]{};
            std::snprintf(body, sizeof(body), "{\"feedbackOn\":%s,\"error\":%s%s%s}",
                          result.feedback_on ? "true" : "false", result.error ? "\"" : "",
                          result.error ? result.error : "null", result.error ? "\"" : "");
            const std::string path = std::string("/pump/") + command_id + "/result";
            if (!http(path.c_str(), body, nullptr, true, kPumpRequestTimeoutMs)) {
                pump_result_path = path;
                pump_result_body = body;
            }
        }
        cJSON_Delete(root);
    }

    unsigned pump_poll_failures = 0;
    std::string pump_result_path;
    std::string pump_result_body;

    void poll_release_command() {
        char pending[48]{};
        if (farmos::reset::pending_release(pending, sizeof(pending))) {
            const std::string base = std::string("/device-commands/") + pending;
            if (http((base + "/applied").c_str(), "{}", nullptr, true)) {
                pump::stop();
                farmos::reset::finish_release();
                return;
            }
        }
        std::string response;
        if (!http("/device-commands/next", "{}", &response, true)) return;
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
        if (!http((base + "/ack").c_str(), "{}", nullptr, true)) return;
        if (!farmos::reset::remember_release(command_id)) return;
        if (http((base + "/applied").c_str(), "{}", nullptr, true)) {
            pump::stop();
            farmos::reset::finish_release();
        }
    }

    static void task(void* arg) {
        auto* self = static_cast<Impl*>(arg);
        std::int64_t last_heartbeat = 0;
        std::int64_t last_release_poll = 0;
        std::int64_t last_pump_poll = 0;
        std::int64_t last_ota_check = 0;
        while (true) {
            CloudSettings candidate{};
            if (xQueueReceive(self->settings_queue, &candidate, 0) == pdTRUE) {
                pump::stop();
                self->pump_result_path.clear();
                const CloudSettings previous = *static_cast<CloudSettings*>(self);
                const ConnectionMode previous_mode = self->connection_mode;
                *static_cast<CloudSettings*>(self) = candidate;
                self->connection_mode = ConnectionMode::UNCONFIGURED;
                std::printf("[NODE] WIFI CONFIG PENDING | probing network and server\n");
                if (self->start_wifi(kWifiProvisioningWait) && self->probe_server() && self->save()) {
                    self->configured = true; self->authenticated = false; self->paused = false;
                    self->connection_mode = ConnectionMode::WIFI;
                    self->standalone_mode_transition_pending = previous_mode == ConnectionMode::LORA_GATEWAY;
                    std::printf("[NODE] WIFI CONFIG COMMITTED | identity preserved\n");
                } else {
                    *static_cast<CloudSettings*>(self) = previous;
                    self->connection_mode = previous_mode;
                    self->standalone_mode_transition_pending = false;
                    if (self->configured) self->start_wifi();
                    std::printf("[NODE] WIFI CONFIG ROLLED BACK | previous configuration preserved\n");
                }
            }
            if (self->connection_mode != ConnectionMode::WIFI || !self->configured || self->paused) { pump::stop(); vTaskDelay(pdMS_TO_TICKS(250)); continue; }
            if (!(xEventGroupGetBits(self->wifi_events) & kWifiConnected)) {
                pump::stop();
                if (!self->start_wifi()) { vTaskDelay(pdMS_TO_TICKS(5000)); continue; }
            }
            if (!self->authenticated && !self->redeem()) { vTaskDelay(pdMS_TO_TICKS(5000)); continue; }
            const std::int64_t now = esp_timer_get_time() / 1000;
            if (now - last_heartbeat >= 30000) {
                char body[96]{}; std::snprintf(body, sizeof(body), "{\"firmwareVersion\":\"%s\"}", config::kFirmwareVersion);
                if (self->http("/device/status", body, nullptr, true)) {
                    NodeCloudOta::confirm_running_image(self->api_base, self->device_token);
                }
                last_heartbeat = now;
            }
            if (now - last_pump_poll >= 3'000) { self->poll_pump_command(); last_pump_poll = now; }
            if (now - last_release_poll >= 2'000) { self->poll_release_command(); last_release_poll = now; }
            if (last_ota_check == 0 || now - last_ota_check >= 6 * 60 * 60'000) {
                NodeCloudOta::check_and_perform_update(self->api_base, self->device_token);
                last_ota_check = now;
            }
            DirectTelemetry telemetry{};
            std::size_t outbox_index = 0;
            if (self->telemetry_outbox.peek(&telemetry, &outbox_index) && self->upload(telemetry)) {
                self->telemetry_outbox.acknowledge(outbox_index);
            }
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
};

NodeCloud::NodeCloud() : impl_(new Impl()) {}
esp_err_t NodeCloud::begin() {
    pump::begin();
    impl_->load();
    const esp_err_t outbox = impl_->telemetry_outbox.begin();
    if (outbox != ESP_OK) return outbox;
    return xTaskCreate(Impl::task, "node_cloud", 12288, impl_, 5, nullptr) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
bool NodeCloud::standalone_active() const {
    return impl_->connection_mode == ConnectionMode::WIFI && impl_->configured && !impl_->paused;
}
ConnectionMode NodeCloud::mode() const { return impl_->connection_mode; }
bool NodeCloud::consume_standalone_mode_commit() {
    return impl_->standalone_mode_commit_pending.exchange(false);
}
void NodeCloud::set_lora_gateway_mode(bool enabled) {
    if (!enabled) {
        impl_->connection_mode = impl_->configured ? ConnectionMode::WIFI : ConnectionMode::UNCONFIGURED;
        impl_->paused = false;
        return;
    }

    // Recovery after a power loss is deliberately based on the durable cloud
    // state, not merely on the old g_pairing blob.  A saved ticket means the
    // server redeem can be retried; an already saved device token means the
    // server-side mode switch completed and only the local binding cleanup is
    // left.  Both cases must continue Wi-Fi so the operation remains
    // idempotent.  A plain cloud-less paired node still selects LoRa.
    const bool pending_ticket = impl_->configured && impl_->connection_mode == ConnectionMode::WIFI &&
                                !impl_->authenticated && impl_->session_id[0] && impl_->provisioning_token[0];
    const bool committed_cloud = impl_->configured && impl_->connection_mode == ConnectionMode::WIFI &&
                                 impl_->authenticated;
    if (pending_ticket || committed_cloud) {
        impl_->paused = false;
        impl_->standalone_mode_transition_pending = pending_ticket;
        if (committed_cloud) impl_->standalone_mode_commit_pending.store(true);
        return;
    }

    impl_->connection_mode = ConnectionMode::LORA_GATEWAY;
    impl_->paused = true;
    impl_->configured = false;
    impl_->authenticated = false;
    impl_->standalone_mode_transition_pending = false;
    nvs_handle_t handle{};
    if (nvs_open("farmos_cloud", NVS_READWRITE, &handle) == ESP_OK) {
        nvs_erase_all(handle);
        nvs_commit(handle);
        nvs_close(handle);
    }
}
bool NodeCloud::enqueue(const DirectTelemetry& value) { return impl_->telemetry_outbox.put(value); }
void NodeCloud::pause_for_pairing() {
    impl_->paused = true;
    pump::stop();
}
void NodeCloud::resume_after_pairing_failure() { impl_->paused = false; }
void NodeCloud::clear_after_pairing() {
    impl_->configured = false; impl_->authenticated = false; impl_->paused = true;
    impl_->connection_mode = ConnectionMode::LORA_GATEWAY;
    impl_->standalone_mode_transition_pending = false;
    impl_->standalone_mode_commit_pending.store(false);
    impl_->telemetry_outbox.clear();
    nvs_handle_t handle{};
    if (nvs_open("farmos_cloud", NVS_READWRITE, &handle) == ESP_OK) { nvs_erase_all(handle); nvs_commit(handle); nvs_close(handle); }
}

bool NodeCloud::accept_ble_config(const std::string& json) {
    cJSON* root = cJSON_ParseWithLength(json.data(), json.size());
    if (!root) return false;
    CloudSettings candidate{};
    const cJSON* mode = cJSON_GetObjectItemCaseSensitive(root, "deploymentMode");
    if (!cJSON_IsString(mode)) mode = cJSON_GetObjectItemCaseSensitive(root, "mode");
    char device_id[40]{};
    const bool valid = cJSON_IsString(mode) && std::strcmp(mode->valuestring, "STANDALONE_NODE") == 0 &&
        json_string(root, "deviceId", device_id, sizeof(device_id)) && std::strcmp(device_id, config::kDeviceId) == 0 &&
        json_string(root, "ssid", candidate.ssid, sizeof(candidate.ssid)) && candidate.ssid[0] &&
        json_string(root, "password", candidate.password, sizeof(candidate.password)) &&
        json_string(root, "apiBaseUrl", candidate.api_base, sizeof(candidate.api_base)) &&
        json_string(root, "sessionId", candidate.session_id, sizeof(candidate.session_id)) &&
        json_string(root, "provisioningToken", candidate.provisioning_token, sizeof(candidate.provisioning_token));
    std::snprintf(candidate.mode, sizeof(candidate.mode), "STANDALONE_NODE");
    cJSON_Delete(root);
    if (!valid) return false;
#ifndef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
    if (std::strncmp(candidate.api_base, "https://", 8) != 0) return false;
#endif
    return xQueueOverwrite(impl_->settings_queue, &candidate) == pdPASS;
}

}  // namespace farmos::node
