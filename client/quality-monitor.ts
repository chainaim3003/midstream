// client/quality-monitor.ts
//
// Buyer-side quality judge. Runs locally on the buyer (free to the
// transaction). Uses Gemini 3 Flash with Function Calling to return
// structured quality reports on each chunk's rolling window of text.
//
// The buyer's decision to keep signing authorizations (or stop) is based
// ENTIRELY on this module's output. There is no third-party evaluator, no
// paid judge. The buyer is in control.
//
// Google recommends Gemini 3 Flash for "transactional and payment agents"
// because it's low-latency, cheap, and good at structured output via
// Function Calling. See the hackathon sponsor page:
//   https://lablab.ai/ai-hackathons/nano-payments-arc

import { GoogleGenAI, Type } from '@google/genai';
import { env } from '../shared/config.js';
import type { QualityReport } from '../shared/events.js';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

// ---------------------------------------------------------------------------
// Function-calling schema — the judge MUST return this shape
// ---------------------------------------------------------------------------

const assessTool = {
  functionDeclarations: [
    {
      name: 'assess_research_chunk',
      description:
        'Assess whether a chunk of streamed research output stayed relevant to ' +
        'the original query, whether any cited sources appear plausible, and ' +
        'whether drift into an unrelated topic has occurred.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          relevance_score: {
            type: Type.NUMBER,
            description: 'Relevance to the original query on a scale of 0.0 to 1.0',
          },
          on_topic: {
            type: Type.BOOLEAN,
            description: 'True if the chunk is clearly on-topic',
          },
          citation_plausible: {
            type: Type.BOOLEAN,
            description: 'True if any sources cited look plausible (not fabricated)',
          },
          drift_detected: {
            type: Type.BOOLEAN,
            description: 'True if the content has drifted into a different subject area',
          },
          reasoning: {
            type: Type.STRING,
            description: 'Short (1-2 sentence) explanation of the score',
          },
        },
        required: ['relevance_score', 'on_topic', 'citation_plausible', 'drift_detected', 'reasoning'],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Assess a single chunk's rolling window
// ---------------------------------------------------------------------------

export async function assessChunk(args: {
  query: string;
  windowText: string;
  chunkIndex: number;
}): Promise<QualityReport> {
  const prompt = [
    `Original research query: "${args.query}"`,
    ``,
    `Most recent chunk of streamed research output (chunk index ${args.chunkIndex}):`,
    args.windowText.slice(0, 4000),
    ``,
    `Evaluate this chunk via the assess_research_chunk tool.`,
  ].join('\n');

  // TODO[verify]: exact @google/genai API shape. The SDK is evolving;
  // the call signature may differ slightly by version. See:
  //   https://ai.google.dev/gemini-api/docs/function-calling
  const resp = await ai.models.generateContent({
    model: env['GEMINI_MONITOR_MODEL' as keyof typeof env] as string ?? 'gemini-2.5-flash',
    contents: prompt,
    config: { tools: [assessTool] },
  });

  const calls = resp.functionCalls ?? [];
  if (calls.length === 0) {
    throw new Error('quality-monitor: Gemini returned no function call');
  }

  const call = calls[0];
  if (call.name !== 'assess_research_chunk') {
    throw new Error(`quality-monitor: unexpected function "${call.name}"`);
  }

  return call.args as QualityReport;
}

// ---------------------------------------------------------------------------
// Rolling-window state + kill decision
// ---------------------------------------------------------------------------

export interface MonitorState {
  query: string;
  threshold: number;      // e.g. 0.75
  windowSize: number;     // e.g. 3
  history: QualityReport[];
}

export function makeMonitorState(args: { query: string; threshold: number; windowSize: number }): MonitorState {
  return {
    query: args.query,
    threshold: args.threshold,
    windowSize: args.windowSize,
    history: [],
  };
}

export function updateRolling(state: MonitorState, report: QualityReport): number {
  state.history.push(report);
  const window = state.history.slice(-state.windowSize);
  const avg = window.reduce((s, r) => s + r.relevance_score, 0) / window.length;
  return avg;
}

export function shouldKill(state: MonitorState): { kill: boolean; reason: string } {
  if (state.history.length < Math.min(3, state.windowSize)) {
    return { kill: false, reason: 'warmup — too few chunks to judge yet' };
  }

  const window = state.history.slice(-state.windowSize);
  const avg = window.reduce((s, r) => s + r.relevance_score, 0) / window.length;

  if (avg < state.threshold) {
    return {
      kill: true,
      reason: `rolling relevance ${avg.toFixed(2)} below threshold ${state.threshold.toFixed(2)}`,
    };
  }

  // Hard drift signal in the most recent chunk
  const last = state.history[state.history.length - 1];
  if (last.drift_detected && last.relevance_score < state.threshold + 0.1) {
    return {
      kill: true,
      reason: `drift detected, last relevance ${last.relevance_score.toFixed(2)} too low to recover`,
    };
  }

  return { kill: false, reason: `rolling avg ${avg.toFixed(2)} above threshold` };
}
