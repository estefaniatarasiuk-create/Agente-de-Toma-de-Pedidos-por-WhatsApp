import IORedis from "ioredis";

const globalForRedis = globalThis as unknown as { redisConnection: IORedis | undefined };

// BullMQ necesita maxRetriesPerRequest: null en la conexión que usan
// Queue/Worker (si no, corta conexiones activas de forma inesperada).
export const redisConnection =
  globalForRedis.redisConnection ??
  new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redisConnection = redisConnection;
}
