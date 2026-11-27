// Optional isolated API process for Docker E2E or an additive VPS sidecar.
// Shares the FarmOS database and auth contract, not its telemetry/scheduler process.
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import simulationRoutes from '../api/routes/simulation.routes';
import { prisma } from '../database/prisma';
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(rateLimit({ windowMs: 60000, limit: 300 }));
app.use('/api/v1/simulation', simulationRoutes);
app.get('/readyz', async (_req, res) => { try { await prisma.$queryRaw`SELECT 1`; res.json({ ready: true }); } catch { res.status(503).json({ ready: false }); } });
app.use((_req, res) => res.status(404).json({ success: false }));
app.use((error: any, _req: any, res: any, _next: any) => res.status(error?.status === 413 ? 413 : 500).json({ success: false, error: 'Simulation API error' }));
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('FarmOS simulation API ready'));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(async () => { await prisma.$disconnect(); process.exit(0); }));
