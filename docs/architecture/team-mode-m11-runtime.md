# Team mode M11 runtime boundaries

This is the application-defined Host/CLI half of #4149 under ADR-0336. The existing BotHarness Typert Service and API Gateway carry every invocation. `TeamPrivateContent`, owned by `TeamService`, enforces current Human permissions; `PrivateAudit` owns the durable SQLite access chain. No native DSH API or second authentication authority is introduced.

## Wire contract

| Method               | Payload                       | Result                                       |
| -------------------- | ----------------------------- | -------------------------------------------- |
| `privateObjects`     | `{ humanId?, kind? }`         | `PrivateObject[]`                            |
| `privateContentOpen` | `{ kind, objectId, reason? }` | `{ viewId, object, messages, memoryFiles? }` |
| `privateContentPage` | `{ viewId, before }`          | `{ messages }`                               |
| `auditLog`           | `{ after?, limit? }`          | `{ records, next? }`                         |
| `auditVerify`        | `{}`                          | `{ ok: true }` or `{ ok: false, brokenAt }`  |

`kind` is `bot`, `channel`, `dm` or `bot-dm`. A `PrivateObject` contains only `{ objectId, kind, name, ownerHumanIds }`. Bot IDs are slugs; all other IDs are Channel IDs. Human–Bot and Human–Human DMs use `dm`; local Bot–Bot DMs use `bot-dm`. Remote Bot DMs, deleted objects and public/role Channels are excluded. Existing legitimate readers of a private Channel and participating DM owners use their ordinary read path: an audited open returns `own-content`.

Bot opens add `object.profile` with `slug`, `displayName`, `description?`, `tag?`, `roles?`, `createdAt`, and `paused?`. `memoryFiles` contains the existing Memory read representation (`path`, `body`, `head`, and optional Markdown/image/binary metadata). Bot messages come from its Human DM; Bot–Bot DMs remain separate objects. Every message page contains at most 50 messages, newest first; pass the oldest returned message ID as `before`. No mutation operation is exposed.

For CLI username resolution, `privateObjects` additionally accepts `username?`, mutually exclusive with `humanId`. Resolution happens inside the permission-checked Service and does not require `members.manage`. Unknown usernames return `object-not-found`.

`privateContent.view` admits object discovery/open/page; `audit.view` admits log/verify. The Owner has implicit permissions. Non-Owner viewers cannot inspect the Owner or an object owner whose role permissions exceed their own ceiling. Lists omit these targets; open/page return `permission-required` with `details.permission: 'privateContent.view'`. Own content returns `own-content` without recording access. Bot-origin contexts refuse every method, even with an Owner or holder Human ID; the Owner Tob CLI broker refuses `audit` and `private` before execution or approval. These methods are not Bot tools.

Views hold metadata only, bind the Human ID, expire after 30 minutes without renewal and disappear on Host restart. The process retains at most 128 views; capacity returns `private-views-full`. Expired, foreign, removed or ownership-changed views return `object-not-found`. Every page rechecks permissions and object ownership. Role revocation clears views, disposes existing browser Peers, closes the paired-device mux and invalidates current access through the established M3/M4 revocation path.

## Durable audit

Each open commits one record before reading private content; list and page do not append. Consequently a downstream Memory read failure can still leave the truthful access-attempt record. Records retain names and Human IDs independently of subsequent offboarding. They contain no message bodies, Memory content or credentials. Optional reasons are trimmed and limited to 1,024 code units.

`private_access_audit` has monotonic sequence order and a unique `audit_id`. `record_json` contains the specified record, with SHA-256 over the schema-ordered unsigned JSON, including the prior hash. `private_audit_head` retains the last sequence, audit ID and hash in the same transaction. Verification checks sequence continuity, every digest/link, the row identity and the durable head. The head detects tail deletion or deletion of all audit rows, as well as interior deletion and edits. Append refuses a damaged tail with `audit-integrity-failed`; it never resets the chain. This is tamper evidence against independent row changes, not an external signature against a database administrator rewriting both chain and head.

Audit pages are oldest first. `after` and `next` are audit IDs; default `limit` is 50, maximum 200. Invalid limits, cursors or payloads return `invalid-input`. No edit, delete or reset RPC/CLI exists.

The migration derives its generation from the immediately preceding M10 `MEMBER_USAGE_MIGRATION`, now 149 → **150**. This branch was rebased onto M10 main (`ace1252f3`) and preserves both M10 model/usage methods and M11's five methods in the import-free `member-methods.ts`. If M6 or another schema change lands before integration, recheck the final preceding generation and allocate the next contiguous generation; do not ship duplicates or move an already published migration.

## CLI and Client handoff

Commands are `audit list [--after <auditId>] [--limit <1..200>]`, `audit verify`, `private list [--member <username>] [--kind <kind>]`, `private open <kind> <id> [--reason <text>]`, and `private page <viewId> --before <messageId>`. Every command supports `--as` and dispatches through the same Gateway and Service. Stdout is one JSON document: the result on success, `{ error: { code, message, details? } }` on refusal.

`teamMode` adds `privateAccessNotice: true` while Team mode is enabled and omits it otherwise. Client/mobile surfaces, translated labels/notices, bilingual CLI guide copy and the combined feature's bilingual release fragment belong to the UI integration. The UI must display the audited-view banner before opening/reading, retain `viewId` across pagination, expose no writes and map the coded refusals above. Rendered, installed native and Human acceptance remain separate from Host/CLI verification.

## Integration question

M2's existing Owner administrative `get` / CLI `show` profile path is retained and does not append an audit record. Whether that management path must also enter the audited viewer is an unresolved integration scope question; this logic branch does not claim that every historical Owner profile-reading path is audited. Client integration must resolve it before claiming comprehensive private-profile auditing.

## Performance

No dependency, worker, polling loop or timer is added. Ordinary message admission and reads do not query the audit. Existing Team status gains only the notice field, with no additional query. Discovery is an explicit metadata inventory, with batched membership and ceiling reads. Open/page use point lookups rather than listing the Host roster or Channels; message pages stay at 50. Appending hashes one bounded record and reads only the tail/head; audit list uses indexed sequence/cursor reads. Full verification is an explicit streaming O(records) operation. Bot opens additionally perform the existing Memory snapshot/file reads, proportional to that Bot's Memory. Regression tests guard page size, absence of inventory reads on open/page, bounded view state and existing Team query budgets. Measurements are Host/CLI diagnostics, not browser or native performance claims.
