# Firmware 0.2.10 — sơ đồ lắp ráp Tuần 5

Nguồn: Bảng sơ đồ chân lắp ráp.pdf do người dùng cung cấp, 3 trang.

| Chức năng | Node ESP32-S3 | Gateway ESP32-S3 |
|---|---|---|
| BOOT | GPIO0, giữ 3s BLE, 10s reset cục bộ | GPIO0, cùng thao tác |
| LM393 AO | GPIO1, nguồn 3.3V | Không có |
| DS18B20 | GPIO4 | Không có |
| Phao 2 dây | GPIO5–GND, kéo lên nội | Không có |
| Relay active HIGH | GPIO6, mặc định LOW/OFF | Không có |
| SHT30, địa chỉ 0x44 | SDA7/SCL8 | Không có |
| LCD AiP31068L tùy chọn, 0x3E | SDA7/SCL8, CS nối GND | Không có |
| SX1278 RESET/CS/MOSI/SCK/MISO | GPIO9/10/11/12/13 | GPIO9/10/11/12/13 |
| SX1278 DIO0 | Không nối, polling | Không nối, polling |

## Dữ liệu thiếu

Node đọc và log cảm biến ngay cả khi chưa ghép Gateway. Mỗi trường có trạng thái hợp lệ riêng. DS18B20 thiếu hoặc đọc lỗi chỉ làm soil_temperature=null. SHT30 kiểm tra CRC độc lập cho nhiệt độ và độ ẩm; một trường hỏng không làm mất trường còn lại. I2C có thời gian chờ hữu hạn; thiếu SHT/LCD không dừng vòng lặp. Không có LoRa thì lora=null, các dịch vụ BLE/USB vẫn hoạt động.

LM393 xuất soil_adc thô khi nằm trong khoảng đo hợp lý; soil_moisture=null đến khi có hiệu chuẩn đất khô/ướt. Giá trị sát hai đầu ADC được coi là chưa xác định. Đây không phải phép xác minh chắc chắn cảm biến đang cắm.

Phao xuất float_contact=0/1; dây hở không phân biệt được phao mở và phao bị rút. water_level=null vì sơ đồ chưa xác định mức điện tại trạng thái thiếu nước. Relay luôn OFF; bản này chưa tự điều khiển bơm.

Ví dụ khi chưa gắn cảm biến:

```text
[NODE] DATA | soil_temperature=null | soil_moisture=null | soil_adc=null | air_temperature=null | air_humidity=null | float_contact=1 | water_level=null | relay_command=OFF | lcd=null | lora=ready
```

Gateway nhận nhiệt độ đất và nhiệt độ/độ ẩm không khí qua LoRa với cờ hợp lệ riêng, in null cho trường thiếu. Các trường không khí được truyền và log; luồng upload cloud hiện có vẫn dùng dữ liệu DS18B20. Không thêm cảm biến DS18B20 cục bộ cho Gateway.

## Build và nạp

Bản pinout và bằng chứng ở tài liệu này thuộc 0.2.10. Để build bản hiện tại, dùng `./tools/build-firmware`; phiên bản đọc từ `firmware/VERSION`, gói đã ký xuất trong `dist/firmware`. Xem [hướng dẫn build hiện tại](../README.md). Không dùng gói thường cho board đã khóa phần cứng.

Chọn đúng loại Node/Gateway và phiên bản 0.2.10 trong Flasher. Thiết bị đã đăng ký phải được người dùng xóa khỏi hệ thống trước khi nạp lại. Không tự xóa thiết bị để kiểm thử.

Đã kiểm tra: hai build ESP32-S3 factory thành công; test host SHT30 kiểm tra CRC đúng/sai độc lập, dữ liệu thiếu/truncated; chữ ký và SHA-256 gói nạp được xác minh. Chưa nạp 0.2.10 lên board thật hoặc kiểm tra cảm biến/relay vật lý.
