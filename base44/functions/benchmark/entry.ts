// Benchmark Harness API — server-side only.
//
// Every action is authorized against the benchmark's owner project through the platform's existing
// authorization path, so workspace/project isolation is enforced on the server and never in the UI.
// Nothing here returns a secret value: benchmark records only ever hold scrubbed text.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  createBenchmark, addBenchmarkTask, registerCandidate, getBenchmark, listBenchmarks,
  listBenchmarkTaskVersions, BENCHMARK_HARNESS_VERSION, RUNTIME_CONTRACT_VERSION,
} from "../../shared/benchmark.ts";
import {
  startBenchmark, advanceBenchmark, finalizeBenchmark, listResults, getAggregate, listFailures,
  FAILURE_CLASSES, UNSCORED_FAILURES,
} from "../../shared/benchmarkRun.ts";
import { evaluatorVersions } from "../../shared/evaluation.ts";
import { rewardPolicyVersions } from "../../shared/reward.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    // Harness metadata is public: versions and failure taxonomy, no benchmark data.
    if (action === "policies") {
      return Response.json({
        harness_version: BENCHMARK_HARNESS_VERSION, runtime_environment_version: RUNTIME_CONTRACT_VERSION,
        evaluator_versions: evaluatorVersions(), reward_policy_versions: rewardPolicyVersions(),
        failure_classes: FAILURE_CLASSES, unscored_failure_classes: UNSCORED_FAILURES,
      });
    }

    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });

    switch (action) {
      case "create": return Response.json(await createBenchmark(base44, user, body));
      case "add_task": return Response.json(await addBenchmarkTask(base44, user, body));
      case "register_candidate": return Response.json(await registerCandidate(base44, user, body));
      case "run": return Response.json(await startBenchmark(base44, user, body));
      case "advance": return Response.json(await advanceBenchmark(base44, user, body));
      case "finalize": return Response.json(await finalizeBenchmark(base44, user, body));
      case "get": return Response.json(await getBenchmark(base44, user, body));
      case "list": return Response.json(await listBenchmarks(base44, user, body));
      case "task_versions": return Response.json(await listBenchmarkTaskVersions(base44, user, body));
      case "results": return Response.json(await listResults(base44, user, body));
      case "aggregate": return Response.json(await getAggregate(base44, user, body));
      case "failures": return Response.json(await listFailures(base44, user, body));
      default: return Response.json({ error: `Unknown action: ${action}`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || "ERROR" }, { status: error.status || 500 });
  }
}