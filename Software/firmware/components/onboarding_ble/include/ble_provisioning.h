#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

#include "esp_err.h"

namespace farmos::onboarding {

struct BleUuids {
    std::array<std::uint8_t, 16> service;
    std::array<std::uint8_t, 16> identity_characteristic;
    std::array<std::uint8_t, 16> config_characteristic;
    std::array<std::uint8_t, 16> ota_characteristic{};
    std::array<std::uint8_t, 16> auth_characteristic{};
};

class BleProvisioningServer {
public:
    using WriteHandler = std::function<bool(const std::string&)>;
    using AuthWriteHandler = std::function<bool(const std::string&)>;
    using AuthReadHandler = std::function<std::string()>;
    using OtaWriteHandler = std::function<bool(const std::uint8_t*, std::size_t)>;
    using OtaReadHandler = std::function<std::string()>;

    BleProvisioningServer(std::string device_name, std::string identity_json,
                          BleUuids uuids, WriteHandler write_handler);

    esp_err_t begin();
    void set_identity_json(std::string identity_json);
    void set_advertising(bool enabled);
    void allow_bond_repair() { bond_repair_allowed_ = true; }
    void set_auth_handlers(AuthWriteHandler auth_write, AuthReadHandler auth_read);
    void set_ota_handlers(OtaWriteHandler ota_write, OtaReadHandler ota_read);

    const std::string& identity_json() const { return identity_json_; }
    bool advertising_enabled() const { return advertising_enabled_; }
    bool bond_repair_allowed() const { return bond_repair_allowed_; }
    bool handle_write(const std::string& value) const;
    bool handle_auth_write(const std::string& value) const;
    std::string handle_auth_read() const;
    bool handle_ota_write(const std::uint8_t* data, std::size_t len) const;
    std::string handle_ota_read() const;

private:
    std::string device_name_;
    std::string identity_json_;
    BleUuids uuids_;
    WriteHandler write_handler_;
    AuthWriteHandler auth_write_handler_;
    AuthReadHandler auth_read_handler_;
    OtaWriteHandler ota_write_handler_;
    OtaReadHandler ota_read_handler_;
    bool advertising_enabled_{true};
    bool bond_repair_allowed_{false};
};

}  // namespace farmos::onboarding
