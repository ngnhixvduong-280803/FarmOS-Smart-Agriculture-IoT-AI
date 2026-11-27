#pragma once

#include <cstdint>
#include "esp_app_desc.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "sx1278_radio.h"
#include "device_identity.h"

namespace farmos::node::config {

// Change these five values if your physical wiring is different.
constexpr farmos::radio::Pins kRadioPins{
    .spi_host = SPI2_HOST,
    .sck = GPIO_NUM_12,
    .miso = GPIO_NUM_13,
    .mosi = GPIO_NUM_11,
    .chip_select = GPIO_NUM_10,
    .reset = GPIO_NUM_9,
};

constexpr gpio_num_t kDs18b20Pin = GPIO_NUM_4;
constexpr gpio_num_t kSoilMoisturePin = GPIO_NUM_1;
constexpr gpio_num_t kFloatPin = GPIO_NUM_5;
constexpr gpio_num_t kRelayPin = GPIO_NUM_6;
constexpr gpio_num_t kI2cSdaPin = GPIO_NUM_7;
constexpr gpio_num_t kI2cSclPin = GPIO_NUM_8;
constexpr gpio_num_t kPairButtonPin = GPIO_NUM_0;

constexpr std::uint32_t kFrequencyHz = 433'000'000;
inline const char* const kFirmwareVersion = esp_app_get_description()->version;
inline farmos::identity::Identity kIdentity{};
inline auto& kNodeId = kIdentity.radio_id;
inline auto& kDeviceId = kIdentity.device_id;
inline auto& kSerialNumber = kIdentity.serial;
// Legacy claim code is only available in an explicitly development-configured
// image. Production BLE uses the factory attestation challenge instead.
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
inline auto& kFactoryClaimCode = kIdentity.setup_secret;
#endif
constexpr std::uint32_t kSendIntervalMs = 5'000;
constexpr std::uint32_t kAckTimeoutMs = 1'500;
constexpr int kMaxAttempts = 3;

}  // namespace farmos::node::config
