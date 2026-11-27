#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace farmos::node {

class NodeOta {
public:
    static void init();
    static void confirm_running_image();
    static bool handle_write(const std::uint8_t* data, std::size_t len);
    static std::string handle_read();
    static bool in_progress();
    static bool boot_pending_verification();
    static bool post_ota_health_observed();
};

}  // namespace farmos::node
