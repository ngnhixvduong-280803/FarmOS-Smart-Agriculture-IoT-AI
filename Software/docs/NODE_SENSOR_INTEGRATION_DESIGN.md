# Tích hợp Node cảm biến ESP32-S3 vào FarmOS

Trạng thái: đề xuất kỹ thuật dựa trên sketch `noteessp32s3.ino` và source hiện tại; chưa phải bản firmware đã kiểm thử hay phát hành.

## Phần cứng theo sketch

| Thành phần | Kết nối |
| --- | --- |
| Độ ẩm đất AO | GPIO1, ADC 12 bit |
| DS18B20 | GPIO4 |
| Phao | GPIO5, INPUT_PULLUP |
| Relay | GPIO6, module HIGH = ON; mặc định LOW |
| I²C | SDA GPIO7, SCL GPIO8 |
| SHT30/SHT4x | 0x44 hoặc 0x45 |
| LCD PCF8574 | 0x27, có thể 0x3F |
| SX1278 | SCK12, MISO13, MOSI11, CS10, RESET9; không nối DIO0 |

Xác minh điện áp, địa chỉ LCD, model cảm biến và cực tính relay trên board thật. Phao hở và đứt dây không phân biệt được bằng một ngõ vào số. Không dùng phao này làm liên động an toàn duy nhất.

## Các khác biệt cần xử lý

- Sketch gửi JSON không xác thực với ID cặp cố định. FarmOS dùng frame nhị phân phiên bản 4, identity riêng và HMAC theo cặp. Hai giao thức không tương thích; ACK của sketch chỉ chứng minh Gateway nhận gói.
- Node hiện log ADC và phao tại chỗ, gửi SHT qua LoRa nhưng Gateway chỉ ghi outbox và upload nhiệt độ đất DS18B20. Node Wi-Fi trực tiếp cũng chỉ upload nhiệt độ đất. LCD hiện hỗ trợ 0x3E, chưa hỗ trợ PCF8574 của sketch.
- Database đã có các cột nhiệt độ đất, độ ẩm đất, nhiệt độ và độ ẩm không khí; chưa có cột ADC và tiếp điểm phao. Không tự suy ra trạng thái nước an toàn từ tiếp điểm.

## Thiết kế đề xuất

1. Giữ firmware ESP-IDF hiện có, identity/enrollment, BLE, signed release, QR và Desktop Flasher. Port chức năng đọc sensor của sketch vào component Node; không thay bằng sketch Arduino độc lập làm mất các hợp đồng này. Luôn giữ relay OFF trong phạm vi giám sát.
2. Lấy trung vị ADC; lưu riêng hai điểm hiệu chuẩn và cờ hợp lệ trong NVS, cho phép kiểm tra và hiệu chuẩn lại có chủ đích. Chỉ tính phần trăm khi đủ hai điểm và khoảng cách đủ lớn; xác minh chiều ADC bằng mẫu thực tế thay vì giả định mọi sensor đều tăng khi ướt. Gửi ADC thô và trạng thái hiệu chuẩn riêng; giá trị thiếu biểu diễn null.
3. Thêm SHT4x, cả hai địa chỉ và kiểm tra CRC; thêm LCD PCF8574 theo đúng mapping phần cứng, tự nhận 0x27/0x3F. Kiểm tra điều kiện lỗi I²C và không chặn các chức năng kết nối. Trang LCD hiển thị số đo và trạng thái kết nối, không coi ACK là xác nhận cloud.
4. Thiết kế frame LoRa mới có phiên bản, bit hợp lệ từng trường, ADC, phần trăm đã hiệu chuẩn, tiếp điểm phao, nhiệt độ đất/không khí và độ ẩm không khí. HMAC phải bao trùm toàn bộ frame; không tái dùng byte reserved trong v4 mà không có quy tắc tương thích. Gateway phải hỗ trợ chuyển tiếp v4 và phiên bản mới trong giai đoạn nâng cấp, đồng thời giới hạn độ dài, kiểm tra range và chống lặp.
5. Gateway ghi toàn bộ mẫu vào outbox bền vững trước ACK; version hóa bản ghi NVS và di chuyển hoặc giữ khả năng đọc các bản ghi cũ. Không đổi kích thước struct blob tại chỗ vì outbox hiện yêu cầu kích thước chính xác khi khởi động. Chỉ xóa khi API xác nhận persisted; bảo toàn event ID khi retry. Xác định chính sách đầy bộ đệm và xử lý mẫu không có DS18B20 nhưng có sensor khác.
6. Node Wi-Fi trực tiếp dùng cùng schema và nguyên tắc outbox, kể cả version hóa định dạng bản ghi. Kiểm tra hợp đồng ingest xác thực, binding và idempotency. Thêm migration tương thích ngược cho ADC/phao nếu cần lịch sử; không làm thay đổi ý nghĩa các trường hiện có.
7. Web/mobile hiển thị giá trị, đơn vị, thời điểm cập nhật và trạng thái thiếu/chưa hiệu chuẩn; phân biệt Node–Gateway ACK, Gateway–server đã lưu và dữ liệu cũ. Phao hiển thị mức tiếp điểm, chỉ gắn nhãn đầy/cạn sau khi xác minh đấu dây và cấu hình.
8. Build gói Node/Gateway đã ký đúng quy trình hiện hành, phát hành DRAFT và kiểm tra tương thích trước kích hoạt. Không ghi eFuse, không tự xóa identity hay ghi đè board đang đăng ký. Đối chiếu server đang chạy với source trước khi phát hành.

## Kiểm thử trước khi dùng

- Unit: CRC SHT, hai chiều hiệu chuẩn, thiếu cảm biến, range, serialize/authenticate frame và tương thích phiên bản.
- Integration: mỗi trường đi qua cả hai chế độ Node → Gateway → API và Node → Wi-Fi → API; dữ liệu bị trùng, mất ACK, mất mạng, khởi động lại và đầy outbox; migration NVS với bản ghi cũ.
- Phần cứng: ngắt nguồn tải bơm; kiểm tra relay OFF khi boot/reset/lỗi, so sánh sensor với mẫu, LCD hai địa chỉ, ghép QR/BLE, hai board LoRa, mất mạng và đối chiếu thời gian/giá trị trong database, web và mobile.
- Kiểm tra riêng giới hạn công suất, băng tần và quy định địa phương trước vận hành vô tuyến.
