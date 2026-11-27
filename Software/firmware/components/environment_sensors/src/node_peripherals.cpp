#include "soil_calibration.h"
#include "node_peripherals.h"
#include "sht30_sample.h"
#include <cmath>
#include <cstdio>
#include <cstring>
#include <algorithm>
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
namespace farmos::sensors {
bool NodePeripherals::lcd_command(unsigned char command) { const unsigned char bytes[]{0,command};return lcd_ && i2c_master_transmit(lcd_,bytes,2,30)==ESP_OK; }
bool NodePeripherals::pcf_write(i2c_master_dev_handle_t dev, unsigned char value, bool data) {
 // Match LiquidCrystal_PCF8574: both nibbles in a single transaction.
 const unsigned char control = 0x08 | (data ? 0x01 : 0x00);
 const unsigned char high = (value & 0xf0) | control;
 const unsigned char low = ((value & 0x0f) << 4) | control;
 const unsigned char bytes[]{static_cast<unsigned char>(high | 0x04), high,
                             static_cast<unsigned char>(low | 0x04), low};
 if (i2c_master_transmit(dev, bytes, sizeof(bytes), 30) != ESP_OK) return false;
 // Clear/home require much longer than ordinary writes. At 100 Hz,
 // pdMS_TO_TICKS(2) was zero and did not provide this delay.
 if (!data && (value == 0x01 || value == 0x02)) esp_rom_delay_us(2000);
 return true;
}
bool NodePeripherals::pcf_init(i2c_master_dev_handle_t dev) {
 const unsigned char idle = 0;
 if (i2c_master_transmit(dev, &idle, 1, 30) != ESP_OK) return false;
 vTaskDelay(pdMS_TO_TICKS(50) + 1);
 const unsigned char reset[]{0x34, 0x30};
 const unsigned int waits_us[]{4500, 200, 200};
 for (const auto wait_us : waits_us) {
   if (i2c_master_transmit(dev, reset, sizeof(reset), 30) != ESP_OK) return false;
   esp_rom_delay_us(wait_us);
 }
 const unsigned char four_bit[]{0x24, 0x20};
 if (i2c_master_transmit(dev, four_bit, sizeof(four_bit), 30) != ESP_OK) return false;
 return pcf_write(dev, 0x28, false) && pcf_write(dev, 0x0c, false) &&
        pcf_write(dev, 0x01, false) && pcf_write(dev, 0x06, false);
}
void NodePeripherals::begin(gpio_num_t soil,gpio_num_t float_pin,gpio_num_t relay,gpio_num_t sda,gpio_num_t scl) {
 // Active-HIGH relay: remain OFF without an authenticated actuator policy.
 gpio_set_level(relay,0); gpio_set_direction(relay,GPIO_MODE_OUTPUT); gpio_set_level(relay,0);
 float_pin_=float_pin; gpio_config_t input{}; input.pin_bit_mask=1ULL<<float_pin;input.mode=GPIO_MODE_INPUT;input.pull_up_en=GPIO_PULLUP_ENABLE;float_ready_=gpio_config(&input)==ESP_OK;
 adc_unit_t unit; adc_oneshot_unit_init_cfg_t init{};
 if(adc_oneshot_io_to_channel(soil,&unit,&channel_)==ESP_OK){init.unit_id=unit;if(adc_oneshot_new_unit(&init,&adc_)==ESP_OK){adc_oneshot_chan_cfg_t config{};config.atten=ADC_ATTEN_DB_12;config.bitwidth=ADC_BITWIDTH_12;if(adc_oneshot_config_channel(adc_,channel_,&config)!=ESP_OK){adc_oneshot_del_unit(adc_);adc_=nullptr;}}}
 // Disconnected ADC settles low. Rail values remain unknown rather than fabricated percentages.
 gpio_set_pull_mode(soil,GPIO_PULLDOWN_ONLY);
 i2c_master_bus_config_t config{};config.i2c_port=I2C_NUM_0;config.sda_io_num=sda;config.scl_io_num=scl;config.clk_source=I2C_CLK_SRC_DEFAULT;config.glitch_ignore_cnt=7;config.flags.enable_internal_pullup=true;
 if(i2c_new_master_bus(&config,&bus_)!=ESP_OK)return;
 i2c_device_config_t device{};device.dev_addr_length=I2C_ADDR_BIT_LEN_7;device.scl_speed_hz=100000;device.device_address=0x44;i2c_master_bus_add_device(bus_,&device,&sht_);device.device_address=0x45;i2c_master_bus_add_device(bus_,&device,&sht_alt_);device.device_address=0x3e;i2c_master_bus_add_device(bus_,&device,&lcd_);device.device_address=0x27;i2c_master_bus_add_device(bus_,&device,&lcd_pcf27_);device.device_address=0x3f;i2c_master_bus_add_device(bus_,&device,&lcd_pcf3f_);
}
PeripheralReadings NodePeripherals::read(const char* connection_status, float soil_temperature, bool show_setup, int dry, int wet, bool dry_ok, bool wet_ok, bool test_calibration) {
 PeripheralReadings result{};
 int samples[31]{}; int count=0; int raw=0;
 if(adc_) { adc_oneshot_read(adc_,channel_,&raw); for(int i=0;i<31;++i) if(adc_oneshot_read(adc_,channel_,&raw)==ESP_OK) samples[count++]=raw; }
 if(count==31) { std::sort(samples,samples+count); result.soil_raw=samples[count/2]; }
 result.soil_moisture_centi_pct = calibrated_soil_centi_percent(result.soil_raw, dry, wet, dry_ok, wet_ok);
 if(float_ready_)result.float_contact=gpio_get_level(float_pin_);
 // A 2-wire open contact and an unplugged float are indistinguishable; never infer safe water level.
 unsigned char reply[6]{}; const unsigned char sht30_command[]{0x24,0x00}; const unsigned char sht4_command[]{0xfd};
 for(int index=0; index<2 && !result.air_temperature_valid && !result.air_humidity_valid; ++index) {
   const auto device=index==0?sht_:sht_alt_; const int address=index==0?0x44:0x45;
   if(!device || !bus_ || i2c_master_probe(bus_,address,30)!=ESP_OK) continue;
   for(int type=0; type<2; ++type) {
     const auto command=type==0?sht30_command:sht4_command; const size_t length=type==0?sizeof(sht30_command):sizeof(sht4_command);
     if(i2c_master_transmit(device,command,length,30)!=ESP_OK) continue;
     vTaskDelay(pdMS_TO_TICKS(20));
     if(i2c_master_receive(device,reply,6,30)!=ESP_OK) continue;
     const auto sample=decode_sht30(reply,sizeof(reply),type==1);
     result.air_temperature=sample.temperature; result.air_temperature_valid=sample.temperature_valid;
     result.air_humidity=sample.humidity; result.air_humidity_valid=sample.humidity_valid;
     if(sample.temperature_valid || sample.humidity_valid) break;
   }
 }

 i2c_master_dev_handle_t pcf = nullptr;
 if (bus_ && i2c_master_probe(bus_,0x27,30)==ESP_OK) pcf=lcd_pcf27_;
 else if (bus_ && i2c_master_probe(bus_,0x3f,30)==ESP_OK) pcf=lcd_pcf3f_;
 if (pcf != active_pcf_) {
   active_pcf_ = pcf;
   lcd_ready_ = false;
 }
 if (pcf) {
   if (!lcd_ready_) lcd_ready_=pcf_init(pcf);
   if (lcd_ready_) {
     char rows[2][32]{};
     if (show_setup) {
       std::snprintf(rows[0], sizeof(rows[0]), "%s", connection_status);
       std::snprintf(rows[1], sizeof(rows[1]), "GHEP DOI QUA BLE");
     } else switch (lcd_page_++ % 4) {
       case 0:
         if (result.soil_moisture_centi_pct >= 0) std::snprintf(rows[0], sizeof(rows[0]), test_calibration ? "TEST dat:%4.0f%%" : "Do am dat:%4.0f%%", result.soil_moisture_centi_pct / 100.0);
         else std::snprintf(rows[0], sizeof(rows[0]), "Dat ADC: %d", result.soil_raw);
         if (std::isfinite(soil_temperature)) std::snprintf(rows[1], sizeof(rows[1]), "Nhiet dat %.1f C", soil_temperature);
         else std::snprintf(rows[1], sizeof(rows[1]), "Nhiet dat: --");
         break;
       case 1:
         if (result.air_temperature_valid) std::snprintf(rows[0], sizeof(rows[0]), "Nhiet KK %.1f C", result.air_temperature);
         else std::snprintf(rows[0], sizeof(rows[0]), "Nhiet KK: --");
         if (result.air_humidity_valid) std::snprintf(rows[1], sizeof(rows[1]), "Do am KK %.0f%%", result.air_humidity);
         else std::snprintf(rows[1], sizeof(rows[1]), "Do am KK: --");
         break;
       case 2:
         if (result.float_contact >= 0) std::snprintf(rows[0], sizeof(rows[0]), "Phao: %c", result.float_contact ? '1' : '0');
         else std::snprintf(rows[0], sizeof(rows[0]), "Tin hieu phao: -");
         std::snprintf(rows[1], sizeof(rows[1]), "Bom: TAT");
         break;
       default:
         std::snprintf(rows[0], sizeof(rows[0]), "Ket noi FarmOS");
         std::snprintf(rows[1], sizeof(rows[1]), "%s", connection_status);
     }
     bool ok = true;
     for (int row = 0; row < 2 && ok; ++row) {
       ok = pcf_write(pcf, row == 0 ? 0x80 : 0xc0, false);
       const auto length = std::strlen(rows[row]);
       for (unsigned i = 0; i < 16 && ok; ++i) {
         ok = pcf_write(pcf, i < length ? rows[row][i] : ' ', true);
       }
     }
     result.lcd_present=ok; if(!ok) lcd_ready_=false;
   }
   return result;
 }
 if(bus_&&i2c_master_probe(bus_,0x3e,30)==ESP_OK){if(!lcd_ready_){vTaskDelay(pdMS_TO_TICKS(40));lcd_ready_=lcd_command(0x38)&&lcd_command(0x0c)&&lcd_command(0x01);vTaskDelay(pdMS_TO_TICKS(2));}if(lcd_ready_){char row[17]{};if(result.air_temperature_valid)std::snprintf(row,sizeof(row),"Air %.1f C",result.air_temperature);else std::snprintf(row,sizeof(row),"Air null");unsigned char data[17];data[0]=0x40;std::memset(data+1,' ',16);std::memcpy(data+1,row,std::strlen(row));result.lcd_present=lcd_command(0x80)&&i2c_master_transmit(lcd_,data,sizeof(data),30)==ESP_OK;}}else lcd_ready_=false;
 return result;
}
}
