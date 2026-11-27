# Hướng dẫn sử dụng hệ thống FarmOS

Tài liệu này mô tả luồng hiện được cài trong server, firmware và ứng dụng mobile.
Kết quả build chỉ chứng minh mã nguồn biên dịch được; các bước Bluetooth, Wi-Fi,
LoRa, cảm biến và reset bằng nút BOOT vẫn phải xác nhận trên thiết bị thật.

## 1. Một thiết bị, ba cách sử dụng

Mỗi bo có một identity nhà sản xuất và một QR duy nhất. Server đọc identity để
biết phần cứng có Wi-Fi, LoRa, cảm biến hay khả năng làm Gateway, rồi app chỉ hiện
những chế độ mà bo đó hỗ trợ.

| Chế độ | Đường truyền dữ liệu | Dùng khi nào |
| --- | --- | --- |
| `GATEWAY` | Cảm biến cục bộ → Wi-Fi → cloud; đồng thời nhận các Node LoRa | Một máy trung tâm đặt gần Wi-Fi, có thể tự đo nhiệt độ và quản lý thêm Node |
| `LEAF_NODE` | Cảm biến → LoRa → Gateway → Wi-Fi → cloud | Điểm đo xa Wi-Fi, cần tiết kiệm điện hoặc phủ nhiều khu vực |
| `STANDALONE_NODE` | Cảm biến → Wi-Fi → cloud | Chỉ cần một điểm đo nằm trong vùng Wi-Fi, không muốn mua Gateway |

Một lần triển khai chỉ chọn một chế độ. `GATEWAY` có cảm biến cục bộ là một thiết
bị duy nhất ở cấp Gateway, không tạo thêm một Node con giả. `STANDALONE_NODE` cũng
ở cấp thiết bị cloud; nó không thuộc Gateway. `LEAF_NODE` luôn thuộc đúng một
Gateway đang hoạt động.

## 2. Khi khách vừa mua thiết bị

QR bán hàng hiện hành là **QR v3 có chữ ký**. Payload chỉ chứa metadata công khai
(`v`, `issuer`, `qrId`, `deviceId`, `serial`, `type`, `model`,
`hardwareRevision`, `kid`, `sig`); nó không chứa `claimCode`, `setup_secret`,
private key, Wi-Fi password hoặc cloud token. Quy trình cấp identity, ghi
`factory_cfg`, readback, verify và in QR được ghi đầy đủ tại
[docs/MANUFACTURING_QR.md](MANUFACTURING_QR.md).

Các endpoint/QR v2 còn trong server chỉ là compatibility cho thiết bị cũ; không
dùng chúng để tạo label production mới. Mỗi bo bán ra phải có `deviceId`, serial,
identity version và key attestation riêng trong `factory_cfg`, đồng thời identity
đó phải ở server trạng thái `READY_TO_SHIP` (sau factory readback, QC và release)
trước khi phát hành QR.

Người dùng thực hiện:

1. Cấp nguồn, chờ thiết bị vào trạng thái sẵn sàng và bật Bluetooth trên điện thoại.
2. Mở app FarmOS, đăng nhập, cấp quyền Camera, Bluetooth và thiết bị lân cận.
3. Chọn vườn/khu vực, bấm thêm thiết bị rồi quét QR trên máy.
4. App hỏi server và hiển thị model, serial cùng các chế độ hợp lệ.
5. Chọn một trong ba luồng bên dưới. Chỉ khi server trả trạng thái hoàn tất thì
   app mới báo đã thêm thiết bị.

Điện thoại cần Internet trong lúc thêm thiết bị. Wi-Fi cấp cho thiết bị phải là
2.4 GHz. API production phải dùng HTTPS.

## 3. Thiết lập làm Gateway

1. Chọn `Gateway`, khu vực đặt máy, nhập tên và mật khẩu Wi-Fi 2.4 GHz.
2. Server kiểm tra QR, quyền vườn và quyền sở hữu, rồi tạo phiên tạm thời.
3. App tìm đúng thiết bị BLE và đối chiếu `deviceId` đọc từ bo với QR.
4. App gửi chế độ, Wi-Fi, địa chỉ API và token phiên qua BLE.
5. Gateway kết nối Wi-Fi, redeem token riêng của thiết bị và báo trạng thái lên
   server. App đợi phiên thành `REDEEMED`.
6. Nếu bo có `LOCAL_SENSOR`, số đo DS18B20 gắn trực tiếp vào Gateway được lưu cho
   khu vực đã chọn. Sau đó có thể thêm nhiều `LEAF_NODE` vào Gateway này.

Gateway lưu tối đa 64 mẫu chưa được server xác nhận trong NVS. Khi Wi-Fi/server
trở lại, nó gửi lại; server chống trùng bằng event ID. Khi bộ đệm đầy, Gateway
không xác nhận mẫu LoRa mới để tránh giả vờ rằng dữ liệu đã được lưu.

## 4. Thiết lập Node thuộc Gateway

1. Gateway đích phải đã thuộc cùng tài khoản/vườn và đang hoạt động.
2. Quét QR Node, chọn `Node qua Gateway`, Gateway đích và khu vực đo.
3. Server tạo phiên ghép cặp ngắn hạn. App truyền cấu hình ghép cặp cho đúng Node
   qua BLE; Gateway lấy grant tương ứng từ server.
4. Node và Gateway xác thực HMAC qua LoRa. Gateway chỉ xác nhận liên kết với server
   sau khi nhận được telemetry hợp lệ.
5. App đợi trạng thái `ACTIVE`; viết BLE thành công chưa đủ để kết luận đã ghép.

Sau khi ghép, Node đọc DS18B20 khoảng mỗi 5–6 giây, gửi tối đa ba lần để chờ ACK.
Gateway gán farm/khu vực từ database, không tin `farmId` hoặc `zoneId` do firmware
tự khai. Node dạng này không cần biết SSID hay mật khẩu Wi-Fi.

## 5. Thiết lập Node độc lập dùng Wi-Fi

1. Quét QR, chọn `Node độc lập`, khu vực và Wi-Fi 2.4 GHz.
2. Server xác thực quyền sở hữu và tạo phiên cloud cho `STANDALONE_NODE`.
3. App đối chiếu BLE identity rồi gửi Wi-Fi, API và token phiên.
4. Node tự redeem credential, heartbeat và gửi telemetry trực tiếp bằng HTTPS.
5. App chỉ hoàn tất sau khi server báo phiên `REDEEMED`.

Node độc lập có outbox NVS 32 mẫu. Mẫu chỉ bị xóa sau phản hồi thành công từ
server; reboot hoặc mất Wi-Fi không xóa các mẫu đang chờ. Khi outbox đầy, phép đo
mới không được ghi thêm. Đây là bộ đệm ngắn hạn, không phải kho dữ liệu nhiều ngày.

## 6. Đổi Wi-Fi, gỡ liên kết và dùng lại thiết bị

- **Đổi Wi-Fi:** Trên app mobile, mở **Thiết bị trong Farm** và chọn **Đổi Wi-Fi**
  cho Node độc lập hoặc Gateway của bạn. Giữ BOOT trên bo đang chạy khoảng 3–5
  giây rồi thả, nhập Wi-Fi 2.4 GHz mới và chọn thiết bị qua Bluetooth. Điện thoại
  cần Internet để xác thực. Thiết bị giữ nguyên tài khoản, vị trí và lịch sử đo.
- **Gỡ thiết bị để cài lại:** Khi bo đang bật, giữ **BOOT** ít nhất 10 giây rồi
  thả để xóa cấu hình cục bộ. Trên web hoặc mobile, chọn **Gỡ khỏi tài khoản**.
  FarmOS thu hồi quyền truy cập cũ ngay, kể cả khi bo mất mạng hoặc còn hiện
  Online. Lịch sử đo được giữ tại Farm cũ. Gỡ Gateway cũng tách các Node con.
  Sau khi làm cả hai bước, quét lại QR v3 còn hiệu lực để cài trên tài khoản cũ
  hoặc tài khoản có quyền trên Farm đích.

## 7. Reboot, mở lại chế độ cài đặt và factory reset

Chỉ thao tác sau khi serial monitor hoặc đèn trạng thái cho biết firmware đã chạy;
không giữ BOOT ngay lúc cấp nguồn vì GPIO0 cũng là chân vào bootloader ESP32-S3.

| Thao tác | Kết quả |
| --- | --- |
| Nhấn `RESET/EN` | Reboot, giữ Wi-Fi, credential, binding và outbox |
| Giữ `BOOT` từ 3 đến dưới 10 giây rồi thả | Reboot/mở lại cửa sổ cài đặt; chưa chuyển quyền sở hữu server |
| Giữ `BOOT` ít nhất 10 giây rồi thả | Xóa deployment cục bộ và reboot; giữ identity nhà sản xuất |

Factory reset xóa cấu hình Wi-Fi lưu bởi driver ESP32. Gateway xóa thêm
`farmos_cloud`, `farmos_nodes`, `farmos_outbox`. Node xóa thêm
`farmos_pair`, `farmos_cloud`, `farmos_outbox`. Mẫu chưa đồng bộ
trong outbox sẽ mất. Partition `factory_cfg`, khóa NVS, boot counter và firmware
không bị xóa.

Factory reset vật lý giữ nguyên liên kết trên server. Khi chuyển chủ, reset bo
và chọn **Gỡ khỏi tài khoản** trước khi bàn giao.

## 8. Khởi chạy dự án cho người phát triển

### Server, database, MQTT và web

Tạo `.env` từ `.env.example`, điền database/Supabase/JWT/Cloudflare theo môi
trường của bạn. Không đưa service-role key hoặc database URL vào mobile.

```bash
cd /Users/levanduy/FarmOS
docker compose up -d --build
docker compose ps
docker compose logs -f backend
```

Sau khi cập nhật source có migration mới, áp dụng migration theo quy trình deploy
của môi trường. Production nên dùng Prisma migration đã review, không dùng
`db push`, reset database hoặc ép mất dữ liệu:

```bash
cd /Users/levanduy/FarmOS/backend
npx prisma migrate deploy
npm run build
```

### Mobile React Native

`.env` ở root cần `MOBILE_API_BASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
Script chỉ sao chép ba cấu hình public cần thiết vào app.

```bash
cd /Users/levanduy/FarmOS/mobile
npm install
npm run prepare:config
npm run start
```

Ở terminal khác dùng `npm run android` hoặc `npm run ios`. BLE, camera và đăng nhập
OAuth phải thử trên điện thoại thật; simulator không chứng minh được provisioning.

### Firmware Gateway và Node

```bash
cd /Users/levanduy/FarmOS/firmware/gateway
/Users/levanduy/.platformio/penv/bin/platformio run
/Users/levanduy/.platformio/penv/bin/platformio run --target upload
/Users/levanduy/.platformio/penv/bin/platformio device monitor
```

```bash
cd /Users/levanduy/FarmOS/firmware/node
/Users/levanduy/.platformio/penv/bin/platformio run
/Users/levanduy/.platformio/penv/bin/platformio run --target upload
/Users/levanduy/.platformio/penv/bin/platformio device monitor
```

Các lệnh upload cần chọn đúng cổng serial nếu có nhiều bo. Build development có
identity mẫu chỉ dành cho bàn thử. Dây chuyền sản xuất phải ghi factory partition
riêng cho từng serial và tạo đúng identity/QR trên server.

## 9. Cách kiểm tra sau khi người dùng thêm thiết bị

1. App hiện đúng chế độ và trạng thái online/freshness của thiết bị.
2. Với Gateway: heartbeat cập nhật; cảm biến cục bộ tạo telemetry mang chính
   `deviceId` Gateway.
3. Với Node qua Gateway: server có binding `ACTIVE`, telemetry mang `nodeId` Node
   và `gatewayId` Gateway.
4. Với Node độc lập: telemetry mang `nodeId` chính thiết bị và không có binding
   Gateway đang hoạt động.
5. Rút Wi-Fi, tạo vài mẫu, nối lại và kiểm tra mỗi event chỉ có một hàng database.
6. Gỡ thiết bị trên app, xác nhận token cũ bị từ chối, sau đó factory reset vật lý.

## 10. Giới hạn hiện tại

- BLE claim v3 dùng challenge-response bind identity/session/nonce và backend
  verify transcript; kết quả compile/test không thay cho kiểm thử hardware,
  BLE link security và key custody trước khi bán thương mại.
- Gateway/Node độc lập đang đẩy telemetry firmware qua HTTPS. MQTT trong backend
  và simulator không có nghĩa firmware vật lý đã dùng MQTT/mTLS.
- Firmware vật lý hiện mới đọc DS18B20. Relay/bơm/van, cảm biến ẩm, flow meter và
  safety interlock trong mô tả sản phẩm chưa được triển khai đầy đủ trên hai bo.
- Chưa kiểm chứng trên điện thoại/bo thật: BLE, QR, OAuth, mất điện giữa lúc ghi
  NVS, RF nhiều Node, reset nút BOOT và dữ liệu thực trong PostgreSQL.
- Trước production cần provisioning mã hóa, Secure Boot/Flash Encryption, khóa
  xoay vòng, OTA ký số và bài kiểm thử thu hồi/chuyển chủ đầy đủ.

## 11. Cập nhật firmware OTA

- Gateway và Node độc lập tự kiểm tra bản cập nhật qua HTTPS sau khi xác thực cloud,
  rồi kiểm tra lại mỗi sáu giờ.
- Node thuộc Gateway được cập nhật tại chỗ bằng mobile/BLE; app chỉ báo hoàn tất
  sau khi firmware mới đọc được cảm biến và nhận ACK LoRa hợp lệ.
- Với Node đã cấu hình, giữ `BOOT` từ 3 đến dưới 10 giây rồi thả để reboot vào cửa
  sổ bảo trì BLE, sau đó mới quét trong màn hình FOTA. Reboot bình thường sẽ đóng
  quảng bá BLE; Node mới chưa cấu hình vẫn tự mở BLE để onboarding. Sau khi OTA,
  Node giữ BLE tạm thời để app đọc kết quả health check rồi tự đóng.
- Server chọn binary theo factory firmware target/hardware revision/partition
  scheme, không theo chế độ mà người dùng đang chọn.
- Mỗi lần cập nhật có job riêng và URL tải ký số hết hạn sau 15 phút. Release phải
  `ACTIVE` và nằm trong phần trăm rollout của thiết bị.
- Không rút nguồn trong lúc đang ghi flash. Nếu firmware mới không đạt health check,
  reboot tiếp theo sẽ dùng cơ chế rollback của ESP-IDF.

Chi tiết phát hành, canary và signing xem tại [OTA.md](OTA.md).

## 12. Admin Web Serial flasher

Admin Web flasher là luồng release trực tiếp cho operator có quyền Admin, không
phải Factory Station và không nhận binary từ máy operator. Mở route `/flasher`
(màn hình có nhãn `Admin only`) rồi chỉ chọn:

1. `Sensor Node` hoặc `Gateway` trong `Firmware type` (tương ứng target
   `NODE` hoặc `GATEWAY` của server).
2. `Serial port` của bo.

Nút `Chọn port và bắt đầu flash` là user gesture duy nhất để gọi Web Serial
`requestPort`. Trình duyệt phải là Chrome/Edge có Web Serial và Web Crypto, chạy
trong secure context (`https://` hoặc `localhost`). Nếu thiếu HTTPS, Web Serial
hoặc Web Crypto, màn hình dừng ngay; không có fallback insecure.

Sau khi đọc chip/MAC và hardware proof, UI tự tạo hoặc resume FlashJob tại
`POST /api/v1/flash/jobs`, lấy signed manifest từ
`GET /api/v1/flash/jobs/:jobId/manifest` và tải đúng image/offset/download URL do
server cấp. Browser kiểm tra aggregate manifest, size và SHA-256 của từng image
trước khi ghi theo đúng thứ tự server ký. Manifest có thể gồm bootloader, partition
table, OTA/data và app/OTA slot; một merged image ở address `0` chỉ hợp lệ khi
manifest đánh dấu rõ. Không cho nhập binary, địa chỉ hoặc offset cục bộ.

Serial enrollment dùng khung FO nhị phân và signed ticket do server cấp, sau đó
reconnect, đọc lại đúng `readbackLength` của artifact và gửi nested
`flashAttestation`/readback để server hoàn tất. Completion trả trực tiếp
`qr: { qrId, payload }` để UI render, tải xuống hoặc in; không gọi thêm
`reissue-qr` sau completion.

### Vòng đời identity

- Bo chưa có identity đi qua enrollment lần đầu. DeviceIdentity và QR chỉ được
  tạo sau khi flash, readback và post-flash attestation thành công; thất bại
  không tạo “ghost device”.
- HardwareBoard ổn định được server ánh xạ từ chip/eFuse material bằng HMAC
  server-side. UI hiển thị identity/generation hiện tại trước khi thao tác.
- Flash bình thường (`NORMAL_REFLASH`, firmware op `REFLASH`) giữ nguyên device,
  serial, owner, key binding, generation và QR hiện tại.
- `Tạo device mới sau success` là reset-reprovision (`RESET_REPROVISION`, firmware
  op `RECOVER`). Operator phải nhập lý do và xác nhận. Generation cũ vẫn current
  trong lúc chờ; chỉ readback và attestation thành công mới retire generation cũ
  và tạo key/device/QR generation mới.
- Nếu flash lỗi trước hoặc sau ticket, UI chỉ cho retry/resume cùng job, ticket
  và challenge khi backend còn cho phép; reload thiếu context thì dừng an toàn.
  Fail/cancel không được xem là đã tạo device. Board bị block chỉ được resolve
  read-only cho tới khi Admin unblock.

Generation history đọc qua `GET /api/v1/flash/boards/:boardId/generations`. Các
thao tác quản trị khác đi qua API adapter với các route `/block`, `/unblock`,
`/unbind` và `/reissue-qr` dưới `/api/v1/flash/boards/:boardId`. Nút recover/
rotate-key hiện bị khóa rõ ràng: chỉ mở lại khi backend + firmware cung cấp
physical Web Serial recovery trả về pending public key do board tự sinh; không
được gửi public key hiện tại từ HELLO để giả lập recovery/rotate.

Checklist key, env, Prisma migration, firmware trust anchor và các bước release
production xem tại [MANUFACTURING_QR.md](MANUFACTURING_QR.md) và contract gốc
[backend/FLASH_CONTRACT.md](../backend/FLASH_CONTRACT.md). Build/test tĩnh không
thay cho kiểm thử Chrome/Edge HTTPS, cáp serial, bootloader, reset/reconnect,
readback và attestation trên ESP32 thật.
