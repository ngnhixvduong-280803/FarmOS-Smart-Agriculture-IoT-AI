#pragma once

#include <string>

namespace farmos::node {

class NodeCloudOta {
 public:
    static bool confirm_running_image(const std::string& api_base, const std::string& device_token);
    static bool check_and_perform_update(const std::string& api_base, const std::string& device_token);
};

}  // namespace farmos::node
