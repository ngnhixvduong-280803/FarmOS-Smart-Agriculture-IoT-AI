# FarmOS Flasher

Ứng dụng React/Tauri nạp USB cho ESP32-S3 chưa khóa Secure Boot/Flash Encryption.
Dashboard quản lý firmware/OTA; nạp USB chỉ thực hiện trong ứng dụng desktop.
Không cần PlatformIO, Python hay khóa station trên máy sử dụng app đã đóng gói.

## Sử dụng

1. Đăng nhập Google bằng tài khoản ADMIN.
2. Chọn Node/Gateway, phiên bản firmware và cổng USB.
3. Kiểm tra rồi nạp. App tải manifest/ảnh từ server, kiểm tra hash và MAC, ghi
   đúng write plan, sau đó xác thực firmware qua UART ở 115200 baud.
4. ID và QR v3 xuất hiện sau khi backend xác nhận enrollment/readback. Trạng thái
   kết nối cloud được kiểm tra riêng; nạp xong không đồng nghĩa đã có Wi-Fi/LoRa.

Board đã khóa bị dừng trước khi tạo job hoặc ghi flash. Không ghi eFuse và không
có nhánh station/ciphertext. Thiết bị còn đăng ký được bảo vệ bằng kiểm tra ID/MAC;
xóa để cấp lại ID/QR là thao tác riêng cần người dùng xác nhận.

## Build firmware và tải gói

Xem [hướng dẫn firmware](../firmware/README.md). Dùng `./tools/build-firmware`
để xuất gói đã ký trong `dist/firmware/<node|gateway>/<version>`.
Trong **Firmware & OTA**, chọn thư mục gói và tải bốn file cho xuất xưởng;
dùng riêng `firmware.bin` cho OTA. Hai kênh phát hành độc lập, upload luôn bắt đầu
ở DRAFT. Bản secure cũ không hiện trong danh sách mặc định nhưng được giữ trên
server cho lịch sử và bảo trì.

## Phát triển desktop

```sh
cd desktop-flasher
npm ci
npm run desktop:dev
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Copy `.env.example` sang `.env`, chỉ điền hai public Supabase values. Callback:
`farmos://auth/callback` cho app đóng gói và
`http://127.0.0.1:17846/auth/callback` cho dev. Session lưu trong OS credential
store; FarmOS bearer chỉ ở native memory. Không đưa service-role hoặc khóa ký
server vào frontend. Startup luôn xác thực lại tài khoản/quyền trên backend.

## Đóng gói

Workflow **Package FarmOS Flasher** chỉ build installer desktop, không build hay
phát hành firmware. Bundled esptool được build từ upstream esptool 4.11.0 bằng
PyInstaller `--collect-data esptool`; máy dùng installer không tải executable
ở runtime. Build thủ công:

```sh
FARMOS_ESPTOOL_BIN=/absolute/path/to/farmos-esptool npm run prepare:tools
npm run desktop:build
```

Không đổi bundle ID khi cập nhật để giữ namespace credential store. App chưa có
auto-updater; dùng installer mới từ workflow.
