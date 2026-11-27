idf_component_register(
    SRCS
        "src/ds18b20_bus.cpp"
        "src/node_peripherals.cpp"
    INCLUDE_DIRS "include"
    REQUIRES
        esp_driver_gpio
        esp_timer
        esp_driver_i2c
        esp_adc
)
