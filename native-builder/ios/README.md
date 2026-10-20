# NexusAI external iOS native builder

A standalone Node.js worker that produces a **genuine signed IPA** from an existing published
NexusAI artifact, by driving the certified `mobileNativeBuilder` boundary.

This is the iOS counterpart of `native-builder/android/worker.mjs`. It reuses every certified
server-side contract unchanged — `mobileNativeBuilder` (claim/heartbeat/submit),
`mobileNativeMaterial` (Apple signing material delivery), `mobileNativeUpload` (private binary
upload) — and the `MobileBuild` lifecycle. No endpoint, entity, schema, scheduler, or release
contract is modified.

## What it does, per job

1. `POST /functions/mobileNativeBuilder` `{action:"claim"}` — receive a native build job.
2. `POST /functions/mobileNativeMaterial` `{action:"material", build_id}` — receive the Apple
   signing credential (the `MOBILE_SIGNING_APPLE` `WorkspaceSecret` value) over the trusted
   `WORKER_SECRET` path. This is the SAME platform-agnostic function the Android worker uses; the
   platform is resolved server-side from the build_id.
3. Download the immutable source artifact's `client_files` (the published web bundle).
4. Scaffold a real Capacitor iOS project from those files in a fresh temp directory.
5. `xcodebuild archive` + `xcodebuild -exportArchive` — a real `.ipa` (App Store package).
6. Verify the resulting package with `codesign --verify --deep --strict`.
7. `POST /functions/mobileNativeUpload` (multipart) — store the IPA in the app's private storage,
   receive a `file_uri`.
8. `POST /functions/mobileNativeBuilder` `{action:"submit", result:{artifact_uri, package_checksum, platform:"ios", signed_at, package_size_bytes}}`.

A heartbeat extends the lease every `HEARTBEAT_INTERVAL_MS` during the xcodebuild so the queue
does not reclaim the job mid-flight.

## Host prerequisites

- **macOS** (the worker fails closed with exit code 2 on any other platform).
- **Xcode** + Command Line Tools (`xcodebuild` reachable via `xcrun`).
- A configured Apple developer account / signing identity in the host keychain (automatic signing
  drives the code signature; the team is selected by `team_id` from the credential).
- **Node.js 18+** (global `fetch`, `FormData`, `Blob`).
- `npm` reachable (for the per-job Capacitor install).

> The genuine IPA + `codesign` verification steps (4-6, the `.ipa` itself, and the signature check)
> require macOS/Xcode and **cannot run in the Base44 backend runtime**. The server-side certification
> (`mobileNativeBuilderIosCert`) certifies every server-side step and records the toolchain steps as
> a BLOCKED blocker; this worker is the component that performs them on a real Mac.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `WORKER_SECRET` | yes | — | The secret the platform's `workerAuth` expects. |
| `NEXUSAI_BASE_URL` | no | `https://fancy-file-flow-master.base44.app` | The app's function base URL. |
| `WORKER_ID` | no | `ios-<random>` | Identifies this worker in the queue. |
| `POLL_INTERVAL_MS` | no | `15000` | Claim poll cadence. |
| `HEARTBEAT_INTERVAL_MS` | no | `120000` | Lease extension cadence during a build. |
| `IOS_BUNDLE_ID` | no | `com.base44.app` | The iOS `CFBundleIdentifier`. |
| `IOS_DISPLAY_NAME` | no | `NexusAI App` | The iOS `CFBundleDisplayName`. |
| `IOS_MIN_OS_VERSION` | no | `14.0` | The iOS deployment target. |
| `SINGLE_PASS` | no | — | Set `1` to run one claim attempt and exit (CI mode). |

## Apple signing credential format

The `MOBILE_SIGNING_APPLE` `WorkspaceSecret` value must be a JSON string:

```json
{
  "issuer_id": "the App Store Connect issuer id (UUID)",
  "key_id": "the API key id (10 chars)",
  "team_id": "the Apple Team id (10 chars)",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...(.p8 PEM)...\n-----END PRIVATE KEY-----",
  "push_notifications": true
}
```

Set it through the existing Mobile Admin signing-credential surface (`putSigningCredential`). The
platform stores it encrypted at rest; this worker receives it only over the `WORKER_SECRET`-
authenticated `material` action and writes it to a per-job temp directory that is deleted when the
job finishes — the credential never persists on the worker host.

> The `.p8` is the App Store Connect API key. Code signing the IPA is driven by `xcodebuild`'s
> automatic signing with the host's installed developer identity, selected by `team_id`. The
> internal mapping from the API key to a signing identity is the host-specific implementation detail
> the contract leaves open (Base44 internals are UNKNOWN); the observable contract is that the user
> supplies the fields above and the worker produces a genuine signed IPA. No App Store Connect API
> is called and nothing is submitted.

## Run

```bash
export WORKER_SECRET="…"
export NEXUSAI_BASE_URL="https://your-app.base44.app"
node worker.mjs
```

For a one-shot CI run: `SINGLE_PASS=1 node worker.mjs`.

## Trust and isolation model

- The worker authenticates every call with `WORKER_SECRET` (constant-time checked server-side by
  the existing `workerAuth`). Without it, no claim, material, upload, or submit succeeds.
- The Apple credential is delivered only for a `build_id` the worker has claimed and only while
  that build is non-terminal; the platform resolves the workspace server-side, so the worker cannot
  request an arbitrary workspace's credential.
- Each job builds in a fresh temp directory that is deleted on completion — disposable build
  environment, no cross-job leakage, no signing material left behind.
- Lease/heartbeat/recovery remain entirely server-side: a crashed worker leaves an expiring lease
  the queue reclaims as bounded recovery. This worker holds no durable state.
- The worker fails closed at startup if the host is not macOS or `xcodebuild` is not found.

## Known constraints

- **Android is out of scope** for this worker (no Linux/Gradle). A claimed Android job is left for
  its lease to expire so a separate Linux worker can reclaim it. Run the Android worker alongside
  this one for Android builds.
- **IPA size vs. upload limits**: the IPA is sent as multipart to `mobileNativeUpload`, which passes
  it through the existing `UploadPrivateFile` integration. Verify your platform's request-body limit
  accommodates the expected IPA size (~10–50 MB for a web-wrapper app).
- The `IOS_BUNDLE_ID` defaults to `com.base44.app`; override per workspace/deployment when a custom
  bundle identifier is required.
- **No App Store Connect submission**: this worker produces and verifies the IPA only. Automatic
  store submission is deliberately not implemented, and no App Store Connect API is called.