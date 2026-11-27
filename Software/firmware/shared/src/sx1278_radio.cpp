#include "sx1278_radio.h"

#include <array>
#include <cstring>

#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace farmos::radio {
namespace {

constexpr char kTag[] = "sx1278";
constexpr std::uint32_t kCrystalFrequencyHz = 32'000'000;
constexpr std::size_t kMaxPayloadLength = 255;

constexpr std::uint8_t kRegFifo = 0x00;
constexpr std::uint8_t kRegOpMode = 0x01;
constexpr std::uint8_t kRegFrfMsb = 0x06;
constexpr std::uint8_t kRegFrfMid = 0x07;
constexpr std::uint8_t kRegFrfLsb = 0x08;
constexpr std::uint8_t kRegPaConfig = 0x09;
constexpr std::uint8_t kRegOcp = 0x0B;
constexpr std::uint8_t kRegLna = 0x0C;
constexpr std::uint8_t kRegFifoAddrPtr = 0x0D;
constexpr std::uint8_t kRegFifoTxBaseAddr = 0x0E;
constexpr std::uint8_t kRegFifoRxBaseAddr = 0x0F;
constexpr std::uint8_t kRegFifoRxCurrentAddr = 0x10;
constexpr std::uint8_t kRegIrqFlags = 0x12;
constexpr std::uint8_t kRegRxNbBytes = 0x13;
constexpr std::uint8_t kRegPktSnrValue = 0x19;
constexpr std::uint8_t kRegPktRssiValue = 0x1A;
constexpr std::uint8_t kRegModemConfig1 = 0x1D;
constexpr std::uint8_t kRegModemConfig2 = 0x1E;
constexpr std::uint8_t kRegSymbTimeoutLsb = 0x1F;
constexpr std::uint8_t kRegPreambleMsb = 0x20;
constexpr std::uint8_t kRegPreambleLsb = 0x21;
constexpr std::uint8_t kRegPayloadLength = 0x22;
constexpr std::uint8_t kRegModemConfig3 = 0x26;
constexpr std::uint8_t kRegSyncWord = 0x39;
constexpr std::uint8_t kRegDioMapping1 = 0x40;
constexpr std::uint8_t kRegVersion = 0x42;
constexpr std::uint8_t kRegPaDac = 0x4D;

constexpr std::uint8_t kLongRangeMode = 0x80;
constexpr std::uint8_t kModeSleep = 0x00;
constexpr std::uint8_t kModeStandby = 0x01;
constexpr std::uint8_t kModeTx = 0x03;
constexpr std::uint8_t kModeRxContinuous = 0x05;

constexpr std::uint8_t kIrqRxTimeout = 0x80;
constexpr std::uint8_t kIrqRxDone = 0x40;
constexpr std::uint8_t kIrqPayloadCrcError = 0x20;
constexpr std::uint8_t kIrqTxDone = 0x08;

bool deadline_reached(std::int64_t deadline_us) {
    return esp_timer_get_time() >= deadline_us;
}

}  // namespace

Sx1278Radio::Sx1278Radio(Pins pins) : pins_(pins) {}

Sx1278Radio::~Sx1278Radio() {
    if (spi_device_ != nullptr) {
        spi_bus_remove_device(spi_device_);
    }
    if (bus_initialized_) {
        spi_bus_free(pins_.spi_host);
    }
}

esp_err_t Sx1278Radio::begin(std::uint32_t frequency_hz) {
    const spi_bus_config_t bus_config{
        .mosi_io_num = pins_.mosi,
        .miso_io_num = pins_.miso,
        .sclk_io_num = pins_.sck,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .data4_io_num = -1,
        .data5_io_num = -1,
        .data6_io_num = -1,
        .data7_io_num = -1,
        .data_io_default_level = false,
        .max_transfer_sz = 256,
        .flags = SPICOMMON_BUSFLAG_MASTER,
        .isr_cpu_id = ESP_INTR_CPU_AFFINITY_AUTO,
        .intr_flags = 0,
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(pins_.spi_host, &bus_config, SPI_DMA_CH_AUTO),
                        kTag, "SPI bus init failed");
    bus_initialized_ = true;

    const spi_device_interface_config_t device_config{
        .command_bits = 0,
        .address_bits = 0,
        .dummy_bits = 0,
        .mode = 0,
        .clock_source = SPI_CLK_SRC_DEFAULT,
        .duty_cycle_pos = 128,
        .cs_ena_pretrans = 0,
        .cs_ena_posttrans = 0,
        .clock_speed_hz = 8'000'000,
        .input_delay_ns = 0,
        .sample_point = SPI_SAMPLING_POINT_PHASE_0,
        .spics_io_num = pins_.chip_select,
        .flags = 0,
        .queue_size = 1,
        .pre_cb = nullptr,
        .post_cb = nullptr,
    };
    ESP_RETURN_ON_ERROR(spi_bus_add_device(pins_.spi_host, &device_config, &spi_device_),
                        kTag, "SPI device init failed");
    ESP_RETURN_ON_ERROR(reset_chip(), kTag, "SX1278 reset failed");

    std::uint8_t version = 0;
    ESP_RETURN_ON_ERROR(read_register(kRegVersion, &version), kTag, "version read failed");
    if (version != 0x12) {
        ESP_LOGI(kTag, "lora=null | RegVersion=0x%02X", version);
        return ESP_ERR_NOT_FOUND;
    }

    ESP_RETURN_ON_ERROR(set_mode(kModeSleep), kTag, "LoRa sleep failed");
    vTaskDelay(pdMS_TO_TICKS(10));

    const std::uint64_t frf = (static_cast<std::uint64_t>(frequency_hz) << 19U) /
                              kCrystalFrequencyHz;
    ESP_RETURN_ON_ERROR(write_register(kRegFrfMsb, (frf >> 16U) & 0xFFU), kTag,
                        "frequency MSB failed");
    ESP_RETURN_ON_ERROR(write_register(kRegFrfMid, (frf >> 8U) & 0xFFU), kTag,
                        "frequency MID failed");
    ESP_RETURN_ON_ERROR(write_register(kRegFrfLsb, frf & 0xFFU), kTag,
                        "frequency LSB failed");

    // 125 kHz bandwidth, coding rate 4/5, explicit header, spreading factor 7,
    // payload CRC enabled, AGC enabled, private sync word and +17 dBm PA_BOOST.
    ESP_RETURN_ON_ERROR(write_register(kRegFifoTxBaseAddr, 0x00), kTag, "TX base failed");
    ESP_RETURN_ON_ERROR(write_register(kRegFifoRxBaseAddr, 0x00), kTag, "RX base failed");
    ESP_RETURN_ON_ERROR(write_register(kRegLna, 0x23), kTag, "LNA config failed");
    ESP_RETURN_ON_ERROR(write_register(kRegModemConfig1, 0x72), kTag, "modem cfg1 failed");
    ESP_RETURN_ON_ERROR(write_register(kRegModemConfig2, 0x74), kTag, "modem cfg2 failed");
    ESP_RETURN_ON_ERROR(write_register(kRegModemConfig3, 0x04), kTag, "modem cfg3 failed");
    ESP_RETURN_ON_ERROR(write_register(kRegSymbTimeoutLsb, 0xFF), kTag,
                        "symbol timeout failed");
    ESP_RETURN_ON_ERROR(write_register(kRegPreambleMsb, 0x00), kTag, "preamble MSB failed");
    ESP_RETURN_ON_ERROR(write_register(kRegPreambleLsb, 0x08), kTag, "preamble LSB failed");
    ESP_RETURN_ON_ERROR(write_register(kRegSyncWord, 0x12), kTag, "sync word failed");
    ESP_RETURN_ON_ERROR(write_register(kRegOcp, 0x2B), kTag, "OCP config failed");
    ESP_RETURN_ON_ERROR(write_register(kRegPaDac, 0x84), kTag, "PA DAC config failed");
    ESP_RETURN_ON_ERROR(write_register(kRegPaConfig, 0x8F), kTag, "PA config failed");
    ESP_RETURN_ON_ERROR(write_register(kRegIrqFlags, 0xFF), kTag, "IRQ clear failed");
    ESP_RETURN_ON_ERROR(standby(), kTag, "standby failed");

    ESP_LOGI(kTag, "SX1278 ready at %lu Hz", static_cast<unsigned long>(frequency_hz));
    return ESP_OK;
}

esp_err_t Sx1278Radio::send(const void* data, std::size_t length,
                            std::uint32_t timeout_ms) {
    if (data == nullptr || length == 0 || length > kMaxPayloadLength) {
        return ESP_ERR_INVALID_ARG;
    }

    ESP_RETURN_ON_ERROR(standby(), kTag, "standby before TX failed");
    ESP_RETURN_ON_ERROR(write_register(kRegDioMapping1, 0x40), kTag, "TX DIO map failed");
    ESP_RETURN_ON_ERROR(write_register(kRegIrqFlags, 0xFF), kTag, "TX IRQ clear failed");
    ESP_RETURN_ON_ERROR(write_register(kRegFifoAddrPtr, 0x00), kTag, "TX FIFO ptr failed");
    ESP_RETURN_ON_ERROR(write_burst(kRegFifo, data, length), kTag, "TX FIFO write failed");
    ESP_RETURN_ON_ERROR(write_register(kRegPayloadLength, static_cast<std::uint8_t>(length)),
                        kTag, "payload length failed");
    ESP_RETURN_ON_ERROR(set_mode(kModeTx), kTag, "TX mode failed");

    const std::int64_t deadline = esp_timer_get_time() +
                                  static_cast<std::int64_t>(timeout_ms) * 1000;
    while (!deadline_reached(deadline)) {
        std::uint8_t irq_flags = 0;
        ESP_RETURN_ON_ERROR(read_register(kRegIrqFlags, &irq_flags), kTag,
                            "TX IRQ read failed");
        if ((irq_flags & kIrqTxDone) != 0) {
            write_register(kRegIrqFlags, kIrqTxDone);
            return standby();
        }
        // ESP-IDF commonly runs at a 100 Hz tick rate. A 2 ms conversion then
        // becomes zero ticks and can starve IDLE0 until the task watchdog fires.
        vTaskDelay(1);
    }

    standby();
    return ESP_ERR_TIMEOUT;
}

esp_err_t Sx1278Radio::receive(void* data, std::size_t capacity,
                               std::size_t* received_length, ReceiveMetadata* metadata,
                               std::uint32_t timeout_ms) {
    if (data == nullptr || capacity == 0 || received_length == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    *received_length = 0;

    ESP_RETURN_ON_ERROR(standby(), kTag, "standby before RX failed");
    ESP_RETURN_ON_ERROR(write_register(kRegDioMapping1, 0x00), kTag, "RX DIO map failed");
    ESP_RETURN_ON_ERROR(write_register(kRegIrqFlags, 0xFF), kTag, "RX IRQ clear failed");
    // Keep the receiver active for the complete software timeout. RxSingle
    // periodically falls back to standby and can create a receive gap exactly
    // when a periodic node transmits.
    ESP_RETURN_ON_ERROR(set_mode(kModeRxContinuous), kTag, "RX mode failed");

    const std::int64_t deadline = esp_timer_get_time() +
                                  static_cast<std::int64_t>(timeout_ms) * 1000;
    while (!deadline_reached(deadline)) {
        std::uint8_t irq_flags = 0;
        ESP_RETURN_ON_ERROR(read_register(kRegIrqFlags, &irq_flags), kTag,
                            "RX IRQ read failed");

        if ((irq_flags & kIrqRxTimeout) != 0) {
            ESP_RETURN_ON_ERROR(write_register(kRegIrqFlags, kIrqRxTimeout), kTag,
                                "RX timeout IRQ clear failed");
            continue;
        }
        if ((irq_flags & kIrqRxDone) == 0) {
            vTaskDelay(1);
            continue;
        }

        write_register(kRegIrqFlags, irq_flags);
        if ((irq_flags & kIrqPayloadCrcError) != 0) {
            standby();
            return ESP_ERR_INVALID_CRC;
        }

        std::uint8_t packet_length = 0;
        std::uint8_t fifo_address = 0;
        ESP_RETURN_ON_ERROR(read_register(kRegRxNbBytes, &packet_length), kTag,
                            "RX length failed");
        ESP_RETURN_ON_ERROR(read_register(kRegFifoRxCurrentAddr, &fifo_address), kTag,
                            "RX address failed");
        if (packet_length > capacity) {
            standby();
            return ESP_ERR_INVALID_SIZE;
        }
        ESP_RETURN_ON_ERROR(write_register(kRegFifoAddrPtr, fifo_address), kTag,
                            "RX FIFO ptr failed");
        ESP_RETURN_ON_ERROR(read_burst(kRegFifo, data, packet_length), kTag,
                            "RX FIFO read failed");
        *received_length = packet_length;

        if (metadata != nullptr) {
            std::uint8_t raw_rssi = 0;
            std::uint8_t raw_snr = 0;
            ESP_RETURN_ON_ERROR(read_register(kRegPktRssiValue, &raw_rssi), kTag,
                                "RSSI read failed");
            ESP_RETURN_ON_ERROR(read_register(kRegPktSnrValue, &raw_snr), kTag,
                                "SNR read failed");
            metadata->rssi_dbm = static_cast<std::int16_t>(-164 + raw_rssi);
            metadata->snr_db = static_cast<std::int8_t>(raw_snr) / 4.0F;
        }
        return standby();
    }

    standby();
    return ESP_ERR_TIMEOUT;
}

esp_err_t Sx1278Radio::standby() {
    return set_mode(kModeStandby);
}

esp_err_t Sx1278Radio::read_register(std::uint8_t address, std::uint8_t* value) {
    if (spi_device_ == nullptr || value == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    std::array<std::uint8_t, 2> tx{static_cast<std::uint8_t>(address & 0x7FU), 0};
    std::array<std::uint8_t, 2> rx{};
    spi_transaction_t transaction{};
    transaction.length = tx.size() * 8;
    transaction.tx_buffer = tx.data();
    transaction.rx_buffer = rx.data();
    ESP_RETURN_ON_ERROR(spi_device_transmit(spi_device_, &transaction), kTag,
                        "SPI register read failed");
    *value = rx[1];
    return ESP_OK;
}

esp_err_t Sx1278Radio::write_register(std::uint8_t address, std::uint8_t value) {
    if (spi_device_ == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    const std::array<std::uint8_t, 2> tx{static_cast<std::uint8_t>(address | 0x80U), value};
    spi_transaction_t transaction{};
    transaction.length = tx.size() * 8;
    transaction.tx_buffer = tx.data();
    return spi_device_transmit(spi_device_, &transaction);
}

esp_err_t Sx1278Radio::read_burst(std::uint8_t address, void* data, std::size_t length) {
    if (spi_device_ == nullptr || data == nullptr || length == 0 ||
        length > kMaxPayloadLength) {
        return ESP_ERR_INVALID_ARG;
    }
    std::array<std::uint8_t, kMaxPayloadLength + 1> tx{};
    std::array<std::uint8_t, kMaxPayloadLength + 1> rx{};
    tx[0] = address & 0x7FU;
    spi_transaction_t transaction{};
    transaction.length = (length + 1) * 8;
    transaction.tx_buffer = tx.data();
    transaction.rx_buffer = rx.data();
    ESP_RETURN_ON_ERROR(spi_device_transmit(spi_device_, &transaction), kTag,
                        "SPI burst read failed");
    std::memcpy(data, rx.data() + 1, length);
    return ESP_OK;
}

esp_err_t Sx1278Radio::write_burst(std::uint8_t address, const void* data,
                                   std::size_t length) {
    if (spi_device_ == nullptr || data == nullptr || length == 0 ||
        length > kMaxPayloadLength) {
        return ESP_ERR_INVALID_ARG;
    }
    std::array<std::uint8_t, kMaxPayloadLength + 1> tx{};
    tx[0] = address | 0x80U;
    std::memcpy(tx.data() + 1, data, length);
    spi_transaction_t transaction{};
    transaction.length = (length + 1) * 8;
    transaction.tx_buffer = tx.data();
    return spi_device_transmit(spi_device_, &transaction);
}

esp_err_t Sx1278Radio::set_mode(std::uint8_t mode) {
    return write_register(kRegOpMode, kLongRangeMode | mode);
}

esp_err_t Sx1278Radio::reset_chip() {
    const gpio_config_t reset_config{
        .pin_bit_mask = 1ULL << pins_.reset,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&reset_config), kTag, "reset GPIO init failed");
    ESP_RETURN_ON_ERROR(gpio_set_level(pins_.reset, 0), kTag, "reset low failed");
    vTaskDelay(pdMS_TO_TICKS(10));
    ESP_RETURN_ON_ERROR(gpio_set_level(pins_.reset, 1), kTag, "reset high failed");
    vTaskDelay(pdMS_TO_TICKS(10));
    return ESP_OK;
}

}  // namespace farmos::radio
