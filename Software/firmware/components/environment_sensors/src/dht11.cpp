#include "dht11.h"

#include <array>
#include <cstdint>

#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace farmos::sensors {
namespace {

bool wait_while_level(gpio_num_t pin, int level, std::uint32_t timeout_us,
                      std::uint32_t* elapsed_us = nullptr) {
    const std::int64_t started = esp_timer_get_time();
    while (gpio_get_level(pin) == level) {
        if (esp_timer_get_time() - started >= timeout_us) {
            return false;
        }
    }
    if (elapsed_us != nullptr) {
        *elapsed_us = static_cast<std::uint32_t>(esp_timer_get_time() - started);
    }
    return true;
}

bool capture_frame(gpio_num_t pin, std::array<std::uint8_t, 5>* bytes) {
    if (!wait_while_level(pin, 1, 100) || !wait_while_level(pin, 0, 120) ||
        !wait_while_level(pin, 1, 120)) {
        return false;
    }

    bytes->fill(0);
    for (std::size_t bit = 0; bit < 40; ++bit) {
        if (!wait_while_level(pin, 0, 100)) {
            return false;
        }
        std::uint32_t high_us = 0;
        if (!wait_while_level(pin, 1, 120, &high_us)) {
            return false;
        }
        (*bytes)[bit / 8] <<= 1U;
        if (high_us > 50) {
            (*bytes)[bit / 8] |= 1U;
        }
    }
    return true;
}

}  // namespace

Dht11::Dht11(gpio_num_t pin) : pin_(pin) {}

esp_err_t Dht11::begin() {
    const gpio_config_t config{
        .pin_bit_mask = 1ULL << pin_,
        .mode = GPIO_MODE_INPUT_OUTPUT_OD,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    const esp_err_t error = gpio_config(&config);
    if (error == ESP_OK) {
        gpio_set_level(pin_, 1);
    }
    return error;
}

esp_err_t Dht11::read(Dht11Reading* reading) {
    if (reading == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }

    gpio_set_direction(pin_, GPIO_MODE_OUTPUT_OD);
    gpio_set_level(pin_, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(pin_, 1);
    esp_rom_delay_us(30);
    gpio_set_direction(pin_, GPIO_MODE_INPUT);

    std::array<std::uint8_t, 5> bytes{};
    static portMUX_TYPE timing_lock = portMUX_INITIALIZER_UNLOCKED;
    taskENTER_CRITICAL(&timing_lock);
    const bool captured = capture_frame(pin_, &bytes);
    taskEXIT_CRITICAL(&timing_lock);
    gpio_set_direction(pin_, GPIO_MODE_INPUT_OUTPUT_OD);
    gpio_set_level(pin_, 1);

    if (!captured) {
        return ESP_ERR_TIMEOUT;
    }
    const std::uint8_t checksum = static_cast<std::uint8_t>(
        bytes[0] + bytes[1] + bytes[2] + bytes[3]);
    if (checksum != bytes[4]) {
        return ESP_ERR_INVALID_CRC;
    }

    reading->humidity_pct = bytes[0] + bytes[1] * 0.1F;
    const float magnitude = bytes[2] + (bytes[3] & 0x7FU) * 0.1F;
    reading->temperature_c = (bytes[3] & 0x80U) != 0 ? -magnitude : magnitude;
    if (reading->humidity_pct < 0.0F || reading->humidity_pct > 100.0F ||
        reading->temperature_c < -40.0F || reading->temperature_c > 80.0F) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    return ESP_OK;
}

}  // namespace farmos::sensors
