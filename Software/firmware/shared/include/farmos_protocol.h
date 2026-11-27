#pragma once

#include <cstddef>
#include <cstdint>

namespace farmos::protocol {

constexpr std::uint16_t kMagic = 0x4D46;  // "FM" on the little-endian wire.
constexpr std::uint8_t kVersion = 4;
constexpr std::int16_t kInvalidTemperatureCentiC = INT16_MIN;
constexpr std::uint16_t kInvalidHumidityCentiPct = UINT16_MAX;

enum class MessageType : std::uint8_t {
    kTelemetry = 1,
    kAck = 2,
    kPairRequest = 3,
    kPairAccept = 4,
};

enum class Quality : std::uint8_t {
    kValid = 0,
    kSuspect = 1,
    kInvalid = 2,
};

enum class AckStatus : std::uint8_t {
    kAccepted = 0,
    kDuplicate = 1,
    kRejected = 2,
};

enum SensorValidMask : std::uint8_t {
    kDht11TemperatureValid = 1U << 0U,
    kDht11HumidityValid = 1U << 1U,
    kAirTemperatureValid = kDht11TemperatureValid,
    kAirHumidityValid = kDht11HumidityValid,
    kDs18b20FirstValid = 1U << 2U,
    kDs18b20SecondValid = 1U << 3U,
    kSoilMoistureValid = 1U << 4U,
};

#pragma pack(push, 1)
struct TelemetryFrame {
    std::uint16_t magic;
    std::uint8_t version;
    std::uint8_t type;
    std::uint32_t node_id;
    std::uint32_t boot_id;
    std::uint32_t sequence;
    std::uint32_t uptime_ms;
    std::int16_t soil_moisture_centi_pct;
    std::int16_t air_temperature_centi_c;
    std::uint16_t air_humidity_centi_pct;
    std::int16_t probe_temperature_1_centi_c;
    std::int16_t probe_temperature_2_centi_c;
    std::uint8_t sensor_valid_mask;
    std::uint8_t quality;
    std::uint8_t reserved[2];
    std::uint8_t auth_tag[8];
    std::uint32_t crc32;
};

struct AckFrame {
    std::uint16_t magic;
    std::uint8_t version;
    std::uint8_t type;
    std::uint32_t node_id;
    std::uint32_t boot_id;
    std::uint32_t sequence;
    std::uint8_t status;
    std::uint8_t reserved[3];
    std::uint8_t auth_tag[8];
    std::uint32_t crc32;
};

struct PairRequestFrame {
    std::uint16_t magic;
    std::uint8_t version;
    std::uint8_t type;
    std::uint32_t node_id;
    std::uint32_t nonce;
    std::uint8_t auth_tag[16];
    std::uint32_t crc32;
};

struct PairAcceptFrame {
    std::uint16_t magic;
    std::uint8_t version;
    std::uint8_t type;
    std::uint32_t node_id;
    std::uint32_t nonce;
    std::uint8_t status;
    std::uint8_t reserved[3];
    std::uint8_t auth_tag[16];
    std::uint32_t crc32;
};
#pragma pack(pop)

static_assert(sizeof(TelemetryFrame) == 46, "Telemetry wire format changed");
static_assert(sizeof(AckFrame) == 32, "ACK wire format changed");
static_assert(sizeof(PairRequestFrame) == 32, "Pair request wire format changed");
static_assert(sizeof(PairAcceptFrame) == 36, "Pair accept wire format changed");

std::uint32_t crc32(const void* data, std::size_t length);
void finalize(TelemetryFrame& frame);
void finalize(AckFrame& frame);
void finalize(PairRequestFrame& frame);
void finalize(PairAcceptFrame& frame);
bool authenticate(TelemetryFrame& frame, const std::uint8_t key[16]);
bool authenticate(AckFrame& frame, const std::uint8_t key[16]);
bool authenticate(PairRequestFrame& frame, const std::uint8_t key[16]);
bool authenticate(PairAcceptFrame& frame, const std::uint8_t key[16]);
bool validate_authenticated(const PairRequestFrame& frame, const std::uint8_t key[16]);
bool validate_authenticated(const PairAcceptFrame& frame, const std::uint8_t key[16]);
bool validate(const TelemetryFrame& frame);
bool validate(const AckFrame& frame);
bool validate_authenticated(const TelemetryFrame& frame, const std::uint8_t key[16]);
bool validate_authenticated(const AckFrame& frame, const std::uint8_t key[16]);
bool validate(const PairRequestFrame& frame);
bool validate(const PairAcceptFrame& frame);

}  // namespace farmos::protocol
