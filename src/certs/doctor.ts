import type { Check, CheckResult, Severity } from "../host/checks.ts";
import { allCertTargets } from "./probe.ts";
import { testInstance } from "./test.ts";

const SEVERITY: Record<"info" | "warn" | "failed", Severity> = {
  info: "note",
  warn: "warn",
  failed: "fail",
};

/** Spec 5.7: doctor runs the same test as `cert test` for every Instance. */
export const certChecks: Check[] = [
  {
    id: "certificates",
    async run(ctx) {
      const results: CheckResult[] = [];
      for (const target of await allCertTargets(ctx)) {
        for (const found of await testInstance(ctx, target)) {
          const text = `${target.name}: ${found.text}`;
          if (found.mark === "done") results.push({ kind: "pass", label: text });
          else {
            results.push({ kind: "problem", severity: SEVERITY[found.mark], message: text });
          }
        }
      }
      return results;
    },
  },
];
