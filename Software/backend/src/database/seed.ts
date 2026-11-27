import { prisma } from "./prisma";
import bcrypt from "bcryptjs";

async function main() {
  console.log("🌱 Bắt đầu gieo dữ liệu mẫu (Seeding Database)...");

  // 1. Tạo Tài khoản Admin & Khách hàng mẫu
  const adminPassword = await bcrypt.hash("admin123", 10);
  const userPassword = await bcrypt.hash("user123", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@farmos.local" },
    update: { role: "ADMIN", password: adminPassword },
    create: {
      email: "admin@farmos.local",
      password: adminPassword,
      name: "Lê Văn Duy (Admin)",
      role: "ADMIN",
    },
  });

  const user = await prisma.user.upsert({
    where: { email: "user@farmos.local" },
    update: { role: "USER", password: userPassword },
    create: {
      email: "user@farmos.local",
      password: userPassword,
      name: "Nguyễn Nông Dân (Khách hàng)",
      role: "USER",
    },
  });
  console.log(`✅ Đã tạo tài khoản Admin & User (${admin.email}, ${user.email})`);

  // 2. Tạo Farm với Tọa độ GPS (Thủ Đức, TP.HCM)
  const farm = await prisma.farm.upsert({
    where: { id: "F01" },
    update: {
      name: "Trang Trại Thực Nghiệm FarmOS",
      location: "Khu Công Nghệ Cao TP.HCM",
      address: "Đường D1, Khu Công Nghệ Cao, P. Tân Phú, TP. Thủ Đức, TP.HCM",
      latitude: 10.854886,
      longitude: 106.786523,
    },
    create: {
      id: "F01",
      name: "Trang Trại Thực Nghiệm FarmOS",
      location: "Khu Công Nghệ Cao TP.HCM",
      address: "Đường D1, Khu Công Nghệ Cao, P. Tân Phú, TP. Thủ Đức, TP.HCM",
      latitude: 10.854886,
      longitude: 106.786523,
    },
  });

  // Gán farm cho Admin và User. Role hệ thống chỉ là ADMIN hoặc USER.
  await prisma.userFarm.upsert({
    where: { user_id_farm_id: { user_id: admin.id, farm_id: farm.id } },
    update: {},
    create: { user_id: admin.id, farm_id: farm.id },
  });
  await prisma.userFarm.upsert({
    where: { user_id_farm_id: { user_id: user.id, farm_id: farm.id } },
    update: {},
    create: { user_id: user.id, farm_id: farm.id },
  });
  console.log(`✅ Đã tạo Trang Trại: ${farm.name} (${farm.id}) với tọa độ GPS: [${farm.latitude}, ${farm.longitude}]`);

  // 3. Tạo 3 Phân Vùng (Zones)
  const zones = [
    {
      id: "Z01",
      farm_id: "F01",
      name: "Zone 1 - Cà Chua Cherry",
      crop_type: "Cà chua cherry",
      target_moisture_min: 50.0,
      target_moisture_max: 75.0,
      valve_id: "V01",
    },
    {
      id: "Z02",
      farm_id: "F01",
      name: "Zone 2 - Dưa Lưới",
      crop_type: "Dưa lưới Taki",
      target_moisture_min: 45.0,
      target_moisture_max: 70.0,
      valve_id: "V02",
    },
    {
      id: "Z03",
      farm_id: "F01",
      name: "Zone 3 - Rau Ăn Lá",
      crop_type: "Cải ngọt",
      target_moisture_min: 60.0,
      target_moisture_max: 85.0,
      valve_id: "V03",
    },
  ];

  for (const z of zones) {
    await prisma.zone.upsert({
      where: { id: z.id },
      update: z,
      create: z,
    });
  }
  console.log(`✅ Đã tạo 3 Phân Vùng: Z01, Z02, Z03`);

  // 4. Tạo các Node Cảm Biến & Gateway kèm Tọa độ GPS vi sai
  const gateway = {
    id: "GATEWAY_01",
    serial_number: "SN-FOS-GW-001",
    name: "Gateway Trung Tâm Trạm Bơm",
    farm_id: "F01",
    zone_id: null,
    owner_id: admin.id,
    type: "GATEWAY",
    gateway_id: null,
    is_activated: true,
    latitude: 10.854886,
    longitude: 106.786523,
    online: true,
    rssi: -55.0,
    firmware_version: "v1.0.2",
    last_seen: new Date(),
  };

  await prisma.node.upsert({
    where: { id: gateway.id },
    update: gateway,
    create: gateway,
  });

  const sensorNodes = [
    {
      id: "NODE_Z01_01",
      serial_number: "SN-FOS-2026-Z01",
      name: "Cảm biến Vườn Cà Chua 01",
      farm_id: "F01",
      zone_id: "Z01",
      gateway_id: "GATEWAY_01",
      owner_id: user.id,
      type: "SENSOR_NODE",
      is_activated: true,
      latitude: 10.854950,
      longitude: 106.786480,
      online: true,
      rssi: -65.0,
      firmware_version: "v1.0.2",
      last_seen: new Date(),
    },
    {
      id: "NODE_Z02_01",
      serial_number: "SN-FOS-2026-Z02",
      name: "Cảm biến Vườn Dưa Lưới 01",
      farm_id: "F01",
      zone_id: "Z02",
      gateway_id: "GATEWAY_01",
      owner_id: user.id,
      type: "SENSOR_NODE",
      is_activated: true,
      latitude: 10.855120,
      longitude: 106.786650,
      online: true,
      rssi: -68.0,
      firmware_version: "v1.0.2",
      last_seen: new Date(),
    },
    {
      id: "NODE_Z03_01",
      serial_number: "SN-FOS-2026-Z03",
      name: "Cảm biến Vườn Rau Ăn Lá 01",
      farm_id: "F01",
      zone_id: "Z03",
      gateway_id: "GATEWAY_01",
      owner_id: user.id,
      type: "SENSOR_NODE",
      is_activated: true,
      latitude: 10.854720,
      longitude: 106.786710,
      online: true,
      rssi: -60.0,
      firmware_version: "v1.0.2",
      last_seen: new Date(),
    },
  ];

  for (const n of sensorNodes) {
    await prisma.node.upsert({
      where: { id: n.id },
      update: n,
      create: n,
    });
  }
  console.log(`✅ Đã tạo 1 Central Gateway và 3 Sensor Nodes kết nối trực thuộc`);

  // 5. Tạo Hồ Sơ Cây Trồng (Crop Profiles)
  const cropProfiles = [
    {
      crop_name: "Cà chua cherry",
      description: "Cây ưa ẩm vừa phải, nhạy cảm với ngập úng gốc, giai đoạn ra hoa kết trái cần giữ ẩm ổn định.",
      optimal_moisture_min: 50.0,
      optimal_moisture_max: 75.0,
      optimal_temp_min: 22.0,
      optimal_temp_max: 30.0,
      water_requirement_desc: "Tưới vào sáng sớm hoặc chiều mát, lượng nước 0.8 - 1.2 lít/gốc/ngày.",
    },
    {
      crop_name: "Dưa lưới Taki",
      description: "Yêu cầu kiểm soát độ ẩm chặt chẽ, giảm nước trước khi thu hoạch 10 ngày để tăng độ ngọt (Brix).",
      optimal_moisture_min: 45.0,
      optimal_moisture_max: 70.0,
      optimal_temp_min: 25.0,
      optimal_temp_max: 34.0,
      water_requirement_desc: "Tưới nhỏ giọt phân đoạn, tránh tưới đẫm làm nứt quả.",
    },
    {
      crop_name: "Cải ngọt",
      description: "Bộ rễ nông, nhu cầu nước liên tục, dễ héo khi nắng gắt.",
      optimal_moisture_min: 60.0,
      optimal_moisture_max: 85.0,
      optimal_temp_min: 20.0,
      optimal_temp_max: 28.0,
      water_requirement_desc: "Tưới phun sương nhẹ 2-3 lần/ngày trong thời kỳ phát triển thân lá.",
    },
  ];

  for (const cp of cropProfiles) {
    await prisma.cropProfile.upsert({
      where: { crop_name: cp.crop_name },
      update: cp,
      create: cp,
    });
  }
  console.log(`✅ Đã tạo 3 Hồ Sơ Cây Trồng (Crop Profiles)`);
  console.log("🎉 Hoàn tất gieo dữ liệu thành công!");
}

main()
  .catch((e) => {
    console.error("❌ Lỗi khi gieo dữ liệu:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
