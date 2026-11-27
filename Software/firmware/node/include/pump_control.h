#pragma once

#include <cstdint>

namespace farmos::node::pump {
struct Result {
    bool feedback_on;
    const char* error;
};

void begin();
bool ready();
bool output_on();
int feedback_state();
void stop();
Result apply(bool on, int duration_seconds);
}
