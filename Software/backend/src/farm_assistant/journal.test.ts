import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { journalInput, summarizeJournal } from './journal';
test('journal validation restricts fields to their category and rejects unknown fields', () => {
  assert.equal(journalInput.safeParse({ category: 'pest', title: 'Lá vàng', amountVnd: 1 }).success, false);
  assert.equal(journalInput.safeParse({ category: 'expense', title: 'Phân bón', amountVnd: 120000 }).success, true);
  assert.equal(journalInput.safeParse({ category: 'task', title: 'Tưới', dueAt: 'not-a-date' }).success, false);
  assert.equal(journalInput.safeParse({ category: 'crop', title: 'Ớt', farm_id: 'other' }).success, false);
});
test('summary includes due tasks and expenses, without turning observations into diagnoses', () => {
  const now = Date.parse('2026-11-18T00:00:00Z');
  const base = { notes: '', occurred_at: new Date(now), due_at: null, amount_vnd: null };
  const summary = summarizeJournal([{ ...base, category: 'pest', title: 'Đốm lá' }, { ...base, category: 'expense', title: 'Phân', amount_vnd: 50000 }, { ...base, category: 'task', title: 'Kiểm tra', due_at: new Date(now + 3600000) }], now);
  assert.equal(summary.expenseMonthVnd, 50000); assert.equal(summary.tasks[0].title, 'Kiểm tra'); assert.equal(summary.recentPests[0].title, 'Đốm lá');
});
