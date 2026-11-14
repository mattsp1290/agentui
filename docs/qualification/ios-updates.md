# iOS update strategy qualification

## Decision

Use rebuild-only updates for v1. Treat every customization change, including a
JavaScript-only change, as rebuild-required in the installed iOS client. Build a
new Release app with its embedded bundle and reinstall it through the developer's
Apple tooling. Native dependency changes also require dependency installation
and a new native build. Desktop customization remains independent.

The standalone React Native probe proves the simulator rebuild path. It does
not mount AgentUI, implement a product update notification, or qualify integrated
Apple task `agentui-onxu`. Physical-device signing and installation remain untested.

## Why rebuild-only

React Native's [Fast Refresh](https://reactnative.dev/docs/0.86/fast-refresh)
supports iteration through a development server. It does not supply this task's
required installed-update protocol. A live-update option would need a compatible
bundle/native version contract, interrupted-download handling, atomic activation,
and last-good restart recovery. No such updater exists in this repository, and
this spike does not add one or depend on Expo or a hosted service. Live delivery
is unqualified, not demonstrated impossible. Rebuild-only is task `agentui-uoyy`'s accepted
v1 alternative.

The generated template's Release `bundleURL()` reads `main.jsbundle` from the
app bundle. Its Debug path reads from Metro. The experiment deliberately uses
Release. See React Native's [device guide](https://reactnative.dev/docs/0.86/running-on-device)
for the distinction between development iteration, embedded bundles, and signing.

## Environment and source

Measured on November 13, 2026, America/New_York.

| Item | Measured value |
| --- | --- |
| Branch | `codex/ios-update-qualification` |
| Base at native measurement | `bf16a1f`, merged foundation |
| Probe implementation source | `7d250ae54c3267997dc0f56b00281fd8076424d0` |
| macOS | 26.6.2, build 25G83, arm64 |
| Xcode | 26.2, build 17C52 |
| Simulator SDK | 26.2 |
| Simulator runtime | iOS 26.3 |
| Simulator | iPhone 17 Pro, `A284C2DE-8B9E-4905-B568-A49A425318BA` |
| Node / npm | 24.22.3 / 11.19.1, isolated tools on PATH |
| CocoaPods / Ruby | 1.16.2 / 3.4.6 |
| React / React Native | 19.3.1 / 0.86.0, matching repository packages |
| CLI / template | 20.2.0 / 0.86.0 |
| Hermes | hermes-engine 250829098.0.14, from Podfile.lock |
| Signing | Simulator only, `CODE_SIGNING_ALLOWED=NO` |

Pinned native and JavaScript dependencies are in
[`Podfile.lock`](../../spikes/ios-updates/Podfile.lock) and
[`package-lock.json`](../../spikes/ios-updates/package-lock.json).
The probe has its own dependency tree and does not change the main workspace lock.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Pinned dependency installation | PASS | npm ci, pod install --deployment, lock comparison; deployment log |
| Release A build/install/render | PASS | build-A log and A screenshot |
| Source edit to B without rebuild, then restart | PASS: still A | restart-no-rebuild log and no-rebuild screenshot |
| Historical fresh-template run before `230f062`, plain `pod install`, warm cache and retained DerivedData | PASS | clean prepare log; first retained in `e4f3a96` |
| Current deployment-mode `prepare.sh` on a freshly generated template | PASS | [Fresh preparation at `f4f8fcf`](../../spikes/ios-updates/evidence/fresh-preparation-f4f8fcf/README.md); script and independent lock comparison exit 0 |
| Release B rebuild/install/render | PASS | build-B log and B screenshot |
| B restart without Metro | PASS | restart-B log, B-restart screenshot |
| Repository regression at native measurement, base `bf16a1f`, excluding spikes | PASS | 11 tests, build, check, lint |
| Linux integration regression at `f4f8fcf`, excluding spikes | PASS | [26 tests, build, check, lint](https://github.com/mattsp1290/agentui/actions/runs/43540852662/job/132280830858) |
| Compatible live-update recovery | UNQUALIFIED | No updater tested |
| Physical-device signing/install/restart | UNQUALIFIED | No physical device or signing assumed |
| Integrated AgentUI behavior | UNQUALIFIED | Standalone probe only |

The new fresh-tree preparation ran at source `f4f8fcf` on the same Mac with pinned
tools. Its provenance records an absent app directory before generation, clean
source before and after, and matching script/dependency blobs. The retained output
contains template generation, deployment verification, and Pod installation success.
An independent comparison confirms the generated native lock equals the committed lock.
Warm native caches and retained DerivedData make this a fresh generated-tree check,
not a cold-cache build. It does not repeat or extend the A/B runtime qualification.

Deployment-mode lock verification was exercised at one checkout path on one Mac.
Codegen podspec checksum stability across checkout paths is untested.

Follow the [probe procedure](../../spikes/ios-updates/README.md) to reproduce the
commands. Screenshots require visual inspection. The scripts report build and
installation completion, not automatic visual acceptance. Full local build output and the generated app are under ignored
`spikes/ios-updates/.work/`. Installed apps live in the simulator container.
Bundle hashes are read back from the installed app.
Retained evidence is in [the evidence directory](../../spikes/ios-updates/evidence/).

The initial A and B experiment used two generated trees, with DerivedData retained.
The follow-up uses deployment-mode CocoaPods installation, then A, source edit
without rebuild, and B in the same existing generated tree. Restart logs retain
the source label, installed bundle hash, Metro port check, and launch PID.
The retained A/B builds reuse previously selected Release-flavored prebuilt
Hermes, React Native core, and dependency artifacts. The initial configuration
swap occurred in an unretained build.

This bounded v1 decision is referenced from the shared architecture and Apple
qualification documents. The probe does not implement product update delivery or
notifications. Native-incompatible changes remain rebuild-required in all cases.

ShellCheck and Bash syntax checks passed for all three probe scripts. See
`evidence/shellcheck.txt`. The retained restart logs report distinct A and B
installed-bundle hashes and no Metro listener. Screenshots were visually checked.

Probe scripts and dependency inputs are byte-identical to native-tested
`7d250ae54c3267997dc0f56b00281fd8076424d0`. From the repository root, verify with:

```sh
git diff --exit-code 7d250ae54c3267997dc0f56b00281fd8076424d0 -- \
  spikes/ios-updates/*.sh spikes/ios-updates/package*.json \
  spikes/ios-updates/Podfile.lock
```

The archived [Mac review summary](../../spikes/ios-updates/evidence/review-summary.md)
describes `f62723a`, before integration. The historical review archive is unchanged.
