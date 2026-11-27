#pragma once

namespace farmos::sensors {
// Temporary 12-bit ADC scale for a resistive two-prong module whose AO falls
// as soil gets wetter. These are NOT measured calibration endpoints.
constexpr int kUncalibratedSoilDryAdc = 4095;
constexpr int kUncalibratedSoilWetAdc = 0;
inline int estimate_soil_moisture_percent(int raw) {
    if (raw < 0 || raw > 4095) return -1;
    constexpr int span = kUncalibratedSoilDryAdc - kUncalibratedSoilWetAdc;
    const int percent = ((kUncalibratedSoilDryAdc - raw) * 100 + span / 2) / span;
    return percent < 0 ? 0 : percent > 100 ? 100 : percent;
}
}
