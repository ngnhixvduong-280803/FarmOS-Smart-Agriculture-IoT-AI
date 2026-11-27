#pragma once

#include <array>
#include <cstdio>
#include <cstring>
#include "gateway_cloud.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"

namespace farmos::gateway {
// Small bench outbox. Never overwrite an unacknowledged record. Each record is
// one atomic NVS blob; recovery needs no separately updated head/tail counters.
class TelemetryOutbox {
 public:
  esp_err_t begin() {
    mutex_ = xSemaphoreCreateMutex();
    if (!mutex_) return ESP_ERR_NO_MEM;
    esp_err_t error = nvs_open("farmos_outbox", NVS_READWRITE, &handle_);
    if (error != ESP_OK) return error;
    for (std::size_t i = 0; i < slots_.size(); ++i) {
      char key[8]; key_for(i, key);
      std::size_t size = sizeof(TelemetryUpload);
      error = nvs_get_blob(handle_, key, &slots_[i].value, &size);
      if (error == ESP_ERR_NVS_NOT_FOUND) continue;
      if (error != ESP_OK || size != sizeof(TelemetryUpload) ||
          !std::memchr(slots_[i].value.node_id, 0, sizeof(slots_[i].value.node_id))) return ESP_FAIL;
      slots_[i].used = true;
    }
    return ESP_OK;
  }
  bool put(const TelemetryUpload& value) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    for (const auto& slot : slots_) {
      if (slot.used && slot.value.boot_id == value.boot_id && slot.value.sequence == value.sequence &&
          std::strcmp(slot.value.node_id, value.node_id) == 0) {
        xSemaphoreGive(mutex_); return true;
      }
    }
    bool saved = false;
    for (std::size_t i = 0; i < slots_.size(); ++i) {
      if (slots_[i].used) continue;
      char key[8]; key_for(i, key);
      if (nvs_set_blob(handle_, key, &value, sizeof(value)) == ESP_OK && nvs_commit(handle_) == ESP_OK) {
        slots_[i] = {true, value}; saved = true;
      }
      break;
    }
    xSemaphoreGive(mutex_); return saved;
  }
  bool peek(TelemetryUpload* value, std::size_t* index) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    for (std::size_t count = 0; count < slots_.size(); ++count) {
      const std::size_t i = (cursor_ + count) % slots_.size();
      if (!slots_[i].used) continue;
      *value = slots_[i].value; *index = i; cursor_ = (i + 1) % slots_.size();
      xSemaphoreGive(mutex_); return true;
    }
    xSemaphoreGive(mutex_); return false;
  }
  bool acknowledge(std::size_t index) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    char key[8]; key_for(index, key);
    bool ok = nvs_erase_key(handle_, key) == ESP_OK && nvs_commit(handle_) == ESP_OK;
    if (ok) slots_[index] = {};
    xSemaphoreGive(mutex_); return ok;
  }
 private:
  static void key_for(std::size_t index, char* key) { std::snprintf(key, 8, "t%02u", static_cast<unsigned>(index)); }
  struct Slot { bool used{false}; TelemetryUpload value{}; };
  std::array<Slot, 64> slots_{};
  std::size_t cursor_{0};
  nvs_handle_t handle_{};
  SemaphoreHandle_t mutex_{};
};
}  // namespace farmos::gateway
