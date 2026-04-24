// server/routes/code-chunk.ts
//
// Paid code-generation chunk route. Same request/response shape as
// text-chunk.ts — the only difference is the system prompt, which tells
// Claude to emit TypeScript (compilable, with tests) rather than prose.
//
// The buyer uses the same QualityMonitor interface with a different
// implementation (client/quality/code-monitor.ts) — the tsc+test oracle.
// Nothing structural changes between use cases on the server side except
// the prompt and the route path.
//
// See text-chunk.ts header for note about Anthropic's "assistant prefill
// cannot end with trailing whitespace" rule and the trimEnd() on prefill.

import type { Express, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../shared/config.js";

interface CodeChunkBody {
  sessionId: string;
  prompt: string;
  textSoFar: string;
  chunkIndex: number;
  maxTokens?: number;
}

interface CodeChunkResponse {
  text: string;
  tokensGenerated: number;
  finishReason: string;
}

const CODE_SYSTEM_PROMPT = [
  "You are a careful TypeScript code generator.",
  "Emit only TypeScript code. No prose, no Markdown fences, no explanatory",
  "commentary — the output will be written directly to a .ts file and compiled",
  "with `tsc --noEmit --strict`. Use ES2022+ syntax. Prefer standard library and",
  "node: imports. Where the user asks for a function, include a small test block",
  "that exercises it using node:test and node:assert/strict.",
].join(" ");

export function mountCodeChunk(
  app: Express,
  gateway: { require: (price: string) => any },
): void {
  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey! });
  const priceLabel = `$${env.pricePerChunkUsdc.toFixed(4)}`;

  app.post("/chunk/code", gateway.require(priceLabel), async (req: Request, res: Response) => {
    const body = req.body as CodeChunkBody | undefined;
    if (!body || typeof body.prompt !== "string" || typeof body.textSoFar !== "string") {
      res.status(400).json({ error: "expected { sessionId, prompt, textSoFar, chunkIndex, maxTokens? }" });
      return;
    }

    const maxTokens = Math.min(body.maxTokens ?? env.chunkSizeTokens, env.chunkSizeTokens);

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: body.prompt },
    ];

    if (body.textSoFar.length > 0) {
      const prefill = body.textSoFar.replace(/\s+$/u, "");
      if (prefill.length > 0) {
        messages.push({ role: "assistant", content: prefill });
      }
    }

    let completion: Anthropic.Message;
    try {
      completion = await anthropic.messages.create({
        model: env.anthropicModel,
        max_tokens: maxTokens,
        system: CODE_SYSTEM_PROMPT,
        messages,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[code-chunk] Anthropic call failed: ${msg}`);
      res.status(502).json({ error: `anthropic: ${msg}` });
      return;
    }

    const text = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const response: CodeChunkResponse = {
      text,
      tokensGenerated: completion.usage.output_tokens,
      finishReason: completion.stop_reason ?? "unknown",
    };

    const payment = (req as any).payment;
    if (payment) {
      console.log(
        `[code-chunk ${body.chunkIndex}] ${response.tokensGenerated} tokens, ` +
        `paid by ${payment.payer?.slice(0, 10)}…, tx ${payment.transaction ?? "(pending)"}`,
      );
    }

    res.json(response);
  });

  console.log(`  POST /chunk/code — ${priceLabel} USDC per chunk (Anthropic ${env.anthropicModel})`);
}
