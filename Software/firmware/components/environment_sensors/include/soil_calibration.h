#pragma once
#include <cstdint>
namespace farmos::sensors {
// Match noteessp32s3.ino: the measured wet endpoint must exceed dry by >=10.
// Returns hundredths of percent, or -1 when calibration/readout is invalid.
inline int calibrated_soil_centi_percent(int raw, int dry, int wet, bool dry_ok, bool wet_ok) {
    if (!dry_ok || !wet_ok || dry < 0 || wet > 4095 || wet <= dry + 9 || raw < 0 || raw > 4095) return -1;
    if (raw <= dry) return 0;
    if (raw >= wet) return 10000;
    return static_cast<int>((static_cast<std::int64_t>(raw - dry) * 10000 + (wet - dry) / 2) / (wet - dry));
}
}
