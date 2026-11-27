# Báo cáo kiểm thử ngày 05/09/2026

## Server

Commit server: 9d33427bcf4920e68e5dbf059841e3a97920db90.
Workflow: https://github.com/levanduy093-work/FarmOS/actions/runs/33969531225
CI backend/frontend/simulator, publish và deploy đều success.
Push khoảng 20:39 giờ Việt Nam; test API bắt đầu 20:49:53, sau hơn 10 phút.
Origin lấy từ BACKEND_API_URL trong .env: https://api.trendhub.sbs.

Backend unit tests: 10/10. Bộ test API thật đã hoàn tất với exit code 0:

- Gateway không xác thực bị từ chối.
- Hai identity thử đăng nhập qua Supabase, đổi mobile token thật, có farm/zone mặc định.
- Tài khoản khác không được claim vào vườn không thuộc quyền.
- Gateway redeem lại trong phiên trả cùng token.
- Gateway đã sở hữu không thể bị tài khoản thứ hai claim lại.
- Phiên pairing cũ bị hủy không thể chuyển ACTIVE.
- Gateway nhận đúng grant; confirm sai khóa bị từ chối.
- Gửi nhiệt độ null bị từ chối; Node không có binding bị từ chối.
- Telemetry 28.25°C lưu thành công, đọc lại đúng telemetryId/nhiệt độ qua API latest.
- Gửi lại cùng eventId trả duplicate; không tạo mẫu mới. soil_moisture giữ null.

Đây là test mô phỏng Gateway qua API, KHÔNG phải kiểm thử RF. Hai user TEST,
hai device TEST và dữ liệu mẫu được giữ để đối chiếu. Danh sách chính xác và
credential chỉ có trong .local-backups/bench-20260905/api-test-fixtures.json,
không đưa vào Git hay báo cáo công khai. Đăng nhập thử bằng tài khoản kỹ thuật
không chứng minh Google OAuth UI hoạt động trên điện thoại.

## Phần cứng

| Vai trò | MAC đọc trực tiếp | Cổng |
| --- | --- | --- |
| Gateway | 14:c1:9f:46:ab:30 | /dev/cu.usbmodem5C4C1465511 |
| Node | ac:27:6e:a4:5e:d4 | /dev/cu.usbmodem5C4C1469801 |

- Đã đọc backup toàn bộ 16 MB mỗi bo, giữ local và giới hạn quyền đọc file.
- PlatformIO/ESP-IDF build hai project success.
- Nạp tuần tự Gateway rồi Node; esptool xác minh hash thành công.
- Monitor Gateway: READY, GATEWAY_000001, nodes=0.
- Monitor Node: READY, NODE_000001, DS18B20 GPIO4, ROM 310000006BF99A28.
- Cả hai báo DEVELOPMENT ONLY, thiếu identity xuất xưởng riêng.
- Chưa có Wi-Fi/password cho Gateway; không có bằng chứng LoRa→cloud hiện tại.
- Quét bằng Bleak trên macOS chờ CoreBluetooth ready không hoàn tất, đã dừng.
  Không kết luận tìm được Node/Gateway hay permission đã được cấp.
- Sau khi chờ bo READY, điều khiển GPIO0 qua DTR của USB UART: cả hai bo nhận
  BOOT 3.5s, báo reopen setup và software reboot; BOOT 10.5s báo LOCAL RESET,
  xóa cấu hình cục bộ rồi READY trở lại. Node tiếp tục nhận đúng DS18B20.
  Bài này chạy ở trạng thái chưa cấu hình/ghép; chưa chứng minh rollback binding
  hoặc giữ dữ liệu của một thiết bị đã vận hành. Backup flash giữ nguyên trước test.

## Mobile

TypeScript và ESLint đạt. Jest: 2 suites, 7 tests đạt, gồm callback OAuth.
Đã sửa PKCE và chỉ truyền code (không phải URL đầy đủ) vào exchangeCodeForSession.
Đã bật đóng gói model QR trên Android.
Gradle :app:assembleDebug thành công với VisionCamera_enableCodeScanner=true.
APK debug ở mobile/android/app/build/outputs/apk/debug/app-debug.apk; cần Metro
khi chạy, không phải bản release ký phát hành cho khách hàng.
Không có điện thoại Android được adb liệt kê; xcrun không có devicectl.
Chưa có test Google/QR/BLE trên điện thoại thật, test iOS, hoặc đánh giá bảo mật BLE.

Kiểm thử bổ sung trên Android emulator `Medium_Phone`:

- Sinh lại public config từ `.env`, build APK debug và cài đặt thành công.
- App khởi động tới màn hình đăng nhập, không có crash JavaScript/native.
- Lần bấm Google đầu phát hiện React Native URL không tương thích Supabase;
  đã thêm URL polyfill và tái hiện xác nhận lỗi biến mất.
- Bổ sung native secure random và SHA-256 WebCrypto polyfill. OAuth mở đúng trang
  Google qua Supabase với `code_challenge_method=s256`, không còn hạ xuống PKCE plain.
- Unit/Jest sau sửa: 3 suites, 8 tests đạt; TypeScript và ESLint đạt.
- Dừng tại trang Google, không nhập tài khoản cá nhân. Vì vậy callback thật,
  dashboard sau đăng nhập, QR/BLE và provisioning vẫn chưa được đánh dấu PASS.

`npm audit --omit=dev` vẫn báo 9 high qua chuỗi React Native/Metro `image-size`.
NPM chỉ đề xuất bản sửa cưỡng bức làm hạ/bẻ phiên bản Metro; chưa tự động áp dụng
vì có nguy cơ phá React Native 0.87. Cần nâng dependency theo bản vá tương thích.

## Chưa được đánh dấu PASS

Ghép nối app→BLE→LoRa→server; đọc nhiệt độ thật tới database; rút nguồn khi outbox
đang ghi; mất Wi-Fi/server rồi hồi phục; reset thiết bị đang có binding; chuyển chủ; thu hồi key;
mã hóa BLE/NVS; MQTT/mTLS; nhiều Gateway/nhiều Node; OTA và tưới thực tế.

Không dùng kết quả build, API mô phỏng hoặc phát hiện DS18B20 để thay các bài trên.
