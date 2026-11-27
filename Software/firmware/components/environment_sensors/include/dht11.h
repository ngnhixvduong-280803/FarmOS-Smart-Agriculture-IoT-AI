#pragma once

#include "driver/gpio.h"
#include "esp_err.h"

namespace farmos::sensors {

struct Dht11Reading {
    float temperature_c;
    float humidity_pct;
};

class Dht11 {
public:
    explicit Dht11(gpio_num_t pin);

    esp_err_t begin();
    esp_err_t read(Dht11Reading* reading);

private:
    gpio_num_t pin_;
};

}  // namespace farmos::sensors
