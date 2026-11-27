# FarmOS – gói hợp đồng API cho nhóm firmware

Bản hợp đồng theo mã nguồn nhánh PR #23. Xem `VERIFICATION.md` để biết bản nào đã chạy trên VPS và kết quả đo; không đồng nhất bản kiểm thử với production. Không có secret/token thật trong gói này.

## Bắt đầu

1. Import `openapi.json` vào Swagger Editor/Insomnia hoặc `postman_collection.json` vào Postman. `postman_environment.json` chỉ có chỗ nhập token cục bộ, không phát hành token cùng firmware.
2. Base URL production: `https://api.trendhub.sbs`, đường dẫn đã bao gồm `/api/v1` trong OpenAPI. Origin không chứa `/api/v1` khi lưu cấu hình thiết bị. Preview dùng địa chỉ trong `VERIFICATION.md`, chỉ qua SSH tunnel.
3. Thiết bị cloud: `GATEWAY` hoặc `STANDALONE_NODE`. `LEAF_NODE` truyền LoRa tới gateway, không gọi API bằng token của app hay token dùng chung.
4. Đọc `CONTRACT.md`, `GAPS.md`, `ACCEPTANCE.md`. Tài liệu BLE/LoRa nguồn nằm trong `reference/`; HTTP OpenAPI không thay thế hợp đồng radio/factory.

## Các file

- `openapi.json`: HTTP device/claim/pairing/lifecycle/OTA; schema cảm biến và ACK.
- `postman_collection.json`, `postman_environment.json`: yêu cầu mẫu, assertions cho ingest; thay biến trên môi trường của nhóm firmware.
- `examples/`: payload và ACK có giá trị giả, không có credential.
- `attestation-vector.json`: vector transcript SHA-256 công khai để kiểm tra P-256; không có private key.
- `reference/`: snapshot nguồn BLE, LoRa, attestation và tài liệu factory/OTA kèm nguồn gốc trong `manifest.json`.
- `tools/verify-preview.cjs`: kiểm tra chức năng và đo API trên DB preview riêng. Script từ chối DB ngoài `farmos_preview`; không chạy vào production.
- `VERIFICATION.md`, `verification.json`: số liệu đo và giới hạn bằng chứng.

Đây là hợp đồng để bắt đầu tích hợp cảm biến/heartbeat và quy trình onboarding, chưa phải xác nhận hệ thống tưới/OTA đã được nghiệm thu trên phần cứng.

Trong Postman, xóa biến `eventId` khi muốn tạo phép đo mới; giữ nguyên khi kiểm tra retry/duplicate. `qrPayload` phải là JSON object QR v3 đã phát hành, không phải tên thiết bị. Các file reference là snapshot để đối chiếu; khi tài liệu cũ khác với hợp đồng hiện tại, ưu tiên CONTRACT.md/OpenAPI và mã nguồn đúng revision.
