#pragma once

#include <cstddef>
#include <cstdint>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_err.h"

namespace farmos::radio {

struct Pins {
    spi_host_device_t spi_host;
    gpio_num_t sck;
    gpio_num_t miso;
    gpio_num_t mosi;
    gpio_num_t chip_select;
    gpio_num_t reset;
};

struct ReceiveMetadata {
    std::int16_t rssi_dbm;
    float snr_db;
};

class Sx1278Radio {
public:
    explicit Sx1278Radio(Pins pins);
    ~Sx1278Radio();

    Sx1278Radio(const Sx1278Radio&) = delete;
    Sx1278Radio& operator=(const Sx1278Radio&) = delete;

    esp_err_t begin(std::uint32_t frequency_hz);
    esp_err_t send(const void* data, std::size_t length, std::uint32_t timeout_ms);
    esp_err_t receive(void* data, std::size_t capacity, std::size_t* received_length,
                      ReceiveMetadata* metadata, std::uint32_t timeout_ms);
    esp_err_t standby();

private:
    esp_err_t read_register(std::uint8_t address, std::uint8_t* value);
    esp_err_t write_register(std::uint8_t address, std::uint8_t value);
    esp_err_t read_burst(std::uint8_t address, void* data, std::size_t length);
    esp_err_t write_burst(std::uint8_t address, const void* data, std::size_t length);
    esp_err_t set_mode(std::uint8_t mode);
    esp_err_t reset_chip();

    Pins pins_;
    spi_device_handle_t spi_device_{nullptr};
    bool bus_initialized_{false};
};

}  // namespace farmos::radio
