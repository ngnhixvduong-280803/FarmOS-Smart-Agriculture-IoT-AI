#pragma once

#include <cstdint>
#include "esp_app_desc.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "sx1278_radio.h"
#include "device_identity.h"

namespace farmos::gateway::config {

// Change these five values if your physical wiring is different.
constexpr farmos::radio::Pins kRadioPins{
    .spi_host = SPI2_HOST,
    .sck = GPIO_NUM_18,
    .miso = GPIO_NUM_19,
    .mosi = GPIO_NUM_23,
    .chip_select = GPIO_NUM_5,
    .reset = GPIO_NUM_14,
};

constexpr std::uint32_t kFrequencyHz = 433'000'000;
inline const char* const kFirmwareVersion = esp_app_get_description()->version;
inline farmos::identity::Identity kIdentity{};
inline auto& kDeviceId = kIdentity.device_id;
inline auto& kSerialNumber = kIdentity.serial;
// Legacy claim code is only available in an explicitly development-configured
// image. Production BLE uses the factory attestation challenge instead.
#ifdef CONFIG_FARMOS_DEVELOPMENT_IDENTITY
inline auto& kFactoryClaimCode = kIdentity.setup_secret;
#endif
// Keep the gateway in RX for a long window. A short window can repeatedly
// close at the same phase as a periodic node transmission and lose that frame.
constexpr std::uint32_t kReceiveWindowMs = 60'000;
constexpr std::uint32_t kAckTurnaroundMs = 25;

}  // namespace farmos::gateway::config
