import { z } from "zod";

// Reject coercion (null -> 0, strings -> numbers) and unknown sensor-only packets.
export const gatewayTelemetrySchema = z.object({
  eventId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  nodeId: z.string().min(1).max(40),
  timestamp: z.number().finite().optional(),
  soil_temp: z.number().min(-55).max(125).optional(),
  air_temp: z.number().min(-55).max(125).optional(),
  soil_moisture: z.number().min(0).max(100).optional(),
  air_humidity: z.number().min(0).max(100).optional(),
  lux: z.number().min(0).max(200000).optional(),
  quality: z.number().int().min(0).max(255).default(1),
}).strict().refine(value => [value.soil_temp, value.air_temp, value.soil_moisture,
  value.air_humidity, value.lux].some(sensor => sensor !== undefined), "Missing sensor reading");
