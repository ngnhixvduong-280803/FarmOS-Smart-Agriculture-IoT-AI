/** Operator-only provisioning of synthetic devices. No public provisioning bypass. */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createOpaqueToken, hashDeviceSecret } from '../security/device-secrets';
const args = process.argv.slice(2);
function arg(name: string) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
async function main() {
  const farmId = arg('--farm'); const email = arg('--owner-email'); const output = arg('--output'); const api = arg('--api');
  if (!farmId || !/^SIM_[A-Za-z0-9_-]{1,35}$/.test(farmId) || !email || !output || !api) throw new Error('Usage: --farm SIM_AGENT_LAB --owner-email existing-user --api https://cloud-origin --output /secure/.env.lab [--standalone] [--topology /path/scenario.json]');
  const origin = new URL(api);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol) || (origin.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('API phải là HTTPS origin; HTTP chỉ dùng cho local');
  const topologyFile = arg('--topology');
  const nodes = topologyFile ? JSON.parse(fs.readFileSync(topologyFile, 'utf8')).nodes as { id: string; gatewayId: string; zoneId: string; cropId: string }[] : [
    { id: 'SIM_NODE_01', gatewayId: 'SIM_GATEWAY_01', zoneId: 'SIM_ZONE_A', cropId: 'mustard-greens' },
    { id: 'SIM_NODE_02', gatewayId: 'SIM_GATEWAY_01', zoneId: 'SIM_ZONE_B', cropId: 'chilli' },
    { id: 'SIM_NODE_03', gatewayId: 'SIM_GATEWAY_01', zoneId: 'SIM_ZONE_C', cropId: 'tomato' },
  ];
  const standalone = args.includes('--standalone');
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 20 || nodes.some(n => !n || ![n.id, n.zoneId, ...(standalone ? [] : [n.gatewayId])].every(id => typeof id === 'string' && /^SIM_[A-Za-z0-9_-]{1,35}$/.test(id))) || new Set(nodes.map(n => n.id)).size !== nodes.length) throw new Error('Topology cần 1–20 node duy nhất, tất cả ID bắt đầu SIM_');
  if (standalone) for (const node of nodes) node.gatewayId = node.id;
  const gateways = standalone ? [] : [...new Set(nodes.map(n => n.gatewayId))];
  if (nodes.some(n => gateways.includes(n.id))) throw new Error('Gateway ID không được trùng node');
  const tokens = Object.fromEntries((standalone ? nodes.map(n => n.id) : gateways).map(id => [id, createOpaqueToken()]));
  const target = path.resolve(output); fs.mkdirSync(path.dirname(target), { recursive: true });
  // Reserve output first; never overwrite/lossily rotate an existing credential.
  const fd = fs.openSync(target, 'wx', 0o600);
  const db = new PrismaClient(); let committed = false;
  try {
    fs.writeFileSync(fd, `FARMOS_LAB_API_URL=${origin.origin}\nFARMOS_LAB_GATEWAY_TOKENS=${JSON.stringify(tokens)}\nFARMOS_LAB_CLOUD_MODE=dataset\n`);
    fs.fsyncSync(fd);
    await db.$transaction(async tx => {
      const owner = await tx.user.findUnique({ where: { email } });
      if (!owner) throw new Error('Owner phải là tài khoản FarmOS đã tồn tại');
      if (await tx.farm.findUnique({ where: { id: farmId } })) throw new Error('Farm đã tồn tại; từ chối sửa dữ liệu hiện có');
      const deviceIds = [...gateways, ...nodes.map(n => n.id)];
      if (await tx.node.count({ where: { id: { in: deviceIds } } }) || await tx.deviceIdentity.count({ where: { device_id: { in: deviceIds } } }) || await tx.gatewayCredential.count({ where: { gateway_id: { in: deviceIds } } })) throw new Error('Device ID đã tồn tại; chọn ID khác');
      await tx.farm.create({ data: { id: farmId, name: 'Phòng mô phỏng AI · ' + farmId, user_farms: { create: { user_id: owner.id } } } });
      for (const zoneId of new Set(nodes.map(n => n.zoneId))) await tx.zone.create({ data: { id: zoneId, farm_id: farmId, name: 'Mô phỏng · ' + zoneId, crop_type: nodes.find(n => n.zoneId === zoneId)!.cropId } });
      for (const id of deviceIds) {
        const isGateway = gateways.includes(id); const n = nodes.find(n => n.id === id);
        await tx.deviceIdentity.create({ data: { device_id: id, serial_number: id + '_' + farmId, type: isGateway ? 'GATEWAY' : 'SENSOR_NODE', claim_code_hash: hashDeviceSecret('simulation-claim:' + id, createOpaqueToken()), state: 'CLAIMED', claimed_by_id: owner.id, claimed_farm_id: farmId, claimed_at: new Date(), identity_version: 2, firmware_target: 'SIMULATION_ONLY', model: 'SYNTHETIC_LAB', capabilities: ['SIMULATION'] } });
        await tx.node.create({ data: { id, name: (isGateway ? 'Gateway mô phỏng ' : 'Node mô phỏng ') + id, serial_number: id + '_' + farmId, capabilities: ['SIMULATION'], firmware_version: 'simulation-1.0.0', farm_id: farmId, owner_id: owner.id, type: isGateway ? 'GATEWAY' : 'SENSOR_NODE', deployment_mode: isGateway ? 'GATEWAY' : standalone ? 'STANDALONE_NODE' : 'LEAF_NODE', connection_mode: isGateway || standalone ? 'WIFI' : 'LORA_GATEWAY', is_activated: true, ...(n ? { zone_id: n.zoneId, gateway_id: standalone ? undefined : n.gatewayId } : {}) } });
        if (isGateway || standalone) await tx.gatewayCredential.create({ data: { gateway_id: id, token_hash: hashDeviceSecret('gateway:' + id, tokens[id]) } });
        else await tx.nodeGatewayBinding.create({ data: { node_id: id, gateway_id: n!.gatewayId, farm_id: farmId, zone_id: n!.zoneId } });
      }
    });
    committed = true;
    console.log(`Created dedicated lab farm ${farmId}; credential file saved (0600). No secrets printed.`);
  } finally {
    fs.closeSync(fd); if (!committed) fs.unlinkSync(target); await db.$disconnect();
  }
}
main().catch(() => { console.error('Lab provisioning failed; existing data is preserved. Check arguments, unused SIM_ IDs, owner and database access.'); process.exitCode = 1; });
