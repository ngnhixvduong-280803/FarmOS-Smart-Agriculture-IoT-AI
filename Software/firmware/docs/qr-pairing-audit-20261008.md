# Kiểm tra QR và ghép nối — 2026-10-08

Luồng: Flasher nạp ảnh đã ký → UART enrollment và readback attestation → backend complete job → identity READY_TO_SHIP + QR v3 đã ký → mobile resolve QR → BLE chứng minh đúng board → finalize claim → Gateway Wi-Fi/cloud hoặc Node LEAF_NODE → bắt tay LoRa xác thực → Gateway xác nhận với backend → mobile chỉ báo hoàn tất khi ACTIVE.

## Kết quả

- QR thật của GATEWAY_3806462982 trên VPS: READY_TO_SHIP, HardwareBoard ACTIVE, QR ISSUED, generation hiện tại. Chữ ký hợp lệ; POST /api/v1/onboarding/qr/resolve trả HTTP 200, claimable=true. Thay serial trong payload bị HTTP 400. Kiểm tra này chỉ đọc dữ liệu, không claim vào tài khoản/farm.
- Backend: 72 kiểm thử onboarding/security/manufacturing/identity đạt.
- Mobile: 19 kiểm thử QR/parser, BLE identity, status polling đạt. Mobile chờ backend xác nhận ACTIVE và xử lý timeout/retry; ghi BLE thành công không tự coi là ghép hoàn tất.
- Binding và token radio được lưu NVS trước khi trả lời bắt tay. Telemetry và ACK đều phải xác thực, replay watermark được checkpoint. Gateway polling phiên ghép mỗi 2 giây; việc ghép không chỉ dựa vào MQTT một lần.

## Sửa trong 0.2.11

Gateway 0.2.10 chỉ gọi cloud.confirm_pairing khi DS18B20 có số đo hợp lệ. Node thiếu DS18B20 vẫn bắt tay và nhận ACK, nhưng app chờ ACTIVE rồi timeout. 0.2.11 xác nhận sau frame được xác thực và replay state được checkpoint, độc lập với cảm biến. Nếu frame có nhiệt độ thì vẫn phải ghi outbox thành công trước ACK/confirmation. Không ghi số đo giả để ghép.

Flasher sửa hướng dẫn QR cho đúng luồng READY_TO_SHIP hiện tại: quét trong app FarmOS và giữ BOOT 3 giây mở BLE; bỏ thông báo bắt buộc xác nhận nhãn in cho mọi board đã được enrollment/readback release.

Hai firmware factory 0.2.11 build thành công và gói có chữ ký offline đã xác minh. OTA giữ DRAFT; dùng USB factory và đúng loại board.

## Phạm vi chưa xác minh

Chưa quét camera điện thoại, thực hiện BLE claim/Wi-Fi redeem trên board hiện tại, ghép hai board Node–Gateway, hoặc cắt nguồn giữa quá trình ghép để kiểm tra phục hồi vật lý. Số phiên pairing trên VPS lúc kiểm tra là 0. Vì vậy chưa kết luận toàn bộ luồng vật lý ổn định. Không xóa/claim board hiện tại hoặc thay cấu hình Wi-Fi của người dùng để kiểm thử.
