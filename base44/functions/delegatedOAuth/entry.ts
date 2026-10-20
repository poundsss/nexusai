// #31G — Authorized delegated OAuth endpoint for generated-app end users.
//
// A one-line wrapper: the entire request handler lives in shared/delegatedOAuthApi.ts so the
// certification suite (appConnectorParityTest) invokes the REAL endpoint contract in-process
// instead of a copy. Security notes, entitlement and fail-closed semantics are documented there.
import { handleDelegatedOAuth } from "../../shared/delegatedOAuthApi.ts";

export default async function (req) {
  return handleDelegatedOAuth(req);
}
