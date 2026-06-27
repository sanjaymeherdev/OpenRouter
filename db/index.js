// db/index.js
// Neon Postgres connection pool. Neon requires SSL.
import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL not set. Postgres features will fail.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Neon
  max: 5,
  idleTimeoutMillis: 30000,
});

export async function query(text, params) {
  const result = await pool.query(text, params);
  return result;
}
