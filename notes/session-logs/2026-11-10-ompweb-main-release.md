# OMPweb main release notes — 2026-11-10

## Scope and destination

These notes cover the local changes since `efe306d5` (the previously published
`0.6.0-n1` application-channel release). The destination is the existing public
[`nanogram/ompweb`](https://github.com/nanogram/ompweb) repository's **main** branch;
no additional repository, feature branch, upstream push or npm publication is
part of this release. The application version remains `0.6.0-n1`.

Previously published background-send ownership, newest-50 progressive history,
128 MiB display-history windows, outcome-aware unread session/folder marks,
last-chat startup, reviewed upstream ports and Main/application-channel selection
remain in place. They are not newly introduced by this commit. Canonical session
history and OMP's model context are not truncated.

## Changes in this release

### GUI-only hot updates and repeatable deployment

- Add a source-snapshot GUI customization mode with explicit presentation/style
  and display-syntax allowlists; critical execution/transport/backend changes are
  deferred until an explicit web restart rather than partially loaded.
- Support remote exact-origin HMR ingress, coalesced source watching, safe Windows
  mapped-file replacement and local-import dependency deferral. Preserve the
  independent fixes that kept incomplete hot edits from breaking app loading.
- Preserve drafts, attachments, focus and selection through eligible GUI remounts;
  serialize stylesheet replacement to avoid browser modification-lock errors.
- Put GUI customization status, applied/deferred files and errors in Settings,
  not a floating chat overlay.
- Add build/stage/deploy/launch/status/rollback scripts, incremental Windows tray
  compilation and guarded publication to the declared repository's main branch.
- Retain frozen primary Windows GUI mode, scoped asynchronous web-only restarts,
  persistent trusted ingress and explicit rollback receipts. Rebuild the bundled
  tray for the Bun-aware launcher. Do not restart the owning host daemon or OMPs.

### Director

- Add one persistent Director chat above Workspaces, with watched-project scope
  and background review scheduling independent of an open browser.
- Offer explicit session-control permission for existing sessions in the watched
  scope: inspect, resume, prompt, steer, queue a follow-up and stop the current
  turn. Recheck scope/permission before writes; keep observe-only defaults.
- Do not grant shell execution, direct file editing, approval answers or session
  creation/deletion. Keep pause/revocation, cooldown, usage/error pauses, bounded
  discovery and replay fencing.
- Remove the dollar initiation threshold and daily review-count cap while
  retaining cost/review reporting and the other scheduling safeguards.
- Preserve Director role updates and native follow-up intent, tighten sidebar
  spacing, and collapse the large controls section by default.

### Chat layout and controls

- Restore token-generation speed in the top bar on desktop and mobile.
- Move theme/language controls into Settings and hide the top History, Branches
  and System shortcuts while preserving other navigation paths.
- Share one row between active tasks and subagents. Hide labels when both occupy
  half the row, show the label when one occupies the full row, and hide completed
  tasks/inactive rosters until new work appears.
- Keep summary bars at the bottom. Expand their scrollable details over the chat,
  without raising the transcript or moving the input.
- Remove per-message Markdown-copy, Read and Fork controls. Retain plain-text
  Copy, user-message Edit, timestamps and the independent native branching APIs.
- Automatically collapse the composer during active work, preserve an explicit
  expansion for that run, and show the full input when idle or waiting for input.
  Preserve drafts/attachments and remove the former manual collapse notch.
- Add a browser-local Settings toggle for the slow-mode snail, hidden by default;
  visibility never changes native slow mode or hides usage-limit warnings.

### Combined model and reasoning picker

- Synchronize the saved visible-model subset through web settings across desktop
  and mobile, with one-time legacy migration, explicit show-all/hide-all and
  recoverable errors instead of silently exposing every model.
- Replace the static model icon with the current reasoning circle; remove the
  separate reasoning toolbar control.
- Show provider-grouped models on the left and the selected model's native
  supported reasoning levels on the right, including on mobile.
- Keep the picker open after model selection and fence further changes until
  native acknowledgement. Preserve custom effort names/aliases and stream guards.
- Remove model search, the repeated model caption under Reasoning, the next-prompt
  hint and Add Providers footer. Model/provider management remains in Settings.
- Preserve selected-choice focus, cross-pane arrow navigation and Escape return.
  Keep reasoning available when model metadata is missing.
- Anchor the popup above the entire input box, not the lower toolbar button.
  Observe composer resizing and shrink into the available space on short/mobile
  viewports so the menu does not cover the draft.

### Readiness, responsiveness and reliable delivery

- Compress development GUI assets, honor revalidation and progressively enhance
  historical Markdown instead of blocking composer readiness on offscreen work.
- Restore known-owner chats alongside workspace loading, retain scroll anchors
  and coalesce sizing work. Cache remains display-only until HTTP revalidation.
- Stabilize unchanged Director/running snapshots, callbacks and memo boundaries so
  background status refreshes do not periodically repaint the active editor.
- Reconcile delayed native acceptance using the original command's private
  identity instead of falsely reporting accepted messages as unsent. Unknown
  legacy outcomes stay delivery-unconfirmed, without automatic resend or matching
  old transcript text.
- Show only genuinely pending native steers/follow-ups above the composer; remove
  consumed/running/finished progress copies once the message belongs in history.
  Preserve distinct same-text submissions and native queue Edit/Delete/Steer.

### Generated files and platform reliability

- Add a desktop link context menu and viewer action for opening authorized local
  document/media files in the server computer's default application. Preserve
  preview/download, Shift-right-click native menus and existing mobile behavior.
- Deny native launches for remote hosts, executables/scripts/shortcuts and
  credential aliases. Reuse source host/session authorization.
- Stream video previews with MIME and byte ranges rather than the text-preview
  size limit; retain bounded text/image/DOCX previews and codec-error alternatives.
- Preserve Windows host-update status during transient reader locks and keep
  service/tray operations scoped to the matching web installation.
- Make regression execution repeatable with serialized files/cases, causal
  acknowledgement barriers, isolated temporary profiles and completed hook
  lifecycles. Update all four locale dictionaries and the contributor/runtime docs.
- Release preflight exposed five fixture-isolation failures: composer preference
  requests created unrelated alerts in attachment tests, and pending mount
  hydration obscured the newer-owner HMR guard. Serve valid web-settings data in
  those fixtures and settle hydration before simulating a newer DOM owner.
  Preserve the attachment limits, Edit recovery and no-overwrite assertions;
  all 83 tests in the two affected files pass after the fixture repair.

## Verification evidence and limits

Recent exercised checks before this publication preparation:

- Combined picker integration: 347 passing tests across nine files, typecheck,
  lint, client build, and real desktop/mobile Chromium selection/navigation.
- Picker cleanup: 345 passing tests across nine files, typecheck, lint, client
  build, and deployed desktop/mobile visual inspection.
- Composer-anchor correction: 39 passing tests across five files, including
  failing-before/passing-after positioning regressions, typecheck, lint and build.
  Deployed checks covered desktop, mobile, a tall unsent draft and a short viewport.
- These targeted counts overlap; they are **not additive** and are not a claim
  that the complete release suite passed on the final candidate.
- Web-only activations retained the owning daemon and existing native process
  identities. No production prompt, model change or reasoning change was used
  to validate picker behavior; mutations ran against an isolated UI scenario.

The final complete check and public-content review are recorded below.
Browser emulation does not establish
physical-phone WAN/Tailscale throughput. No Linux/macOS runtime or GitHub CI
result is claimed here. Private operational logs, screenshots, hostnames,
installation paths, native process inventories and session transcripts are kept
outside the public Git tree.

## Public-content and packaging review

- Replace the installation-specific hostname in a Windows configuration fixture
  with `https://desktop.example.test:8445`; the test needs no live endpoint.
- Static review found no concrete credential disclosure or introduced
  authorization regression in the candidate. This is not an exhaustive security
  guarantee; local runtime receipts remain private because encoding is not
  redaction.
- Packaging review confirmed the new UI/runtime/release scripts are included.
  Retain the deliberately tracked rebuilt Windows tray with its native source.
- Preserve the established public noreply author/committer identity rather than
  publishing workstation Git identity settings.
- Preserve upstream license, attribution and commit history. Generated runtime
  artifacts and operational evidence are not included in the public commit.

## Final publication verification

The existing `node scripts/ui-release.cjs build --verify` pipeline passed on
Windows after the fixture-isolation repairs:

- TypeScript typecheck and ESLint: pass.
- Complete serialized suite: **3,722 passed, 63 skipped, 0 failed** — 3,785 tests
  across 348 files.
- Client build: 104 output files; existing CSS `::highlight` warnings remain.
- Native tray build/validation step: pass.
- All 12 isolated production smoke checks: pass, covering launcher startup,
  served SPA/assets, gzip, host linking, session listing, the shipped Edit
  extension, live events, shutdown and temporary-directory cleanup.

This is local verification, not a GitHub CI result. Publication targets the
existing `nanogram/ompweb` main branch with a normal non-force push, without
creating another repository or public branch and without restarting production
services or native sessions.
