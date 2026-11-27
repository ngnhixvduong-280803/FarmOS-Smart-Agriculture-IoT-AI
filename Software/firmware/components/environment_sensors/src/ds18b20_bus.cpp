#include "ds18b20_bus.h"

#include <algorithm>
#include <array>
#include <cstdint>

#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"

namespace farmos::sensors {
namespace {

constexpr std::uint8_t kSearchRom = 0xF0;
constexpr std::uint8_t kMatchRom = 0x55;
constexpr std::uint8_t kSkipRom = 0xCC;
constexpr std::uint8_t kConvertTemperature = 0x44;
constexpr std::uint8_t kReadScratchpad = 0xBE;
constexpr std::uint8_t kDs18b20Family = 0x28;

}  // namespace

Ds18b20Bus::Ds18b20Bus(gpio_num_t pin) : pin_(pin) {}

esp_err_t Ds18b20Bus::begin() {
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

bool Ds18b20Bus::reset() {
    static portMUX_TYPE timing_lock = portMUX_INITIALIZER_UNLOCKED;
    taskENTER_CRITICAL(&timing_lock);
    gpio_set_direction(pin_, GPIO_MODE_OUTPUT_OD);
    gpio_set_level(pin_, 0);
    esp_rom_delay_us(480);
    gpio_set_level(pin_, 1);
    gpio_set_direction(pin_, GPIO_MODE_INPUT_OUTPUT_OD);
    esp_rom_delay_us(70);
    const bool present = gpio_get_level(pin_) == 0;
    esp_rom_delay_us(410);
    taskEXIT_CRITICAL(&timing_lock);
    return present;
}

void Ds18b20Bus::write_bit(bool value) {
    static portMUX_TYPE timing_lock = portMUX_INITIALIZER_UNLOCKED;
    taskENTER_CRITICAL(&timing_lock);
    gpio_set_level(pin_, 0);
    if (value) {
        esp_rom_delay_us(6);
        gpio_set_level(pin_, 1);
        esp_rom_delay_us(64);
    } else {
        esp_rom_delay_us(60);
        gpio_set_level(pin_, 1);
        esp_rom_delay_us(10);
    }
    taskEXIT_CRITICAL(&timing_lock);
}

bool Ds18b20Bus::read_bit() {
    static portMUX_TYPE timing_lock = portMUX_INITIALIZER_UNLOCKED;
    taskENTER_CRITICAL(&timing_lock);
    gpio_set_level(pin_, 0);
    esp_rom_delay_us(3);
    gpio_set_level(pin_, 1);
    esp_rom_delay_us(10);
    const bool value = gpio_get_level(pin_) != 0;
    esp_rom_delay_us(53);
    taskEXIT_CRITICAL(&timing_lock);
    return value;
}

void Ds18b20Bus::write_byte(std::uint8_t value) {
    for (int bit = 0; bit < 8; ++bit) {
        write_bit((value & 0x01U) != 0);
        value >>= 1U;
    }
}

std::uint8_t Ds18b20Bus::read_byte() {
    std::uint8_t value = 0;
    for (int bit = 0; bit < 8; ++bit) {
        if (read_bit()) {
            value |= static_cast<std::uint8_t>(1U << bit);
        }
    }
    return value;
}

void Ds18b20Bus::select(const OneWireRom& device) {
    write_byte(kMatchRom);
    for (const std::uint8_t byte : device) {
        write_byte(byte);
    }
}

bool Ds18b20Bus::search_next(OneWireRom* device) {
    if (device == nullptr || last_device_ || !reset()) {
        return false;
    }
    write_byte(kSearchRom);

    std::uint8_t bit_number = 1;
    std::uint8_t last_zero = 0;
    std::size_t byte_index = 0;
    std::uint8_t byte_mask = 1;

    while (byte_index < search_rom_.size()) {
        const bool id_bit = read_bit();
        const bool complement_bit = read_bit();
        if (id_bit && complement_bit) {
            return false;
        }

        bool direction = false;
        if (id_bit != complement_bit) {
            direction = id_bit;
        } else {
            direction = bit_number < last_discrepancy_
                            ? (search_rom_[byte_index] & byte_mask) != 0
                            : bit_number == last_discrepancy_;
            if (!direction) {
                last_zero = bit_number;
            }
        }

        if (direction) {
            search_rom_[byte_index] |= byte_mask;
        } else {
            search_rom_[byte_index] &= static_cast<std::uint8_t>(~byte_mask);
        }
        write_bit(direction);

        ++bit_number;
        byte_mask <<= 1U;
        if (byte_mask == 0) {
            ++byte_index;
            byte_mask = 1;
        }
    }

    if (bit_number != 65 || crc8(search_rom_.data(), 7) != search_rom_[7]) {
        return false;
    }
    last_discrepancy_ = last_zero;
    last_device_ = last_discrepancy_ == 0;
    *device = search_rom_;
    return true;
}

esp_err_t Ds18b20Bus::discover(std::array<OneWireRom, kMaxDevices>* devices,
                               std::size_t* device_count) {
    if (devices == nullptr || device_count == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    *device_count = 0;
    search_rom_.fill(0);
    last_discrepancy_ = 0;
    last_device_ = false;

    OneWireRom device{};
    while (*device_count < devices->size() && search_next(&device)) {
        if (device[0] == kDs18b20Family) {
            (*devices)[(*device_count)++] = device;
        }
    }
    std::sort(devices->begin(), devices->begin() + *device_count);
    return *device_count > 0 ? ESP_OK : ESP_ERR_NOT_FOUND;
}

esp_err_t Ds18b20Bus::start_conversion() {
    if (!reset()) {
        return ESP_ERR_NOT_FOUND;
    }
    write_byte(kSkipRom);
    write_byte(kConvertTemperature);
    return ESP_OK;
}

esp_err_t Ds18b20Bus::read_temperature(const OneWireRom& device,
                                       float* temperature_c) {
    if (temperature_c == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!reset()) {
        return ESP_ERR_NOT_FOUND;
    }
    select(device);
    write_byte(kReadScratchpad);

    std::array<std::uint8_t, 9> scratchpad{};
    for (std::uint8_t& byte : scratchpad) {
        byte = read_byte();
    }
    if (crc8(scratchpad.data(), 8) != scratchpad[8]) {
        return ESP_ERR_INVALID_CRC;
    }

    const std::int16_t raw = static_cast<std::int16_t>(
        static_cast<std::uint16_t>(scratchpad[0]) |
        (static_cast<std::uint16_t>(scratchpad[1]) << 8U));
    *temperature_c = raw / 16.0F;
    if (*temperature_c < -55.0F || *temperature_c > 125.0F) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    return ESP_OK;
}

std::uint64_t Ds18b20Bus::rom_as_u64(const OneWireRom& rom) {
    std::uint64_t value = 0;
    for (std::size_t index = 0; index < rom.size(); ++index) {
        value |= static_cast<std::uint64_t>(rom[index]) << (index * 8U);
    }
    return value;
}

std::uint8_t Ds18b20Bus::crc8(const std::uint8_t* data, std::size_t length) {
    std::uint8_t crc = 0;
    for (std::size_t index = 0; index < length; ++index) {
        std::uint8_t value = data[index];
        for (int bit = 0; bit < 8; ++bit) {
            const bool mix = (crc ^ value) & 0x01U;
            crc >>= 1U;
            if (mix) {
                crc ^= 0x8CU;
            }
            value >>= 1U;
        }
    }
    return crc;
}

}  // namespace farmos::sensors
