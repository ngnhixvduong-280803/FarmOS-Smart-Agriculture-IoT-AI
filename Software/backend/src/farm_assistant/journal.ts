import { z } from 'zod';
export const categories = ['crop', 'pest', 'nutrition', 'task', 'expense', 'harvest'] as const;
const date = z.string().datetime({ offset: true });
export const journalInput = z.object({
  category: z.enum(categories), title: z.string().trim().min(1).max(160), notes: z.string().trim().max(2000).default(''),
  occurredAt: date.optional(), dueAt: date.optional(), amountVnd: z.number().int().min(0).max(2000000000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.amountVnd !== undefined && value.category !== 'expense') ctx.addIssue({ code: 'custom', message: 'Chi phí chỉ áp dụng cho mục chi phí.' });
  if (value.dueAt && value.category !== 'task') ctx.addIssue({ code: 'custom', message: 'Hạn thực hiện chỉ áp dụng cho công việc.' });
});
type Entry = { category: string; title: string; notes: string; occurred_at: Date; due_at: Date | null; amount_vnd: number | null };
export function summarizeJournal(entries: Entry[], now = Date.now()) {
  const currentMonth = new Date(now).toISOString().slice(0, 7);
  return {
    recentPests: entries.filter(e => e.category === 'pest').slice(0, 5),
    recentNutrition: entries.filter(e => e.category === 'nutrition').slice(0, 5),
    recentCrops: entries.filter(e => e.category === 'crop').slice(0, 5),
    tasks: entries.filter(e => e.category === 'task' && e.due_at && e.due_at.getTime() <= now + 7 * 86400_000).sort((a,b) => a.due_at!.getTime() - b.due_at!.getTime()).slice(0, 10),
    expenseMonthVnd: entries.filter(e => e.category === 'expense' && e.occurred_at.toISOString().slice(0, 7) === currentMonth).reduce((sum, e) => sum + (e.amount_vnd || 0), 0),
  };
}
