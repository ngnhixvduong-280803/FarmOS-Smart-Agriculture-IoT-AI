# Checklist nghiệm thu firmware

- [ ] Factory numeric ID/P-256/public key/QRv3 khớp, chưa qua QC không claim được.
- [ ] App tạo claim, BLE board ký đúng vector, attest/finalize/redeem; test sai key/replay/hết hạn/mất Internet.
- [ ] Gateway và standalone lấy token riêng, leaf chỉ dùng radio key; revoked/quarantine/retired không gửi được.
- [ ] Gửi đủ sensor, bỏ field invalid; SHT30 là nhiệt/ẩm không khí; thống nhất đơn vị độ ẩm đất/probe mapping.
- [ ] Sensor → flash outbox → HTTPS → persisted ACK → DB đọc lại đúng; retry cùng eventId không trùng.
- [ ] HTTP200 dropped=true được báo mất mẫu, không tính persisted;400/401/403/409/429/503 được xử lý khác nhau.
- [ ] Mất Wi-Fi, server reboot, timeout sau commit, gateway/node reboot, mất nguồn giữa ghi NVS không mất/nhân đôi mẫu vượt giới hạn công bố.
- [ ] Đầy outbox có chỉ báo và policy; đo dung lượng/tuổi thọ flash, không tuyên bố lưu nhiều ngày với queue nhỏ.
- [ ] Heartbeat30giây, offline sau TTL120giây; gateway relay vẫn heartbeat độc lập.
- [ ] Poll lifecycle/OTA có jitter và tổng lưu lượng phù hợp quota/NAT.
- [ ] OTA đúng target/version/hash/partition; corrupt/downgrade/power-cut rollback; BOOT_CONFIRMED sau health proof thật.
- [ ] Leaf OTA có thỏa thuận proof sau BLE; không nghiệm thu chỉ bằng bản ghi FLASHED.
- [ ] Tưới chỉ nghiệm thu sau có command channel/ACK/flow/tank interlock/emergency-stop trên board thật.

Ghi phiên bản firmware, revision API, topology, thời gian, số mẫu tạo/nhận/drop/retry, RTT p50/p95/p99, tuổi mẫu khi lên UI và ảnh/log chứng minh. Không dùng kết quả localhost thay cho phép đo Internet/4G/LoRa thực địa.
