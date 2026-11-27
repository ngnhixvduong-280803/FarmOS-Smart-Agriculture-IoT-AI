#include <cassert>
#include "sht30_sample.h"
int main() {
    // Sensirion datasheet known CRC vector: BEEF -> 92.
    unsigned char bytes[]{0xbe,0xef,0x92,0xbe,0xef,0x92};
    auto sample = farmos::sensors::decode_sht30(bytes,6);
    assert(sample.temperature_valid && sample.humidity_valid);
    assert(sample.temperature > 85 && sample.temperature < 86);
    assert(sample.humidity > 74 && sample.humidity < 75);
    bytes[2] ^= 1;
    sample = farmos::sensors::decode_sht30(bytes,6);
    assert(!sample.temperature_valid && sample.humidity_valid);
    bytes[5] ^= 1;
    sample = farmos::sensors::decode_sht30(bytes,6);
    assert(!sample.temperature_valid && !sample.humidity_valid);
    assert(!farmos::sensors::decode_sht30(nullptr,6).temperature_valid);
    assert(!farmos::sensors::decode_sht30(bytes,5).humidity_valid);
    unsigned char zero[]{0,0,0,0,0,0};
    assert(!farmos::sensors::decode_sht30(zero,6).temperature_valid);
}
