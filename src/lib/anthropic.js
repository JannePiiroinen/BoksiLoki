// Keskitetty Anthropic-kutsu: mittaa keston, lukee token-käytön ja laskee kustannuksen.
// Hinnat luetaan ympäristömuuttujista (USD per miljoona tokenia), ei kovakoodata.

function envPrice(name) {
  const n = parseFloat(process.env[name] ?? "");
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Palauttaa null, jos hintoja ei ole asetettu - tokenit kirjataan silti.
export function estimateCostUsd(inputTokens, outputTokens) {
  const inputPrice = envPrice("PRICE_INPUT_PER_MTOK");
  const outputPrice = envPrice("PRICE_OUTPUT_PER_MTOK");
  if (inputPrice === null || outputPrice === null) return null;
  return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
}

export class AnthropicError extends Error {
  constructor(status, body) {
    super(`Anthropic API ${status}`);
    this.status = status;
    this.body = body;
  }
}

// Heittää AnthropicErrorin, jos API palauttaa virheen. Raakavirheteksti on vain palvelimen lokia varten.
export async function callClaude({ model, maxTokens, messages }) {
  const started = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
  });
  if (!res.ok) throw new AnthropicError(res.status, await res.text());

  const data = await res.json();
  const latencyMs = Date.now() - started;
  const text = (data.content || []).map((b) => b.text || "").join("");
  const usage = data.usage || {};
  return {
    text,
    usage,
    model: data.model || model,
    latencyMs,
    costUsd: estimateCostUsd(usage.input_tokens || 0, usage.output_tokens || 0),
  };
}

// callClaude-tulos recordUsageDetailsin odottamaan muotoon.
export function usageDetails(result) {
  return {
    model: result.model,
    inputTokens: result.usage.input_tokens ?? null,
    outputTokens: result.usage.output_tokens ?? null,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
  };
}

// Mallin vastaus JSON-objektiksi; poistaa mahdolliset ```json-aidat. Heittää, jos JSON on virheellistä.
export function parseClaudeJson(text) {
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}
