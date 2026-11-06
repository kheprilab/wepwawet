import type { Profile, Target, WepConfig, WepPolicy } from "../types.js";
import { workflows } from "../types.js";
import { CLI_VERSION } from "../version.js";

export const doctorProjectWikiPages = [
  ".wep/wiki/architecture.md",
  ".wep/wiki/conventions.md",
  ".wep/wiki/testing.md",
  ".wep/wiki/decisions.md",
];

export function configTemplate(targets: Target[], profile: Profile = "default"): string {
  return JSON.stringify(defaultConfig(targets, profile), null, 2);
}

export function defaultConfig(targets: Target[], profile: Profile = "default"): WepConfig {
  const config: WepConfig = {
    version: 1,
    installedVersion: CLI_VERSION,
    profile,
    judge: { enabled: true, trigger: "post-implementation" },
    comprehensionGate: {
      enabled: false,
      trigger: "agent-assessed-significance",
      evaluationMode: "prefer-independent",
    },
    targets,
    templatePacks: [],
    sourceOfTruth: ".wep",
    createdBy: "wep",
    defaults: {
      target: targets[0],
      workflow: "task-fit",
      allowedWorkflows: [...workflows],
      requireTaskCapsule: true,
      requireWorkflowReason: true,
      contextBudget: "proportional",
    },
    workflowRules: {
      default: "task-fit",
      bugfix: "TDD",
      apiOrContract: "SDD+TDD",
      edgeCases: "SDD+EDD",
      ui: "UI review",
      smallSafePatch: "fast-patch",
      unknownArea: "research-first",
    },
  };

  if (profile === "strict" || profile === "regulated") {
    config.defaults.contextBudget = "thorough";
  }

  if (profile === "regulated") {
    config.workflowRules.smallSafePatch = "TDD";
    config.workflowRules.default = "research-first";
  }

  return config;
}

/** Ignores everything a directory holds while keeping the rule itself trackable. */
export const selfIgnoringDirectoryTemplate = "*\n!.gitignore\n";

/** Keeps personal comprehension responses out of version control by default. */
export const localComprehensionIgnoreTemplate = selfIgnoringDirectoryTemplate;

/** Keeps upgrade candidates, which are suggestions nobody accepted yet, out of the diff. */
export const upgradesIgnoreTemplate = selfIgnoringDirectoryTemplate;

export function policyTemplate(profile: Profile = "default"): string {
  return JSON.stringify(defaultPolicy(profile), null, 2);
}

export function defaultPolicy(profile: Profile = "default"): WepPolicy {
  const policy: WepPolicy = {
    version: 1,
    profile,
    mergeStrategy: "preserve-and-suggest",
    protectedFiles: ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", ".pi/README.md"],
    protectedFileMerge: {
      agentMayEdit: "after-explicit-human-approval",
      approvalScope: "current-conversation",
      requireDiffPreview: true,
    },
    blockedReadPatterns: [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "secrets/", "credentials/", "private/"],
    contextBudget: {
      rootInstructions: "minimal",
      loadWorkflowsOnDemand: true,
      doNotReadAllByDefault: true,
    },
    enforcement: {
      requireTaskCapsule: true,
      requireWorkflowReason: true,
      requireAcceptanceCriteria: true,
      requireReviewChecklist: true,
    },
    writePolicy: {
      doctor: [
        ".wep/wiki/agent-setup.md",
        ".wep/wiki/gaps.md",
        ".wep/wiki/recommendations.md",
        ".wep/wiki/instruction-audit.md",
        ...doctorProjectWikiPages,
        "AGENTS.wep.suggested.md",
        "CLAUDE.wep.suggested.md",
        ".github/copilot-instructions.wep.suggested.md",
      ],
      task: [".wep/tasks/TASK-XXX/"],
      compile: [".wep/tasks/TASK-XXX/exports/<target>.md"],
      decisions: [".wep/wiki/decisions.md"],
      implementationNotes: [".wep/local/impl/TASK-XXX/log.md"],
    },
  };

  if (profile === "strict" || profile === "regulated") {
    policy.blockedReadPatterns = [
      ...policy.blockedReadPatterns,
      ".npmrc",
      ".netrc",
      ".ssh/",
      "id_rsa",
      "id_dsa",
      "id_ecdsa",
      "id_ed25519",
    ];
  }

  if (profile === "regulated") {
    policy.blockedReadPatterns = [
      ...policy.blockedReadPatterns,
      "*.mobileprovision",
      "*.keystore",
      "*.jks",
      "*.asc",
      "*.gpg",
      "compliance/",
    ];
  }

  return {
    ...policy,
    blockedReadPatterns: Array.from(new Set(policy.blockedReadPatterns)),
  };
}
