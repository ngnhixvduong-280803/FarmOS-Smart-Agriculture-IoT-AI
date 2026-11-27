import { Router, Response } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate, AuthRequest } from '../middleware/auth.middleware';
import { buildReport } from '../../farm_assistant/report';
import { irrigationFollowup } from '../../farm_assistant/irrigation';

const router = Router();
router.use(authenticate);
router.get('/:farmId', async (req: AuthRequest, res: Response) => {
  try {
    const farm = await prisma.farm.findFirst({ where: { id: req.params.farmId, ...(req.user!.role === 'ADMIN' ? {} : { user_farms: { some: { user_id: req.user!.id } } }) }, select: { id: true, name: true } });
    if (!farm) return res.status(404).json({ success: false, error: 'Không tìm thấy trang trại.' });
    const [nodes, logs] = await Promise.all([
      prisma.node.findMany({ where: { farm_id: farm.id, is_activated: true, NOT: { capabilities: { has: 'SIMULATION' } } }, select: { id: true, name: true, zone_id: true, type: true, online: true, last_seen: true, telemetries: { where: { farm_id: farm.id, timestamp: { gte: new Date(Date.now() - 26 * 3600_000), lte: new Date() } }, orderBy: { timestamp: 'desc' }, take: 288, select: { timestamp: true, quality: true, soil_moisture: true } } } }),
      prisma.irrigationLog.findMany({ where: { zone: { farm_id: farm.id }, created_at: { gte: new Date(Date.now() - 24 * 3600_000) } }, orderBy: { created_at: 'desc' }, take: 30, select: { status: true, created_at: true, completed_at: true, zone_id: true, zone: { select: { name: true } } } }),
    ]);
    return res.json({ success: true, data: { farm, generatedAt: new Date().toISOString(), sourceType: 'physical', nodesChecked: nodes.length, findings: [...buildReport(nodes, logs), ...irrigationFollowup(logs, nodes)], summary: { irrigationCount: logs.length, completed: logs.filter(l => l.status === 'COMPLETED').length, failed: logs.filter(l => ['FAILED', 'TIMEOUT', 'REJECTED'].includes(l.status)).length, truncated: logs.length === 30 }, limitations: ['Báo cáo chưa đưa ra liều tưới hoặc chẩn đoán cây; so sánh sau tưới phụ thuộc dữ liệu cảm biến.', 'Thiết bị mô phỏng không được đưa vào báo cáo cảm biến thực.'] } });
  } catch { return res.status(503).json({ success: false, error: 'Không thể tạo báo cáo trang trại.' }); }
});
export default router;
