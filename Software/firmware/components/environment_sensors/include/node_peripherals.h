#pragma once
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_adc/adc_oneshot.h"
namespace farmos::sensors {
struct PeripheralReadings { int soil_raw{-1}; int soil_moisture_centi_pct{-1}; int float_contact{-1}; bool air_temperature_valid{false}; bool air_humidity_valid{false}; float air_temperature{0}; float air_humidity{0}; bool lcd_present{false}; };
class NodePeripherals {
public:
 void begin(gpio_num_t soil, gpio_num_t float_pin, gpio_num_t relay, gpio_num_t sda, gpio_num_t scl);
 PeripheralReadings read(const char* connection_status, float soil_temperature, bool show_setup, int dry, int wet, bool dry_ok, bool wet_ok, bool test_calibration);
private:
 adc_oneshot_unit_handle_t adc_{nullptr}; adc_channel_t channel_{};
 i2c_master_bus_handle_t bus_{nullptr}; i2c_master_dev_handle_t sht_{nullptr}, sht_alt_{nullptr}, lcd_{nullptr}, lcd_pcf27_{nullptr}, lcd_pcf3f_{nullptr};
 gpio_num_t float_pin_{GPIO_NUM_NC}; bool float_ready_{false}; bool lcd_ready_{false};
 i2c_master_dev_handle_t active_pcf_{nullptr};
 unsigned lcd_page_{0};
 bool lcd_command(unsigned char command);
 bool pcf_write(i2c_master_dev_handle_t dev, unsigned char value, bool data);
 bool pcf_init(i2c_master_dev_handle_t dev);
};
}
