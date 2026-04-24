// server/routes/text-chunk.ts
//
// Paid text-chunk route. One HTTP request = one paid chunk of ~32 tokens.
// The buyer calls this N times per session. Server is stateless across
// requests — the buyer sends cumulative text-so-far and server continues
// Claude's generation from it via assistant-prefill.
//
// Payment shape:
//   POST /chunk/text
//   Headers: PAYMENT-SIGNATURE: <base64>   (added by buyer's GatewayClient.pay)
//   Body:    { sessionId, prompt, textSoFar, chunkIndex, maxTokens }
//   Response 200: { text, tokensGenerated, finishReason }
//
// The Circle Gateway middleware handles the full x402 protocol: if the
// header is missing or the signature invalid, it replies 402. The buyer's
// GatewayClient auto-retries with a signed authorization. We never touch
// the signature or the 402 response; that's all the SDK.
//
// IMPORTANT: Anthropic rejects an assistant-prefill message that ends with
// trailing whitespace ("final assistant content cannot end with trailing
// whitespace"). Claude's generated text commonly ends with a space or
// newline because it paused mid-word. We trimEnd() on the prefill before
// sending. We do NOT mutate the text we return to the buyer, so their
// cumulative text preserves the original whitespace for display.

import type { Express, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../shared/config.js";

interface TextChunkBody {
  sessionId: string;
  prompt: string;
  textSoFar: string;
  chunkIndex: number;
  maxTokens?: number;
}

interface TextChunkResponse {
  text: string;
  tokensGenerated: number;
  finishReason: string;
}

export function mountTextChunk(
  app: Express,
  gateway: { require: (price: string) => any },
): void {
  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey! });
  const priceLabel = `$${env.pricePerChunkUsdc.toFixed(4)}`;

  app.post("/chunk/text", gateway.require(priceLabel), async (req: Request, res: Response) => {
    const body = req.body as TextChunkBody | undefined;
    if (!body || typeof body.prompt !== "string" || typeof body.textSoFar !== "string") {
      res.status(400).json({ error: "expected { sessionId, prompt, textSoFar, chunkIndex, maxTokens? }" });
      return;
    }

    const maxTokens = Math.min(body.maxTokens ?? env.chunkSizeTokens, env.chunkSizeTokens);

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: body.prompt },
    ];

    if (body.textSoFar.length > 0) {
      // Anthropic rule: assistant prefill cannot end with trailing whitespace.
      // Trim at the end only; leading whitespace is fine.
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
        messages,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[text-chunk] Anthropic call failed: ${msg}`);
      res.status(502).json({ error: `anthropic: ${msg}` });
      return;
    }

    const text = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const response: TextChunkResponse = {
      text,
      tokensGenerated: completion.usage.output_tokens,
      finishReason: completion.stop_reason ?? "unknown",
    };

    const payment = (req as any).payment;
    if (payment) {
      console.log(
        `[text-chunk ${body.chunkIndex}] ${response.tokensGenerated} tokens, ` +
        `paid by ${payment.payer?.slice(0, 10)}…, tx ${payment.transaction ?? "(pending)"}`,
      );
    }

    res.json(response);
  });

  console.log(`  POST /chunk/text — ${priceLabel} USDC per chunk (Anthropic ${env.anthropicModel})`);
}
