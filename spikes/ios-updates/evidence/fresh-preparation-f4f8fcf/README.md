# Fresh deployment-mode preparation evidence

Requested by handoff `agentui-h-5gd2`. Executed November 13, 2026 at 8:52 PM America/New_York (01:52 UTC November 14).

PASS at source `f4f8fcfda7ac3afde2bad94b36223a2cc25bc661` on the separate evidence branch `codex/ios-fresh-preparation`.

The pre-existing `.work/app` was renamed to `.work/app-before-fresh-f4f8fcf` before invocation. The app path was absent when the current `bash spikes/ios-updates/prepare.sh` ran. The capture procedure checks this precondition and records it. The script generated the template, ran npm ci and CocoaPods deployment mode, and exited 0. A separate post-run byte comparison of the generated and committed Podfile.lock also exited 0. Both locks hash to `2262ad4d53493fdcbf46c15cbaceac7e3f3a00d96e30467d06cc981968327a2f`.

`provenance.json` records the clean working tree before and after, exact source SHA, actual script/dependency Git blobs and SHA-256 hashes, all six inputs matching native-tested 7d250ae, tool versions, invocation, output exit status and post-run lock comparison. `prepare.log.gz` contains full combined stdout/stderr, with only the local home-directory prefix replaced by `~`. The original raw output remains in ignored `.work/evidence/fresh-preparation/prepare.log`; raw and retained output hashes are recorded. `capture-procedure.py.txt` is the procedure that captured the measurement, with the same home-prefix substitution; it is a record, not changed probe tooling.

Native artifact caches were warm, as shown by cache-hit lines. DerivedData at `.work/build` was retained with the same directory inode before and after. The previous app tree was preserved; no evidence or DerivedData was deleted. This is fresh app-tree preparation, not a cold-cache build or another A/B runtime qualification.

Historical correction: the earlier `prepare-clean.log.gz` was captured before commit 230f062 added `pod install --deployment`; it does not establish fresh execution of the current script. The diff for 230f062 shows that change. The historical deployment log was a later check on an existing generated tree. Preserve those historical records; this new run supplies the missing current-script fresh-tree evidence. Linux has independently corrected the historical labels at 1dad289, which is newer than the requested base; this branch intentionally remains based on f4f8fcf and changes only new evidence files.

No scripts, dependency inputs, qualification document, architecture files, or shared integration branch were changed. This result does not qualify physical-device signing, live update recovery, or integrated AgentUI. Linux owns evidence integration and the repeated review/fix cycle for PR3.
