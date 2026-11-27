#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "driver/gpio.h"
#include "esp_err.h"

namespace farmos::sensors {

using OneWireRom = std::array<std::uint8_t, 8>;

class Ds18b20Bus {
public:
    static constexpr std::size_t kMaxDevices = 2;

    explicit Ds18b20Bus(gpio_num_t pin);

    esp_err_t begin();
    esp_err_t discover(std::array<OneWireRom, kMaxDevices>* devices,
                       std::size_t* device_count);
    esp_err_t start_conversion();
    esp_err_t read_temperature(const OneWireRom& device, float* temperature_c);

    static std::uint64_t rom_as_u64(const OneWireRom& rom);

private:
    bool reset();
    void write_bit(bool value);
    bool read_bit();
    void write_byte(std::uint8_t value);
    std::uint8_t read_byte();
    void select(const OneWireRom& device);
    bool search_next(OneWireRom* device);
    static std::uint8_t crc8(const std::uint8_t* data, std::size_t length);

    gpio_num_t pin_;
    OneWireRom search_rom_{};
    std::uint8_t last_discrepancy_{0};
    bool last_device_{false};
};

}  // namespace farmos::sensors
