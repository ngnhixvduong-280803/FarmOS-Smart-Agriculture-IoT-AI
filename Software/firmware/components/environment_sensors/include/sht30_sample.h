#pragma once
#include <cstddef>
#include <cstdint>
#include <algorithm>
namespace farmos::sensors {
struct Sht30Sample {
    bool temperature_valid{false};
    bool humidity_valid{false};
    float temperature{0};
    float humidity{0};
};
inline bool sht30_crc_ok(const std::uint8_t* bytes) {
    std::uint8_t crc = 0xff;
    for (int index = 0; index < 2; ++index) {
        crc ^= bytes[index];
        for (int bit = 0; bit < 8; ++bit) crc = (crc & 0x80) ? (crc << 1) ^ 0x31 : crc << 1;
    }
    return crc == bytes[2];
}
inline Sht30Sample decode_sht30(const std::uint8_t* bytes, std::size_t size, bool sht4 = false) {
    Sht30Sample result{};
    if (!bytes || size != 6) return result;
    if (sht30_crc_ok(bytes)) {
        result.temperature = -45.0f + 175.0f * ((bytes[0] << 8) | bytes[1]) / 65535.0f;
        result.temperature_valid = result.temperature >= -40 && result.temperature <= 125;
    }
    if (sht30_crc_ok(bytes + 3)) {
        const float raw_humidity = ((bytes[3] << 8) | bytes[4]) / 65535.0f;
        result.humidity = sht4 ? std::clamp(-6.0f + 125.0f * raw_humidity, 0.0f, 100.0f) : 100.0f * raw_humidity;
        result.humidity_valid = true;
    }
    return result;
}
}
