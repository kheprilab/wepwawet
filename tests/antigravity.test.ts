import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentFilePaths, emitTemplateAgent, hasAgentFormat, modelPatterns } from "../src/agents.js";
import { runCompile } from "../src/compile.js";
import { runComprehensionEnable } from "../src/comprehension.js";
import { detectTargets } from "../src/detect.js";
import { runDoctor } from "../src/doctor.js";
import { pathExists } from "../src/fs-utils.js";
import { runHook } from "../src/hook/index.js";
import { runTraceDisable, runTraceEnable, runTraceStatus } from "../src/hook/install.js";
import { normalizePayload } from "../src/hook/payload.js";
import { runTraceReport } from "../src/hook/report.js";
import { parseTrace } from "../src/hook/trace.js";
import { runImplEnable } from "../src/impl.js";
import { runInit } from "../src/init.js";
import { runJudgeEnable } from "../src/judge.js";
import { runRemove } from "../src/remove.js";
import { runTask } from "../src/task.js";
import { targets } from "../src/types.js";
import { runUpgrade } from "../src/upgrade.js";
import { tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("antigravity target (AC-1..AC-10)", () => {
  describe("AC-1: registry and detection", () => {
    it("registers antigravity in targets and AgentTarget", () => {
      expect(targets).toContain("antigravity");
      expect(hasAgentFormat("antigravity")).toBe(true);
    });

    it("does not detect antigravity from GEMINI.md alone and behaves as no setup in non-interactive init", async () => {
      await writeFile(path.join(tmp, "GEMINI.md"), "# Gemini CLI instructions\n", "utf8");

      const detection = await detectTargets(tmp);
      expect(detection.detected).toEqual([]);
      expect(detection.evidence.antigravity).toEqual([]);

      await expect(runInit({ cwd: tmp, nonInteractive: true })).rejects.toThrow(/No agent setup detected/);
    });

    it("detects antigravity from its own signals without false-positives on codex files", async () => {
      await writeFile(path.join(tmp, "AGENTS.md"), "# Codex\n", "utf8");
      await mkdir(path.join(tmp, ".agents/skills"), { recursive: true });
      const codexOnly = await detectTargets(tmp);
      expect(codexOnly.detected).toEqual(["codex"]);

      await writeFile(path.join(tmp, "GEMINI.md"), "# Antigravity\n", "utf8");
      await mkdir(path.join(tmp, ".agents/agents"), { recursive: true });
      const both = await detectTargets(tmp);
      expect(both.detected).toContain("codex");
      expect(both.detected).toContain("antigravity");
      expect(both.evidence.antigravity).toEqual([".agents/agents"]);
    });
  });

  describe("AC-2: init, doctor, upgrade, compile, and protected GEMINI.md", () => {
    it("installs GEMINI.md, skills, target reference, and judge agent; preserves existing GEMINI.md", async () => {
      await writeFile(path.join(tmp, "GEMINI.md"), "# Custom project rules\n", "utf8");

      const init = await runInit({ cwd: tmp, target: "antigravity", nonInteractive: true });
      expect(init.selectedTargets).toEqual(["antigravity"]);
      expect(await readFile(path.join(tmp, "GEMINI.md"), "utf8")).toBe("# Custom project rules\n");
      expect(await pathExists(path.join(tmp, "GEMINI.wep.suggested.md"))).toBe(true);
      expect(await pathExists(path.join(tmp, ".agents/skills/wep-task/SKILL.md"))).toBe(true);
      expect(await pathExists(path.join(tmp, ".agents/agents/wep-judge.md"))).toBe(true);

      const targetRef = await readFile(path.join(tmp, ".wep/targets/antigravity.md"), "utf8");
      expect(targetRef).toContain("ask_question");
      expect(targetRef).toContain("GEMINI.md");
      expect(targetRef).toContain("after-run check");

      const doctor = await runDoctor({ cwd: tmp });
      expect(doctor.installedTargets).toEqual(["antigravity"]);
      expect(doctor.missing).toEqual([]);

      await runTask("Verify compile", { cwd: tmp });
      const compiled = await runCompile("TASK-001", { cwd: tmp, target: "antigravity" });
      expect(compiled.outputPath).toContain("antigravity.md");

      const upgrade = await runUpgrade({ cwd: tmp });
      expect(upgrade.conflicts).toEqual([]);
    });

    it("does not report a target as installed in doctor when its exclusive files are absent", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      expect((await runDoctor({ cwd: tmp })).installedTargets).toEqual(["codex"]);

      // Removing AGENTS.md leaves only shared .agents/skills, so neither codex nor antigravity is falsely reported.
      await rm(path.join(tmp, "AGENTS.md"));
      expect((await runDoctor({ cwd: tmp })).installedTargets).toEqual([]);
    });
  });

  describe("AC-3: safe remove when coexisting with codex", () => {
    it("preserves shared .agents/skills when removing antigravity while codex remains installed", async () => {
      await runInit({ cwd: tmp, target: "codex,antigravity", nonInteractive: true });
      expect(await pathExists(path.join(tmp, ".agents/skills/wep-task/SKILL.md"))).toBe(true);
      expect(await pathExists(path.join(tmp, ".agents/agents/wep-judge.md"))).toBe(true);

      const removed = await runRemove({ cwd: tmp, target: "antigravity", force: true });
      expect(removed.protected).toContain("GEMINI.md");
      expect(await pathExists(path.join(tmp, "GEMINI.md"))).toBe(true);
      expect(await pathExists(path.join(tmp, ".agents/agents/wep-judge.md"))).toBe(false);
      // Shared skills stay because codex is still installed
      expect(await pathExists(path.join(tmp, ".agents/skills/wep-task/SKILL.md"))).toBe(true);
    });

    it("removes shared .agents/skills when antigravity is the only installed target", async () => {
      await runInit({ cwd: tmp, target: "antigravity", nonInteractive: true });
      const removed = await runRemove({ cwd: tmp, target: "antigravity", force: true });
      expect(removed.protected).toContain("GEMINI.md");
      expect(await pathExists(path.join(tmp, ".agents/skills/wep-task/SKILL.md"))).toBe(false);
      expect(await pathExists(path.join(tmp, ".agents/agents/wep-judge.md"))).toBe(false);
    });
  });

  describe("AC-4: subagent definitions and template agents", () => {
    it("emits judge, implementer, comprehension, and template agents with official Antigravity tool names", async () => {
      await runInit({ cwd: tmp, target: "antigravity", nonInteractive: true });
      await runImplEnable({ cwd: tmp });
      await runComprehensionEnable({ cwd: tmp });

      expect(agentFilePaths.judge.antigravity).toBe(".agents/agents/wep-judge.md");
      expect(agentFilePaths.implementer.antigravity).toBe(".agents/agents/wep-implementer.md");
      expect(agentFilePaths.comprehension.antigravity).toBe(".agents/agents/wep-comprehension.md");

      const judge = await readFile(path.join(tmp, ".agents/agents/wep-judge.md"), "utf8");
      expect(judge).toContain("name: wep-judge");
      expect(judge).toContain("subagent: true");
      expect(judge).toContain("mainAgent: false");
      expect(judge).toContain("tools: [view_file, find_file, run_command]");

      const impl = await readFile(path.join(tmp, ".agents/agents/wep-implementer.md"), "utf8");
      expect(impl).toContain("name: wep-implementer");
      expect(impl).toContain("subagent: true");
      expect(impl).toContain("mainAgent: false");
      expect(impl).toContain("tools: [view_file, find_file, create_file, edit_file, run_command]");

      const comp = await readFile(path.join(tmp, ".agents/agents/wep-comprehension.md"), "utf8");
      expect(comp).toContain("name: wep-comprehension");
      expect(comp).toContain("subagent: true");
      expect(comp).toContain("mainAgent: false");
      expect(comp).toContain("tools: [view_file, find_file, run_command]");
      expect(comp).toMatch(/independent thread|separate thread/i);

      const emitted = emitTemplateAgent("security-reviewer", "# Security Reviewer\n\nAudit diffs.", "antigravity");
      expect(Object.keys(emitted)).toEqual([".agents/agents/security-reviewer.md"]);
      expect(emitted[".agents/agents/security-reviewer.md"]).toContain("subagent: true");
      expect(emitted[".agents/agents/security-reviewer.md"]).toContain("mainAgent: false");
      expect(emitted[".agents/agents/security-reviewer.md"]).toContain(
        "tools: [view_file, find_file, create_file, edit_file, run_command]",
      );

      expect(modelPatterns.antigravity.pattern.test("gemini-2.5-pro")).toBe(true);
      expect(modelPatterns.antigravity.pattern.test("flash")).toBe(true);
      expect(modelPatterns.antigravity.pattern.test("inherit")).toBe(true);
      expect(modelPatterns.antigravity.pattern.test("not a valid model!")).toBe(false);
    });
  });

  describe("AC-5, AC-6, AC-7: trace hooks, payload normalization, and Stop completeness", () => {
    it("wires and unwires wep-trace in .agents/hooks.json while preserving foreign hooks", async () => {
      await runInit({ cwd: tmp, target: "antigravity", nonInteractive: true });
      await mkdir(path.join(tmp, ".agents"), { recursive: true });
      await writeFile(
        path.join(tmp, ".agents/hooks.json"),
        JSON.stringify({ "user-linter": { Stop: [{ type: "command", command: "./lint.sh" }] } }, null, 2),
        "utf8",
      );

      const enabled = await runTraceEnable({ cwd: tmp });
      expect(enabled.wiredTargets).toContain("antigravity");
      const hooks = JSON.parse(await readFile(path.join(tmp, ".agents/hooks.json"), "utf8"));
      expect(hooks["user-linter"]).toBeDefined();
      expect(hooks["wep-trace"]).toBeDefined();
      expect(hooks["wep-trace"].SessionStart).toHaveLength(1);
      expect(hooks["wep-trace"].PreToolUse[0].matcher).toBe("*");
      expect(hooks["wep-trace"].PostToolUse[0].matcher).toBe("*");
      expect(hooks["wep-trace"].Stop).toHaveLength(1);

      const status = await runTraceStatus({ cwd: tmp });
      expect(status.wiredTargets).toContain("antigravity");

      await runTraceDisable({ cwd: tmp });
      const afterDisable = JSON.parse(await readFile(path.join(tmp, ".agents/hooks.json"), "utf8"));
      expect(afterDisable["wep-trace"]).toBeUndefined();
      expect(afterDisable["user-linter"]).toBeDefined();
    });

    it("normalizes Antigravity payloads, classifies GEMINI.md, emits stdout JSON, and completes on Stop", async () => {
      await runInit({ cwd: tmp, target: "antigravity", nonInteractive: true });
      await runTraceEnable({ cwd: tmp });

      const normalized = normalizePayload("PreToolUse", {
        conversationId: "conv-123",
        cwd: tmp,
        hookEventName: "PreToolUse",
        toolCall: {
          id: "call-1",
          name: "edit_file",
          args: { Path: path.join(tmp, "GEMINI.md") },
        },
      });
      expect(normalized.sessionId).toBe("conv-123");
      expect(normalized.toolName).toBe("edit_file");
      expect(normalized.callId).toBe("call-1");
      expect(normalized.toolInput).toEqual({ Path: path.join(tmp, "GEMINI.md") });

      const startRes = await runHook(
        "SessionStart",
        JSON.stringify({ conversationId: "conv-123", cwd: tmp, hookEventName: "SessionStart" }),
        tmp,
        { host: "antigravity" },
      );
      expect(startRes.recorded).toBe(true);

      const preRes = await runHook(
        "PreToolUse",
        JSON.stringify({
          conversationId: "conv-123",
          cwd: tmp,
          hookEventName: "PreToolUse",
          toolCall: { id: "call-1", name: "edit_file", args: { Path: path.join(tmp, "GEMINI.md") } },
        }),
        tmp,
        { host: "antigravity" },
      );
      expect(preRes.body).toEqual({ decision: "allow" });

      const postRes = await runHook(
        "PostToolUse",
        JSON.stringify({
          conversationId: "conv-123",
          cwd: tmp,
          hookEventName: "PostToolUse",
          toolCall: { id: "call-1", name: "edit_file", args: { Path: path.join(tmp, "GEMINI.md") } },
        }),
        tmp,
        { host: "antigravity" },
      );
      expect(postRes.body).toEqual({});

      await runHook(
        "PreToolUse",
        JSON.stringify({
          conversationId: "conv-123",
          cwd: tmp,
          hookEventName: "PreToolUse",
          toolCall: { id: "call-2", name: "run_command", args: { CommandLine: "pnpm test" } },
        }),
        tmp,
        { host: "antigravity" },
      );
      await runHook(
        "PostToolUse",
        JSON.stringify({
          conversationId: "conv-123",
          cwd: tmp,
          hookEventName: "PostToolUse",
          toolCall: { id: "call-2", name: "run_command", args: { CommandLine: "pnpm test" } },
        }),
        tmp,
        { host: "antigravity" },
      );

      await runHook(
        "Stop",
        JSON.stringify({
          conversationId: "conv-123",
          cwd: tmp,
          hookEventName: "Stop",
          terminationReason: "NO_TOOL_CALL",
        }),
        tmp,
        { host: "antigravity" },
      );

      const rawTrace = await readFile(path.join(tmp, ".wep/local/traces/conv-123.jsonl"), "utf8");
      const parsed = parseTrace("conv-123", rawTrace);
      expect(parsed.complete).toBe(true);
      expect(parsed.observations.find((o) => o.callId === "call-1")?.area).toBe("harness");
      expect(parsed.observations.find((o) => o.callId === "call-2")?.commandHead).toBe("pnpm");

      // Non-antigravity trace ending in stop remains incomplete
      const claudeStop = rawTrace.replace('"host":"antigravity"', '"host":"claude"');
      expect(parseTrace("conv-123", claudeStop).complete).toBe(false);

      const report = await runTraceReport({ cwd: tmp });
      expect(report.sessions.filter((s) => s.complete)).toHaveLength(1);
    });
  });

  describe("AC-8: no judge run guard written into versioned .agents/hooks.json", () => {
    it("does not install a machine-pinned run guard into .agents/hooks.json when enabling judge", async () => {
      await runInit({ cwd: tmp, target: "antigravity", nonInteractive: true });
      const judgeRes = await runJudgeEnable({ cwd: tmp });

      expect(judgeRes.guard).toBeUndefined();
      expect(await pathExists(path.join(tmp, ".agents/hooks.json"))).toBe(false);
    });
  });
});
