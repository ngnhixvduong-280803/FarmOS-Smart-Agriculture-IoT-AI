# Báo cáo kiểm chứng API / web trên VPS — 18/10/2026

## Môi trường và ranh giới

Bản preview Docker độc lập trên VPS FarmOS: backend4fd7cb5, frontend257c91b, simulator3aea412 (enginea981055); PostgreSQL16 DB `farmos_preview` riêng, không dùng DB/credential production. Schema DB mới tạo bằng db push; chưa kiểm chứng migration production. Production vẫn image SHA bfec96c từ09/10/2026, restart count0; PR#23 còn REVIEW_REQUIRED, không bypass review.

- Web đã đăng nhập/mở: http://127.0.0.1:4080/nodes
- API qua SSH: http://127.0.0.1:4081
- Simulator preview đang gửi: http://127.0.0.1:4011
- Port4010 là simulator cũ; giữ nguyên dữ liệu và outbox cũ.

Các địa chỉ127.0.0.1 đi qua SSH tunnel tới VPS, không phải server chạy trên máy Mac và không phải endpoint công khai cho firmware ngoài Internet. Token preview không nằm trong gói. Login lưu cục bộ ở file được ignore, quyền0600. Nhóm firmware cần credential thiết bị riêng sau provisioning trên môi trường được chỉ định.

## Số liệu đo

| Phép đo | Cỡ mẫu / tải | Trung vị | p95 | Kết quả |
|---|---|---|---|---|
| HTTPS-contract ingest vật lý qua HTTP loopback ngay trong VPS |60 mẫu,2req/s,1request đồng thời |32.98ms |40.34ms |0 lỗi, đọc lại DB đúng |
| Ingest synthetic có xác thực từ Mac qua SSH tới VPS |12 mẫu tuần tự |232.21ms |366.32ms |0 lỗi |
| GET danh sách thiết bị ngay trên VPS |10 lần |24.25ms |92.43ms |đọc đúng node/sample metadata |
| Direct-device ingest → authenticated Socket.IO farm room → Mac |1 mẫu |160.84ms |không đủ mẫu |đủ cả5 trường sensor |

Phép đo loopback/SSH chưa bao gồm TLS/WAN public, mạng4G, LoRa, cảm biến hay flash/NVS của board. Đây là kiểm tra chức năng và tải nhỏ, không phải tải tối đa/SLA. Benchmark60 mẫu thực hiện ở API revisiona981055; sửa realtime sau đó và phép thử Socket.IO thực hiện ở4fd7cb5, HTTP persistence contract không thay đổi.

## Lưu trữ, kịch bản và retry

- Bốn preset được chạy qua toàn bộ thời gian sự kiện, tạo2019 frame trong phép kiểm tra tách biệt; upload **36 mẫu đại diện** (baseline/event/final) và đọc lại API/DB đủ36. Không tuyên bố đã tải toàn bộ2019 mẫu.
- Burst3node: 12 bản tin duy nhất, 12 request, 0 lần503, 12 ACK; DB đối chiếu đủ12.
- Gateway mất mạng giả lập: giữ3 mẫu trong outbox trong2500ms, không tăng ACK; nối lại gửi đủ6 mẫu trước/sau outage, queue còn0; DB đối chiếu đủ6.
- Credential sai/thiếu/thu hồi bị401; fieldpH lạ/null bị400; revoked leaf trả dropped=true và không tạo telemetry. Duplicate event không tạo thêm row.
- Node chỉ có soil_temp27.12°C được lưu và hiển thị đúng; thiếu soil_moisture hiển thị dấu trống, không lỗi UI hay tạo số đo mặc định.
- SIM data vẫn ở simulation_samples;0 row telemetry vật lý của SIM node.

## Cập nhật giao diện

Đã đối chiếu marker41.23%VWC, eventId và sampleId giữa API ACK và cửa sổ chi tiết node. Detail tự poll5giây. Một lần quan sát qua công cụ thấy giá trị mới sau8.046giây tính từ bắt đầu gửi, nhưng gồm thời gian lập lịch gọi công cụ; không dùng con số đó làm phép đo render chính xác hay SLA UI. Có ảnh xác nhận marker và phiên chạy liên tục.

Đã bật phiên live3node, mỗi5giây sinh3mẫu, bước mô phỏng1phút. Hàng đợi được gửi serial, dữ liệu/số ACK tăng; có thể Tạm dừng trong simulator. Thời gian mô phỏng chạy nhanh hơn giờ nhận server; hiển thị riêng cả hai.

## Đánh giá bàn giao

Đủ để bắt đầu tích hợp telemetry/heartbeat/outbox và các hợp đồng ghép nối đã mô tả. Chưa đủ nghiệm thu hệ thống tưới hoặc một sản phẩm firmware hoàn chỉnh: pH/EC vật lý, quota theo thiết bị/fleet load, QR/BLE board proof, OTA leaf và interlock/flow/relay cần xử lý theo GAPS.md/ACCEPTANCE.md. API mô phỏng không phải giao thức telemetry vật lý.

OpenAPI20paths đã validate; vector attestation đối chiếu backend; frontend build thành công;73 test hồi quy backend đạt. File verification.json chứa run/sample IDs và chi tiết tái kiểm tra, không chứa secret.
