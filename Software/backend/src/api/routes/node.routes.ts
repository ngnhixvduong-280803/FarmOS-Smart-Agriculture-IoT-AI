import { Router, Request, Response } from "express";
import crypto from "crypto";
import { DeviceIdentityState, DeviceLifecycleEventType, DeviceQrLabelState, NodeConnectionMode } from "@prisma/client";
import { prisma } from "../../database/prisma";
import { authenticate, AuthRequest, getSessionFromRequest } from "../middleware/auth.middleware";
import { env } from "../../config/env";
import { rateLimit } from "express-rate-limit";
import { createOpaqueToken, hashDeviceSecret, matchesDeviceSecret } from "../../security/device-secrets";
import { isLegacyIdentity, legacyProvisioningEnabled } from "../../security/provisioning";
import { invalidateDeviceAccess, releaseDeviceAccount } from "../../security/device-access";
import { isNodeOnline } from "../../telemetry/node-presence";
import { qrPayloadForLabel } from "../../manufacturing/qr";

const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

function safelyMatches(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function checkProvisionAuth(req: Request): boolean {
  // 1. Xác thực qua Device Ingest Token (phục vụ nút 1-Click Sync trên Simulator)
  const deviceToken = req.header("x-farmos-device-token");
  if (deviceToken && env.DEVICE_INGEST_TOKEN && safelyMatches(env.DEVICE_INGEST_TOKEN, deviceToken)) {
    return true;
  }
  // 2. Xác thực qua Session Cookie của Admin
  const session = getSessionFromRequest(req);
  if (session && session.role === "ADMIN") {
    return true;
  }
  // 3. Xác thực qua Authorization Bearer Token
  const authHeader = req.header("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const bearerToken = authHeader.substring(7).trim();
    if (env.DEVICE_INGEST_TOKEN && safelyMatches(env.DEVICE_INGEST_TOKEN, bearerToken)) {
      return true;
    }
  }
  return false;
}

async function validateNodeRelations(farmId: string, zoneId?: string | null, gatewayId?: string | null, nodeId?: string) {
  if (zoneId) {
    const zone = await prisma.zone.findUnique({
      where: { id: zoneId },
      select: { farm_id: true },
    });
    if (!zone || zone.farm_id !== farmId) {
      return "Zone phải thuộc cùng trang trại với thiết bị";
    }
  }

  if (gatewayId) {
    if (gatewayId === nodeId) {
      return "Thiết bị không thể là Gateway của chính nó";
    }
    const gateway = await prisma.node.findUnique({
      where: { id: gatewayId },
      select: { farm_id: true, type: true },
    });
    if (!gateway || gateway.farm_id !== farmId || gateway.type !== "GATEWAY") {
      return "Gateway phải tồn tại, là Gateway và thuộc cùng trang trại với thiết bị";
    }
  }

  return null;
}

// POST /api/v1/nodes/provision - Quyền Admin: Đăng ký thông tin thiết bị xuất xưởng vào Supabase
router.post("/provision", async (req: Request, res: Response) => {
  try {
    if (!env.ENABLE_LEGACY_PROVISIONING) {
      return res.status(410).json({ success: false, error: "Legacy v2 provisioning is disabled; use manufacturing QR v3" });
    }
    if (!checkProvisionAuth(req)) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: Yêu cầu quyền Quản trị viên (Admin) hoặc Device Ingest Token hợp lệ để đăng ký thiết bị xuất xưởng!",
      });
    }

    const { devices, id, serialNumber, name, type = "SENSOR_NODE", farmId, gatewayId, claimCode, model, bleName, capabilities, firmwareTarget, hardwareRevision, partitionScheme, bootloaderVersion } = req.body;
    const deviceList: Array<{ id: string; serialNumber?: string; name?: string; type?: string; farmId?: string; gatewayId?: string; claimCode?: string; model?: string; bleName?: string; capabilities?: string[]; firmwareTarget?: string; hardwareRevision?: string; partitionScheme?: string; bootloaderVersion?: string }> =
      Array.isArray(devices) && devices.length > 0
        ? devices
        : id
        ? [{ id, serialNumber, name, type, farmId, gatewayId, claimCode, model, bleName, capabilities, firmwareTarget, hardwareRevision, partitionScheme, bootloaderVersion }]
        : [];

    if (deviceList.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Vui lòng cung cấp thông tin thiết bị cần đăng ký (id, serialNumber, type)",
      });
    }

    // A revoked/quarantined factory identity is terminal for this endpoint.
    // Check the complete request before mutating any row, so a mixed batch
    // cannot partially re-register a compromised device.
    const requestedIds = deviceList.filter((dev) => dev?.id).map((dev) => String(dev.id).trim());
    const existingIdentities = await prisma.deviceIdentity.findMany({ where: { device_id: { in: requestedIds } } });
    const blockedIdentity = existingIdentities.find((identity) => identity.state === DeviceIdentityState.REVOKED || identity.state === DeviceIdentityState.QUARANTINED);
    if (blockedIdentity) {
      return res.status(409).json({ success: false, error: `Device identity ${blockedIdentity.device_id} is ${blockedIdentity.state} and cannot be re-provisioned` });
    }
    const v3Identity = existingIdentities.find((identity) => identity.identity_version >= 3 && identity.state !== DeviceIdentityState.LEGACY);
    if (v3Identity) {
      return res.status(409).json({ success: false, error: `Device identity ${v3Identity.device_id} is a QR v3 identity; use manufacturing routes` });
    }

    const results: any[] = [];
    const activation: Array<{ id: string; serialNumber: string; claimCode: string | null; qrPayload: string | null }> = [];
    for (const dev of deviceList) {
      if (!dev.id) continue;
      const devId = String(dev.id).trim();
      const devSerial = dev.serialNumber ? String(dev.serialNumber).trim() : devId;
      const devType = dev.type === "GATEWAY" ? "GATEWAY" : "SENSOR_NODE";
      // Factory registration must not create a runtime Node in a fake/default
      // farm. The Node row is created only by a successful claim/finalize.
      const devFarmId = dev.farmId ? String(dev.farmId).trim() : null;
      const devGatewayId = dev.gatewayId && devType !== "GATEWAY" ? String(dev.gatewayId).trim() : null;
      const defaultCapabilities = devType === "GATEWAY"
        ? ["WIFI", "LORA", "GATEWAY", "LOCAL_SENSOR"]
        : ["WIFI", "LORA", "SENSOR_DS18B20"];
      const devCapabilities = Array.isArray(dev.capabilities)
        ? [...new Set(dev.capabilities.map(String).map(value => value.trim().toUpperCase()).filter(Boolean))]
        : defaultCapabilities;
      const devFirmwareTarget = String(dev.firmwareTarget || (devType === "GATEWAY" ? "ESP32S3_LORA_GATEWAY_V1" : "ESP32S3_LORA_SENSOR_V1")).trim();
      const devHardwareRevision = String(dev.hardwareRevision || "REV_A").trim();
      const devPartitionScheme = String(dev.partitionScheme || "FARMOS_16M_V1").trim();
      const existingIdentity = await prisma.deviceIdentity.findUnique({ where: { device_id: devId } });
      const existingNode = await prisma.node.findUnique({
        where: { id: devId },
        select: { id: true, is_activated: true, type: true, deployment_mode: true, gateway_id: true, owner_id: true, farm_id: true },
      });
      const effectiveFirmwareTarget = existingIdentity?.firmware_target || devFirmwareTarget;
      const effectiveHardwareRevision = existingIdentity?.hardware_revision || devHardwareRevision;
      const effectivePartitionScheme = existingIdentity?.partition_scheme || devPartitionScheme;
      // Factory registration is intentionally idempotent. Once a device has
      // been activated through cloud or pairing onboarding, a later inventory
      // sync must not silently turn a standalone Node into a leaf (or detach
      // it from its Gateway).
      const effectiveType = existingNode?.is_activated ? existingNode.type : devType;
      const effectiveDeploymentMode = existingNode?.is_activated
        ? existingNode.deployment_mode
        : devType === "GATEWAY" ? "GATEWAY" : "LEAF_NODE";
      const effectiveGatewayId = existingNode?.is_activated ? existingNode.gateway_id : devGatewayId;
      const oneTimeClaimCode = existingIdentity
        ? null
        : dev.claimCode
        ? String(dev.claimCode).trim()
        : createOpaqueToken(12);

      const saved = existingNode
        ? await prisma.node.update({
            where: { id: devId },
            data: {
              serial_number: devSerial,
              name: dev.name ? String(dev.name).trim() : devId,
              type: effectiveType,
              connection_mode: effectiveDeploymentMode === "LEAF_NODE" ? NodeConnectionMode.LORA_GATEWAY : NodeConnectionMode.WIFI,
              capabilities: devCapabilities,
              deployment_mode: effectiveDeploymentMode,
              ...(existingNode.is_activated || devGatewayId === null ? {} : { gateway_id: effectiveGatewayId }),
            },
          })
        : null;
      if (saved) results.push(saved);
      const identityState = existingIdentity
        ? (existingIdentity.identity_version < 3 && existingIdentity.state === DeviceIdentityState.INVENTORY ? DeviceIdentityState.LEGACY : existingIdentity.state)
        : (saved?.is_activated ? DeviceIdentityState.CLAIMED : DeviceIdentityState.LEGACY);
      await prisma.deviceIdentity.upsert({
        where: { device_id: devId },
        update: {
          serial_number: devSerial,
          type: devType,
          capabilities: devCapabilities,
          // Factory compatibility identity is immutable after first inventory registration.
          firmware_target: effectiveFirmwareTarget,
          hardware_revision: effectiveHardwareRevision,
          partition_scheme: effectivePartitionScheme,
          bootloader_version: existingIdentity?.bootloader_version || undefined,
          model: dev.model ? String(dev.model).trim() : undefined,
          ble_name: dev.bleName ? String(dev.bleName).trim() : undefined,
          // Existing claim material and lifecycle state are immutable here.
          claim_code_hash: undefined,
          state: identityState,
          identity_version: existingIdentity?.identity_version ?? 2,
          claimed_by_id: existingIdentity?.claimed_by_id ?? saved?.owner_id ?? null,
          claimed_farm_id: existingIdentity?.claimed_farm_id ?? (saved?.is_activated ? saved.farm_id : null),
          claimed_at: existingIdentity?.claimed_at ?? (saved?.is_activated ? new Date() : null),
        },
        create: {
          device_id: devId,
          serial_number: devSerial,
          type: devType,
          capabilities: devCapabilities,
          firmware_target: effectiveFirmwareTarget,
          hardware_revision: effectiveHardwareRevision,
          partition_scheme: effectivePartitionScheme,
          bootloader_version: dev.bootloaderVersion ? String(dev.bootloaderVersion).trim() : null,
          model: dev.model ? String(dev.model).trim() : null,
          ble_name: dev.bleName ? String(dev.bleName).trim() : `${devType === "GATEWAY" ? "FarmOS-GW" : "FarmOS-NODE"}-${devId.slice(-6)}`,
          claim_code_hash: hashDeviceSecret(`claim:${devId}`, oneTimeClaimCode!),
          state: DeviceIdentityState.LEGACY,
          identity_version: 2,
        },
      });
      await prisma.deviceLifecycleEvent.create({ data: {
        device_id: devId,
        event_type: DeviceLifecycleEventType.LEGACY_PROVISIONED,
        from_state: existingIdentity?.state || null,
        to_state: identityState,
        actor_type: "LEGACY_PROVISION",
        actor_id: null,
        metadata: { runtimeNodeCreated: Boolean(saved), legacy: true },
      } });
      activation.push({
        id: devId,
        serialNumber: devSerial,
        claimCode: oneTimeClaimCode,
        qrPayload: oneTimeClaimCode
          ? JSON.stringify({ v: 2, deviceId: devId, serial: devSerial, claim: oneTimeClaimCode })
          : null,
      });
    }

    res.status(200).json({
      success: true,
      message: `Đã đăng ký thành công ${results.length} thiết bị vào danh mục kho xuất xưởng Supabase!`,
      count: results.length,
      data: results,
      activation,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v1/nodes/inventory - Xem danh mục thiết bị trong Supabase (Dành cho Admin)
router.get("/inventory", async (req: Request, res: Response) => {
  try {
    if (!checkProvisionAuth(req)) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: Chỉ Quản trị viên mới có quyền xem kho thiết bị xuất xưởng",
      });
    }

    const { status } = req.query;
    const where: any = {};
    if (status === "unactivated") {
      where.is_activated = false;
    } else if (status === "activated") {
      where.is_activated = true;
    }

    const inventory = await prisma.node.findMany({
      where,
      include: {
        gateway: { select: { id: true, name: true, serial_number: true } },
        owner: { select: { id: true, name: true, email: true } },
        farm: { select: { id: true, name: true } },
      },
      orderBy: { created_at: "desc" },
    });

    const results: any[] = [...inventory];
    if (status !== "activated") {
      const existingNodeIds = new Set(inventory.map((n: any) => n.id));
      const identityWhere: any = {
        generation_state: { not: "RETIRED" },
        is_current: true,
      };
      if (existingNodeIds.size > 0) {
        identityWhere.device_id = { notIn: Array.from(existingNodeIds) };
      }
      const unassignedIdentities = await prisma.deviceIdentity.findMany({
        where: identityWhere,
        orderBy: [{ updated_at: "desc" }],
      });
      for (const identity of unassignedIdentities) {
        results.push({
          id: identity.device_id,
          serial_number: identity.serial_number,
          name: identity.model || identity.device_id,
          type: identity.type,
          deployment_mode: identity.type === "GATEWAY" ? "GATEWAY" : "LEAF_NODE",
          capabilities: identity.capabilities,
          gateway_id: null,
          gateway: null,
          farm_id: null,
          farm: null,
          owner_id: null,
          owner: null,
          is_activated: false,
          online: false,
          created_at: identity.created_at,
          updated_at: identity.updated_at,
        });
      }
    }

    res.json({ success: true, count: results.length, data: results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v1/nodes - Lấy danh sách nodes (Admin xem tất cả, User chỉ xem node của mình)
router.get("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const where =
      user.role === "ADMIN"
        ? {}
        : {
            OR: [
              { owner_id: user.id },
              { farm: { user_farms: { some: { user_id: user.id } } } },
            ],
          };

    const nodes = await prisma.node.findMany({
      where,
      include: {
        farm: {
          select: {
            id: true,
            name: true,
            location: true,
            latitude: true,
            longitude: true,
            user_farms: {
              select: {
                user: { select: { id: true, name: true, email: true, role: true } },
              },
            },
          },
        },
        zone: {
          select: { id: true, name: true, crop_type: true, target_moisture_min: true, target_moisture_max: true, valve_id: true },
        },
        gateway: {
          select: { id: true, name: true, serial_number: true, online: true },
        },
        owner: { select: { id: true, name: true, email: true } },
        telemetries: {
          orderBy: { timestamp: "desc" },
          take: 1,
        },
      },
      orderBy: { created_at: "desc" },
    });

    // Only project datasets belonging to already-authorized dedicated lab devices.
    const labNodes = nodes.filter(n => n.id.startsWith('SIM_') && n.farm_id?.startsWith('SIM_'));
    const [simulationEntries, identities] = await Promise.all([
      Promise.all(labNodes.map(async n => {
        const sample = await prisma.simulationSample.findFirst({
          where: { farm_id: n.farm_id!, ...(n.type === 'GATEWAY' ? { gateway_id: n.id } : { node_id: n.id }) },
          orderBy: [{ received_at: 'desc' }, { id: 'desc' }],
          select: { id: true, event_id: true, run_id: true, node_id: true,
            received_at: true, simulated_at: true, observations: true, context: true },
        });
        return [n.id, sample] as const;
      })),
      prisma.deviceIdentity.findMany({
        where: { device_id: { in: nodes.map(node => node.id) } },
        select: {
          device_id: true, identity_version: true, state: true, claimed_by_id: true,
          generation_state: true, is_current: true,
          lifecycle_commands: {
            where: { type: "RELEASE_ACCOUNT", status: { in: ["PENDING", "ACKNOWLEDGED"] }, expires_at: { gt: new Date() } },
            select: { id: true },
            take: 1,
          },
        },
      }),
    ]);
    const simulationViews = new Map(simulationEntries);
    const identitiesByDevice = new Map(identities.map(identity => [identity.device_id, identity]));
    const formatted: any[] = nodes.map((node: any) => {
      const isSimulation = node.id.startsWith('SIM_') && node.farm_id?.startsWith('SIM_');
      const sample = simulationViews.get(node.id);
      const observations = sample?.observations as Record<string, any> | undefined;
      const latestReading = node.telemetries[0];
      const latestTelemetry = isSimulation
        ? (sample && node.type !== 'GATEWAY' ? { ...observations, timestamp: sample.simulated_at } : null)
        : (latestReading?.farm_id === node.farm_id ? latestReading : null);

      // Ưu tiên 1: node.owner trực tiếp
      // Ưu tiên 2: nếu node đã kích hoạt và gắn với nông trại, lấy chủ nông trại từ user_farms
      let effectiveOwner = node.owner;
      if (!effectiveOwner && node.is_activated && node.farm?.user_farms?.length > 0) {
        const preferred = node.farm.user_farms.find((uf: any) => uf.user?.role === "USER") || node.farm.user_farms[0];
        if (preferred?.user) {
          effectiveOwner = {
            id: preferred.user.id,
            name: preferred.user.name,
            email: preferred.user.email,
          };
        }
      }

      const identity = identitiesByDevice.get(node.id);
      const manageableIdentity = Boolean(identity && identity.is_current && identity.generation_state === "ACTIVE" &&
        identity.state !== "QUARANTINED" && identity.state !== "REVOKED");
      const leaf = node.deployment_mode === "LEAF_NODE" || node.connection_mode === NodeConnectionMode.LORA_GATEWAY;
      const online = isNodeOnline(node);
      const canUnbind = !isSimulation && node.is_activated && manageableIdentity && (user.role === "ADMIN" || node.owner_id === user.id);

      return {
        id: node.id,
        is_simulation: Boolean(isSimulation),
        simulation: sample ? {
          sample_id: sample.id, event_id: sample.event_id, run_id: sample.run_id,
          source_node_id: sample.node_id, received_at: sample.received_at,
          simulated_at: sample.simulated_at, context: sample.context,
        } : null,
        serial_number: node.serial_number,
        name: node.name || node.id,
        type: node.type,
        deployment_mode: node.deployment_mode,
        capabilities: node.capabilities,
        gateway_id: node.gateway_id,
        gateway: node.gateway,
        is_activated: node.is_activated,
        online,
        can_unbind: canUnbind,
        can_release_offline: canUnbind,
        can_reconfigure_wifi: !isSimulation && node.is_activated && manageableIdentity && !leaf &&
          node.owner_id === user.id && identity?.claimed_by_id === user.id && (identity?.identity_version ?? 0) >= 3,
        release_pending: canUnbind && Boolean(identity?.lifecycle_commands.length),
        rssi: node.rssi,
        firmware_version: node.firmware_version,
        last_seen: node.last_seen,
        latitude: node.latitude,
        longitude: node.longitude,
        farm: node.farm
          ? {
              id: node.farm.id,
              name: node.farm.name,
              location: node.farm.location,
              latitude: node.farm.latitude,
              longitude: node.farm.longitude,
            }
          : null,
        zone: node.zone,
        owner: effectiveOwner,
        latest_telemetry: latestTelemetry
          ? {
              soil_moisture: latestTelemetry.soil_moisture,
              soil_temp: latestTelemetry.soil_temp,
              air_temp: latestTelemetry.air_temp,
              air_humidity: latestTelemetry.air_humidity,
              lux: latestTelemetry.lux,
              quality: latestTelemetry.quality,
              timestamp: latestTelemetry.timestamp,
            }
          : null,
        identity_state: node.is_activated ? "CLAIMED" : "INVENTORY",
        created_at: node.created_at,
        updated_at: node.updated_at,
      };
    });

    if (user.role === "ADMIN") {
      const existingNodeIds = new Set(nodes.map((n: any) => n.id));
      const identityWhere: any = {
        generation_state: { not: "RETIRED" },
        is_current: true,
      };
      if (existingNodeIds.size > 0) {
        identityWhere.device_id = { notIn: Array.from(existingNodeIds) };
      }
      const unassignedIdentities = await prisma.deviceIdentity.findMany({
        where: identityWhere,
        orderBy: [{ updated_at: "desc" }],
      });

      for (const identity of unassignedIdentities) {
        formatted.push({
          id: identity.device_id,
          serial_number: identity.serial_number,
          name: identity.model || identity.device_id,
          type: identity.type,
          deployment_mode: identity.type === "GATEWAY" ? "GATEWAY" : "LEAF_NODE",
          capabilities: identity.capabilities,
          gateway_id: null,
          gateway: null,
          is_activated: false,
          online: false,
          rssi: null,
          firmware_version: null,
          last_seen: null,
          latitude: null,
          longitude: null,
          farm: null,
          zone: null,
          owner: null,
          latest_telemetry: null,
          identity_state: identity.state,
          created_at: identity.created_at,
          updated_at: identity.updated_at,
        });
      }
    }

    res.json({ success: true, data: formatted });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v1/nodes/:id/qr - Reopen the already-issued QR for an accessible device.
router.get("/:id/qr", authenticate, async (req: AuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  const deviceId = String(req.params.id || "").trim();
  if (!deviceId || deviceId.length > 128) {
    return res.status(400).json({ success: false, error: "Invalid device ID" });
  }
  try {
    const user = req.user!;
    const node = await prisma.node.findFirst({
      where: {
        id: deviceId,
        ...(user.role === "ADMIN" ? {} : {
          OR: [
            { owner_id: user.id },
            { farm: { user_farms: { some: { user_id: user.id } } } },
          ],
        }),
      },
      select: { id: true },
    });
    if (!node && (user.role !== "ADMIN" || !await prisma.deviceIdentity.findUnique({ where: { device_id: deviceId }, select: { device_id: true } }))) {
      return res.status(404).json({ success: false, error: "Device not found" });
    }
    const label = await prisma.deviceQrLabel.findUnique({ where: { device_id: deviceId }, include: { device: { select: { state: true } } } });
    if (!label) return res.json({ success: true, data: null });
    const inactive = label.state === DeviceQrLabelState.REVOKED || label.state === DeviceQrLabelState.QUARANTINED ||
      label.device.state === DeviceIdentityState.REVOKED || label.device.state === DeviceIdentityState.QUARANTINED;
    const payload = inactive ? null : qrPayloadForLabel(label);
    return res.json({ success: true, data: {
      qrId: label.qr_id,
      deviceId: label.device_id,
      state: inactive ? (label.device.state === DeviceIdentityState.REVOKED ? DeviceQrLabelState.REVOKED : DeviceQrLabelState.QUARANTINED) : label.state,
      payload,
    } });
  } catch {
    return res.status(500).json({ success: false, error: "Cannot load device QR" });
  }
});

// POST /api/v1/nodes/claim - Người dùng thêm & kích hoạt Node / Gateway vào trang trại của mình
router.post("/claim", authenticate, async (req: AuthRequest, res) => {
  try {
    if (!legacyProvisioningEnabled()) {
      return res.status(410).json({ success: false, error: "Legacy v2 claim is disabled; use manufacturing QR v3" });
    }
    const user = req.user!;
    const { nodeId, serialNumber, name, farmId, zoneId, gatewayId, latitude, longitude, claimCode, type = "SENSOR_NODE" } = req.body;

    if (!nodeId && !serialNumber) {
      return res.status(400).json({ success: false, error: "Vui lòng cung cấp Mã Node (ID) hoặc Số Serial của thiết bị" });
    }

    if (!farmId) {
      return res.status(400).json({ success: false, error: "Vui lòng chọn Trang trại (Farm) để gán thiết bị" });
    }

    // Kiểm tra quyền sở hữu Farm của User
    if (user.role !== "ADMIN") {
      const userFarm = await prisma.userFarm.findUnique({
        where: {
          user_id_farm_id: { user_id: user.id, farm_id: farmId },
        },
      });

      if (!userFarm) {
        return res.status(403).json({
          success: false,
          error: "Bạn chỉ có thể thêm thiết bị vào Trang trại thuộc quyền sở hữu của chính mình!",
        });
      }
    }

    const targetId = (nodeId || serialNumber).trim();
    const targetSerial = serialNumber ? String(serialNumber).trim() : targetId;

    const relationError = await validateNodeRelations(farmId, zoneId, type === "GATEWAY" ? null : gatewayId, targetId);
    if (relationError) {
      return res.status(400).json({ success: false, error: relationError });
    }

    // XÁC THỰC NGHIÊM NGẶT: Kiểm tra xem thiết bị có thuộc hệ thống xuất xưởng Supabase hay không
    let existingNode = await prisma.node.findFirst({
      where: {
        OR: [
          { id: targetId },
          { serial_number: targetSerial },
        ],
      },
    });

    const identity = await prisma.deviceIdentity.findFirst({
      where: {
        OR: [
          { device_id: targetId },
          { serial_number: targetSerial },
        ],
      },
    });

    // Nếu mã thiết bị KHÔNG tồn tại trong cả Node lẫn Identity -> Từ chối kích hoạt
    if (!existingNode && !identity) {
      return res.status(404).json({
        success: false,
        error: `Mã thiết bị "${targetId}" không tồn tại trong hệ thống FarmOS! Vui lòng kiểm tra lại tem số Serial hoặc liên hệ Quản trị viên (Admin) để đăng ký thiết bị vào hệ thống.`,
      });
    }

    if (identity?.state === DeviceIdentityState.REVOKED || identity?.state === DeviceIdentityState.QUARANTINED) {
      return res.status(409).json({ success: false, error: `Thiết bị này đã bị ${identity.state === DeviceIdentityState.REVOKED ? "thu hồi" : "cách ly"}` });
    }
    if (identity && !isLegacyIdentity(identity)) {
      return res.status(409).json({ success: false, error: "Identity is not an explicit legacy v2 device" });
    }
    // The legacy browser form must not turn a public device ID/serial into
    // ownership. QR onboarding proves possession with the factory claim code;
    // keep the same proof for this compatibility endpoint.
    if (identity && !matchesDeviceSecret(`claim:${identity.device_id}`, identity.claim_code_hash, String(claimCode || "").trim())) {
      return res.status(401).json({ success: false, error: "Thiếu hoặc sai mã sở hữu trên QR thiết bị" });
    }
    if (!identity && user.role !== "ADMIN") {
      return res.status(404).json({ success: false, error: "Thiết bị chưa có factory identity để kích hoạt" });
    }
    const requestedType = type === "GATEWAY" ? "GATEWAY" : "SENSOR_NODE";
    if (identity && identity.type !== requestedType) {
      return res.status(400).json({ success: false, error: "Loại thiết bị không khớp factory identity" });
    }
    if (identity?.claimed_by_id && identity.claimed_by_id !== user.id && user.role !== "ADMIN") {
      return res.status(400).json({
        success: false,
        error: `Thiết bị (${targetSerial}) đã được kích hoạt bởi tài khoản khác. Vui lòng liên hệ Quản trị viên!`,
      });
    }

    // Nếu node đã được người khác kích hoạt
    if (existingNode?.is_activated && existingNode.owner_id && existingNode.owner_id !== user.id && user.role !== "ADMIN") {
      return res.status(400).json({
        success: false,
        error: `Thiết bị "${existingNode.name || targetId}" (${existingNode.serial_number || targetId}) đã được kích hoạt bởi tài khoản khác. Vui lòng liên hệ Quản trị viên!`,
      });
    }

    const actualId = existingNode?.id || identity!.device_id;
    const actualSerial = targetSerial || existingNode?.serial_number || identity!.serial_number;
    const effectiveGatewayId = requestedType === "GATEWAY"
      ? null
      : gatewayId !== undefined
        ? (gatewayId || null)
        : (existingNode?.farm_id === farmId ? existingNode?.gateway_id || null : null);
    const deploymentMode = requestedType === "GATEWAY"
      ? "GATEWAY"
      : effectiveGatewayId
        ? "LEAF_NODE"
        : "STANDALONE_NODE";
    const connectionMode = deploymentMode === "LEAF_NODE" ? NodeConnectionMode.LORA_GATEWAY : NodeConnectionMode.WIFI;

    // Xác thực thành công -> Kích hoạt và gán cho User trong 1 transaction đồng bộ
    const node = await prisma.$transaction(async (tx) => {
      const savedNode = await tx.node.upsert({
        where: { id: actualId },
        update: {
          name: name?.trim() || existingNode?.name || actualId,
          farm_id: farmId,
          zone_id: zoneId || (existingNode?.farm_id === farmId ? existingNode?.zone_id : null),
          gateway_id: effectiveGatewayId,
          owner_id: user.id,
          is_activated: true,
          type: requestedType,
          connection_mode: connectionMode,
          deployment_mode: deploymentMode,
          latitude: latitude !== undefined && latitude !== null ? parseFloat(latitude) : existingNode?.latitude,
          longitude: longitude !== undefined && longitude !== null ? parseFloat(longitude) : existingNode?.longitude,
          serial_number: actualSerial,
        },
        create: {
          id: actualId,
          serial_number: actualSerial,
          name: name?.trim() || actualId,
          farm_id: farmId,
          zone_id: zoneId || null,
          gateway_id: effectiveGatewayId,
          owner_id: user.id,
          is_activated: true,
          type: requestedType,
          connection_mode: connectionMode,
          deployment_mode: deploymentMode,
          latitude: latitude !== undefined && latitude !== null ? parseFloat(latitude) : null,
          longitude: longitude !== undefined && longitude !== null ? parseFloat(longitude) : null,
        },
        include: { farm: true, zone: true, gateway: true },
      });

      if (identity) {
        await tx.deviceIdentity.update({
          where: { device_id: identity.device_id },
          data: {
            state: "CLAIMED",
            claimed_by_id: user.id,
            claimed_farm_id: farmId,
            claimed_at: new Date(),
          },
        });
      }

      return savedNode;
    });

    res.status(200).json({
      success: true,
      message: "Xác thực mã hợp lệ và kích hoạt thiết bị thành công!",
      data: node,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/v1/nodes/:id/location - Cập nhật tọa độ GPS / cấu hình của Node
router.patch("/:id/location", authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { latitude, longitude, zoneId, gatewayId, name } = req.body;
    const user = req.user!;

    const node = await prisma.node.findUnique({
      where: { id },
      include: {
        farm: {
          include: { user_farms: true },
        },
      },
    });

    if (!node) {
      return res.status(404).json({ success: false, error: "Không tìm thấy thiết bị Node" });
    }

    const isOwner = node.owner_id === user.id || (node.farm?.user_farms.some((uf) => uf.user_id === user.id) ?? false);
    if (user.role !== "ADMIN" && !isOwner) {
      return res.status(403).json({ success: false, error: "Bạn không có quyền chỉnh sửa thiết bị này" });
    }

    if (zoneId || gatewayId) {
      if (!node.farm_id) {
        return res.status(400).json({ success: false, error: "Thiết bị chưa được gán vào trang trại" });
      }
      const relationError = await validateNodeRelations(node.farm_id, zoneId, gatewayId, node.id);
      if (relationError) {
        return res.status(400).json({ success: false, error: relationError });
      }
    }

    const updated = await prisma.node.update({
      where: { id },
      data: {
        ...(latitude !== undefined && { latitude: parseFloat(latitude) }),
        ...(longitude !== undefined && { longitude: parseFloat(longitude) }),
        ...(zoneId !== undefined && { zone_id: zoneId || null }),
        ...(gatewayId !== undefined && { gateway_id: gatewayId || null }),
        ...(name && { name }),
      },
      include: { farm: true, zone: true, gateway: true },
    });

    res.json({
      success: true,
      message: "Cập nhật thông tin thiết bị thành công!",
      data: updated,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Account release and the physical BOOT reset are independent operations.
router.post("/:id/unbind", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT device_id FROM device_identities WHERE device_id = ${id} FOR UPDATE`;
      const node = await tx.node.findUnique({
        where: { id },
        select: { owner_id: true, is_activated: true },
      });
      if (!node) return { status: 404, error: "Không tìm thấy thiết bị" };
      if (user.role !== "ADMIN" && node.owner_id !== user.id) {
        return { status: 403, error: "Bạn không có quyền hủy liên kết thiết bị này" };
      }
      if (!node.is_activated) return { status: 409, error: "Thiết bị chưa được kích hoạt" };
      const identity = await tx.deviceIdentity.findUnique({ where: { device_id: id }, select: { state: true, identity_version: true, batch_id: true, is_current: true, generation_state: true } });
      if (!identity) return { status: 409, error: "Thiết bị chưa có factory identity" };
      if (!identity.is_current || identity.generation_state !== "ACTIVE" || identity.state === DeviceIdentityState.REVOKED || identity.state === DeviceIdentityState.QUARANTINED) {
        return { status: 409, error: `Không thể gỡ identity đang ở trạng thái ${identity.state}` };
      }
      await releaseDeviceAccount(tx, id, identity, { forcedBy: user.id });
      return { status: 200, data: { status: "APPLIED", boardConfirmed: false } };
    });
    if (result.error) return res.status(result.status).json({ success: false, error: result.error });
    return res.status(result.status).json({ success: true, data: result.data });
  } catch (error: any) {
    const status = /Invalid device lifecycle transition/.test(error?.message || "") ? 409 : 500;
    return res.status(status).json({ success: false, error: error.message });
  }
});

router.get("/release-commands/:commandId", authenticate, async (req: AuthRequest, res: Response) => {
  const command = await prisma.deviceLifecycleCommand.findUnique({ where: { id: req.params.commandId }, include: { device: { select: { claimed_by_id: true } } } });
  if (!command || (req.user!.role !== "ADMIN" && command.requested_by_id !== req.user!.id && command.device.claimed_by_id !== req.user!.id)) {
    return res.status(404).json({ success: false, error: "Không tìm thấy lệnh gỡ" });
  }
  if (["PENDING", "ACKNOWLEDGED"].includes(command.status) && command.expires_at <= new Date()) {
    await prisma.deviceLifecycleCommand.updateMany({
      where: { id: command.id, status: { in: ["PENDING", "ACKNOWLEDGED"] }, expires_at: { lte: new Date() } },
      data: { status: "EXPIRED" },
    });
    const current = await prisma.deviceLifecycleCommand.findUnique({ where: { id: command.id } });
    if (!current) return res.status(404).json({ success: false, error: "Không tìm thấy lệnh gỡ" });
    return res.json({ success: true, data: { commandId: current.id, status: current.status, expiresAt: current.expires_at } });
  }
  return res.json({ success: true, data: { commandId: command.id, status: command.status, expiresAt: command.expires_at } });
});

// DELETE /api/v1/nodes/:id - Xóa vĩnh viễn thiết bị khỏi hệ thống (Admin only).
// Phục vụ xóa thiết bị trong kho xuất xưởng (chưa kích hoạt), board thử nghiệm,
// hoặc board phế liệu / hỏng không còn tồn tại trên thực địa.
router.delete("/:id", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    if (user.role !== "ADMIN") {
      return res.status(403).json({ success: false, error: "Chỉ Quản trị viên mới có quyền xóa vĩnh viễn thiết bị khỏi hệ thống" });
    }

    const node = await prisma.node.findUnique({
      where: { id },
      include: {
        farm: {
          include: { user_farms: true },
        },
      },
    });

    const currentIdentity = await prisma.deviceIdentity.findUnique({
      where: { device_id: id },
      select: { hardware_board_id: true },
    });

    if (!node && !currentIdentity) {
      return res.status(404).json({ success: false, error: "Không tìm thấy thiết bị cần xóa" });
    }

    await prisma.$transaction(async (tx) => {
      const identities = currentIdentity?.hardware_board_id
        ? await tx.deviceIdentity.findMany({ where: { hardware_board_id: currentIdentity.hardware_board_id }, select: { device_id: true } })
        : currentIdentity ? [{ device_id: id }] : [];
      const identityIds = Array.from(new Set([id, ...identities.map((item) => item.device_id)]));

      // Hủy mọi phiên truy cập, claim, pairing của thiết bị
      await invalidateDeviceAccess(tx, id, "Device permanently deleted by administrator");

      // Dọn dẹp dữ liệu đo đạc lịch sử và sự kiện ingest cũ
      await tx.telemetryData.deleteMany({ where: { node_id: { in: identityIds } } });
      await tx.ingestEvent.deleteMany({ where: { node_id: { in: identityIds } } });

      // Nếu là gateway, gỡ liên kết gateway khỏi các node con
      await tx.node.updateMany({ where: { gateway_id: { in: identityIds } }, data: { gateway_id: null } });

      // Xóa phiên làm việc gateway & pairing
      await tx.gatewayCredential.deleteMany({ where: { gateway_id: { in: identityIds } } });
      await tx.gatewayProvisioningSession.deleteMany({ where: { gateway_id: { in: identityIds } } });
      await tx.pairingSession.deleteMany({ where: { OR: [{ node_id: { in: identityIds } }, { gateway_id: { in: identityIds } }] } });
      await tx.nodeGatewayBinding.deleteMany({ where: { OR: [{ node_id: { in: identityIds } }, { gateway_id: { in: identityIds } }] } });

      // Xóa các bảng có ràng buộc Restrict tới DeviceIdentity
      await tx.deviceLifecycleCommand.deleteMany({ where: { device_id: { in: identityIds } } });
      await tx.deviceQrRevocation.deleteMany({ where: { device_id: { in: identityIds } } });
      await tx.deviceIdentityKeyRevocation.deleteMany({ where: { device_id: { in: identityIds } } });

      if (currentIdentity?.hardware_board_id) {
        await tx.flashJob.deleteMany({ where: { OR: [{ source_device_id: { in: identityIds } }, { hardware_board_id: currentIdentity.hardware_board_id }] } });
      } else {
        await tx.flashJob.deleteMany({ where: { source_device_id: { in: identityIds } } });
      }

      // Xóa các bảng cascade khác của DeviceIdentity
      await tx.deviceClaimSession.deleteMany({ where: { device_id: { in: identityIds } } });
      await tx.deviceQrLabel.deleteMany({ where: { device_id: { in: identityIds } } });
      await tx.deviceLifecycleEvent.deleteMany({ where: { device_id: { in: identityIds } } });

      // Xóa OTA jobs & events của node
      await tx.otaEvent.deleteMany({ where: { device_id: { in: identityIds } } });
      await tx.otaUpdateJob.deleteMany({ where: { device_id: { in: identityIds } } });

      // Xóa bản ghi Node
      await tx.node.deleteMany({ where: { id: { in: identityIds } } });

      // Xóa bản ghi DeviceIdentity
      await tx.deviceIdentity.deleteMany({ where: { device_id: { in: identityIds } } });

      // Xóa HardwareBoard nếu không còn bất kỳ identity nào khác tham chiếu
      if (currentIdentity?.hardware_board_id) {
        const remaining = await tx.deviceIdentity.count({ where: { hardware_board_id: currentIdentity.hardware_board_id } });
        if (remaining === 0) {
          await tx.hardwareBoardAudit.deleteMany({ where: { hardware_board_id: currentIdentity.hardware_board_id } });
          await tx.hardwareBoard.deleteMany({ where: { id: currentIdentity.hardware_board_id } });
        }
      }
    });

    const displayName = node?.name || id;
    res.json({ success: true, message: `Đã xóa vĩnh viễn thiết bị ${displayName} khỏi hệ thống.` });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
