// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { getRedis } from "./redisClient.js";
import { query } from "./db/index.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) console.warn("WARNING: OPENROUTER_API_KEY not set.");

const MODELS_CACHE_KEY = "openrouter:free_models";
const MODELS_CACHE_TTL = 60 * 60; // 1 hour

const FREE_MODELS = {
  "meta-llama/llama-3.3-70b-instruct:free": "Llama 3.3 70B (general)",
  "openai/gpt-oss-120b:free": "GPT-OSS 120B (reasoning/coding)",
  "qwen/qwen3-coder:free": "Qwen3 Coder 480B (coding)",
  "cohere/north-mini-code:free": "North Mini Code (fast coding)",
  "nvidia/nemotron-3-ultra-550b-a55b:free": "Nemotron 3 Ultra (1M context)",
  "nvidia/nemotron-nano-12b-v2-vl:free": "Nemotron Nano VL (vision)",
  "nousresearch/hermes-3-llama-3.1-405b:free": "Hermes 3 405B (open-ended)",
};

// ---------- Simple tool definitions (function calling demo) ----------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluate a basic arithmetic expression.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "e.g. '12 * (3 + 4)'" },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current server time in ISO format.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function runTool(name, args) {
  if (name === "calculator") {
    try {
      // eslint-disable-next-line no-new-func
      const result = Function(`"use strict"; return (${args.expression});`)();
      return String(result);
    } catch (e) {
      return `Error evaluating expression: ${e.message}`;
    }
  }
  if (name === "get_current_time") {
    return new Date().toISOString();
  }
  return `Unknown tool: ${name}`;
}

// ---------- Rate limiting via Redis (per-IP, sliding window-ish) ----------
async function rateLimit(req, res, next) {
  try {
    const redis = await getRedis();
    const ip = req.ip || "unknown";
    const key = `ratelimit:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60); // 60s window
    if (count > 15) {
      return res.status(429).json({ error: "Rate limit exceeded. Try again shortly." });
    }
    next();
  } catch (err) {
    console.error("Rate limit check failed (allowing request):", err.message);
    next();
  }
}

// ---------- Routes ----------

app.get("/api/models", async (req, res) => {
  try {
    const redis = await getRedis();
    const cached = await redis.get(MODELS_CACHE_KEY);
    if (cached) return res.json(JSON.parse(cached));
    await redis.set(MODELS_CACHE_KEY, JSON.stringify(FREE_MODELS), { EX: MODELS_CACHE_TTL });
    res.json(FREE_MODELS);
  } catch (err) {
    res.json(FREE_MODELS); // fallback if redis is down
  }
});

// Create a new chat session
app.post("/api/sessions", async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: "model is required" });
  const id = uuidv4();
  try {
    await query("INSERT INTO sessions (id, model) VALUES ($1, $2)", [id, model]);
    res.json({ sessionId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get history for a session
app.get("/api/sessions/:id/messages", async (req, res) => {
  try {
    const result = await query(
      "SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY id ASC",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Main chat endpoint with tool-calling loop + persistence
app.post("/api/chat", rateLimit, async (req, res) => {
  const { sessionId, model, message } = req.body;
  if (!sessionId || !model || !message) {
    return res.status(400).json({ error: "sessionId, model, and message are required" });
  }

  try {
    // Persist user message
    await query("INSERT INTO messages (session_id, role, content) VALUES ($1, 'user', $2)", [
      sessionId,
      message,
    ]);

    // Rebuild conversation history for context
    const historyResult = await query(
      "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id ASC",
      [sessionId]
    );
    let messages = historyResult.rows.map((r) => ({ role: r.role, content: r.content }));

    // Tool-calling loop (max 3 iterations to avoid infinite loops)
    let finalReply = null;
    for (let i = 0; i < 3; i++) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "HTTP-Referer": "https://railway.app",
          "X-Title": "Free Model App",
        },
        body: JSON.stringify({ model, messages, tools: TOOLS }),
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ error: data });
      }

      const choice = data.choices?.[0];
      const msg = choice?.message;

      if (msg?.tool_calls?.length) {
        // Model wants to call a tool. Append its tool-call message, then tool results.
        messages.push(msg);
        for (const call of msg.tool_calls) {
          const args = JSON.parse(call.function.arguments || "{}");
          const toolResult = runTool(call.function.name, args);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolResult,
          });
        }
        continue; // loop again so the model can use the tool result
      }

      finalReply = msg?.content ?? "(no response)";
      break;
    }

    if (finalReply === null) finalReply = "(tool loop exceeded max iterations)";

    await query("INSERT INTO messages (session_id, role, content) VALUES ($1, 'assistant', $2)", [
      sessionId,
      finalReply,
    ]);

    res.json({ reply: finalReply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
