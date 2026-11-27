import { Router, Response } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate, AuthRequest } from '../middleware/auth.middleware';
import { journalInput, summarizeJournal } from '../../farm_assistant/journal';
const router = Router();
router.use(authenticate);
async function accessible(req: AuthRequest) {
  return prisma.farm.findFirst({ where: { id: req.params.farmId, ...(req.user!.role === 'ADMIN' ? {} : { user_farms: { some: { user_id: req.user!.id } } }) }, select: { id: true } });
}
router.get('/:farmId', async (req: AuthRequest, res: Response) => {
  try {
    if (!await accessible(req)) return res.status(404).json({ success: false, error: 'Không tìm thấy trang trại.' });
    const entries = await prisma.farmJournalEntry.findMany({ where: { farm_id: req.params.farmId }, orderBy: { occurred_at: 'desc' }, take: 200 });
    const summary = summarizeJournal(entries);
    const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
    const expense = await prisma.farmJournalEntry.aggregate({ where: { farm_id: req.params.farmId, category: 'expense', occurred_at: { gte: month, lte: new Date() } }, _sum: { amount_vnd: true } });
    summary.expenseMonthVnd = expense._sum.amount_vnd || 0;
    return res.json({ success: true, data: { entries, summary, truncated: entries.length === 200 } });
  } catch { return res.status(503).json({ success: false, error: 'Không tải được nhật ký. Kiểm tra migration cơ sở dữ liệu.' }); }
});
router.post('/:farmId', async (req: AuthRequest, res: Response) => {
  try {
    if (!await accessible(req)) return res.status(404).json({ success: false, error: 'Không tìm thấy trang trại.' });
    const parsed = journalInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Thông tin nhật ký không hợp lệ.' });
    const x = parsed.data;
    const entry = await prisma.farmJournalEntry.create({ data: { farm_id: req.params.farmId, category: x.category, title: x.title, notes: x.notes, occurred_at: x.occurredAt ? new Date(x.occurredAt) : new Date(), due_at: x.dueAt ? new Date(x.dueAt) : null, amount_vnd: x.amountVnd ?? null, created_by: req.user!.id } });
    return res.status(201).json({ success: true, data: entry });
  } catch { return res.status(503).json({ success: false, error: 'Không lưu được nhật ký. Kiểm tra migration cơ sở dữ liệu.' }); }
});
export default router;
