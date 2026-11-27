# 🌾 FarmOS — Multi-Gateway & Multi-Node Smart Simulator (v3.0)

Bộ giả lập đa Gateway và đa Node cảm biến độc lập dành cho **FarmOS**, hỗ trợ cả **MQTT** và **REST API**, tích hợp Web Control Panel đồ họa tương tác thời gian thực, quản lý mã định danh thiết bị phục vụ Onboarding/Claim vào tài khoản người dùng, và tích hợp cơ chế đồng bộ kho xuất xưởng (Admin Provisioning).

---

## 🚀 Khởi chạy nhanh

### 1. Cài đặt thư viện & Build:
```bash
cd /Users/levanduy/FarmOS/simulator
npm install
npm run build
```

### 2. Khởi động Simulator:
```bash
npm start
```
*(hoặc `npm run dev` để chạy chế độ hot-reload)*

---

## 🎮 Giao diện Web Control Panel (Cổng 4000)

Khi simulator khởi động, mở trình duyệt tại:
👉 **[http://localhost:4000](http://localhost:4000)**

Tại đây bạn có thể:
* **Cấu hình nhiều Gateway:** Thêm mới, chỉnh sửa, xóa Gateway. Mỗi Gateway có Mã ID (`GATEWAY_01`, `GATEWAY_02`...) và Số Serial (`SN-FOS-GW-001`...) hiển thị rõ ràng kèm nút 📋 **Copy Mã**.
* **Cấu hình nhiều Node cảm biến:** Thêm mới, chỉnh sửa, xóa Node theo từng Zone & Gateway. Mỗi Node có Mã ID (`NODE_Z01_01`...) và Số Serial (`SN-FOS-2026-Z01`...) kèm nút 📋 **Copy Mã**.
* **Kéo thanh trượt (Sliders) đầy đủ các trường dữ liệu:**
  * Độ ẩm đất (10% - 95%)
  * Nhiệt độ không khí & Nhiệt độ đất (°C)
  * Độ ẩm không khí (%)
  * Cường độ ánh sáng (Lux)
  * Trạng thái Online
* **Nút tác vụ nhanh:** ⚠️ *Ép khô 28%*, 💧 *Đủ ẩm 75%*, 🚨 *Bể cạn 10%*, 💧 *Đầy bể 88%*, 🚰 *Kẹt van / No-flow*, 📡 *Rớt mạng (Offline)*.
* **🚀 Đăng ký mã vào Supabase (Admin):** 1-Click đồng bộ toàn bộ danh sách thiết bị lên Database Supabase để cấp phép mã xuất xưởng, cho phép người dùng kích hoạt vào trang trại trên FarmOS Web.
* **Live Console:** Xem trực tiếp gói tin lệnh Server gửi xuống và phản hồi ACK gửi về.

Badge ở góc phải chỉ chuyển sang “đã kết nối” sau khi broker MQTT kết nối hoặc API trả HTTP thành công. Khi đổi MQTT/REST API, simulator gửi ngay snapshot gồm 3 Node và Gateway, không chờ hết chu kỳ telemetry. Lệnh điều khiển vẫn đi qua MQTT và ACK được trả về đúng topic MQTT, kể cả khi telemetry đang dùng REST fallback.

### Kiểm tra end-to-end

1. Mở `http://localhost:4000`, chọn MQTT. Badge cần báo **MQTT đã kết nối**.
2. Chọn REST API. Badge cần báo **REST API đã xác thực**; Server nhận ngay 3 telemetry và 1 gateway-status.
3. Gửi lệnh tưới từ FarmOS. Simulator nhận `farm/F01/zone/<zone>/command`, sau đó gửi ACK về `farm/F01/node/GATEWAY_01/ack`.

Nếu MQTT thiếu cấu hình hoặc broker ngắt, simulator giữ QoS 1 message trong outbox local, retry theo exponential backoff có jitter và chỉ xóa message sau PUBACK. Khi queue đầy, telemetry cũ bị ưu tiên bỏ trước status/ACK; ACK được giữ lại để đóng lệnh an toàn.

---

## ⌨️ Phím tắt CLI trong Terminal

* `[1]`, `[2]`, `[3]`: Hạ ẩm Zone 1 / Zone 2 / Zone 3 xuống 30%
* `[4]`: Giả lập Bể cạn nước (10%)
* `[5]`: Giả lập Kẹt van / No-flow (Flow=0L, ACK FAILED)
* `[m]`: Chuyển đổi giao thức MQTT 🔁 REST API
* `[h]`: Hiển thị bảng trợ giúp
* `[q]`: Thoát simulator

## Phòng mô phỏng cây trồng và đất (mới)

Chế độ độc lập có chọn cải xanh/ớt/cà chua, mô hình cân bằng nước, kịch bản theo thời gian, dữ liệu đánh giá agent và API cloud có credential gateway riêng. Chạy Docker bằng `docker compose -f docker-compose.simulation.yml up -d --build` từ root; UI tại http://127.0.0.1:4010. Chi tiết nguồn khoa học, giới hạn và kết nối VPS: [LAB.md](LAB.md).
