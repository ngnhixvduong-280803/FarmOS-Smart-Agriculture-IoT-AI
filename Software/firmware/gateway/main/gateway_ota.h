#pragma once

#include <string>
#include "esp_err.h"

namespace farmos::gateway {

struct OtaCheckResult {
    bool update_available{false};
    std::string target_version;
    std::string download_url;
    std::string sha256;
    std::size_t size_bytes{0};
};

class GatewayOta {
public:
    static void init();
    static void confirm_running_image(const std::string& api_base, const std::string& gateway_token);
    static bool check_and_perform_update(const std::string& api_base, const std::string& gateway_token);
};

}  // namespace farmos::gateway
