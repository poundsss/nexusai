# NexusAI external Android native builder

A standalone Node.js worker that produces a **genuine signed AAB** from an existing published
NexusAI artifact, by driving the certified `mobileNativeBuilder` boundary.

This is the executor half of the architecture: NexusAI owns the lifecycle (queue, lease,
heartbeat, recovery); this worker is a pure, disposable executor that claims a job, builds a
real Android App Bundle with Gradle, signs it with the keystore stored in the workspace's
`WorkspaceSecret`, uploads the AAB back into private storage, and submits the result.

## What it does, per job

1. `POST /functions/mobileNativeBuilder` `{action:"claim"}` — receive a native build job.
2. `POST /functions/mobileNativeMaterial` `{action:"material", build_id}` — receive the
   signing keystore (the `MOBILE_SIGNING_ANDROID` `WorkspaceSecret` value) over the trusted
   `WORKER_SECRET` path.
3. Download the immutable source artifact's `client_files` (the published web bundle).
4. Scaffold a real Capacitor Android project from those files in a fresh temp directory.
5. `gradle :app:bundleRelease` — a real `.aab`.
6. Sign it with the keystore from step 2 (Gradle `signingConfig.release`).
7. `POST /functions/mobileNativeUpload` (multipart) — store the AAB in the app's private
   storage, receive a `file_uri`.
8. `POST /functions/mobileNativeBuilder` `{action:"submit", result:{artifact_uri, package_checksum, platform:"android", signed_at, package_size_bytes}}`.

A heartbeat extends the lease every `HEARTBEAT_INTERVAL_MS` during the Gradle build so the
queue does not reclaim the job mid-flight.

## Host prerequisites

- **Node.js 18+** (global `fetch`, `FormData`, `Blob`).
- **JDK 17+** (`JAVA_HOME`).
- **Android SDK** (`ANDROID_SDK_ROOT`), with platform 33+ and build-tools installed.
- **Gradle** is not required on the host — the Capacitor Android project ships the Gradle
  wrapper, which `worker.mjs` invokes.
- `npm` reachable (for the per-job Capacitor install).

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `WORKER_SECRET` | yes | — | The secret the platform's `workerAuth` expects. |
| `ANDROID_SDK_ROOT` | yes | — | Android SDK root for the Gradle build. |
| `JAVA_HOME` | yes | — | JDK 17+ home. |
| `NEXUSAI_BASE_URL` | no | `https://fancy-file-flow-master.base44.app` | The app's function base URL. |
| `WORKER_ID` | no | `android-<random>` | Identifies this worker in the queue. |
| `POLL_INTERVAL_MS` | no | `15000` | Claim poll cadence. |
| `HEARTBEAT_INTERVAL_MS` | no | `120000` | Lease extension cadence during a build. |
| `ANDROID_APPLICATION_ID` | no | `com.base44.app` | The Android `applicationId`. |
| `ANDROID_MIN_SDK_VERSION` | no | `22` | `minSdkVersion` override. |
| `SINGLE_PASS` | no | — | Set `1` to run one claim attempt and exit (CI mode). |

## Signing credential format

The `MOBILE_SIGNING_ANDROID` `WorkspaceSecret` value must be a JSON string:

```json
{
  "keystore_base64": "<base64 of a .jks or .keystore file>",
  "keystore_password": "the-keystore-password",
  "key_alias": "the-key-alias",
  "key_password": "the-key-password"
}
```

Set it through the existing Mobile Admin signing-credential surface (`putSigningCredential`).
The platform stores it encrypted at rest; this worker receives it only over the
`WORKER_SECRET`-authenticated `material` action, writes it to a per-job temp directory, and
deletes that directory when the job finishes — the keystore never persists on the worker host.

## Run

```bash
export WORKER_SECRET="…"
export ANDROID_SDK_ROOT="/opt/android-sdk"
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk"
export NEXUSAI_BASE_URL="https://your-app.base44.app"
node worker.mjs
```

For a one-shot CI run: `SINGLE_PASS=1 node worker.mjs`.

## Trust and isolation model

- The worker authenticates every call with `WORKER_SECRET` (constant-time checked server-side
  by the existing `workerAuth`). Without it, no claim, material, upload, or submit succeeds.
- The keystore is delivered only for a `build_id` the worker has claimed and only while that
  build is non-terminal; the platform resolves the workspace server-side, so the worker cannot
  request an arbitrary workspace's credential.
- Each job builds in a fresh temp directory that is deleted on completion — disposable build
  environment, no cross-job leakage.
- Lease/heartbeat/recovery remain entirely server-side: a crashed worker leaves an expiring
  lease the queue reclaims as bounded recovery. This worker holds no durable state.

## Known constraints

- **iOS is out of scope** for this worker (no macOS/Xcode). A claimed iOS job is left for its
  lease to expire so a separate Mac worker can reclaim it. Run a Mac worker alongside this one
  for iOS builds.
- **AAB size vs. upload limits**: the AAB is sent as multipart to `mobileNativeUpload`, which
  passes it through the existing `UploadPrivateFile` integration. Verify your platform's
  request-body limit accommodates the expected AAB size (~5–20 MB for a web-wrapper app).
- The `applicationId` defaults to `com.base44.app`; override `ANDROID_APPLICATION_ID` per
  workspace/deployment when a custom package name is required.