# Firmware FarmOS

ESP32-S3 N16R8 + SX1278 433 MHz. Mỗi loại thiết bị có một cấu hình phát hành:
`node` và `gateway`. Cả hai dùng danh tính thật, enrollment/QR có chữ ký và OTA
có chữ ký; không bật Secure Boot phần cứng, Flash Encryption hoặc ghi eFuse.
Phiên bản duy nhất nằm trong `firmware/VERSION`; runtime đọc từ app descriptor.

## Build một lệnh

Từ root repository, chạy `./tools/build-firmware`. Lần đầu lệnh tự tạo
`.venv/firmware` và cài dependency đã pin; các lần sau dùng lại môi trường này.
Không cần chọn profile hoặc gọi riêng bước ký firmware.

Root `.env` cần `FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY` (P-256 public key của
server) và `FARMOS_FIRMWARE_SIGNING_KEY_FILE` (đường dẫn khóa RSA3072 ký ứng dụng,
file riêng tư quyền 600). Dùng lại khóa ứng dụng hiện có để OTA tương thích;
không tạo khóa mới mỗi lần build. Tên cấu hình cũ
`FARMOS_SECURE_BOOT_SIGNING_KEY_FILE` vẫn được đọc để chuyển tiếp, nhưng không
còn bật bảo mật eFuse. API URL/Wi-Fi được cấp sau qua BLE, không nhúng secret
server vào firmware.

```sh
./tools/build-firmware
# Chỉ build một loại:
./tools/build-firmware --device node
./tools/build-firmware --device gateway
```

Lệnh mặc định build tuần tự cả hai loại, kiểm tra cấu hình và public key,
ký/kiểm tra chữ ký ứng dụng rồi xuất:

```text
dist/firmware/node/<version>/
dist/firmware/gateway/<version>/
  firmware.bin           # app đã ký, cũng là file dùng cho OTA
  bootloader.bin
  partitions.bin
  ota_data_initial.bin
  artifacts.json         # offset, kích thước và SHA-256 của từng ảnh
  release.json           # loại thiết bị và phiên bản
```

Thư mục chỉ xuất hiện sau khi mọi kiểm tra đạt. Không ghi đè gói đã xuất;
đổi `firmware/VERSION` cho bản phát hành mới hoặc dùng `--out /path/to/new-output`.
`--env-file /path/to/.env` chọn cấu hình khác mà không sửa source.

## Phát hành và nạp

1. Desktop **Firmware & OTA**: chọn gói đã ký trong `dist/firmware`, tải bộ bốn
   file lên kênh xuất xưởng. Dashboard cũng nhận bốn file này. Upload tạo DRAFT;
   kiểm tra rồi kích hoạt đúng kênh.
2. Desktop **Nạp thiết bị**: chọn Node/Gateway, firmware và USB, kiểm tra rồi nạp.
   Server xác nhận enrollment/readback trước khi cấp ID/QR. Không cần station key.
3. OTA là kênh riêng: tải riêng `firmware.bin` đã ký lên kênh OTA, kiểm tra và
   kích hoạt rollout. Không tự kích hoạt OTA khi upload gói xuất xưởng.

Không dùng `pio run -t upload`: hook chỉ hướng dẫn sang desktop để không bỏ qua
FlashJob, xác thực board và cấp ID/QR. `pio run -d firmware/node` chỉ biên dịch;
file app thô trong `.pio/build` chưa phải gói phát hành đã ký.

## Bố cục và bảo trì

- `node/`, `gateway/`: ứng dụng và cấu hình phần cứng.
- `shared/`, `components/`: giao thức, identity, LoRa, BLE và cảm biến dùng chung.
- `flash_layout.json`: layout/offset và vùng identity được bảo vệ. Không đổi
  partition chỉ để dọn source; factory reset phải giữ `factory_cfg`.
- `docs/assembly-pinout-0.2.10.md`: tham khảo dây nối và chân cảm biến.
- `.pio/`, `managed_components/`, `sdkconfig.node`/`sdkconfig.gateway`: sinh lại
  bởi build, không commit. Không xóa thư mục khóa hoặc recovery.

Đã bỏ các profile production/secure/dev và radio-test độc lập cùng công cụ
khóa eFuse cũ khỏi luồng hiện tại. Muốn bảo trì board đã khóa, lấy công cụ theo
Git revision đã dùng cho board đó và giữ nguyên kho khóa/recovery riêng tư.
Flasher hiện tại chỉ nhận board chưa khóa. Server vẫn đọc được release/lịch sử
secure cũ; OTA giữ cùng nhóm firmware với bản đang cài.
