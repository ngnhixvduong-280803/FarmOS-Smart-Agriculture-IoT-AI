#pragma once

#include <cstdint>
#include <string>

#include "esp_err.h"

namespace farmos::gateway {

struct PairingGrant {
    bool available{false};
    char pairing_id[48]{};
    char node_id[40]{};
    char radio_token_hex[33]{};
    std::int16_t rssi_dbm{0};
    std::int16_t snr_centi_db{0};
};

struct TelemetryUpload {
    char node_id[40]{};
    std::uint32_t boot_id{0};
    std::uint32_t sequence{0};
    std::int16_t temperature_centi_c{0};
    std::uint8_t quality{0};
};

class GatewayCloud {
public:
    GatewayCloud();
    esp_err_t begin();
    bool accept_ble_config(const std::string& json);
    bool online() const;
    bool current_pairing(PairingGrant* output) const;
    void confirm_pairing(const PairingGrant& grant, int rssi_dbm, float snr_db);
    bool enqueue_telemetry(const TelemetryUpload& telemetry);

private:
    struct Impl;
    Impl* impl_;
};

}  // namespace farmos::gateway
