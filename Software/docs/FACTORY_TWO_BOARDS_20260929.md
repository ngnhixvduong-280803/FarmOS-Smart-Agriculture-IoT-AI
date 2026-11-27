# Hai bo ESP32-S3 xuất xưởng ngày 2026-09-29

## Kết quả trên bo và hệ thống production

| Vai trò | Identity | eFuse MAC | QR v3 |
|---|---|---|---|
| gateway | `GATEWAY_260929001` | `14:c1:9f:46:ab:30` | `QR3-7ECCEE494A24C9EA7A29` |
| node | `NODE_260929001` | `ac:27:6e:a4:5e:d4` | `QR3-3990B41C241BEEEDF5ED` |

- Cả hai bo: ESP32-S3 rev 0.2, flash 16 MiB, PSRAM 8 MiB; cổng WCH USB–UART
  VID:PID `1a86:55d3`. Enrollment dùng UART0; tùy chọn USB native mặc định tắt.
- Firmware và app descriptor cùng `0.2.8`. Signature Secure Boot v2 RSA3072
  và ảnh AES-XTS được kiểm tra trước khi nạp. Đọc lại đủ 7 partition và so hash
  đạt trước eFuse. Sau chuyển đổi, cả hai bo đã khởi động, ký challenge P-256
  và ký kết quả hash prefix ứng dụng đang chạy khớp APP đã ký v0.2.8.
- Cả hai bo có Secure Boot bật, Flash Encryption bật, `SPI_BOOT_CRYPT_CNT=7`,
  Secure Download Mode bật, JTAG bị khóa vĩnh viễn. Đây là trạng thái đọc từ
  ROM trên bo thật sau khi ghi eFuse; không phải chỉ dựa vào sdkconfig/build.
- Backend production: hai batch/identity `READY_TO_SHIP`, chưa claim vào
  account/farm. Station `mac-factory-01` đã được cấu hình và xác thực. Backend
  giữ nguyên image SHA đang chạy; chỉ cấu hình station được thêm và backend
  được recreate từ cùng image.
- QR PNG đã được giải mã lại, khớp đúng payload public đã ký. API production
  `/api/v1/onboarding/qr/resolve` trả success cho cả hai. Tem vẫn `ISSUED`:
  tạo PNG không được coi là đã in vật lý.
- Desktop FarmOS Flasher ADMIN đã upload đủ 4 artifact đã ký cho mỗi role;
  catalog hiển thị Gateway/Node v0.2.8 ở trạng thái DRAFT. Chưa kích hoạt OTA
  hay rollout sang các thiết bị khác.

## Phiên bản và hồ sơ readback

Factory readback/evidence ban đầu được giữ nguyên ở `.local-backups/factory-20260929`.
Trong lúc kiểm tra catalog, phát hiện PROJECT_VER còn 0.2.7 dù runtime báo
0.2.8. Đã sửa CMake, build/ký/mã hóa lại, cập nhật riêng APP của hai bo qua
station và xác minh hash của ứng dụng thực sự đang chạy. Snapshot artifact
factory ban đầu giữ ở `encrypted/<role>/factory-initial-snapshot`; bộ cuối ở
`release-0.2.8`. Đây là update station cục bộ, không giả định có FlashJob trên
backend cho lần update này.

## Khóa và bản sao

Không có private key/token trong báo cáo này. Credential station ở thư mục
Application Support/FarmOS Manufacturing, quyền 600. Vật liệu khóa và flash
backup cục bộ nằm trong thư mục ignored với quyền riêng tư; không commit.
Archive khóa AES-GCM nằm trong vault ngoài repository và đã thử decrypt bằng
khóa recovery lưu trong macOS Keychain. Bản archive mã hóa thứ hai ở
`/opt/farmos/factory-backups` trên VPS; hash hai bản trùng nhau. Cần bảo toàn
khóa recovery Keychain để khôi phục archive.

## Giới hạn kiểm chứng và bước thử trên điện thoại

- Chưa claim vào account: người dùng sẽ quét Gateway trước, chọn farm/cấu hình
  Wi-Fi; sau đó quét Node, chọn mode qua Gateway và ghép LoRa.
- Chưa chứng minh luồng Wi-Fi/cloud, ghép LoRa và telemetry hai chiều sau claim
  trên account người dùng. Không dùng pairing/token giả để thay kết quả này.
- Node báo không thấy DS18B20 trên GPIO4. Cần gắn cảm biến và kiểm tra reading
  thật trước khi xem bộ kit cảm biến hoàn chỉnh đã qua QC phần đo lường.
- Hai bo được nạp bằng station CLI. Desktop đã kiểm chứng upload catalog;
  chưa kiểm chứng nạp USB hoặc OTA trực tiếp từ UI desktop lên hai bo đã khóa.
  Gói Factory catalog chung không phải ciphertext riêng của các bo này.
  Bản desktop mới kiểm tra bảo mật trước khi tạo FlashJob/ghi flash và chặn
  đường plaintext cho bo đã khóa. Dùng OTA đã ký hoặc station ciphertext để
  cập nhật các bo này, theo SOP `MANUFACTURING_QR.md`.

## Kiểm tra phần mềm

- 41 kiểm tra config, factory station, layout/manifest và serial codec đạt.
- Gateway/Node production build đạt. Frontend build và desktop build đạt.
- P-256 challenge và signed application prefix verification đạt trên cả hai
  bo sau khi Secure Boot/Flash Encryption được bật.
