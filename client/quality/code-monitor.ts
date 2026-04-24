// client/quality/code-monitor.ts
//
// Deterministic code-quality oracle for Midstream.
//
// Flow for each assess() call on the cumulative code so far:
//
//   1. Balance pre-check. Count matched braces, parens, brackets, and
//      string quotes. If any are unbalanced, the code is "still being
//      written" — score 0.8 ("indeterminate, keep going"), skip tsc.
//      0.8 sits comfortably above the default 0.6 kill threshold so
//      partial code doesn't cause false-positive kills.
//
//   2. tsc --noEmit --strict in a temp dir. 10s timeout.
//      Fail → score 0.0 (the code is structurally done but won't compile).
//
//   3. node --test. 15s timeout.
//      All pass → score 1.0.
//      At least one fails → score 0.3 (compiles but logic wrong).
//
// The judge is the TypeScript compiler and Node's test runner. Deterministic,
// cheap, not gameable by any prose-shaping tricks.
//
// Scoring scale rationale:
//   0.0  — definitively broken (tsc fails on balanced code)
//   0.3  — compiles, tests fail (worth knowing, worth stopping over)
//   0.8  — indeterminate (above threshold, don't kill, keep going)
//   1.0  — definitively good (compiles AND tests pass, OR compiles with no tests yet)

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QualityMonitor, QualityContext } from "../../shared/types.js";
import type { QualityReport } from "../../shared/events.js";

// Score used for "code is still being written" — above default threshold.
const INDETERMINATE_SCORE = 0.8;

export class CodeQualityMonitor implements QualityMonitor {
  readonly name = "tsc-strict+node-test";
  readonly useCase = "code" as const;

  async assess(ctx: QualityContext): Promise<QualityReport> {
    if (ctx.cumulative.kind !== "code") {
      throw new Error(
        `CodeQualityMonitor requires cumulative.kind = "code", got "${ctx.cumulative.kind}"`,
      );
    }

    const code = ctx.cumulative.code;

    // --- Phase 0: balance pre-check -----------------------------------
    // If the code has unbalanced braces/parens/brackets/strings, it's still
    // in-progress. Return an indeterminate score so the kill gate doesn't
    // misfire on partial but valid code.
    const balance = checkBalance(code);
    if (!balance.balanced) {
      return {
        score: INDETERMINATE_SCORE,
        reasoning: `code appears incomplete: ${balance.reason}`,
        meta: {
          compiles: null,
          tests_pass: null,
          incomplete: true,
          balance_issue: balance.reason,
          length: code.length,
        },
        chunkIndex: ctx.chunkIndex,
        assessedAt: Date.now(),
      };
    }

    const dir = await mkdtemp(join(tmpdir(), "midstream-code-"));
    const file = join(dir, "out.ts");

    try {
      await writeFile(file, code, "utf-8");

      // --- Phase 1: compile ---------------------------------------------
      const tsc = await runTimed(
        "npx",
        [
          "--yes",
          "tsc",
          "--noEmit",
          "--strict",
          "--target",
          "es2022",
          "--module",
          "nodenext",
          "--moduleResolution",
          "nodenext",
          "--skipLibCheck",
          file,
        ],
        { timeoutMs: 10_000, cwd: dir },
      );

      if (!tsc.ok) {
        return {
          score: 0.0,
          reasoning: `tsc --strict failed: ${firstLine(tsc.stderr || tsc.stdout)}`,
          meta: {
            compiles: false,
            tests_pass: false,
            exit_code: tsc.code,
            timed_out: tsc.timedOut,
            diagnostic_count: countMatches(
              tsc.stdout + "\n" + tsc.stderr,
              /error TS\d+/g,
            ),
            length: code.length,
          },
          chunkIndex: ctx.chunkIndex,
          assessedAt: Date.now(),
        };
      }

      // --- Phase 2: run tests ------------------------------------------
      // --experimental-strip-types lets Node run .ts directly (Node 22.6+).
      // If the emitted code has no tests, node --test finds none and exits 0
      // — we treat that as "compiles, nothing to fail" = 1.0.
      const test = await runTimed(
        "node",
        ["--test", "--experimental-strip-types", file],
        { timeoutMs: 15_000, cwd: dir },
      );

      const testsPass = test.ok;
      const summary = parseNodeTestSummary(test.stdout);
      const score = testsPass ? 1.0 : 0.3;

      return {
        score,
        reasoning: testsPass
          ? summary.pass + summary.fail === 0
            ? "compiles; no tests present in this chunk yet"
            : `compiles and ${summary.pass}/${summary.pass + summary.fail} tests pass`
          : `compiles but ${summary.fail} test(s) failing: ${firstFailure(test.stdout)}`,
        meta: {
          compiles: true,
          tests_pass: testsPass,
          tests_summary: summary,
          timed_out: test.timedOut,
          length: code.length,
        },
        chunkIndex: ctx.chunkIndex,
        assessedAt: Date.now(),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Balance check — tell "incomplete" from "broken"
// ---------------------------------------------------------------------------

interface BalanceResult {
  balanced: boolean;
  reason: string;
}

function checkBalance(code: string): BalanceResult {
  // Walk the string tracking three counters plus a "string/comment" state.
  // We avoid counting braces inside strings, template literals, or comments.
  let braces = 0;
  let parens = 0;
  let brackets = 0;

  type State =
    | "code"
    | "single_string"
    | "double_string"
    | "template_string"
    | "line_comment"
    | "block_comment";
  let state: State = "code";

  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    const next = code[i + 1] ?? "";

    switch (state) {
      case "code":
        if (ch === "'") state = "single_string";
        else if (ch === '"') state = "double_string";
        else if (ch === "`") state = "template_string";
        else if (ch === "/" && next === "/") {
          state = "line_comment";
          i++;
        } else if (ch === "/" && next === "*") {
          state = "block_comment";
          i++;
        } else if (ch === "{") braces++;
        else if (ch === "}") braces--;
        else if (ch === "(") parens++;
        else if (ch === ")") parens--;
        else if (ch === "[") brackets++;
        else if (ch === "]") brackets--;
        break;

      case "single_string":
        if (ch === "\\") i++;
        else if (ch === "'") state = "code";
        else if (ch === "\n") return { balanced: false, reason: "unterminated single-quote string" };
        break;

      case "double_string":
        if (ch === "\\") i++;
        else if (ch === '"') state = "code";
        else if (ch === "\n") return { balanced: false, reason: "unterminated double-quote string" };
        break;

      case "template_string":
        // Template literals span newlines and can contain ${...} expressions.
        // For balance purposes we just wait for the closing backtick.
        if (ch === "\\") i++;
        else if (ch === "`") state = "code";
        break;

      case "line_comment":
        if (ch === "\n") state = "code";
        break;

      case "block_comment":
        if (ch === "*" && next === "/") {
          state = "code";
          i++;
        }
        break;
    }
  }

  if (state !== "code") {
    return { balanced: false, reason: `file ended inside ${state.replace("_", " ")}` };
  }
  if (braces !== 0) {
    return {
      balanced: false,
      reason: `brace mismatch (net ${braces > 0 ? "+" + braces + " unclosed {" : braces + " unexpected }"})`,
    };
  }
  if (parens !== 0) {
    return {
      balanced: false,
      reason: `paren mismatch (net ${parens > 0 ? "+" + parens + " unclosed (" : parens + " unexpected )"})`,
    };
  }
  if (brackets !== 0) {
    return {
      balanced: false,
      reason: `bracket mismatch (net ${brackets > 0 ? "+" + brackets + " unclosed [" : brackets + " unexpected ]"})`,
    };
  }

  // One more heuristic: if code is very short (< 50 chars) it's probably
  // only a few tokens and likely incomplete even if balanced.
  if (code.trim().length < 50) {
    return { balanced: false, reason: `too short (${code.trim().length} chars) to judge` };
  }

  return { balanced: true, reason: "balanced" };
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runTimed(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; cwd: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
      },
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, opts.timeoutMs);

    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
      });
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr, timedOut });
    });
  });
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").slice(0, 200);
}

function countMatches(s: string, r: RegExp): number {
  return (s.match(r) || []).length;
}

function parseNodeTestSummary(out: string): { pass: number; fail: number } {
  const pass = (out.match(/^ok /gm) || []).length;
  const fail = (out.match(/^not ok /gm) || []).length;
  return { pass, fail };
}

function firstFailure(out: string): string {
  const m = out.match(/not ok .+/);
  return m ? m[0].slice(0, 200) : "unknown failure";
}
