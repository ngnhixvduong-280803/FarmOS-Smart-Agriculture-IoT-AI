#pragma once
#include <cstdio>
#include <iterator>
#include <cstdint>
#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"

namespace farmos::reset {
inline bool store_action(std::uint8_t action) {
    nvs_handle_t handle{};
    if (nvs_open("farmos_reset", NVS_READWRITE, &handle) != ESP_OK) return false;
    const bool saved = nvs_set_u8(handle, "action", action) == ESP_OK && nvs_commit(handle) == ESP_OK;
    nvs_close(handle);
    return saved;
}

inline bool remember_release(const char* command_id) {
    nvs_handle_t handle{};
    if (nvs_open("farmos_reset", NVS_READWRITE, &handle) != ESP_OK) return false;
    const bool saved = nvs_set_str(handle, "release_id", command_id) == ESP_OK && nvs_commit(handle) == ESP_OK;
    nvs_close(handle);
    return saved;
}

inline bool pending_release(char* command_id, std::size_t size) {
    nvs_handle_t handle{};
    if (nvs_open("farmos_reset", NVS_READONLY, &handle) != ESP_OK) return false;
    const bool found = nvs_get_str(handle, "release_id", command_id, &size) == ESP_OK && command_id[0];
    nvs_close(handle);
    return found;
}

inline void forget_release() {
    nvs_handle_t handle{};
    if (nvs_open("farmos_reset", NVS_READWRITE, &handle) != ESP_OK) return;
    if (nvs_erase_key(handle, "release_id") == ESP_OK) nvs_commit(handle);
    nvs_close(handle);
}

inline void finish_release() {
    if (store_action(2)) esp_restart();
}

// Run before workers. Preserve identity, encryption keys, boot counter and ownership.
inline unsigned consume(bool gateway) {
    nvs_handle_t handle{};
    ESP_ERROR_CHECK(nvs_open("farmos_reset", NVS_READWRITE, &handle));
    std::uint8_t action = 0;
    nvs_get_u8(handle, "action", &action);
    if (action == 2) {
        // Clear settings written by older firmware through IDF's default
        // flash-backed Wi-Fi storage. The normal cloud worker uses RAM.
        ESP_ERROR_CHECK(esp_event_loop_create_default());
        wifi_init_config_t wifi = WIFI_INIT_CONFIG_DEFAULT();
        ESP_ERROR_CHECK(esp_wifi_init(&wifi));
        ESP_ERROR_CHECK(esp_wifi_restore());
        ESP_ERROR_CHECK(esp_wifi_deinit());
        ESP_ERROR_CHECK(esp_event_loop_delete_default());
        const esp_err_t release_error = nvs_erase_key(handle, "release_id");
        if (release_error != ESP_ERR_NVS_NOT_FOUND) ESP_ERROR_CHECK(release_error);
        const char* gateway_namespaces[] = {"farmos_cloud", "farmos_nodes", "farmos_outbox", "nimble_bond"};
        const char* node_namespaces[] = {"farmos_pair", "farmos_cloud", "farmos_outbox", "nimble_bond"};
        const char** namespaces = gateway ? gateway_namespaces : node_namespaces;
        for (std::size_t i = 0; i < std::size(gateway_namespaces); ++i) {
            nvs_handle_t settings{};
            // NVS namespaces are created lazily. A fresh Gateway does not have
            // `farmos_nodes` yet and a fresh Node does not have `farmos_pair`.
            // Missing optional namespaces still count as reset-success; aborting
            // here would prevent the remaining settings from being erased.
            const esp_err_t open_error = nvs_open(namespaces[i], NVS_READWRITE, &settings);
            if (open_error == ESP_ERR_NVS_NOT_FOUND) continue;
            ESP_ERROR_CHECK(open_error);
            ESP_ERROR_CHECK(nvs_erase_all(settings));
            ESP_ERROR_CHECK(nvs_commit(settings));
            nvs_close(settings);
        }
        std::printf("[DEVICE] LOCAL RESET | user settings erased; factory identity and server ownership retained\n");
    }
    if (action) {
        ESP_ERROR_CHECK(nvs_erase_key(handle, "action"));
        ESP_ERROR_CHECK(nvs_commit(handle));
    }
    nvs_close(handle);
    return action;
}
inline void button_task(void*) {
    gpio_config_t config{};
    config.pin_bit_mask = 1ULL << GPIO_NUM_0;
    config.mode = GPIO_MODE_INPUT;
    config.pull_up_en = GPIO_PULLUP_ENABLE;
    ESP_ERROR_CHECK(gpio_config(&config));
    // Ignore boot-time GPIO0 (ROM download strap); operate after READY.
    while (!gpio_get_level(GPIO_NUM_0)) vTaskDelay(pdMS_TO_TICKS(100));
    unsigned ticks = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(100));
        if (!gpio_get_level(GPIO_NUM_0)) {
            ++ticks;
            if (ticks == 30) std::printf("[DEVICE] BOOT | release to reopen setup; hold 10s total for local reset\n");
            if (ticks == 100) std::printf("[DEVICE] BOOT | release to reset local settings; server ownership stays\n");
            continue;
        }
        if (ticks >= 30) {
            if (store_action(ticks >= 100 ? 2 : 1)) esp_restart();
            std::printf("[DEVICE] BOOT | could not save reset request\n");
        }
        ticks = 0;
    }
}
inline void start_button() {
    configASSERT(xTaskCreate(button_task, "reset_button", 3072, nullptr, 3, nullptr) == pdPASS);
}
}  // namespace farmos::reset
