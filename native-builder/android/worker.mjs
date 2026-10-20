#!/usr/bin/env node
// NexusAI external Android native build executor.
//
// A standalone, deployable worker that produces a GENUINE signed AAB from an existing published
// NexusAI artifact, by driving the certified `mobileNativeBuilder` boundary over HTTPS with
// WORKER_SECRET (the same trusted boundary the platform uses for claim/heartbeat/submit).
//
// What this worker does, per claimed build:
//   1. claim  — POST /functions/mobileNativeBuilder { action:"claim" }
//   2. material — POST /functions/mobileNativeMaterial { action:"material", build_id } → keystore
//   3. download the immutable source artifact's client_files (the published web bundle)
//   4. scaffold a real Capacitor Android project from those files
//   5. gradle bundleRelease  → a genuine .aab (Android App Bundle)
//   6. sign it with the keystore from the WorkspaceSecret credential
//   7. upload — POST /functions/mobileNativeUpload (multipart) → private file_uri
//   8. submit — POST /functions/mobileNativeBuilder { action:"submit", result:{artifact_uri,...} }
//
// Lease/heartbeat/recovery stay controlled by NexusAI: this worker only extends its lease via
// `heartbeat` and reports the outcome via `submit`. A crashed worker leaves an expiring lease
// that the queue reclaims as bounded recovery — the worker holds no durable state of its own.
//
// REQUIRED environment:
//   WORKER_SECRET             — the shared secret the platform's workerAuth expects (x-worker-secret)
//   ANDROID_SDK_ROOT          — path to the Android SDK the Gradle build compiles against
//   JAVA_HOME                 — JDK 17+ (Gradle + the Android Gradle Plugin requirement)
//
// OPTIONAL environment:
//   NEXUSAI_BASE_URL          — the app's function base URL (default: the published app URL)
//   WORKER_ID                 — identify this worker in the queue (default: android-<random>)
//   POLL_INTERVAL_MS          — claim poll cadence (default 15000)
//   HEARTBEAT_INTERVAL_MS     — lease extension cadence during a build (default 120000)
//   ANDROID_APPLICATION_ID    — the Android applicationId / package name (default com.base44.app)
//   ANDROID_MIN_SDK_VERSION   — minSdkVersion override (default 22)
//   SINGLE_PASS               — "1" to exit after one claim attempt (for CI), else loops forever
//
// Prerequisites on the host: Node.js 18+, Android SDK, JDK 17+, Gradle (or the wrapper), and
// `npm` reachable for Capacitor install. See README.md for the full setup.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = (process.env.NEXUSAI_BASE_URL || "https://fancy-file-flow-master.base44.app").replace(/\/$/, "");
const SECRET = process.env.WORKER_SECRET;
const WORKER_ID = process.env.WORKER_ID || `android-${randomBytes(4).toString("hex")}`;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 120000);
const APP_ID = process.env.ANDROID_APPLICATION_ID || "com.base44.app";
const MIN_SDK = Number(process.env.ANDROID_MIN_SDK_VERSION || 22);
const SINGLE_PASS = process.env.SINGLE_PASS === "1";

if (!SECRET) {
  console.error("[fatal] WORKER_SECRET is required");
  process.exit(2);
}
if (!process.env.ANDROID_SDK_ROOT && !process.env.ANDROID_HOME) {
  console.error("[fatal] ANDROID_SDK_ROOT (or ANDROID_HOME) is required for the Gradle build");
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

async function uploadAab(build_id, aabPath) {
  const buf = readFileSync(aabPath);
  const form = new FormData();
  form.append("build_id", build_id);
  form.append("file", new Blob([buf], { type: "application/octet-stream" }), "app-release.aab");
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
  const r = spawnSync(cmd, args, { cwd, stdio: "pipe", env: { ...process.env, ...env }, encoding: "utf8", shell: process.platform === "win32" });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const e = new Error(`${cmd} ${args.join(" ")} exited ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
    e.code = "BUILD_STEP_FAILED"; throw e;
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

// Scaffold a genuine Capacitor Android project from the artifact's web bundle, build and sign
// a real AAB, and return its path. Everything happens in a disposable per-job temp directory.
async function buildSignedAab(job, input, credentialText) {
  const work = join(tmpdir(), `nexusai-android-${job.id}-${Date.now()}`);
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
    // Ensure a default entry exists.
    if (!existsSync(join(webDir, "index.html"))) {
      await writeFile(join(webDir, "index.html"), '<!doctype html><meta http-equiv="refresh" content="0; url=./index.htm">', "utf8");
    }

    // --- 3. package.json + Capacitor config ---
    await writeFile(join(work, "package.json"), JSON.stringify({
      name: "nexusai-android-shell",
      version: "1.0.0",
      private: true,
      dependencies: { "@capacitor/core": "^6", "@capacitor/android": "^6" },
      devDependencies: { "@capacitor/cli": "^6" },
    }, null, 2));
    await writeFile(join(work, "capacitor.config.json"), JSON.stringify({
      appId: APP_ID,
      appName: input.release?.version_name ? `App ${input.release.version_name}` : "NexusAI App",
      webDir: "www",
      bundledWebRuntime: false,
      android: { allowMixedContent: false },
    }, null, 2));

    // --- 4. Install Capacitor + add the Android platform ---
    run("npm", ["install", "--no-audit", "--no-fund"], work);
    run("npx", ["cap", "add", "android"], work);
    run("npx", ["cap", "copy", "android"], work);

    // --- 5. Configure release signing from the WorkspaceSecret keystore ---
    let cred;
    try { cred = JSON.parse(credentialText); }
    catch { throw Object.assign(new Error("The signing credential is not valid JSON"), { code: "BAD_CREDENTIAL" }); }
    if (!cred.keystore_base64 || !cred.keystore_password || !cred.key_alias || !cred.key_password) {
      throw Object.assign(new Error("The signing credential is missing keystore_base64/keystore_password/key_alias/key_password"), { code: "BAD_CREDENTIAL" });
    }
    const ksBuf = Buffer.from(cred.keystore_base64, "base64");
    if (!ksBuf.length) throw Object.assign(new Error("The keystore decoded to zero bytes"), { code: "BAD_CREDENTIAL" });
    const ksPath = join(work, "android", "app", "release.keystore");
    await writeFile(ksPath, ksBuf);
    await writeFile(join(work, "android", "keystore.properties"), [
      `storeFile=release.keystore`,
      `storePassword=${cred.keystore_password}`,
      `keyAlias=${cred.key_alias}`,
      `keyPassword=${cred.key_password}`,
      "",
    ].join("\n"));

    // Append a valid signingConfig to app/build.gradle (Groovy allows re-opening the android block).
    const buildGradlePath = join(work, "android", "app", "build.gradle");
    let bg = await readFile(buildGradlePath, "utf8");
    bg += `
// === NexusAI native builder release signing (appended) ===
def nexusKs = new Properties()
def nexusKsFile = rootProject.file('keystore.properties')
if (nexusKsFile.exists()) {
    nexusKs.load(new FileInputStream(nexusKsFile))
    android {
        signingConfigs {
            release {
                storeFile file(nexusKs['storeFile'])
                storePassword nexusKs['storePassword']
                keyAlias nexusKs['keyAlias']
                keyPassword nexusKs['keyPassword']
            }
        }
        buildTypes {
            release {
                signingConfig signingConfigs.release
            }
        }
    }
}
`;
    await writeFile(buildGradlePath, bg);

    // --- 6. Apply release version + minSdk from the pinned build / worker config ---
    {
      let g = await readFile(buildGradlePath, "utf8");
      if (input.release?.version_code != null) {
        g = g.replace(/versionCode\s+\d+/, `versionCode ${input.release.version_code}`);
      }
      if (input.release?.version_name != null) {
        g = g.replace(/versionName\s+"[^"]*"/, `versionName "${String(input.release.version_name).replace(/"/g, '\\"')}"`);
      }
      g = g.replace(/minSdkVersion\s+\d+/, `minSdkVersion ${MIN_SDK}`);
      await writeFile(buildGradlePath, g);
    }

    // --- 7. Build the genuine AAB ---
    const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
    const androidDir = join(work, "android");
    run(gradlew, [":app:bundleRelease"], androidDir, {
      ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME,
      ANDROID_HOME: process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT,
    });

    // --- 8. Locate the produced AAB ---
    const aabPath = join(androidDir, "app", "build", "outputs", "bundle", "release", "app-release.aab");
    if (!existsSync(aabPath)) {
      throw Object.assign(new Error("Gradle reported success but no AAB was produced at the expected path"), { code: "NO_AAB_OUTPUT" });
    }
    return aabPath;
  } finally {
    // Disposable per-job workspace: removed regardless of outcome. The keystore lived only here.
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function processJob(job, input) {
  if (input.platform !== "android") {
    // This worker only builds Android. Leave the job to expire its lease so a future iOS worker
    // (a Mac) can reclaim it — do NOT submit a failure, which would terminalize the build.
    console.log(`[skip] job ${job.id} build ${input.build_id} is platform=${input.platform}; leaving for another worker`);
    return;
  }

  // Heartbeat keeps the lease alive across the long Gradle build; cleared on completion.
  const hb = setInterval(() => {
    heartbeat(job.id, job.lease_token).catch((e) => console.error(`[heartbeat] ${e.message}`));
  }, HEARTBEAT_MS);

  let outcome;
  try {
    const mat = await material(input.build_id);
    const aabPath = await buildSignedAab(job, input, mat.credential);
    const package_checksum = sha256File(aabPath);
    const package_size_bytes = readFileSync(aabPath).length;
    const up = await uploadAab(input.build_id, aabPath);
    outcome = {
      artifact_uri: up.file_uri,
      package_checksum,
      platform: "android",
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
  console.log(`[start] worker=${WORKER_ID} base=${BASE} appId=${APP_ID} minSdk=${MIN_SDK}`);
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