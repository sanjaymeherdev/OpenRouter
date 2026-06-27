// redisClient.js
// Railway's Redis plugin provides REDIS_URL automatically when you add the
// Redis service to the same project and reference it in your env vars.
import { createClient } from "redis";
import dotenv from "dotenv";
dotenv.config();

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const redisClient = createClient({ url: redisUrl });

redisClient.on("error", (err) => console.error("Redis error:", err));

let connected = false;
let connectPromise = null;

export async function getRedis() {
  if (!connected) {
    if (!connectPromise) {
      connectPromise = redisClient.connect().catch((err) => {
        console.warn("Redis connection failed, proceeding without caching:", err.message);
        connected = true; // Mark as "done trying" so we don't retry endlessly
        return null;
      });
    }
    await connectPromise;
  }
  return redisClient;
}
