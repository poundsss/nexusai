#!/usr/bin/env node
// NexusAI external iOS native build executor.
//
// A standalone, deployable worker that produces a GENUINE signed IPA from an existing published
// NexusAI artifact, by driving the certified `mobileNativeBuilder` boundary over HTTPS with
// WORKER_SECRET (the same trusted boundary the platform uses for claim/heartbeat/submit).
//
// This is the iOS counterpart of native-builder/android/worker.mjs. It reuses, UNCHANGED, every
// certified server-side contract: mobileNativeBuilder (claim/heartbeat/submit), mobileNativeMaterial
// (Apple signing material delivery — already platform-agnostic; resolves platform server-side from
// the build_id), mobileNativeUpload (private binary upload — already platform-agnostic), and the
// MobileBuild lifecycle. No endpoint, entity, schema, scheduler, or release contract is touched.
//
// What this worker does, per claimed build:
//   1. claim  — POST /functions/mobileNativeBuilder { action:"claim" }
//   2. material — POST /functions/mobileNativeMaterial { action:"material", build_id } → Apple credential
//   3. download the immutable source artifact's client_files (the published web bundle)
//   4. scaffold a real Capacitor iOS project from those files
//   5. xcodebuild archive + exportArchive → a genuine .ipa (App Store package)
//   6. verify the resulting package with codesign --verify
//   7. upload — POST /functions/mobileNativeUpload (multipart) → private file_uri
//   8. submit — POST /functions/mobileNativeBuilder { action:"submit", result:{artifact_uri,...} }
//
// Lease/heartbeat/recovery stay controlled by NexusAI: this worker only extends its lease via
// `heartbeat` and reports the outcome via `submit`. A crashed worker leaves an expiring lease
// that the queue reclaims as bounded recovery — the worker holds no durable state of its own.
//
// Prerequisites on the host: macOS with Xcode + Command Line Tools, Node.js 18+, and `npm`
// reachable for the Capacitor install. See README.md for the full setup.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";

const BASE = (process.env.NEXUSAI_BASE_URL || "https://fancy-file-flow-master.base44.app").replace(/\/$/, "");
const SECRET = process.env.WORKER_SECRET;
const WORKER_ID = process.env.WORKER_ID || `ios-${randomBytes(4).toString("hex")}`;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 120000);
const BUNDLE_ID = process.env.IOS_BUNDLE_ID || "com.base44.app";
const DISPLAY_NAME = process.env.IOS_DISPLAY_NAME || "NexusAI App";
const MIN_OS = process.env.IOS_MIN_OS_VERSION || "14.0";
const SINGLE_PASS = process.env.SINGLE_PASS === "1";

// ===================== Fail-closed startup guards =====================
if (platform() !== "darwin") {
  console.error("[fatal] The iOS worker must run on macOS (this host is " + platform() + ")");
  process.exit(2);
}
if (!SECRET) {
  console.error("[fatal] WORKER_SECRET is required");
  process.exit(2);
}
// Require Xcode + xcodebuild. `xcrun --find xcodebuild` fails non-zero when Xcode is absent.
const xcodeFind = spawnSync("xcrun", ["--find", "xcodebuild"], { stdio: "pipe", encoding: "utf8" });
if (xcodeFind.status !== 0 || xcodeFind.error) {
  console.error("[fatal] xcodebuild not found — install Xcode and run xcode-select --install");
  process.exit(2);
}

const jsonHeaders = { "x-worker-secret": SECRET, "Content-Type": "application/json" };

async function postJson(fn, body) {
  const res = await fetch(`${BASE}/functions/${fn}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.code = json.code; err.status = res.status; throw err;
  }
  return json;
}

async function claim() { return postJson("mobileNativeBuilder", { action: "claim", worker_id: WORKER_ID }); }
async function heartbeat(job_id, lease_token) { return postJson("mobileNativeBuilder", { action: "heartbeat", job_id, lease_token }); }
async function submit(job_id, lease_token, result) { return postJson("mobileNativeBuilder", { action: "submit", job_id, lease_token, result }); }
async function material(build_id) { return postJson("mobileNativeMaterial", { action: "material", build_id }); }

async function uploadIpa(build_id, ipaPath) {
  const buf = readFileSync(ipaPath);
  const form = new FormData();
  form.append("build_id", build_id);
  form.append("file", new Blob([buf], { type: "application/octet-stream" }), "app-release.ipa");
  const res = await fetch(`${BASE}/functions/mobileNativeUpload`, {
    method: "POST",
    headers: { "x-worker-secret": SECRET },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status}`); err.code = json.code; err.status = res.status; throw err;
  }
  return json;
}

function sha256File(p) {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
}

function run(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: "pipe", env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const e = new Error(`${cmd} ${args.join(" ")} exited ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
    e.code = "BUILD_STEP_FAILED"; throw e;
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

// Validate the delivered Apple credential shape. The certified contract stores the credential as
// opaque encrypted text in MOBILE_SIGNING_APPLE; the worker interprets its JSON shape. The
// observable Base44 fields are: issuer_id, key_id, team_id, private_key (the .p8 PEM), and a
// push_notifications toggle. The internal signing implementation (how the .p8 maps to a signing
// identity on the host) is UNKNOWN and may differ — this worker records the credential and drives
// xcodebuild's automatic signing with the host's installed developer identity, selected by team_id.
function parseAppleCredential(credentialText) {
  let cred;
  try { cred = JSON.parse(credentialText); }
  catch { throw Object.assign(new Error("The Apple signing credential is not valid JSON"), { code: "BAD_CREDENTIAL" }); }
  if (!cred.issuer_id || !cred.key_id || !cred.team_id || !cred.private_key) {
    throw Object.assign(new Error("The Apple signing credential is missing issuer_id/key_id/team_id/private_key"), { code: "BAD_CREDENTIAL" });
  }
  return cred;
}

// Scaffold a genuine Capacitor iOS project from the artifact's web bundle, build a real signed IPA
// with xcodebuild, and verify it with codesign. Everything happens in a disposable per-job temp dir.
async function buildSignedIpa(job, input, credentialText) {
  const work = join(tmpdir(), `nexusai-ios-${job.id}-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    // --- 1. Download the immutable source artifact payload ---
    const sourceUrl = input.source?.signed_url || input.source?.payload_url;
    if (!sourceUrl) throw Object.assign(new Error("The projection carried no source URL"), { code: "NO_SOURCE" });
    const pres = await fetch(sourceUrl);
    if (!pres.ok) throw Object.assign(new Error(`Source artifact fetch failed: ${pres.status}`), { code: "SOURCE_FETCH_FAILED" });
    const payload = await pres.json().catch(() => null);
    const files = Array.isArray(payload?.client_files) ? payload.client_files : [];
    if (!files.length) throw Object.assign(new Error("The pinned artifact has no client_files to package"), { code: "EMPTY_ARTIFACT" });

    // --- 2. Write the web bundle to www/ (Capacitor's webDir) ---
    const webDir = join(work, "www");
    await mkdir(webDir, { recursive: true });
    for (const f of files) {
      const rel = String(f.path || "").replace(/^\/+/, "");
      if (!rel || rel.includes("..")) continue; // path-traversal guard on artifact content
      const dest = join(webDir, rel);
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(dest, String(f.content ?? ""), "utf8");
    }
    if (!existsSync(join(webDir, "index.html"))) {
      await writeFile(join(webDir, "index.html"), '<!doctype html><meta http-equiv="refresh" content="0; url=./index.htm">', "utf8");
    }

    // --- 3. package.json + Capacitor config ---
    const displayName = input.release?.version_name ? `App ${input.release.version_name}` : DISPLAY_NAME;
    await writeFile(join(work, "package.json"), JSON.stringify({
      name: "nexusai-ios-shell",
      version: "1.0.0",
      private: true,
      dependencies: { "@capacitor/core": "^6", "@capacitor/ios": "^6" },
      devDependencies: { "@capacitor/cli": "^6" },
    }, null, 2));
    await writeFile(join(work, "capacitor.config.json"), JSON.stringify({
      appId: BUNDLE_ID,
      appName: displayName,
      webDir: "www",
      bundledWebRuntime: false,
      ios: { contentInset: "always", backgroundColor: "#ffffff" },
    }, null, 2));

    // --- 4. Install Capacitor + add the iOS platform ---
    run("npm", ["install", "--no-audit", "--no-fund"], work);
    run("npx", ["cap", "add", "ios"], work);
    run("npx", ["cap", "copy", "ios"], work);

    // --- 5. Validate the Apple credential (fail closed before the long xcodebuild) ---
    const cred = parseAppleCredential(credentialText);

    // --- 6. Configure the iOS project: bundle id, display name, version, team ---
    const iosDir = join(work, "ios", "App");
    const pbxPath = join(iosDir, "App.xcodeproj", "project.pbxproj");
    if (!existsSync(pbxPath)) {
      throw Object.assign(new Error("Capacitor did not produce an App.xcodeproj"), { code: "NO_XCODE_PROJECT" });
    }
    let pbx = await readFile(pbxPath, "utf8");
    pbx = pbx.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = "${BUNDLE_ID}";`);
    pbx = pbx.replace(/PRODUCT_NAME = [^;]+;/g, `PRODUCT_NAME = "${displayName}";`);
    await writeFile(pbxPath, pbx);

    const infoPlistPath = join(iosDir, "App", "Info.plist");
    if (existsSync(infoPlistPath)) {
      let info = await readFile(infoPlistPath, "utf8");
      if (input.release?.version_name) {
        info = info.replace(/<key>CFBundleShortVersionString<\/key>\s*<string>[^<]*<\/string>/,
          `<key>CFBundleShortVersionString</key>\n\t<string>${String(input.release.version_name).replace(/</g, "&lt;")}</string>`);
      }
      if (input.release?.version_code != null) {
        info = info.replace(/<key>CFBundleVersion<\/key>\s*<string>[^<]*<\/string>/,
          `<key>CFBundleVersion</key>\n\t<string>${input.release.version_code}</string>`);
      }
      await writeFile(infoPlistPath, info);
    }

    // --- 7. Archive + export a genuine signed IPA ---
    // The signing identity is resolved by xcodebuild's automatic signing, selected by the team_id
    // from the credential. The .p8 API key itself is not used for code signing (it is the App Store
    // Connect API key); the host's installed developer certificate drives the signature. This is
    // the internal implementation detail the contract leaves open ("Base44 internals are UNKNOWN"),
    // and it is why the worker requires a macOS host with a configured developer account.
    const archivePath = join(work, "App.xcarchive");
    run("xcodebuild", [
      "-workspace", join(iosDir, "App.xcworkspace"),
      "-scheme", "App",
      "-configuration", "Release",
      "-archivePath", archivePath,
      "-destination", "generic/platform=iOS",
      "CODE_SIGN_STYLE=Automatic",
      `DEVELOPMENT_TEAM=${cred.team_id}`,
      `PRODUCT_BUNDLE_IDENTIFIER=${BUNDLE_ID}`,
      `IPHONEOS_DEPLOYMENT_TARGET=${MIN_OS}`,
      "archive",
    ], work);

    if (!existsSync(archivePath)) {
      throw Object.assign(new Error("xcodebuild archive reported success but no .xcarchive was produced"), { code: "NO_ARCHIVE_OUTPUT" });
    }

    // Export the archive to a .ipa with an export options plist (App Store distribution).
    const exportDir = join(work, "export");
    await mkdir(exportDir, { recursive: true });
    const exportPlistPath = join(work, "ExportOptions.plist");
    await writeFile(exportPlistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store</string>
  <key>teamID</key><string>${cred.team_id}</string>
  <key>uploadBitcode</key><false/>
  <key>uploadSymbols</key><false/>
  <key>compileBitcode</key><false/>
</dict>
</plist>
`);
    run("xcodebuild", [
      "-exportArchive",
      "-archivePath", archivePath,
      "-exportOptionsPlist", exportPlistPath,
      "-exportPath", exportDir,
    ], work);

    // --- 8. Locate the produced IPA ---
    let finalIpa = join(exportDir, "App.ipa");
    if (!existsSync(finalIpa)) {
      const ipas = readdirSync(exportDir).filter((f) => f.endsWith(".ipa"));
      if (!ipas.length) throw Object.assign(new Error("xcodebuild exportArchive reported success but no .ipa was produced"), { code: "NO_IPA_OUTPUT" });
      finalIpa = join(exportDir, ipas[0]);
    }

    // --- 9. Verify the resulting package with codesign ---
    // Unzip the IPA and verify the embedded .app signature. A failed verification is a non-retryable
    // build failure — the produced package is not a valid signed iOS app.
    const verifyDir = join(work, "verify");
    await mkdir(verifyDir, { recursive: true });
    run("unzip", ["-o", "-q", finalIpa, "-d", verifyDir], work);
    const apps = readdirSync(join(verifyDir, "Payload")).filter((f) => f.endsWith(".app"));
    if (!apps.length) throw Object.assign(new Error("The IPA has no Payload/*.app"), { code: "BAD_IPA" });
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", join(verifyDir, "Payload", apps[0])], work);

    return finalIpa;
  } finally {
    // Disposable per-job workspace: removed regardless of outcome. The Apple credential and any
    // extracted signing material lived only in this directory.
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function processJob(job, input) {
  if (input.platform !== "ios") {
    // This worker only builds iOS. Leave the job to expire its lease so a future Android worker
    // (a Linux host) can reclaim it — do NOT submit a failure, which would terminalize the build.
    console.log(`[skip] job ${job.id} build ${input.build_id} is platform=${input.platform}; leaving for another worker`);
    return;
  }

  // Heartbeat keeps the lease alive across the long xcodebuild; cleared on completion.
  const hb = setInterval(() => {
    heartbeat(job.id, job.lease_token).catch((e) => console.error(`[heartbeat] ${e.message}`));
  }, HEARTBEAT_MS);

  let outcome;
  try {
    const mat = await material(input.build_id);
    const ipaPath = await buildSignedIpa(job, input, mat.credential);
    const package_checksum = sha256File(ipaPath);
    const package_size_bytes = readFileSync(ipaPath).length;
    const up = await uploadIpa(input.build_id, ipaPath);
    outcome = {
      artifact_uri: up.file_uri,
      package_checksum,
      platform: "ios",
      signed_at: new Date().toISOString(),
      package_size_bytes,
    };
    console.log(`[built] job ${job.id} → ${up.file_uri} (${package_size_bytes} bytes, ${package_checksum.slice(0, 12)})`);
  } catch (e) {
    outcome = { error: { code: String(e.code || "BUILDER_ERROR").slice(0, 64), message: String(e.message || "builder error").slice(0, 500) } };
    console.error(`[failed] job ${job.id}: ${e.message}`);
  } finally {
    clearInterval(hb);
  }

  await submit(job.id, job.lease_token, outcome);
}

async function tick() {
  let claimed;
  try {
    claimed = await claim();
  } catch (e) {
    console.error(`[claim] ${e.message}`);
    return;
  }
  if (!claimed.job || !claimed.input) {
    if (SINGLE_PASS) console.log("[idle] no native build job available");
    return;
  }
  console.log(`[claim] job ${claimed.job.id} build ${claimed.input.build_id} platform ${claimed.input.platform}`);
  await processJob(claimed.job, claimed.input);
}

async function main() {
  console.log(`[start] worker=${WORKER_ID} base=${BASE} bundleId=${BUNDLE_ID} minOS=${MIN_OS}`);
  if (SINGLE_PASS) {
    await tick();
    return;
  }
  while (true) {
    await tick().catch((e) => console.error(`[tick] ${e.message}`));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => { console.error(`[fatal] ${e.message}`); process.exit(1); });