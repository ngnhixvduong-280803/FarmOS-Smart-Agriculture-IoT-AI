import { Response, Router } from "express";
import { prisma } from "../../database/prisma";
import { AuthRequest, authenticate, requireRole } from "../middleware/auth.middleware";
import { isNodeOnline } from "../../telemetry/node-presence";

const router = Router();
router.use(authenticate, requireRole(["ADMIN"]));

type AdminDeviceRow = {
  id: string;
  deviceId: string;
  serial: string | null;
  type: string;
  model: string | null;
  capabilities: string[];
  firmwareTarget: string | null;
  hardwareRevision: string | null;
  partitionScheme: string | null;
  identityState: string | null;
  generation: number | null;
  generationState: string | null;
  current: boolean | null;
  identityVersion: number | null;
  claimedById: string | null;
  claimedFarmId: string | null;
  source: "IDENTITY" | "LEGACY_NODE";
  hasIdentity: boolean;
  node: ReturnType<typeof nodeSummary> | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * GET /api/v1/admin/devices
 *
 * Returns one operational inventory row per current/non-retired identity, then
 * legacy Node rows that have no such identity.  Raw board keys, MACs, claim
 * hashes, public/private credentials, and retired generations are excluded.
 */
router.get("/", async (_req: AuthRequest, res: Response) => {
  try {
    const identities = await prisma.deviceIdentity.findMany({
      where: { generation_state: { not: "RETIRED" }, is_current: true },
      orderBy: [{ updated_at: "desc" }],
      select: {
        device_id: true, serial_number: true, type: true, model: true,
        capabilities: true, firmware_target: true, hardware_revision: true,
        partition_scheme: true, state: true, generation: true,
        generation_state: true, is_current: true, claimed_by_id: true,
        claimed_farm_id: true, identity_version: true, created_at: true, updated_at: true,
      },
    });
    // Keep a node whose only matching identity generation is retired from
    // being reintroduced as a misleading "legacy" row below.  Restrict this
    // lookup to returned node ids instead of scanning every identity row.
    const nodes = await prisma.node.findMany({
      select: {
        id: true, name: true, serial_number: true, farm_id: true, zone_id: true,
        owner_id: true, type: true, deployment_mode: true, capabilities: true,
        gateway_id: true, is_activated: true, online: true,
        rssi: true, firmware_version: true, last_seen: true, created_at: true,
        updated_at: true, farm: { select: { id: true, name: true } },
      },
      orderBy: [{ updated_at: "desc" }],
    });
    const nodeIds = nodes.map((node) => node.id);
    const allIdentityIds = new Set((nodeIds.length
      ? await prisma.deviceIdentity.findMany({ where: { device_id: { in: nodeIds } }, select: { device_id: true } })
      : []).map((identity) => identity.device_id));
    const rows = mergeAdminDevices(identities, nodes, allIdentityIds);
    return res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Không thể tải kho thiết bị" });
  }
});

function nodeSummary(node: any) {
  return {
    id: node.id,
    name: node.name,
    serial: node.serial_number,
    farmId: node.farm_id,
    farmName: node.farm?.name || null,
    zoneId: node.zone_id,
    ownerId: node.owner_id,
    type: node.type,
    deploymentMode: node.deployment_mode,
    gatewayId: node.gateway_id,
    isActivated: node.is_activated,
    online: isNodeOnline(node),
    rssi: node.rssi,
    firmwareVersion: node.firmware_version,
    lastSeen: node.last_seen,
    createdAt: node.created_at,
    updatedAt: node.updated_at,
  };
}

/** Pure merge used by the HTTP route and unit tests: current identities win,
 * matching operational Nodes are nested once, and retired identity ids cannot
 * leak back as legacy rows. */
export function mergeAdminDevices(identities: any[], nodes: any[], allIdentityIds: Iterable<string> = identities.map((identity) => identity.device_id)): AdminDeviceRow[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rows: AdminDeviceRow[] = identities.map((identity) => {
    const node = nodeById.get(identity.device_id);
    return {
      id: identity.device_id,
      deviceId: identity.device_id,
      serial: identity.serial_number,
      type: identity.type,
      model: identity.model,
      capabilities: identity.capabilities,
      firmwareTarget: identity.firmware_target,
      hardwareRevision: identity.hardware_revision,
      partitionScheme: identity.partition_scheme,
      identityState: identity.state,
      generation: identity.generation,
      generationState: identity.generation_state,
      current: identity.is_current,
      identityVersion: identity.identity_version,
      claimedById: identity.claimed_by_id,
      claimedFarmId: identity.claimed_farm_id,
      source: "IDENTITY",
      hasIdentity: true,
      node: node ? nodeSummary(node) : null,
      createdAt: identity.created_at,
      updatedAt: identity.updated_at,
    };
  });
  const seen = new Set(allIdentityIds);
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    rows.push({
      id: node.id,
      deviceId: node.id,
      serial: node.serial_number,
      type: node.type,
      model: null,
      capabilities: node.capabilities,
      firmwareTarget: null,
      hardwareRevision: null,
      partitionScheme: null,
      identityState: null,
      generation: null,
      generationState: null,
      current: null,
      identityVersion: null,
      claimedById: node.owner_id,
      claimedFarmId: node.farm_id,
      source: "LEGACY_NODE",
      hasIdentity: false,
      node: nodeSummary(node),
      createdAt: node.created_at,
      updatedAt: node.updated_at,
    });
  }
  rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return rows;
}

export default router;
