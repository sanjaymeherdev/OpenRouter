// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { query } from "./db/index.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) console.warn("WARNING: OPENROUTER_API_KEY not set.");

// Excludes models that don't work with the chat/completions + tool-calling
// flow below (music/audio generation, content-safety classifiers).
const EXCLUDED_IDS = new Set([
  "google/lyria-3-clip-preview",
  "google/lyria-3-pro-preview",
  "nvidia/nemotron-3.5-content-safety:free",
]);

async function fetchFreeModelsLive() {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter models fetch failed: ${res.status}`);
  const data = await res.json();
  const all = data.data || [];

  return all
    .filter((m) => {
      if (EXCLUDED_IDS.has(m.id)) return false;
      const promptPrice = parseFloat(m.pricing?.prompt ?? "1");
      const completionPrice = parseFloat(m.pricing?.completion ?? "1");
      return promptPrice === 0 && completionPrice === 0;
    })
    .map((m) => ({
      id: m.id,
      name: m.name,
      context_length: m.context_length,
      input_modalities: m.architecture?.input_modalities || ["text"],
      output_modalities: m.architecture?.output_modalities || ["text"],
      supports_tools: (m.supported_parameters || []).includes("tools"),
      supports_reasoning: (m.supported_parameters || []).includes("reasoning"),
      description: (m.description || "").slice(0, 200),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

let cachedModels = null;
let modelsFetchTime = 0;
const MODELS_CACHE_TTL = 60 * 30; // 30 min — free model list changes often

async function getCachedModels() {
  const now = Date.now();
  if (cachedModels && now - modelsFetchTime < MODELS_CACHE_TTL * 1000) {
    return cachedModels;
  }
  try {
    cachedModels = await fetchFreeModelsLive();
    modelsFetchTime = now;
    return cachedModels;
  } catch (err) {
    console.error("Models fetch error:", err.message);
    if (cachedModels) {
      return cachedModels;
    }
    throw err;
  }
}

// ---------- Tool definitions (function calling demo) ----------
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

// ---------- Rate limiting via in-memory store (per-IP, fixed 60s window) ----------
const rateLimitStore = new Map();

async function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const key = `ratelimit:${ip}`;
  const now = Date.now();
  const windowMs = 60 * 1000; // 60 seconds
  const maxRequests = 15;

  let record = rateLimitStore.get(key);
  if (!record || now - record.startTime > windowMs) {
    record = { count: 1, startTime: now };
    rateLimitStore.set(key, record);
  } else {
    record.count++;
    if (record.count > maxRequests) {
      return res.status(429).json({ error: "Rate limit exceeded. Try again shortly." });
    }
  }
  next();
}

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now - record.startTime > 60 * 1000) {
      rateLimitStore.delete(key);
    }
  }
}, 60 * 1000);

// ---------- Routes ----------

// Full live list of free, chat-capable models (cached in-memory for 30min)
app.get("/api/models", async (req, res) => {
  try {
    const models = await getCachedModels();
    res.json(models);
  } catch (err) {
    console.error("Models fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// List all sessions (sidebar history), most recent first, with a derived title
app.get("/api/sessions", async (req, res) => {
  try {
    const result = await query(
      `SELECT s.id, s.model, s.created_at,
              (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id ASC LIMIT 1) AS title
       FROM sessions s
       ORDER BY s.created_at DESC
       LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new chat session
app.post("/api/sessions", async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: "model is required" });
  const id = uuidv4();
  try {
    await query("INSERT INTO sessions (id, model) VALUES ($1, $2)", [id, model]);
    res.json({ sessionId: id, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get message history for a session
app.get("/api/sessions/:id/messages", async (req, res) => {
  try {
    const result = await query(
      "SELECT role, content, created_at FROM messages WHERE session_id = $1 AND role != 'tool' ORDER BY id ASC",
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
    await query("INSERT INTO messages (session_id, role, content) VALUES ($1, 'user', $2)", [
      sessionId,
      message,
    ]);

    const historyResult = await query(
      "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id ASC",
      [sessionId]
    );
    let messages = historyResult.rows.map((r) => ({ role: r.role, content: r.content }));

    let finalReply = null;
    let lastRawResponse = null;
    let toolsUsed = [];

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
      lastRawResponse = data;
      if (!response.ok) {
        return res.status(response.status).json({ error: data });
      }

      const choice = data.choices?.[0];
      const msg = choice?.message;

      if (msg?.tool_calls?.length) {
        messages.push(msg);
        for (const call of msg.tool_calls) {
          const args = JSON.parse(call.function.arguments || "{}");
          const toolResult = runTool(call.function.name, args);
          toolsUsed.push({ name: call.function.name, args, result: toolResult });
          messages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
        }
        continue;
      }

      finalReply = msg?.content ?? "(no response)";
      break;
    }

    if (finalReply === null) finalReply = "(tool loop exceeded max iterations)";

    await query("INSERT INTO messages (session_id, role, content) VALUES ($1, 'assistant', $2)", [
      sessionId,
      finalReply,
    ]);

    res.json({ reply: finalReply, toolsUsed, raw: lastRawResponse });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
