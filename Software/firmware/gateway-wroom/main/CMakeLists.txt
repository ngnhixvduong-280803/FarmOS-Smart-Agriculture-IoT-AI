idf_component_register(
    SRCS "main.cpp" "gateway_cloud.cpp" "gateway_ota.cpp"
    INCLUDE_DIRS "../include"
    REQUIRES shared environment_sensors onboarding_ble nvs_flash esp_wifi esp_event esp_netif esp_http_client espressif__cjson mbedtls app_update esp_https_ota
)
