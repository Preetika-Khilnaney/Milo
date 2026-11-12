// AI layer: an OpenAI-compatible chat-completions client with tool calling.
// Works with any OpenAI-compatible provider (Google Gemini, Groq, OpenAI, OpenRouter, local Ollama...).
// If no key is configured, a rule-based fallback keeps the demo usable and is labelled "offline".
const BASE_URL = (process.env.LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, "");
const API_KEY = process.env.LLM_API_KEY || "";
const MODEL = process.env.LLM_MODEL || "gemini-3.8-flash";
let currentModel = MODEL;
const model = () => currentModel;

// If the configured model doesn't exist for this key, ask the provider which models it has
// and pick a capable chat model automatically.
async function pickAvailableModel() {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${API_KEY}`, ...(BASE_URL.includes("googleapis.com") ? { "x-goog-api-key": API_KEY } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`could not list models (${res.status})`);
  const ids = ((await res.json()).data || []).map((m) => String(m.id).replace(/^models\//, ""));
  const usable = ids.filter((id) => !/(whisper|tts|guard|embed|audio|vision-only|moderation|image|playai|distil|prompt)/i.test(id));
  const prefs = [/llama-4.*maverick/i, /llama-4/i, /gpt-oss-120b/i, /llama.*70b/i, /qwen.*(32b|30b|235b)/i, /kimi/i, /gpt-oss/i, /llama/i, /qwen/i, /flash/i, /.*/];
  for (const re of prefs) {
    const hit = usable.find((id) => re.test(id));
    if (hit) return hit;
  }
  throw new Error("no usable chat models found for this key");
}

const enabled = () => Boolean(API_KEY);

async function chat(messages, opts = {}, retried = false) {
  try {
    return await chatOnce(messages, opts);
  } catch (e) {
    if (!retried && /\b404\b|model_not_found|does not exist|not found|no longer available/i.test(e.message)) {
      const next = await pickAvailableModel();
      if (next && next !== currentModel) {
        console.log(`  [ai] model "${currentModel}" is not available; switching to "${next}". Set LLM_MODEL=${next} in .env to make this permanent.`);
        currentModel = next;
        return chat(messages, opts, true);
      }
    }
    throw e;
  }
}

async function chatOnce(messages, { tools, json = false, temperature = 0.2 } = {}) {
  const body = { model: currentModel, messages, temperature };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (json) body.response_format = { type: "json_object" };
  // Gemini "thinking" models: keep thinking short so replies come back quickly
  if (BASE_URL.includes("googleapis.com") && process.env.LLM_REASONING !== "default") body.reasoning_effort = process.env.LLM_REASONING || "low";
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      ...(BASE_URL.includes("googleapis.com") ? { "x-goog-api-key": API_KEY } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 45000)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  return j.choices[0].message;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
  }
  return null;
}

module.exports = { chat, enabled, parseJson, model, BASE_URL, get MODEL() { return currentModel; } };
