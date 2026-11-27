# FarmOS Simulation Lab

## Mô phỏng một node độc lập

Để chạy nền bằng Docker, dùng `docker compose -f docker-compose.standalone.yml up -d --build`.
Docker chỉ mở cổng 4010 trên máy này và dùng volume riêng để giữ tọa độ cùng
nhật ký. Đóng tab không dừng Lab. Docker Desktop cần chạy để mở lại trang.
Dùng `docker compose -f docker-compose.standalone.yml stop` để dừng Lab.

Để đồng bộ với FarmOS, dùng CLI ở dưới với `--standalone` và một node trong
mỗi vườn `SIM_`. Với cấu hình mặc định của Lab, JSON topology cần khai báo
`id` là `SIM_STANDALONE_01`, `zoneId` là `SIM_ZONE_A` và `cropId` là
`mustard-greens`. Lưu thông tin xác thực vào `simulator/.env.standalone-cloud`
và đặt `FARMOS_STANDALONE_CLOUD=1`. Node dùng token của chính nó để gửi thẳng
đến API mô phỏng. Số đo cloud được lưu trong `simulation_samples`.

Để chạy nhiều Lab độc lập, dùng project Compose, tệp env và cổng localhost riêng
cho từng Lab. Chọn bằng `docker compose -p <project>`, `FARMOS_STANDALONE_ENV_FILE`
và `FARMOS_STANDALONE_PUBLIC_PORT`. Trong tệp env, đặt `FARMOS_STANDALONE_INSTANCE`
riêng và `FARMOS_STANDALONE_CROP` thành `mustard-greens`, `chilli` hoặc `tomato`.
Ví dụ `DRY` dùng `SIM_NODE_DRY` và `SIM_ZONE_DRY`. Muốn mở sẵn kịch bản đất khô
khi khởi động, đặt `FARMOS_STANDALONE_PRESET=1`. Nhịp thực mặc định 5 giây, có
thể đổi bằng `FARMOS_STANDALONE_CADENCE_MS`. Bước thời gian trong mô hình do
kịch bản quy định.

Chạy `npm --prefix simulator run lab:standalone` từ thư mục gốc rồi mở
http://127.0.0.1:4010. Node hiển thị mẫu đầu tiên ngay và lấy mẫu mỗi 5 giây khi
đang chạy. Có thể tạm dừng hoặc chọn kịch bản để xem số đo, tư vấn và thông báo của node.

Phiên standalone lưu tại `simulator/.lab-standalone`, chạy agent luật cục bộ
và tắt gửi cloud. Mã node mô phỏng là `SIM_STANDALONE_01`. Chế độ này mô phỏng
số đo và trạng thái kết nối, chưa giả lập BLE, Wi-Fi hoặc API firmware của ESP32.

Màn standalone hiển thị bản tin theo cấu trúc firmware, gồm nhiệt độ đầu dò đất,
nhiệt độ và độ ẩm không khí, độ ẩm đất đã hiệu chuẩn và mã chất lượng. ADC thô
hiển thị riêng. Bản tin có tại `GET /api/device-telemetry` và được lưu trong
`*.device-telemetry.jsonl`. Giá trị ADC tự sinh sử dụng mốc giả lập 300–1500.
Endpoint thử nội bộ hỗ trợ nhập ADC tay, dùng mốc thử firmware 0–1280
(quality 1) hoặc bỏ hiệu chuẩn để kiểm tra bản tin thiếu độ ẩm đất. Agent vẫn đọc % VWC
của mô hình môi trường.

### Agent và API standalone

Trong mục **Đề xuất tưới → Vị trí dự báo**, nhập tọa độ node. Lab lưu vị trí
cục bộ và chỉ gửi cặp tọa độ tới Open-Meteo. Agent thời tiết lấy 24 giờ dự báo
theo giờ (mưa, xác suất mưa, ET₀). Khi API lỗi hoặc chưa cấu hình vị trí,
trạng thái hiển thị rõ và luận cứ tưới chỉ dựa trên dữ liệu mô phỏng hiện có.

Agent chất lượng kiểm tra bản tin firmware, trạng thái kết nối và bất thường
trong lịch sử. Khi thiếu trường ẩm đất, chất lượng đáng ngờ hoặc chưa có VWC
tương ứng, agent giữ đề xuất tưới. Agent xu hướng dự báo 6 giờ mô phỏng từ VWC.
Agent môi trường tính điểm sương từ nhiệt độ và độ ẩm không khí. Agent tổng hợp
có thể đề nghị cân nhắc chờ mưa nếu đất vẫn trên ngưỡng, xu hướng đang khô và
trong 6 giờ dự báo có ít nhất 2 mm ở các giờ xác suất mưa từ 60%. Đây là ngưỡng
thử nghiệm. Mưa tính theo đồng hồ thực, xu hướng VWC theo đồng hồ mô phỏng.
ET₀ còn được dùng trong kế hoạch thử nghiệm dưới đây. Kết quả chỉ để người dùng xem xét.

| API local | Dữ liệu cho agent |
| --- | --- |
| `GET /api/agents` | Phiên, node, ID bản tin, chất lượng, dự báo VWC, thời tiết, điểm sương, đề xuất, sức khỏe node, đánh giá sau tưới và lịch tưới giả lập. |
| `POST /api/agents/location` | Lưu JSON với `latitude`, `longitude`; gửi JSON `null` để xóa vị trí. |
| `GET /api/device-telemetry` | Bản tin gần nhất theo cấu trúc firmware. Trả `null` khi mất kết nối. |
| `GET /api/observations` | Quan sát môi trường tổng hợp, gồm VWC và ngữ cảnh cây/đất. |
| `GET /api/notifications` | Các lần đổi trạng thái giám sát theo số đo. |

Trong **Sức khỏe và kế hoạch tưới**:

- Sức khỏe dựa vào tuổi bản tin mô phỏng và nhịp lấy mẫu. Dữ liệu heartbeat,
  phiên bản firmware và nguồn điện cần đến từ thiết bị thật khi tích hợp.
- **Thử tưới trong mô phỏng** ghi yêu cầu cho bước kế tiếp. Agent so sánh số đo
  hợp lệ liền trước và số đo hợp lệ đầu tiên trong tối đa 6 giờ mô phỏng sau đó.
  Lượng yêu cầu và thay đổi VWC được báo riêng. Lượng nước thực cấp chưa được đo.
- Kế hoạch 24 giờ dùng VWC tổng hợp, hồ sơ cây/đất, diện tích, mưa và ET₀.
  So sánh chờ, tưới đầu cửa sổ dự báo, sau 6 giờ và sau 12 giờ, kèm
  phương án nếu không có mưa. Liều đưa vào so sánh tính theo thiếu hụt tới độ ẩm
  đồng ruộng với hiệu suất giả định 90%, giới hạn 20 mm. Xếp hạng theo giờ dưới
  ngưỡng, giờ ẩm cao và lượng nước. Đây là thử nghiệm cân bằng nước, cần lượng
  nước thực đo và VWC hiệu chuẩn trước khi áp dụng cho vườn thật.

Standalone chạy lịch bằng đồng hồ thực, kể cả khi giao diện đóng. Mốc ngày
là **06:00 giờ Việt Nam**. Khi khởi động với vị trí và mẫu hợp lệ, Lab tính
bản đầu tiên ngay. Dự báo dùng 168 giờ thời tiết và hiển thị 7 cửa sổ 24 giờ,
so sánh có mưa theo dự báo với không mưa, cả hai giả định chưa tưới.

Ở đầu mỗi giờ, Lab đọc mẫu gần nhất và dự báo mới hoặc còn trong thời hạn
cache. Kế hoạch 24 giờ thay đổi khi trạng thái đầu vào đổi, mức ẩm lệch ít
nhất 1 điểm % VWC, ngưỡng cảnh báo đổi, tổng chênh lệch mưa theo các giờ
trùng nhau từ 1 mm hoặc ET₀ từ 0,5 mm, hoặc kế hoạch/giờ tưới dự kiến đã qua.
Khi kế hoạch thay đổi vì điều kiện đầu vào, dự báo 7 ngày cũng được tính lại
từ mẫu đang dùng cho kế hoạch. Thay đổi vị trí và lượt tưới mô phỏng kích hoạt kiểm tra ngay. Nếu dự báo
ngày chưa có đủ dữ liệu, Lab thử lại ở lượt kiểm tra sau.

`GET /api/agents` trả `forecastSchedule` gồm bản dự báo tuần, kế hoạch 24 giờ
đang lưu và thời điểm/lý do kiểm tra gần nhất. Nhật ký theo phiên nằm trong
`*.schedule.jsonl`. Khởi động lại tạo phiên mô phỏng mới và bản dự báo đầu
phiên mới. Nhật ký cũ vẫn nằm trong thư mục dữ liệu của Lab.

Bộ mô phỏng cục bộ/Docker cho cải xanh, ớt và cà chua, với dữ liệu tổng hợp có nguồn tham số. Mục tiêu là phát triển AI agent đọc dữ liệu, phát hiện bất thường, lập kế hoạch tưới và kiểm thử vòng phản hồi. Không phải mô hình nông học đã hiệu chuẩn tại Việt Nam.

## Chạy bằng Docker

Từ thư mục gốc FarmOS:

```sh
docker compose -f docker-compose.simulation.yml up -d --build
```

Mở http://127.0.0.1:4010. Giao diện và volume dữ liệu độc lập với Compose production. Cloud tạm dừng mặc định. Dừng bằng `docker compose -f docker-compose.simulation.yml down`; không dùng `down -v` nếu cần giữ datasets.

Chạy trực tiếp: `npm --prefix simulator run lab`. Build: `npm --prefix simulator run build`. Kiểm thử: `npm --prefix simulator run test:lab`.

## Cây, đất và nguồn

- Cải xanh ăn lá (*Brassica juncea*): nghiên cứu *Sustainability* 2021, DOI https://doi.org/10.3390/su132413948 làm căn cứ thiết kế kịch bản stress nước/hữu cơ. Kc mượn nhóm rau nhỏ FAO; thời đoạn 10/15/15/5 ngày, rễ 0.3 m và p=0.3 là giả định kỹ thuật, không phải tham số được bài báo đo. Không dùng thông số cải lấy hạt thay cho cải ăn lá; không đồng nhất %FC với %VWC.
- Ớt cay (*Capsicum annuum*): Rao 2011, *Journal of Agrometeorology* 13(2), 128–130, https://journal.agrimetassociation.org/index.php/jam/article/download/1356/1134. Kc chọn trung điểm các khoảng theo giai đoạn (0.425/0.54/0.925/0.625), không phải giá trị trung bình đo; giữ hằng từng giai đoạn. Rễ 0.30 m tham chiếu bài báo, thời đoạn 20/30/40/30 ngày là giả định, p=0.3 mượn mục ớt chuông của FAO. Chưa hiệu chuẩn cho giống ớt địa phương.
- Cà chua (*Solanum lycopersicum*): giữ hệ số FAO/nội suy, rễ 0.8 m và p=0.4. Acquah et al., *IJABE* 2018, DOI https://doi.org/10.25165/j.ijabe.20181106.3972 là nghiên cứu đối chiếu nhà kính; không gán các hệ số FAO đang dùng thành số đo của bài này.
- FAO-56: https://www.fao.org/4/X0490E/x0490e0b.htm (Eq.58, Tables 11–12), https://www.fao.org/4/X0490E/x0490e0e.htm (Eq.82–84, Table 22, Example 36).
- Ba đất: cát pha, thịt bụi, sét pha bụi. FC/WP theo ví dụ FAO; độ bão hòa, tốc độ thoát nước, hiệu suất tưới 0.9 là giả định kỹ thuật. Manifest ghi rõ nguồn và các lựa chọn tham số.

Không có raw dataset nghiên cứu được tải/huấn luyện trong phiên bản này. Hồ sơ tham số là trích xuất có nguồn; số liệu quan trắc do mô hình sinh.

## Các kịch bản

Chọn cây, đất, tuổi, diện tích, VWC ban đầu, pH, ECe, hữu cơ, thời điểm bắt đầu, seed, bước 1–60 phút. Thời tiết: nhiệt trung bình/biên độ, ẩm không khí, lux đỉnh, ET0 nhập trực tiếp. Có thể chỉnh JSON để thêm tối đa 20 node với nhiều gateway; ID phải khớp topology cloud đã provision.

Có bốn kịch bản mẫu: khô hạn, mưa lớn/thoát nước chậm, lỗi cảm biến/mất mạng và đất chua/mặn/cải tạo pH giả định.

Sự kiện: mưa, tưới (tổng mm phân bố theo thời gian), tăng/giảm nhiệt, mất mạng gateway, node mất kết nối, cảm biến đứng/lệch, tưới không lưu lượng, pH tiến đến mục tiêu cải tạo giả định. Thời gian tính theo giờ từ đầu lượt, có thể chồng lấp. Sửa kịch bản rồi áp dụng tạo run mới; run cũ vẫn giữ. Mất node: không có gói gửi gateway. Mất mạng gateway: mẫu vào outbox và gửi bù khi hồi phục.

Cân bằng nước bucket một lớp, ETc=Kc×ET0, giảm theo Ks; rễ cố định. Nước dư có thoát sâu và tràn; không có mao dẫn, dòng nhiều lớp hay ảnh hưởng độ mặn lên ET. Ks nhân ETc tổng là xấp xỉ. Sự kiện nhiệt không tự thay đổi ET0; chỉnh ET0 riêng để thử tăng nhu cầu bốc thoát hơi. pH/EC/hữu cơ là ngữ cảnh kịch bản; chưa tính phản ứng vật tư, NPK, sinh khối hoặc năng suất.

Đơn vị độ ẩm là `% VWC` (=100×m³/m³). Không đồng nhất với %ADC, %field-capacity hoặc ngưỡng phần trăm của dashboard cũ. ECe là EC dịch chiết bão hòa, không phải EC của đầu dò bất kỳ.

## Kết nối cloud FarmOS trên VPS

Có hai đường:

1. **Dataset (mặc định):** API mới `/api/v1/simulation/ingest`, lưu `simulation_samples` cùng database FarmOS; giữ toàn bộ nguồn, context và ground truth. Không ghi telemetry vật lý hoặc phát cảnh báo tưới thật. Backend cần được build/deploy cùng migration `20261016090000_simulation_datasets`.
2. **Telemetry (tùy chọn):** đặt `FARMOS_LAB_CLOUD_MODE=telemetry` để dùng `/api/v1/onboarding/gateway/telemetry` hiện có. Chỉ gửi các trường schema hiện có; pH/EC/nhãn vẫn ở dataset cục bộ. Chỉ dùng farm thử nghiệm, vì đường này có thể kích hoạt dashboard/cảnh báo hiện có. Không cho gửi timestamp tương lai qua đường này.

Cấp thiết bị riêng bằng CLI chạy trong môi trường backend đã có DATABASE_URL/JWT_SECRET đúng. CLI chỉ tạo farm mới có prefix `SIM_`, chỉ tạo ID mới, không sửa/rotate thiết bị có sẵn. Owner phải là email tài khoản FarmOS hiện có:

```sh
node dist/simulation/provision.cli.js \
  --farm SIM_AGENT_LAB \
  --owner-email user@example.com \
  --api https://your-farmos-origin.example \
  --output /secure/farmos-lab.env
```

Mặc định tạo SIM_GATEWAY_01, SIM_NODE_01/SIM_NODE_02/SIM_NODE_03 và SIM_ZONE_A/SIM_ZONE_B/SIM_ZONE_C. Có thể `--topology /path/scenario.json` cho topology nhiều gateway. Farm/node/zone IDs cần duy nhất trên cloud; dùng JSON tùy chỉnh khi tạo nhiều lab. File output chứa credential, quyền 0600; sao chép an toàn thành `simulator/.env.lab` (đã gitignore). Không gửi token qua chat hay đưa vào image.

Với `--standalone --topology /path/scenario.json`, mỗi phần tử trong
`nodes` chỉ cần `id`, `zoneId` và `cropId`. CLI tạo credential riêng cho
từng node và không tạo gateway hay binding.

Chạy lại container để nhận env rồi bấm “Bật gửi cloud”. Outbox giữ nguyên eventId khi retry; HTTP 200 có dropped=true không được tính thành công. HTTP request có timeout, không theo redirect mang credential. Đọc lại sample ID để xác nhận lưu thật.

Trên VPS, simulator vẫn chỉ bind host 127.0.0.1:4010. Truy cập qua SSH tunnel, ví dụ `ssh -L 4010:127.0.0.1:4010 <farmos-admin-host>`. Không công khai bảng điều khiển localhost trực tiếp.

Production deploy theo `deploy/README.md` (CI/CD). Có thể chạy API simulation riêng bằng `node dist/simulation/server.js` trong image backend cùng schema, database và auth env, nếu cần sidecar; phải định tuyến riêng, không thay thế backend hiện tại. Không dùng `prisma db push`, seed toàn hệ thống hay reset database production. Migration chỉ thêm bảng/index, không sửa telemetry hiện có.

## Dữ liệu cho agent và bộ đánh giá

Mỗi run lưu manifest, observations JSONL, labels JSONL và nhật ký action trong volume `/data` (chạy trực tiếp: `simulator/.lab`). Tải riêng trong UI:

- Quan sát: cảm biến, context cây/đất/pH/EC/hữu cơ, không có lịch sự kiện hay ground truth.
- Nhãn chuẩn: vật lý ẩn, stress/ngập, sự kiện, sensor fault, nhu cầu tưới của mô hình. Nhãn do mô hình tạo, không phải chẩn đoán chuyên gia thực địa.
- Manifest: toàn bộ cấu hình ban đầu, nguồn tham số, giả định và actions phát sinh.

API cloud dùng phiên đăng nhập FarmOS (cookie hoặc mobile bearer), quyền thành viên farm:

```text
GET /api/v1/simulation/runs?farmId=SIM_AGENT_LAB
GET /api/v1/simulation/runs/<runId>/samples?farmId=SIM_AGENT_LAB&limit=100
GET /api/v1/simulation/runs/<runId>/samples?farmId=SIM_AGENT_LAB&includeLabels=1
```

Phân trang bằng `nextCursor` rồi truyền `cursor`. Mặc định ẩn manifest/ground truth; chỉ evaluator yêu cầu `includeLabels=1`. Agent không được đọc manifest, labels hoặc `/api/state` của giao diện nghiên cứu. Agent cục bộ đọc `/api/catalog` để lấy hồ sơ cây/đất và nguồn, `/api/observations` để lấy snapshot đang kết nối, hoặc `/api/export?kind=observations` để lấy lịch sử (bỏ các mẫu node mất kết nối; dữ liệu gateway mất mạng trong file là lịch sử đo chờ gửi, không phải đã tới cloud); hành động mô phỏng: `POST /api/actions/irrigate` body `{"nodeId":"SIM_NODE_01","mm":10}`. Đây chỉ là tưới trong mô hình; chưa tích hợp lệnh tưới cloud/thiết bị vật lý.

Giữ cùng một họ kịch bản và các biến thể seed trong cùng split; tách test theo cả họ kịch bản, không chia ngẫu nhiên từng timestamp. Báo cáo phát hiện stress, nhận biết sensor fault, sai số dự báo VWC, lượng tưới, và tỷ lệ khuyến nghị thiếu căn cứ. Không dùng dữ liệu tổng hợp để khẳng định hiệu quả cải tạo/năng suất ngoài thực địa.

## Kiểm chứng

Unit/invariant: tái lập seed, bảo toàn nước cả mùa vụ, tích phân mưa theo cửa sổ lệch bước, tưới/no-flow, cảm biến đứng, validation, persistent HTTP outbox/ACK.

Backend regression: `npm --prefix backend run test:onboarding`.

Chạy integration tự động: `./simulator/scripts/test-lab-e2e.sh` (cần Docker, port 55439 trống; tự tạo và xóa container DB tạm của chính lượt test).

Integration thật với PostgreSQL Docker: `backend/src/simulation/e2e.test.ts` từ chối chạy trừ khi DATABASE_URL trỏ chính xác `127.0.0.1:55439/farmos_lab_test`. Chạy chỉ trên database tạm đã tạo schema; không dùng database đang vận hành.

### Thiết bị ảo trong FarmOS

CLI cấp danh tính riêng cho gateway và từng node, gắn farm/khu vực và binding; tên, serial, capability `SIMULATION` giúp nhận diện thiết bị. Sau khi API xác nhận mẫu mới, gateway và node cập nhật `last_seen` theo giờ nhận thực. Gửi lại bản tin trùng không gia hạn trạng thái online.

Trang Thiết bị dùng mẫu mới nhất trong `simulation_samples` để hiển thị số đo node, cây trồng, pH/EC, mã bản tin, mã mẫu, giờ mô phỏng và giờ server nhận; cửa sổ chi tiết làm mới mỗi 5 giây. Gateway hiển thị bản tin chuyển tiếp và node nguồn, không gán số đo đất của node cho gateway. Độ ẩm mô phỏng có đơn vị % VWC, không áp ngưỡng ADC của cảm biến thật. Không đưa dữ liệu vào telemetry/alert vật lý.

Trên bảng điều khiển mô phỏng, mục Cloud hiển thị payload mới tạo và xác nhận gần nhất của node đang chọn. Xác nhận chỉ xuất hiện sau `persisted: true`; lịch sử xác nhận tại giao diện giữ trong phiên tiến trình, dữ liệu chính thức vẫn lưu ở server. Provisioning hiện dùng CLI quản trị, chưa có ghép nối qua QR.

Các thay đổi backend/frontend cần được duyệt, merge và triển khai qua CI trước khi cấp thiết bị trên VPS và bật gửi cloud.

## Agent tư vấn thử nghiệm

Agent luật tham chiếu chạy cục bộ sau mỗi bước, chỉ nhận mẫu quan sát khi node và gateway trực tuyến; không nhận nhãn chuẩn hay danh sách sự kiện. Nó đưa ra theo dõi, xem xét tưới, nghi cảm biến đứng (5 số đo giống hệt) hoặc không có dữ liệu. Ngưỡng dựa trên FC, WP và p của hồ sơ mô phỏng. Đây không phải LLM, không đề xuất liều nước, không điều khiển thiết bị, và chưa chẩn đoán độ lệch cảm biến, pH/EC hay sự cố dòng chảy. Dữ liệu và ngưỡng chưa hiệu chuẩn thực địa.

Xem kết quả theo node trong trang Lab; tải nhật ký riêng qua `/api/advice/export`. Sau reset, bộ nhớ cảm biến và kết quả hiện tại được đặt lại. Đánh giá bốn preset 168 bước: `./simulator/node_modules/.bin/tsx simulator/scripts/evaluate-advisor.ts` từ root. Bộ đánh giá sử dụng ground truth mô phỏng riêng để đối chiếu; agent không nhận nhãn. Kết quả chỉ phản ánh kịch bản mô hình, không phải độ chính xác ngoài thực tế.

### Trang hỏi đáp và thông báo

Trang `/agent` trả lời theo mẫu dựa trên quan sát hiện có; trang `/notifications` hiển thị thay đổi trạng thái của từng node, và ghi sự kiện vào `<runId>.notifications.jsonl`. Thông báo không lặp khi trạng thái không đổi. Hai trang chỉ theo dõi khi mô phỏng tiến bước; không có push, không đọc hệ thống sản xuất, không duy trì phiên chạy sau khi tiến trình khởi động lại. Khi reset, giao diện chuyển sang lượt mới; file các lượt cũ vẫn nằm trên đĩa. Chưa tích hợp LLM; không dùng câu trả lời theo mẫu như chẩn đoán nông nghiệp.

### DeepSeek cho hỏi đáp

Đặt `DEEPSEEK_API_KEY` trong file `simulator/.env.lab` (file này không đưa vào Git), rồi khởi động lại Lab hoặc container. Có thể đặt `DEEPSEEK_MODEL`; mặc định `deepseek-flash`. Cấu hình server-side, không đưa key vào trình duyệt. Khi đã cấu hình, câu hỏi, tối đa tám lượt hội thoại gần đây và snapshot quan sát/tư vấn tổng hợp được gửi tới DeepSeek; không gửi ground truth, sự kiện ẩn, credential gateway hay manifest. Nếu không cấu hình, giao diện ghi rõ chế độ trả lời theo mẫu. LLM có thể mắc lỗi; luật giám sát độc lập với nó và không thực hiện lệnh tưới. Nếu nhà cung cấp lỗi, hệ thống báo lỗi thay vì giả vờ đã trả lời bằng AI.

### Chất lượng số đo và phản hồi sau lệnh tưới

Agent tạm giữ khuyến nghị khi độ ẩm giảm đột ngột từ 6 điểm % VWC trong tối đa một giờ; dấu hiệu được giữ trong cửa sổ 24 giờ mô phỏng. Đây là ngưỡng thử nghiệm, có thể cảnh báo cả biến động thật; không kết luận có lỗi hoặc phát hiện được mọi độ lệch. Năm số đo giống nhau chỉ bị coi là nghi đứng khi các mẫu liên tiếp cách nhau không quá một giờ. Sau mất kết nối, lịch sử agent Lab được làm mới; không suy ra độ tin cậy từ nhãn ẩn.

Lệnh tưới do người dùng nhấn trong Lab được ghi kèm lượng yêu cầu vào mẫu tổng hợp gửi cloud, để phân tích FarmOS so sánh số đo trước/sau. Lượng yêu cầu không chứng minh bơm chạy hay nước đã cấp. Chức năng này không gửi lệnh thiết bị thật; sự kiện kịch bản ẩn không được chuyển thành lệnh quan sát. Ngữ cảnh này được hỗ trợ tối đa 50 mm mỗi bước. Báo cáo chỉ đối chiếu khi có mẫu phù hợp và đáng tin cậy.

## Dữ liệu huấn luyện cho ba vườn độc lập

Từ thư mục gốc, dùng một thư mục đích chưa tồn tại:

```sh
npm --prefix simulator ci
./simulator/node_modules/.bin/tsx simulator/scripts/generate-standalone-dataset.ts <data-dir>
python3 -m venv <venv-dir>
<venv-dir>/bin/pip install scikit-learn torch
<venv-dir>/bin/python simulator/scripts/benchmark-standalone-dataset.py <data-dir> <model-dir>
```

Mỗi vườn có 96 lượt, mỗi lượt 14 ngày với bước một giờ. Tám nhóm kịch bản gồm
bình thường, khô, mưa lớn, cảm biến đứng, cảm biến lệch, mất kết nối, tưới có
phản hồi và tưới không có lưu lượng. `observations.jsonl` là đầu vào quan sát,
`labels.jsonl` có VWC chuẩn và các nhãn vật lý, `manifest.json` lưu nguồn và cấu
hình từng lượt. Ghép bằng `runId`, `nodeId`, `sequence`. Mất kết nối được biểu
diễn bằng các giá trị null. Tập train, validation và test không dùng chung lượt,
cùng có đủ ba cây và tám nhóm, với các biến thể seed và cấu hình khác nhau.

Benchmark dùng cửa sổ 12 giờ, dự báo VWC sau 6 giờ và 168 giờ, so sánh giữ
nguyên số đo, Ridge và LSTM. Chỉ tập train dùng để chuẩn hóa và huấn luyện, dùng
validation chọn epoch LSTM, rồi đo MAE trên test. Benchmark lưu trọng số và
`metrics.json`. Kết quả đánh giá trên dữ liệu tổng hợp, độc lập với thuật toán
đang phục vụ các bản dự báo và đề xuất trên FarmOS.
