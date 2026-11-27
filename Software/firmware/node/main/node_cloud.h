#pragma once

#include <cstdint>
#include <string>
#include "esp_err.h"

namespace farmos::node {

enum class ConnectionMode : std::uint8_t {
    UNCONFIGURED = 0,
    WIFI = 1,
    LORA_GATEWAY = 2,
};

struct DirectTelemetry {
    std::uint32_t boot_id{0};
    std::uint32_t sequence{0};
    std::int16_t temperature_centi_c{0};
    std::uint8_t quality{0};
    std::uint8_t sensor_mask{4}; // Older outbox records contain only soil temperature.
    std::int16_t air_temperature_centi_c{0};
    std::uint16_t air_humidity_centi_pct{0};
    std::int16_t soil_moisture_centi_pct{-1};
};

class NodeCloud {
 public:
    NodeCloud();
    esp_err_t begin();
    bool accept_ble_config(const std::string& json);
    bool standalone_active() const;
    ConnectionMode mode() const;
    // Returns true exactly once after an authenticated LEAF_NODE ->
    // STANDALONE_NODE transition has redeemed its server ticket and
    // durably committed the resulting device credential. The app clears the
    // old LoRa binding only after observing this commit; a Wi-Fi probe alone
    // is never enough to switch the persisted transport identity.
    bool consume_standalone_mode_commit();
    void set_lora_gateway_mode(bool enabled);
    bool enqueue(const DirectTelemetry& telemetry);
    void pause_for_pairing();
    void resume_after_pairing_failure();
    void clear_after_pairing();

 private:
    struct Impl;
    Impl* impl_;
};

}  // namespace farmos::node
