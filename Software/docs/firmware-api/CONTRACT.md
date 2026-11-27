# Hợp đồng vận hành

## HTTPS và xác thực

Dùng HTTPS, kiểm tra CA và hostname; không tắt TLS verification. Hai header bắt buộc sau khi redeem:

```
x-farmos-device-id: GATEWAY_12345
x-farmos-device-token: <deviceAccessToken>
Content-Type: application/json
```

Alias `x-farmos-gateway-id/token` còn tương thích, firmware mới dùng `device-*`. Token riêng từng thiết bị được trả ở `/onboarding/devices/redeem`; giữ trong NVS phù hợp chính sách bảo vệ key. Không đưa JWT app, shared ingest token, Supabase secret hoặc khóa ký factory vào ESP. Leaf không được dùng API gateway bằng danh tính của leaf.

## Factory → QR v3 → app/BLE → cloud

Factory tạo numeric device ID hậu tố uint32 >0, key P-256 và đăng ký public key; `GATEWAY_<decimal>`/`NODE_<decimal>`. QR v3 chứa metadata public và chữ ký, không chứa cloud token/private key/setup secret. Server yêu cầu identity READY_TO_SHIP và QR hợp lệ.

App (JWT người dùng, không phải firmware) gọi resolve → claim-sessions với farmId, zoneId, deploymentMode và Idempotency-Key → nhận sessionId/challenge/provisioningToken/nonce/expiresAt. App trao challenge cho board qua BLE, lấy chữ ký board gửi về `/attest`, rồi `/finalize`.

- GATEWAY/STANDALONE_NODE: nhận provisioning session qua BLE; kết nối Wi-Fi; gọi `/devices/redeem` với deviceId/sessionId/provisioningToken/firmwareVersion, lưu deviceAccessToken. Retry redeem cùng phiên còn hạn trả cùng token nếu chưa bị thay thế/thu hồi.
- LEAF_NODE: finalize tạo pairing session; app chuyển radioToken cho node qua BLE. Gateway poll `/gateway/pairing-sessions/next`, thực hiện LoRa HMAC handshake và chỉ confirm sau khi nhận telemetry hợp lệ. radioToken không phát plaintext qua LoRa. Không xác nhận thành công chỉ vì ghi BLE xong.
- Claim cloud session 10 phút, pairing 5 phút. Luôn dùng expiresAt/ttlMs server trả. QR v2 bị tắt mặc định.

Transcript attestation: concat các chuỗi/buffer có length-prefix uint32 big-endian: domain, deviceId, sessionId, SHA256(provisioningToken UTF-8), nonce đã decode base64url; cuối là identityVersion uint32 big-endian. SHA256 transcript là message truyền vào ECDSA-P256-SHA256 (vì vậy hàm ký/verify hash message thêm một lần). Chữ ký DER, encode base64url. Dùng vector kèm theo và nguồn `factory_attestation.cpp`; không tự thay đổi endian/domain/encoding.

## Telemetry vật lý

Gateway relay gọi `/onboarding/gateway/telemetry` và giữ nodeId nguồn. Node độc lập/cảm biến gateway gọi `/onboarding/device/telemetry` (server ép nodeId theo credential).

| Trường | Hợp đồng |
|---|---|
| eventId | 16–128 ký tự `[A-Za-z0-9_-]`, duy nhất trong luồng của gateway/device; giữ nguyên khi retry |
| timestamp | Unix giây; không gửi mili giây; đồng bộ NTP trước khi đo |
| soil_temp, air_temp | °C, -55 đến 125; bỏ trường nếu không có phép đo hợp lệ |
| soil_moisture | 0–100%; API vật lý chưa mang calibration/unit metadata; không tự gọi là %VWC |
| air_humidity | %RH 0–100; SHT30 đo không khí, không đo độ ẩm đất |
| lux | 0–200000 |
| quality | số nguyên 0–255; radio hiện 0=valid, 1=suspect, 2=invalid; mặc định HTTP là 1 |

Ít nhất một phép đo hợp lệ; không gửi `null`, chuỗi số, NaN, sentinel hay field lạ. API strict: pH/EC/pin/áp suất/lưu lượng/probe thứ hai hiện chưa có trường riêng. Hai DS18B20 không được tự gộp thành cùng soil_temp mà không thống nhất cách chọn probe. Timestamp thiếu, trước 2020 hoặc quá tương lai >5 phút bị thay bằng giờ server; bản tin quá cũ nhưng sau 2020 vẫn có thể được lưu theo giờ đo.

ACK thành công yêu cầu `success=true`, `data.persisted=true`, `dropped` không true. `duplicate=true` nghĩa đã xử lý trước đó, có thể bỏ bản tin khỏi outbox. telemetryId chỉ có ở lần insert mới, không bắt buộc khi duplicate. Gateway có thể nhận HTTP200/persisted=true/dropped=true nếu leaf bị thu hồi/chưa active: loại mẫu khỏi hàng đợi đang retry để không chặn cả gateway, nhưng ghi riêng là DROPPED, không tính là đã lưu số đo. Direct route trả403 nếu mode/farm/zone không phù hợp.

Outbox bền vững: persist trước gửi/ACK LoRa, không tạo eventId mới khi retry. Timeout/mất ACK/503/5xx retry cùng ID; backoff 1/2/4/8…60 giây có jitter. 429 tôn trọng Retry-After/RateLimit headers, giữ dữ liệu. 400 cách ly payload lỗi thay vì lặp vô hạn; 401 dừng gửi và xử lý credential/revocation, không tự reset mất dữ liệu trên mọi lỗi401. 403/409 cần đồng bộ lại topology/phiên. TLS, JSON, response body bị cắt đều chưa phải ACK.

## Presence, lifecycle và tốc độ

Gửi `/device/status` mỗi 30 giây với firmwareVersion đang chạy. Online được suy ra từ last_seen trong120 giây; relay telemetry chỉ cập nhật leaf, gateway cần heartbeat riêng. Device detail hiện poll5 giây, vì vậy độ trễ màn hình thường phụ thuộc nhịp poll, khác độ trễ lưu API. WebSocket telemetry vật lý dùng Socket.IO (không phải raw WebSocket), auth phiên app và room theo farm.

Global API giới hạn300 request/phút/IP (fixed window), node-list120/phút/IP; nhiều gateway chung NAT chia sẻ hạn mức. Simulator4 mẫu/giây=240/phút trước heartbeat/poll. Không coi đây là cam kết throughput tối đa; xem kết quả đo và cần load test riêng trước khi tăng fleet. Ví dụ20 node gửi mỗi5 giây đã240 request/phút, cộng poll lifecycle2 giây=30 và heartbeat=2; phần dư rất nhỏ.

Poll `/device-commands/next` khoảng2–5 giây có jitter; data=null không có lệnh. RELEASE_ACCOUNT: nhận command → `/ack` → xóa liên kết theo quy trình board → `/applied` trong hạn. Lệnh áp dụng làm thu hồi credential; cần quy định lưu vết/retry sau mất ACK trước khi nghiệm thu. Đây là lệnh vòng đời, không phải điều khiển van.

## OTA

Gateway/standalone gọi `/ota/check?deviceType=...&currentVersion=...`; identity firmware_target/hardware_revision/partition_scheme quyết định binary, không dùng deploymentMode. Có update: dùng đúng jobId/downloadUrl trả về và credential, kiểm tra SHA-256 và project/version, ghi inactive partition. Report DOWNLOADING → FLASHING → FLASHED → BOOT_CONFIRMED; FAILED có thể retry DOWNLOADING. BOOT_CONFIRMED chỉ được credential của chính device báo sau reboot/health proof. Leaf cần thiết kế riêng xác nhận BLE/mobile; API hiện từ chối mobile giả lập BOOT_CONFIRMED. Không tự suy diễn HTTP200/FLASHED là cập nhật phần cứng thành công.

## Mô phỏng

`/simulation/ingest` chỉ dành SIM_ farm/node/binding, chứa manifest/context/groundTruth. Firmware thật không gửi endpoint hoặc schema này. Dữ liệu mô phỏng không đi vào TelemetryData/alert vật lý.

## Điều khiển bơm theo thiết bị

Trong **Thiết bị → Chi tiết thiết bị**, chủ thiết bị hoặc quản trị viên có thể yêu cầu bật/tắt bơm trên Node Wi-Fi độc lập đã nghiệm thu phần cứng. Poll lệnh và báo kết quả dùng credential riêng của Node qua HTTPS. Web chờ phản hồi tiếp điểm contactor của chính Node. Mỗi lần bật có giới hạn 30 giây trên firmware. Xác nhận tiếp điểm tại thời điểm lệnh được xử lý không đo lưu lượng và không phải trạng thái trực tiếp sau khi hết thời gian chạy.

Firmware mặc định tắt tính năng. Trước khi đưa Node vào `PUMP_CONTROL_NODE_IDS`, cần kiểm tra khóa liên động phần cứng ngắt contactor khi thiếu nước, ngõ permissive cách ly báo HIGH khi an toàn, ngõ phản hồi cách ly báo HIGH khi contactor đóng, và relay ở OFF khi reset hoặc mất nguồn. Chọn hai GPIO thực tế trong menuconfig **FarmOS pump control** theo bản đấu dây đã kiểm chứng. Node cần dùng firmware đã bật `CONFIG_FARMOS_PUMP_CONTROL` và có kết nối HTTPS. Kiểm thử bằng tải thử trước, gồm bật/tắt có phản hồi, phao ngắt, ngõ phản hồi sai, mất mạng, tự ngắt sau 30 giây và khởi động lại. Giữ danh sách Node trống cho đến khi hoàn tất nghiệm thu.

Chế độ thử relay `CONFIG_FARMOS_RELAY_BENCH_NODE_V1` chỉ nhận lệnh trên `NODE_232622412`, dùng cho relay SPDT để trống tải. Dùng các tiếp điểm khô COM → GND của Node, NO → GPIO14, NC → GPIO15. Firmware xác nhận đóng hoặc mở khi hai ngõ đọc phù hợp. Nếu thiếu dây, chập ngõ hoặc tiếp điểm không đổi, lệnh báo lỗi. Giới hạn bật vẫn là 30 giây. Dùng chế độ điều khiển bơm có khóa liên động khi nối tải thật.
