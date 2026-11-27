# Khoảng trống cần chốt trước bàn giao nghiệm thu

1. Production PR #23 chưa được duyệt/merge. Preview riêng chứng minh API trên VPS, không chứng minh endpoint production đã nâng cấp.
2. Telemetry vật lý hỗ trợ soil_temp/air_temp/soil_moisture/air_humidity/lux. Chưa có pH, EC, pin, flow, sensor ID/probe2, unit/calibration version. Không gửi các field đó theo schema simulation. Cần version API trước khi mở rộng.
3. soil_moisture vật lý chỉ 0–100, chưa thống nhất VWC so với ADC%. Không dùng ngưỡng mô phỏng VWC để điều khiển từ cảm biến ADC chưa hiệu chuẩn.
4. Gateway /status hiện nhận firmwareVersion và cập nhật presence; không có schema heartbeat water-level/interlock hoàn chỉnh trên đường HTTPS này. MQTT legacy ingest tắt mặc định. Điều khiển tưới IRRIGATION_CONTROL_ENABLED=false; chưa thể nghiệm thu van/bơm qua API firmware.
5. Rate limit300 request/phút/IP dùng bộ nhớ tiến trình, chưa phân quota theo credential, chưa chứng minh vận hành nhiều gateway/NAT. Thử tải mức thấp không phải kiểm thử chịu tải lớn.
6. QR v3/factory release/P-256/BLE có mã nguồn và test, nhưng preview SIM provisioning bằng CLI bỏ qua QR. Cần board thật/điện thoại để nghiệm thu onboarding, NVS, mất điện và key custody.
7. Leaf OTA qua BLE: server chỉ chấp nhận BOOT_CONFIRMED từ cloud credential. Cần thống nhất attestation/proof sau reboot của leaf; không bàn giao như đã hoàn tất OTA leaf.
8. Delivery ACK của gateway có dropped=true dù persisted=true: firmware phải đếm DROPPED riêng. Không tính lost/revoked leaf thành số đo lưu thành công.
9. UI chi tiết thiết bị poll5 giây; chưa có realtime event riêng cho synthetic ingest. Tốc độ lưu và tốc độ hiển thị phải đo riêng.
10. RELEASE_ACCOUNT làm mất credential sau /applied; cần chốt replay/recovery nếu response cuối bị mất trước khi xác nhận quy trình reset hoàn chỉnh.

11. Dashboard khu vực vẫn đọc telemetry vật lý; số mô phỏng hiện được đối chiếu ở trang Thiết bị. Đã bỏ các số demo mặc định khi không có phép đo và sửa số lượng thiết bị từ API. Không dùng card khu vực trống làm bằng chứng ingest thất bại.
12. Lifecycle enum còn DECOMMISSION, nhưng /applied hiện chỉ chấp nhận RELEASE_ACCOUNT. Cần chốt luồng decommission trước khi bên firmware triển khai xóa/retire board.
