# FarmOS: vòng đời thiết bị và giới hạn kiểm chứng

Tài liệu mô tả mã nguồn hiện tại, không phải tuyên bố đã sẵn sàng bán thương mại.
Hai bo phát triển: ESP32-S3 N16R8 + SX1278 RA-01 433 MHz. Node đọc một DS18B20
GPIO4. Firmware dùng PlatformIO/ESP-IDF. Không có DHT11, cảm biến độ ẩm hay relay
thật trong cấu hình này. Không suy diễn tính năng tưới của backend thành chức năng
đã có trên hai bo.

> Quy trình factory/QR v3 hiện hành nằm ở
> [docs/MANUFACTURING_QR.md](MANUFACTURING_QR.md). Phần mô tả QR v2 và
> `setup_secret` bên dưới là compatibility/di sản của bộ phát triển; identity v3
> production không đưa possession code hoặc `setup_secret` vào BLE identity hay QR.

## 1. Trước khi bán

Nhà sản xuất phải cấp identity v3 riêng cho từng bo: loại thiết bị, `device_id`,
serial, model, hardware revision, firmware target và key attestation P-256; Node
có thêm `radio_id`. Ghi vào partition `factory_cfg`, đăng ký public key/fingerprint
với server, rồi chỉ phát hành QR v3 sau factory readback verification. QR v3 chỉ
chứa metadata public có chữ ký; không chứa setup secret, possession code hoặc
cloud token. Không giao cho khách identity mặc định NODE_000001/GATEWAY_000001
của bộ phát triển.

BLE v3 hiện có challenge-response bind device/session/nonce và production config
reject payload không có attestation; key custody, Secure Boot/Flash Encryption,
NVS encryption và hardware proof vẫn là release gates. Không đốt eFuse trên bo
thử nghiệm một cách tự động.

## 2. Khách mua và đăng nhập

App React Native đăng nhập Google thông qua Supabase. Backend xác thực identity,
tạo user FarmOS và vườn/khu vực mặc định khi user mới chưa tồn tại; trả mobile
access token. Token ứng dụng không được đưa vào ESP. Việc đăng nhập Google qua
trình duyệt và quay lại app cần kiểm thử trên điện thoại thật, khác với test
đăng nhập tài khoản kỹ thuật qua API.

Một tài khoản có thể quản lý nhiều Gateway. Trước khi thêm thiết bị, app cần
Internet để liên hệ server, quyền camera khi quét QR và quyền Bluetooth.

## 3. Thêm Gateway hoặc Node độc lập

1. Chọn vườn, quét QR, chọn `GATEWAY` hoặc `STANDALONE_NODE`, khu vực và nhập
   Wi-Fi 2.4 GHz/password. App chỉ hiện chế độ server cho phép.
2. Backend kiểm tra QR v3, quyền vườn và chủ sở hữu; tạo claim session 10 phút.
3. App chọn Gateway BLE và kiểm tra id đọc được đúng với QR, gửi Wi-Fi và phiên.
4. Thiết bị thử Wi-Fi. Sai Wi-Fi: giữ cấu hình cũ. Đúng Wi-Fi: lưu phiên vào NVS,
   gọi HTTPS redeem lấy token riêng. Token được lưu trong NVS, phiên tạm bị xóa.
5. Server đánh dấu phiên REDEEMED. App đợi trạng thái này, không báo thành công
   chỉ vì viết BLE xong.

Redeem lặp trong thời hạn phiên trả cùng token, miễn token đó chưa bị thu hồi hoặc
thay thế. Phiên đã hết hạn cần cài lại. Wi-Fi đúng nhưng cloud lỗi chưa có đầy đủ
rollback cấu hình cũ; không coi đây là cơ chế phục hồi hoàn chỉnh.

Node độc lập gửi thẳng HTTPS và có outbox NVS 32 mẫu. Gateway có cảm biến cục bộ
và outbox NVS 64 mẫu, đồng thời có thể nhận thêm Node LoRa.

## 4. Thêm Node qua Gateway

1. Node chưa ghép giữ BLE mở trong suốt trạng thái chưa cấu hình (firmware hiện
   chưa có bộ hẹn giờ 10 phút tự đóng quảng bá).
2. App đọc Node, người dùng chọn Gateway và khu vực. Chỉ Gateway cần Internet.
3. Backend tạo phiên 5 phút và khóa LoRa tương ứng. App gửi khóa vào Node qua BLE;
   Gateway đích lấy khóa qua API mỗi khoảng 2 giây.
4. Node gửi PairRequest chứa nonce/chữ ký HMAC. Gateway xác thực, lưu binding,
   trả PairAccept có chữ ký. Khóa không được gửi trực tiếp qua LoRa.
5. Node lưu binding; bắt đầu gửi telemetry có chữ ký. Gateway thấy telemetry hợp lệ
   mới gọi confirm. Server cập nhật quan hệ user–farm–zone–node–gateway và ACTIVE.

Hai đầu giới hạn thời gian chờ grant. Phiên bị thay thế không được xác nhận lại.
ACTIVE là bằng chứng liên kết, không phải bằng chứng cảm biến đã đọc thành công.
Nhiệt độ N/A vẫn có thể có liên kết LoRa tốt.

## 5. Vận hành thường ngày

DS18B20 → Node → SX1278 → Gateway → HTTPS API → PostgreSQL → WebSocket/app/web.

Node đo khoảng mỗi 5–6 giây, gửi boot_id/sequence và giá trị có chữ ký; tối đa
3 lần thử ACK. Không có số đo độ ẩm giả. Trường điện áp hiện chưa phải phép đo pin.

Gateway xác thực Node. Với nhiệt độ hợp lệ, Gateway ghi vào outbox NVS trước khi
ACK. Outbox hiện 64 mẫu, không phải bộ nhớ lưu nhiều ngày; đầy/lỗi ghi thì không
ACK mẫu mới. Node hết số lần thử vẫn chuyển sang chu kỳ sau: chưa có outbox Node,
nên không có bảo đảm không mất bất kỳ mẫu nào.

Server kiểm tra binding, kiểu/range cảm biến, gán farm/zone từ database chứ không
tin client. Mã sự kiện chống trùng và bản ghi telemetry cùng transaction. HTTP thành
công có persisted=true chỉ sau commit; lỗi database trả 503 để gửi lại. Gateway
chỉ xóa mẫu NVS sau xác nhận persisted. Nếu mất phản hồi HTTP, lần gửi lại không
tạo thêm hàng telemetry. Đường MQTT/REST legacy dùng handler riêng, chưa được nâng
cấp cùng mức bảo đảm này.

Gateway heartbeat khoảng 30 giây. online hiện không thay thế phép kiểm tra freshness
toàn hệ thống. Cần xem last_seen khi đánh giá mất kết nối.

## 6. Mất điện, mất mạng và lỗi cảm biến

- Mất điện: identity, cấu hình, binding và outbox Gateway còn trong NVS.
- Mất Wi-Fi: Gateway thử kết nối lại; LoRa vẫn hoạt động tới khi outbox đầy.
- Server lỗi: giữ mẫu chưa xác nhận trong outbox, gửi lại sau.
- Rút DS18B20: Node báo N/A; không biến N/A thành 0°C. Không gửi nhiệt độ giả lên server.
- Sai khóa hoặc chưa ghép: Gateway từ chối telemetry.
- Hai bo khác phiên bản protocol: không được xem là ghép được; cần nạp phiên bản tương thích.

## 7. Nút BOOT và reset

Thực hiện sau khi monitor hiện READY; không giữ BOOT trong lúc cấp điện vì GPIO0
là chân vào bootloader của ESP32-S3.

| Thao tác | Kết quả |
| --- | --- |
| Nhấn RESET/EN | Khởi động lại, không xóa cấu hình |
| Giữ BOOT 3 đến dưới 10 giây rồi thả | Khởi động lại vào cài đặt; Node giữ binding cũ trên NVS cho đến khi ghép mới thành công |
| Giữ BOOT ít nhất 10 giây rồi thả | Xóa cấu hình cục bộ theo vai trò, khởi động lại |

Node reset xóa farmos_pair, farmos_cloud và farmos_outbox. Gateway reset xóa farmos_cloud, farmos_nodes và
farmos_outbox (mẫu chưa đồng bộ mất đi). Luôn giữ factory_cfg, nvs_keys, boot counter
và firmware. Reset bị ngắt điện sẽ tiếp tục dọn cấu hình ở lần boot sau.

Reset cục bộ KHÔNG xóa quyền sở hữu server, lịch sử đo hay tài khoản. Chủ cũ vẫn là
chủ cũ. Chủ/Admin phải dùng thao tác unbind trên app trước khi reset để server đưa
identity về INVENTORY, thu hồi credential và binding. Gateway mất danh sách Node
sau reset phải ghép lại; chưa tự tải khóa binding từ server.

## 8. Những phần còn chặn bán thương mại

- BLE v3 đã có transcript attestation; cần chứng minh trên hardware thật, kiểm
  soát BLE link security và key custody trước khi gọi là production-ready.
- NVS encryption có đường tích hợp nhưng cấu hình dev chưa bật. Khóa server còn
  phụ thuộc JWT_SECRET; chưa có key ring/rotation độc lập.
- Chưa có MQTT/mTLS trên Gateway, cấp/đổi chứng thư tự động và OTA có chữ ký.
- LoRa HMAC không mã hóa nội dung; chống replay qua restart Gateway chưa hoàn chỉnh.
- Đã có unbind/thu hồi credential và binding ở server/app, nhưng chuyển chủ và
  factory reset vẫn cần kiểm thử end-to-end trên thiết bị thật.
- Chưa có giới hạn duty cycle/đánh giá pháp lý vô tuyến hoặc thử RF nhiều Node.
- Chưa kiểm chứng native BLE/Google/QR, reset vật lý và ngắt điện bằng một bộ kiểm
  thử hardware đầy đủ. Kết quả build không thay cho các bài này.

## 9. Kiểm thử và dữ liệu thử

Backend: npm run test:onboarding. Firmware: pio run cho từng project. Mobile:
tsc --noEmit và ESLint. backend/scripts/onboarding-smoke.mjs --live dùng origin từ
BACKEND_API_URL trong .env, tạo hai tài khoản kỹ thuật/thiết bị TEST và kiểm tra
claim, quyền sở hữu, hủy phiên, xác thực Gateway, chống trùng và đọc lại telemetry.
Đây là mô phỏng phần Gateway qua API, tuyệt đối không gọi nó là test LoRa/BLE.
Manifest/credential ở .local-backups (Git-ignored); giữ riêng phục vụ đối chiếu.

Kiểm thử phần cứng phải nhận diện MAC, sao lưu flash, nạp tuần tự Gateway rồi Node,
ghi monitor, chạy app provisioning và đối chiếu node_id/sequence/nhiệt độ với hàng
database. Chưa có đủ Wi-Fi/điện thoại thì đánh dấu BLOCKED, không đánh dấu PASS.
