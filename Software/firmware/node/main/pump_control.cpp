#include "pump_control.h"

#include <cstring>

#include "board_config.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

namespace farmos::node::pump {
#ifdef CONFIG_FARMOS_PUMP_CONTROL
namespace {

// Exclude the Node peripherals, strapping pins, USB, console and flash/PSRAM.
constexpr bool available_pin(int pin) {
    return (pin >= 14 && pin <= 18) || pin == 21 || (pin >= 38 && pin <= 42) ||
           pin == 47 || pin == 48;
}
#ifdef CONFIG_FARMOS_RELAY_BENCH_NODE_V1
constexpr auto normally_open = GPIO_NUM_14;
constexpr auto normally_closed = GPIO_NUM_15;

int contact_state() {
    const bool no_closed = gpio_get_level(normally_open) == 0;
    const bool nc_closed = gpio_get_level(normally_closed) == 0;
    if (no_closed == nc_closed) return -1;
    return no_closed ? 1 : 0;
}

bool permitted() { return true; }
#else
constexpr int permissive = CONFIG_FARMOS_PUMP_PERMISSIVE_GPIO;
constexpr int feedback = CONFIG_FARMOS_PUMP_FEEDBACK_GPIO;
static_assert(available_pin(permissive) && available_pin(feedback) && permissive != feedback,
              "Configure two verified, separate pump input pins");
constexpr auto permissive_pin = static_cast<gpio_num_t>(permissive);
constexpr auto feedback_pin = static_cast<gpio_num_t>(feedback);
int contact_state() { return gpio_get_level(feedback_pin); }
bool permitted() { return gpio_get_level(permissive_pin) != 0; }
#endif
constexpr int max_run_seconds = 30;
esp_timer_handle_t watchdog{};
portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
std::int64_t deadline_us = 0;
bool initialized = false;

void cutoff(void*) {
    portENTER_CRITICAL(&lock);
    if (deadline_us && (esp_timer_get_time() >= deadline_us || !permitted())) {
        gpio_set_level(config::kRelayPin, 0);
        deadline_us = 0;
    }
    portEXIT_CRITICAL(&lock);
}

bool stable_feedback(bool expected) {
    int matches = 0;
    for (int count = 0; count < 30; ++count) {
        if (contact_state() == static_cast<int>(expected)) {
            if (++matches == 3) return true;
        } else {
            matches = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    return false;
}
}

void begin() {
    gpio_config_t input{};
    input.mode = GPIO_MODE_INPUT;
#ifdef CONFIG_FARMOS_RELAY_BENCH_NODE_V1
    if (std::strcmp(config::kDeviceId, "NODE_232622412") != 0) return;
    input.pin_bit_mask = (1ULL << normally_open) | (1ULL << normally_closed);
    input.pull_up_en = GPIO_PULLUP_ENABLE;
#else
    input.pin_bit_mask = (1ULL << feedback) | (1ULL << permissive);
    input.pull_down_en = GPIO_PULLDOWN_ENABLE;
#endif
    if (gpio_config(&input) != ESP_OK) return;
    esp_timer_create_args_t args{};
    args.callback = cutoff;
    args.name = "pump_cutoff";
    if (esp_timer_create(&args, &watchdog) == ESP_OK &&
        esp_timer_start_periodic(watchdog, 20'000) == ESP_OK) initialized = true;
}

bool ready() { return initialized; }
int feedback_state() { return initialized ? contact_state() : -1; }

bool output_on() {
    portENTER_CRITICAL(&lock);
    const bool on = deadline_us != 0;
    portEXIT_CRITICAL(&lock);
    return on;
}

void stop() {
    portENTER_CRITICAL(&lock);
    gpio_set_level(config::kRelayPin, 0);
    deadline_us = 0;
    portEXIT_CRITICAL(&lock);
}

Result apply(bool on, int duration_seconds) {
    if (!initialized) return {false, "OUTPUT_ERROR"};
    if (!on) {
        stop();
        if (stable_feedback(false)) return {false, nullptr};
        return {contact_state() == 1, "FEEDBACK_MISMATCH"};
    }
    if (duration_seconds < 1 || duration_seconds > max_run_seconds) return {false, "OUTPUT_ERROR"};
    const int before = contact_state();
    if (before == 1) return {true, "FEEDBACK_ALREADY_ON"};
    if (before < 0) return {false, "FEEDBACK_MISMATCH"};

    portENTER_CRITICAL(&lock);
    const bool safe = permitted();
    const bool started = safe && !deadline_us && gpio_set_level(config::kRelayPin, 1) == ESP_OK;
    if (started) deadline_us = esp_timer_get_time() + duration_seconds * 1'000'000LL;
    portEXIT_CRITICAL(&lock);
    if (!started) return {false, safe ? "OUTPUT_ERROR" : "INTERLOCK_OPEN"};

    const bool confirmed = stable_feedback(true);
    portENTER_CRITICAL(&lock);
    const bool still_safe = deadline_us && permitted() && contact_state() == 1;
    portEXIT_CRITICAL(&lock);
    if (confirmed && still_safe) return {true, nullptr};
    stop();
    stable_feedback(false);
    return {contact_state() == 1, permitted() ? "FEEDBACK_MISMATCH" : "INTERLOCK_OPEN"};
}
#else
void begin() {}
bool ready() { return false; }
bool output_on() { return false; }
int feedback_state() { return -1; }
void stop() {}
Result apply(bool, int) { return {false, "OUTPUT_ERROR"}; }
#endif
}
