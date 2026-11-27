import { request } from './api';
export type Finding = { agent: string; level: 'info' | 'warning'; title: string; detail: string; observedAt?: string };
export type AssistantReport = { generatedAt: string; nodesChecked: number; findings: Finding[]; limitations: string[]; summary: { irrigationCount: number; completed: number; failed: number; truncated: boolean } };
export type JournalCategory = 'crop' | 'pest' | 'nutrition' | 'task' | 'expense' | 'harvest';
export type JournalEntry = { id: string; category: JournalCategory; title: string; notes: string; occurred_at: string; due_at: string | null; amount_vnd: number | null };
export type JournalResult = { entries: JournalEntry[]; truncated: boolean; summary: { tasks: JournalEntry[]; expenseMonthVnd: number } };
const farmPath = (farmId: string) => encodeURIComponent(farmId);
export const farmAssistant = {
  report: (farmId: string) => request<AssistantReport>(`/farm-assistant/${farmPath(farmId)}`),
  journal: (farmId: string) => request<JournalResult>(`/farm-journal/${farmPath(farmId)}`),
  addJournal: (farmId: string, input: { category: JournalCategory; title: string; notes: string; dueAt?: string; amountVnd?: number }) => request<JournalEntry>(`/farm-journal/${farmPath(farmId)}`, { method: 'POST', body: JSON.stringify(input) }),
};

export type SimulationPlan = { reason: string; unresolved: boolean; rainMm: number; startsAt: number; fetchedAt: number; options: { delay: number | null; mm: number; dryHours: number; wetHours: number; trajectory: number[] }[] };
export type SimulationAgentSnapshot = {
  generatedAt: number;
  quality: string;
  irrigation: { action: string; reason: string };
  deviceHealth: { status: string };
  weather: { status: string; rainMm24h?: number; maxRainProbability?: number };
  irrigationFollowup: { status: string; requestedMm?: number; before?: number | null; after?: number | null };
  forecastSchedule: {
    lastCheck: { checkedAt: number } | null;
    plan24h: { result: { status: string; startsAt?: number; selected?: { delayHours: number | null; mm: number } } } | null;
    weekly: { forecast: {
      status: string; threshold?: number; firstBelowWithRain?: number | null; firstBelowWithoutRain?: number | null;
      trajectory?: { at: number; withRain: number; withoutRain: number }[];
    } } | null;
  };
};
export type SimulationNode = { agentSnapshot?: SimulationAgentSnapshot; nodeId: string; crop: string; soil: string; receivedAt: string; samples: number; moisture?: number; threshold?: number; usable: boolean; qualityReason?: string; recommendation: string; soilRecommendation?: string; weatherUnavailable?: boolean; wetEpisodes?: number; sensors?: { field: string; current: number | null; average: number | null; count: number }[]; rapidDrying?: { drop: number; typicalDrop: number }; wetNow?: { hours: number; threshold: number }; irrigationResponse?: { mm: number; before: number; after: number; loss?: number; status: string }; irrigationPlan?: SimulationPlan; tomorrowPlan?: SimulationPlan; models?: { horizon: number; testCount: number; candidates: { name: string; forecast: number; mae: number }[] } };
export type SimulationFarm = { id: string; name: string; nodes: SimulationNode[] };
export const getSimulationAnalysis = (farmId: string) => request<SimulationFarm | null>(`/simulation/farm-analysis?farmId=${encodeURIComponent(farmId)}`);

export const getAllSimulationAnalyses = () => request<SimulationFarm[]>('/simulation/analysis');
