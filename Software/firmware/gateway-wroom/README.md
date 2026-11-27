# Gateway ESP32-WROOM-32 — bản thử nghiệm, chưa phát hành

Project này thử biên dịch mã Gateway FarmOS cho ESP32-D0WD revision 3+, flash 4 MB và SX1278 SCK 18, MISO 19, MOSI 23, CS 5, RESET 14. Các file build ra chưa phải gói phát hành: không nạp lên thiết bị hoặc tải lên server.

Bản thử nghiệm có đường chuyển tiếp nhiệt độ đất, nhiệt độ và độ ẩm không khí với giao thức FarmOS v4. Bản ghi outbox cũ được đọc tương thích, nhưng chưa có kiểm thử tích hợp với NVS thật. Chưa có đường ADC thô, công tắc phao hoặc độ ẩm đất sau hiệu chuẩn.

Trước khi có thể phát hành cần hỗ trợ chip ESP32 và layout 4 MB xuyên suốt firmware identity, flash manifest, backend và Desktop Flasher; cập nhật đích firmware và chữ ký P-256, đóng gói ký, kiểm tra OTA và phục hồi; hoàn thiện onboarding và xác thực/ghép Node; kiểm tra SX1278, Wi-Fi và end-to-end trên phần cứng. Công cụ Desktop Flasher hiện mặc định ESP32-S3 và không được dùng firmware này.

Wi-Fi phải được cấp qua provisioning bảo mật; không đưa SSID/password vào source hay artifact.
