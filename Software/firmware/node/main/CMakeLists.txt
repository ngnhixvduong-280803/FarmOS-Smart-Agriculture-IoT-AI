idf_component_register(
    SRCS "main.cpp" "node_ota.cpp" "node_cloud.cpp" "node_cloud_ota.cpp" "pump_control.cpp"
    INCLUDE_DIRS "../include"
    REQUIRES shared environment_sensors onboarding_ble nvs_flash esp_timer esp_wifi esp_event esp_netif esp_http_client esp_https_ota espressif__cjson app_update mbedtls
)
