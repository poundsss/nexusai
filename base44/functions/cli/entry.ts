// THE NexusAI CLI's executable wrapper: one command per request.
//
//   POST { command, args, json }   or   POST { argv: ["push", "--project", "<id>", "--json"] }
//
// Answers `{ command, ok, exit_code, status, stdout, stderr }` with the command's HTTP status: the
// process-level contract (exit code, stdout channel, stderr channel) is decided in shared/cli.ts and
// only transported here. No command logic, authorization or error mapping lives in this file.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { runCli, runCliArgv } from "../../shared/cli.ts";

export const config = { method: "POST", description: "NexusAI CLI: init, link, pull, edit, push, types, sandbox, build, deploy, open, workflows (list/runs), logs." };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  const body = await req.json().catch(() => ({}));
  const out = Array.isArray(body.argv)
    ? await runCliArgv(base44, user, body.argv, body.args || {})
    : await runCli(base44, user, { command: body.command, args: body.args || {}, json: body.json !== false });
  const { result: _result, ...transport } = out;
  return Response.json(transport, { status: out.status });
}