import { Router, Response } from "express";
import { Node, Prisma, PumpCommand } from "@prisma/client";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config/env";
import { prisma } from "../../database/prisma";
import { AuthRequest, authenticate } from "../middleware/auth.middleware";
import { GatewayRequest, requireGatewayAuth } from "../middleware/gateway-auth.middleware";

export const pumpWebRoutes = Router();
export const pumpDeviceRoutes = Router();
pumpWebRoutes.use(rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: "draft-7", legacyHeaders: false }));
pumpWebRoutes.use(authenticate);
pumpDeviceRoutes.use(requireGatewayAuth);

const RUN_SECONDS = 30;
const COMMAND_MS = 45_000;
const DELIVERY_HEADROOM_MS = 8000;
const READY_MS = 45_000;
const active = ["PENDING", "DELIVERED"];
const requestSchema = z.object({ on: z.boolean(), requestId: z.uuid() });
const resultSchema = z.object({
  feedbackOn: z.boolean(),
  error: z.enum(["INTERLOCK_OPEN", "FEEDBACK_MISMATCH", "OUTPUT_ERROR", "FEEDBACK_ALREADY_ON"]).nullable(),
});

function pumpCommandView(command: PumpCommand, now = new Date()) {
  const status = active.includes(command.status) && command.expires_at <= now ? "TIMEOUT" : command.status;
  return {
    id: command.id,
    on: command.turn_on,
    status,
    error: command.error_code,
    feedbackOn: command.feedback_on,
    confirmedAt: command.confirmed_at?.toISOString() ?? null,
  };
}

function eligible(node: Node) {
  return node.type === "SENSOR_NODE" && node.deployment_mode === "STANDALONE_NODE" &&
    node.connection_mode === "WIFI" && !node.farm_id?.startsWith("SIM_");
}

async function unavailable(tx: Prisma.TransactionClient, node: Node, now: Date) {
  if (!eligible(node)) return "UNSUPPORTED_DEVICE";
  if (!node.is_activated) return "DEVICE_INACTIVE";
  if (!env.PUMP_CONTROL_NODE_IDS.has(node.id)) return "NOT_COMMISSIONED";
  const identity = await tx.deviceIdentity.findUnique({ where: { device_id: node.id } });
  if (identity?.state !== "CLAIMED" || !identity.is_current || identity.generation_state !== "ACTIVE") return "DEVICE_INACTIVE";
  const releasing = await tx.deviceLifecycleCommand.findFirst({
    where: { device_id: node.id, type: "RELEASE_ACCOUNT", status: { in: ["PENDING", "ACKNOWLEDGED"] }, expires_at: { gt: now } },
  });
  if (releasing) return "DEVICE_RELEASING";
  if (!node.pump_ready_at || now.getTime() - node.pump_ready_at.getTime() > READY_MS) return "NO_DEVICE_RESPONSE";
  return null;
}

async function lockDevice(tx: Prisma.TransactionClient, nodeId: string) {
  await tx.$queryRaw`SELECT device_id FROM device_identities WHERE device_id = ${nodeId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${nodeId} FOR UPDATE`;
  return tx.node.findUnique({ where: { id: nodeId } });
}

function sendFailure(res: Response, status: number, code: string) {
  return res.status(status).json({ success: false, error: code });
}

pumpWebRoutes.get("/:nodeId", async (req: AuthRequest, res) => {
  const commandId = z.uuid().optional().safeParse(req.query.commandId);
  if (!commandId.success) return sendFailure(res, 400, "INVALID_COMMAND");
  try {
    const node = await prisma.node.findUnique({ where: { id: req.params.nodeId } });
    if (!node || (node.owner_id !== req.user!.id && req.user!.role !== "ADMIN")) return sendFailure(res, 404, "DEVICE_NOT_FOUND");
    const now = new Date();
    const [reason, command] = await Promise.all([
      unavailable(prisma, node, now),
      prisma.pumpCommand.findFirst({
        where: {
          node_id: node.id,
          id: commandId.data,
          ...(req.user!.role === "ADMIN" ? {} : { requested_by_id: req.user!.id }),
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      }),
    ]);
    if (commandId.data && !command) return sendFailure(res, 404, "COMMAND_NOT_FOUND");
    return res.json({ success: true, data: { reason, runSeconds: RUN_SECONDS, command: command ? pumpCommandView(command, now) : null } });
  } catch {
    return sendFailure(res, 503, "SERVER_UNAVAILABLE");
  }
});

pumpWebRoutes.post("/:nodeId", async (req: AuthRequest, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return sendFailure(res, 400, "INVALID_COMMAND");
  try {
    const result = await prisma.$transaction(async tx => {
      const node = await lockDevice(tx, req.params.nodeId);
      if (!node || (node.owner_id !== req.user!.id && req.user!.role !== "ADMIN")) return { code: "DEVICE_NOT_FOUND", status: 404 };
      const now = new Date();
      const { on, requestId } = parsed.data;
      const prior = await tx.pumpCommand.findUnique({ where: { id: requestId } });
      if (prior) {
        if (prior.node_id !== node.id || prior.requested_by_id !== req.user!.id || prior.turn_on !== on) return { code: "INVALID_COMMAND", status: 409 };
        return { command: prior };
      }
      const reason = await unavailable(tx, node, now);
      if (reason) return { code: reason, status: 409 };
      const inFlight = { node_id: node.id, status: { in: active }, expires_at: { gt: now } };
      if (await tx.pumpCommand.findFirst({ where: { ...inFlight, ...(on ? {} : { turn_on: false }) } })) {
        return { code: "COMMAND_IN_PROGRESS", status: 409 };
      }
      if (!on) {
        await tx.pumpCommand.updateMany({ where: { ...inFlight, turn_on: true }, data: { status: "CANCELLED" } });
      }
      const command = await tx.pumpCommand.create({
        data: {
          id: requestId, node_id: node.id, requested_by_id: req.user!.id, turn_on: on,
          created_at: now, expires_at: new Date(now.getTime() + COMMAND_MS),
        },
      });
      return { command };
    });
    if (!result.command) return sendFailure(res, result.status!, result.code!);
    return res.status(202).json({ success: true, data: pumpCommandView(result.command) });
  } catch {
    return sendFailure(res, 503, "SERVER_UNAVAILABLE");
  }
});

pumpDeviceRoutes.post("/next", async (req: GatewayRequest, res) => {
  const nodeId = req.gatewayId!;
  if (!env.PUMP_CONTROL_NODE_IDS.has(nodeId)) return res.json({ success: true, data: null });
  try {
    const data = await prisma.$transaction(async tx => {
      const node = await lockDevice(tx, nodeId);
      if (!node || !node.is_activated || !eligible(node)) return null;
      const now = new Date();
      if (!node.pump_ready_at || now.getTime() - node.pump_ready_at.getTime() >= 15_000) {
        await tx.node.update({ where: { id: nodeId }, data: { pump_ready_at: now } });
      }
      if (await unavailable(tx, { ...node, pump_ready_at: now }, now)) return null;
      const command = await tx.pumpCommand.findFirst({
        where: { node_id: nodeId, status: "PENDING", expires_at: { gt: new Date(now.getTime() + DELIVERY_HEADROOM_MS) } },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      });
      if (!command) return null;
      if (command.requested_by_id !== node.owner_id) {
        const requester = await tx.user.findUnique({ where: { id: command.requested_by_id }, select: { role: true } });
        if (requester?.role !== "ADMIN") {
          await tx.pumpCommand.update({ where: { id: command.id }, data: { status: "CANCELLED" } });
          return null;
        }
      }
      // Deliver ON once. An ambiguous delivery must never replay after reboot.
      await tx.pumpCommand.update({ where: { id: command.id }, data: { status: "DELIVERED" } });
      return { commandId: command.id, on: command.turn_on, runSeconds: RUN_SECONDS, expiresAt: command.expires_at };
    });
    if (!data) return res.json({ success: true, data: null });
    const { expiresAt, ...command } = data;
    return res.json({ success: true, data: { ...command, expiresInMs: Math.max(0, expiresAt.getTime() - Date.now()) } });
  } catch {
    return sendFailure(res, 503, "SERVER_UNAVAILABLE");
  }
});

pumpDeviceRoutes.post("/:id/result", async (req: GatewayRequest, res) => {
  const parsed = resultSchema.safeParse(req.body);
  if (!parsed.success || !z.uuid().safeParse(req.params.id).success) return sendFailure(res, 400, "INVALID_RESULT");
  try {
    const command = await prisma.pumpCommand.findFirst({ where: { id: req.params.id, node_id: req.gatewayId! } });
    if (!command) return sendFailure(res, 404, "COMMAND_NOT_FOUND");
    if (["CONFIRMED", "FAILED"].includes(command.status)) return res.json({ success: true });
    const now = new Date();
    const error = parsed.data.error ?? (parsed.data.feedbackOn !== command.turn_on ? "FEEDBACK_MISMATCH" : null);
    const updated = await prisma.pumpCommand.updateMany({
      where: { id: command.id, status: "DELIVERED", expires_at: { gt: now } },
      data: { status: error ? "FAILED" : "CONFIRMED", error_code: error, feedback_on: parsed.data.feedbackOn, confirmed_at: now },
    });
    if (!updated.count) return sendFailure(res, 409, "COMMAND_NO_LONGER_ACTIVE");
    return res.json({ success: true });
  } catch {
    return sendFailure(res, 503, "SERVER_UNAVAILABLE");
  }
});
