#include "ble_provisioning.h"

#include <algorithm>
#include <cstring>
#include <vector>

#include "esp_log.h"
#include "host/ble_att.h"
#include "host/ble_hs.h"
#include "host/ble_sm.h"
#include "host/ble_store.h"
#include "host/ble_uuid.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

extern "C" void ble_store_config_init(void);

namespace farmos::onboarding {
namespace {

constexpr char kTag[] = "farmos_ble";
BleProvisioningServer* g_server = nullptr;
std::uint8_t g_own_addr_type = 0;
ble_uuid128_t g_service_uuid{};
ble_uuid128_t g_identity_uuid{};
ble_uuid128_t g_config_uuid{};
ble_uuid128_t g_ota_uuid{};
ble_uuid128_t g_auth_uuid{};

void advertise();

int require_secure_authenticated_link(std::uint16_t conn_handle) {
    ble_gap_conn_desc descriptor{};
    if (ble_gap_conn_find(conn_handle, &descriptor) != 0) return BLE_ATT_ERR_UNLIKELY;
    if (!descriptor.sec_state.encrypted) return BLE_ATT_ERR_INSUFFICIENT_ENC;
    if (!descriptor.sec_state.authenticated || descriptor.sec_state.key_size < 16) {
        return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
    }
    return 0;
}

int gap_event(ble_gap_event* event, void*) {
    if (event->type == BLE_GAP_EVENT_CONNECT) {
        ESP_LOGW(kTag, "BLE connect status=%d", event->connect.status);
        if (event->connect.status == 0 && g_server && g_server->advertising_enabled()) {
            // Explicitly request Secure Connections so pairing does not depend
            // on how the central handles a protected characteristic read.
            const int rc = ble_gap_security_initiate(event->connect.conn_handle);
            ESP_LOGW(kTag, "BLE security request status=%d", rc);
        }
    }
    if (event->type == BLE_GAP_EVENT_DISCONNECT) {
        ESP_LOGW(kTag, "BLE disconnect reason=%d", event->disconnect.reason);
    }
    if (event->type == BLE_GAP_EVENT_REPEAT_PAIRING) {
        const auto& pairing = event->repeat_pairing;
        // A physical BOOT service request permits replacing this peer's stale
        // bond only when the replacement is also authenticated Secure Connections.
        if (g_server && g_server->advertising_enabled() && g_server->bond_repair_allowed() &&
            pairing.new_authenticated && pairing.new_sc && pairing.new_bonding && pairing.new_key_size == 16) {
            ble_gap_conn_desc peer{};
            if (ble_gap_conn_find(pairing.conn_handle, &peer) == 0 &&
                ble_store_util_delete_peer(&peer.peer_id_addr) == 0) {
                ESP_LOGW(kTag, "BLE replacing stale peer bond in physical setup mode");
                return BLE_GAP_REPEAT_PAIRING_RETRY;
            }
        }
        ESP_LOGW(kTag, "BLE repeat pairing ignored");
        return BLE_GAP_REPEAT_PAIRING_IGNORE;
    }
    if (event->type == BLE_GAP_EVENT_ENC_CHANGE) {
        const int status = event->enc_change.status;
        if (status == 0) ESP_LOGW(kTag, "BLE encryption established");
        else if (status != BLE_HS_ENOTCONN) {
            ESP_LOGW(kTag, "BLE encryption failed: %d", status);
            ble_gap_terminate(event->enc_change.conn_handle, BLE_ERR_AUTH_FAIL);
        }
    }
    if (event->type == BLE_GAP_EVENT_DISCONNECT ||
        (event->type == BLE_GAP_EVENT_CONNECT && event->connect.status != 0)) {
        advertise();
    }
    if (event->type == BLE_GAP_EVENT_PASSKEY_ACTION) {
        // Numeric comparison is the only mobile-compatible authenticated
        // Secure Connections mode for this headless peripheral. The phone OS
        // presents the confirmation UI; do not auto-answer passkey input or
        // display actions and never fall back to Just Works.
        ESP_LOGW(kTag, "BLE pairing action=%u", event->passkey.params.action);
        if (event->passkey.params.action == BLE_SM_IOACT_NUMCMP) {
            ble_sm_io io{};
            io.action = BLE_SM_IOACT_NUMCMP;
            io.numcmp_accept = 1;
            const int status = ble_sm_inject_io(event->passkey.conn_handle, &io);
            if (status != 0) ESP_LOGW(kTag, "BLE numeric comparison failed: %d", status);
        } else {
            ESP_LOGW(kTag, "BLE pairing action unsupported: %u", event->passkey.params.action);
        }
    }
    return 0;
}

int gatt_access(std::uint16_t conn_handle, std::uint16_t, ble_gatt_access_ctxt* ctxt, void* arg) {
    if (g_server == nullptr) return BLE_ATT_ERR_UNLIKELY;
    const auto kind = reinterpret_cast<std::uintptr_t>(arg);
    if (kind == 1 && ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const auto& value = g_server->identity_json();
        return os_mbuf_append(ctxt->om, value.data(), value.size()) == 0
                   ? 0
                   : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (kind == 2 && ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        const int security_status = require_secure_authenticated_link(conn_handle);
        if (security_status != 0) return security_status;
        const std::size_t length = OS_MBUF_PKTLEN(ctxt->om);
        if (length == 0 || length > 768) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        std::string value(length, '\0');
        std::uint16_t copied = 0;
        if (ble_hs_mbuf_to_flat(ctxt->om, value.data(), value.size(), &copied) != 0) {
            return BLE_ATT_ERR_UNLIKELY;
        }
        value.resize(copied);
        return g_server->handle_write(value) ? 0 : BLE_ATT_ERR_UNLIKELY;
    }
    if (kind == 3 && ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const int security_status = require_secure_authenticated_link(conn_handle);
        if (security_status != 0) return security_status;
        const std::string status = g_server->handle_ota_read();
        return os_mbuf_append(ctxt->om, status.data(), status.size()) == 0
                   ? 0
                   : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (kind == 3 && ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        const int security_status = require_secure_authenticated_link(conn_handle);
        if (security_status != 0) return security_status;
        const std::size_t length = OS_MBUF_PKTLEN(ctxt->om);
        if (length == 0 || length > 1024) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        std::vector<std::uint8_t> buffer(length);
        std::uint16_t copied = 0;
        if (ble_hs_mbuf_to_flat(ctxt->om, buffer.data(), buffer.size(), &copied) != 0) {
            return BLE_ATT_ERR_UNLIKELY;
        }
        return g_server->handle_ota_write(buffer.data(), copied) ? 0 : BLE_ATT_ERR_UNLIKELY;
    }
    if (kind == 4 && ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const int security_status = require_secure_authenticated_link(conn_handle);
        if (security_status != 0) return security_status;
        const std::string value = g_server->handle_auth_read();
        return os_mbuf_append(ctxt->om, value.data(), value.size()) == 0
                   ? 0
                   : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (kind == 4 && ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        const int security_status = require_secure_authenticated_link(conn_handle);
        if (security_status != 0) return security_status;
        const std::size_t length = OS_MBUF_PKTLEN(ctxt->om);
        if (length == 0 || length > 768) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        std::string value(length, '\0');
        std::uint16_t copied = 0;
        if (ble_hs_mbuf_to_flat(ctxt->om, value.data(), value.size(), &copied) != 0) {
            return BLE_ATT_ERR_UNLIKELY;
        }
        value.resize(copied);
        return g_server->handle_auth_write(value) ? 0 : BLE_ATT_ERR_UNLIKELY;
    }
    return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
}

ble_gatt_chr_def g_characteristics[] = {
    {.uuid = &g_identity_uuid.u, .access_cb = gatt_access,
     .arg = reinterpret_cast<void*>(1), .descriptors = nullptr,
     .flags = BLE_GATT_CHR_F_READ, .min_key_size = 0,
     .val_handle = nullptr, .cpfd = nullptr},
    {.uuid = &g_config_uuid.u, .access_cb = gatt_access,
     .arg = reinterpret_cast<void*>(2), .descriptors = nullptr,
     .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC |
              BLE_GATT_CHR_F_WRITE_AUTHEN, .min_key_size = 16,
     .val_handle = nullptr, .cpfd = nullptr},
    {.uuid = &g_ota_uuid.u, .access_cb = gatt_access,
     .arg = reinterpret_cast<void*>(3), .descriptors = nullptr,
     .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP |
              BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_READ_AUTHEN |
              BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN,
     .min_key_size = 16,
     .val_handle = nullptr, .cpfd = nullptr},
    {.uuid = &g_auth_uuid.u, .access_cb = gatt_access,
     .arg = reinterpret_cast<void*>(4), .descriptors = nullptr,
     .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP |
              BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_READ_AUTHEN |
              BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN,
     .min_key_size = 16, .val_handle = nullptr, .cpfd = nullptr},
    {.uuid = nullptr, .access_cb = nullptr, .arg = nullptr, .descriptors = nullptr,
     .flags = 0, .min_key_size = 0, .val_handle = nullptr, .cpfd = nullptr},
};

ble_gatt_svc_def g_services[] = {
    {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &g_service_uuid.u,
     .includes = nullptr, .characteristics = g_characteristics},
    {.type = 0, .uuid = nullptr, .includes = nullptr, .characteristics = nullptr},
};

void advertise() {
    if (g_server == nullptr || !g_server->advertising_enabled()) return;
    ble_hs_adv_fields fields{};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    const char* name = ble_svc_gap_device_name();
    fields.name = reinterpret_cast<std::uint8_t*>(const_cast<char*>(name));
    fields.name_len = std::strlen(name);
    fields.name_is_complete = 1;
    fields.uuids128 = &g_service_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;
    if (ble_gap_adv_set_fields(&fields) != 0) {
        ESP_LOGE(kTag, "Cannot set BLE advertising fields");
        return;
    }
    ble_gap_adv_params parameters{};
    parameters.conn_mode = BLE_GAP_CONN_MODE_UND;
    parameters.disc_mode = BLE_GAP_DISC_MODE_GEN;
    const int rc = ble_gap_adv_start(g_own_addr_type, nullptr, BLE_HS_FOREVER,
                                     &parameters, gap_event, nullptr);
    if (rc != 0 && rc != BLE_HS_EALREADY) ESP_LOGE(kTag, "BLE advertise failed: %d", rc);
}

void on_sync() {
    if (ble_hs_id_infer_auto(0, &g_own_addr_type) != 0) {
        ESP_LOGE(kTag, "Cannot infer BLE address");
        return;
    }
    advertise();
}

void host_task(void*) {
    nimble_port_run();
    nimble_port_freertos_deinit();
}

}  // namespace

BleProvisioningServer::BleProvisioningServer(std::string device_name,
                                             std::string identity_json,
                                             BleUuids uuids,
                                             WriteHandler write_handler)
    : device_name_(std::move(device_name)),
      identity_json_(std::move(identity_json)),
      uuids_(uuids),
      write_handler_(std::move(write_handler)) {}

esp_err_t BleProvisioningServer::begin() {
    if (g_server != nullptr) return ESP_ERR_INVALID_STATE;
    g_server = this;
    g_service_uuid.u.type = BLE_UUID_TYPE_128;
    g_identity_uuid.u.type = BLE_UUID_TYPE_128;
    g_config_uuid.u.type = BLE_UUID_TYPE_128;
    std::copy(uuids_.service.begin(), uuids_.service.end(), g_service_uuid.value);
    std::copy(uuids_.identity_characteristic.begin(), uuids_.identity_characteristic.end(), g_identity_uuid.value);
    std::copy(uuids_.config_characteristic.begin(), uuids_.config_characteristic.end(), g_config_uuid.value);

    bool has_ota = false;
    for (auto b : uuids_.ota_characteristic) {
        if (b != 0) { has_ota = true; break; }
    }
    bool has_auth = false;
    for (auto b : uuids_.auth_characteristic) {
        if (b != 0) { has_auth = true; break; }
    }
    // The static definitions are reused by the one process-wide server. Make
    // the optional slots explicit before selecting the OTA/auth layout.
    g_characteristics[3].uuid = nullptr;
    g_characteristics[3].arg = nullptr;
    g_characteristics[3].flags = 0;
    if (has_ota) {
        g_ota_uuid.u.type = BLE_UUID_TYPE_128;
        std::copy(uuids_.ota_characteristic.begin(), uuids_.ota_characteristic.end(), g_ota_uuid.value);
        g_characteristics[2].uuid = &g_ota_uuid.u;
        g_characteristics[2].arg = reinterpret_cast<void*>(3);
        g_characteristics[2].flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE |
                                     BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_READ_ENC |
                                     BLE_GATT_CHR_F_READ_AUTHEN | BLE_GATT_CHR_F_WRITE_ENC |
                                     BLE_GATT_CHR_F_WRITE_AUTHEN;
    } else {
        g_characteristics[2].uuid = nullptr;
        g_characteristics[2].arg = nullptr;
        g_characteristics[2].flags = 0;
    }
    if (has_auth) {
        g_auth_uuid.u.type = BLE_UUID_TYPE_128;
        std::copy(uuids_.auth_characteristic.begin(), uuids_.auth_characteristic.end(), g_auth_uuid.value);
        // Gateway has no OTA characteristic, so keep its auth characteristic
        // in slot 2 rather than placing it behind a null GATT definition.
        const std::size_t index = has_ota ? 3 : 2;
        g_characteristics[index].uuid = &g_auth_uuid.u;
        g_characteristics[index].arg = reinterpret_cast<void*>(4);
        g_characteristics[index].flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE |
                                         BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_READ_ENC |
                                         BLE_GATT_CHR_F_READ_AUTHEN | BLE_GATT_CHR_F_WRITE_ENC |
                                         BLE_GATT_CHR_F_WRITE_AUTHEN;
    } else if (!has_ota) {
        g_characteristics[2].uuid = nullptr;
        g_characteristics[2].arg = nullptr;
        g_characteristics[2].flags = 0;
    }

    esp_err_t error = nimble_port_init();
    if (error != ESP_OK) return error;
    ble_store_config_init();
    ble_hs_cfg.sm_bonding = 1;
    // Exchange identity keys so a bonded phone can be recognized after its
    // private Bluetooth address rotates. Secure Connections derives the LTK.
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_sc_only = 1;
    ble_hs_cfg.sm_mitm = 1;
    ble_hs_cfg.sm_sec_lvl = 4;
    // Mobile OSes support Numeric Comparison and display the confirmation
    // prompt. The device has no input path, so any passkey input/display mode
    // is rejected rather than silently downgrading to Just Works.
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_DISP_YES_NO;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    if (ble_svc_gap_device_name_set(device_name_.c_str()) != 0) return ESP_FAIL;
    if (ble_gatts_count_cfg(g_services) != 0 || ble_gatts_add_svcs(g_services) != 0) return ESP_FAIL;
    ble_hs_cfg.sync_cb = on_sync;
    nimble_port_freertos_init(host_task);
    return ESP_OK;
}

void BleProvisioningServer::set_identity_json(std::string identity_json) {
    identity_json_ = std::move(identity_json);
}

void BleProvisioningServer::set_advertising(bool enabled) {
    advertising_enabled_ = enabled;
    if (!enabled) {
        ble_gap_adv_stop();
    } else if (!ble_gap_adv_active()) {
        advertise();
    }
}

void BleProvisioningServer::set_auth_handlers(AuthWriteHandler auth_write,
                                               AuthReadHandler auth_read) {
    auth_write_handler_ = std::move(auth_write);
    auth_read_handler_ = std::move(auth_read);
}

void BleProvisioningServer::set_ota_handlers(OtaWriteHandler ota_write, OtaReadHandler ota_read) {
    ota_write_handler_ = std::move(ota_write);
    ota_read_handler_ = std::move(ota_read);
}

bool BleProvisioningServer::handle_write(const std::string& value) const {
    return advertising_enabled_ && write_handler_ && write_handler_(value);
}

bool BleProvisioningServer::handle_auth_write(const std::string& value) const {
    return advertising_enabled_ && auth_write_handler_ && auth_write_handler_(value);
}

std::string BleProvisioningServer::handle_auth_read() const {
    return auth_read_handler_ ? auth_read_handler_() : "{\"status\":\"IDLE\"}";
}

bool BleProvisioningServer::handle_ota_write(const std::uint8_t* data, std::size_t len) const {
    return ota_write_handler_ && ota_write_handler_(data, len);
}

std::string BleProvisioningServer::handle_ota_read() const {
    if (ota_read_handler_) {
        return ota_read_handler_();
    }
    return "{\"status\":\"IDLE\"}";
}

}  // namespace farmos::onboarding
