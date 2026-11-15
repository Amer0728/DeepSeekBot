# Approval Templates and auto approval

A Bot inherits the optional global default, selects one complete shared template, or disables its Reviewer (ADR-0342). Deterministic authorization runs first; Reviewer outcomes are allow for this call or ask-human.

## Sub-features

- `library`: Bot settings → Auto approval → Global default template (DSH Select), existing template library and Reviewer model. No global default means inherited review is off. Read failures remain errors.
- `cli`: `approval-template list --bot <bot>`, `approval-template-global-set <name|off>`, `approval-template-set <bot> <inherit|name|off>`; library create/edit commands retain existing Markdown contents.
- `select`: Channel settings → Auto approval, or composer Workspace Grants panel → Auto approval, uses the same DSH Select. Inheritance shows its effective global source. Specific selection replaces global; Off retains deterministic rules.
- `reviewer`: a covered call leaves an auto-approved record with template identity/version; an uncovered or failed review posts a Human card with the reason and captured version when available. No new model rejection or rejection pause occurs.
- `guard`: effective template/global/Bot policy changes bypass Full Access and model review, retaining Human or explicit management-scope authorization and execution fences (ADR-0249).

## How to get to it (user POV)

Bot mode → Bot settings → Auto approval for global default; open a Bot DM → Channel settings → Auto approval for its selection.

## Driving it with verify-app

Use an isolated Host and its own authenticated CLI. Confirm health and Client console/DOM before each journey. Use the actual CLI Host origin and a private token file; never put tokens in screenshots or args.

1. Capture light/dark global and Bot selection before/after at the same viewport and locale.
2. Set global cautious with the CLI, select inherit through the Client, and read back list --bot: selected @global, source global, effective cautious. Change global to get-work-done: inheritance follows. Select cautious specifically, change global or clear it: the Bot remains cautious. Select Off: effective null, source off.
3. New Bot creation reads back @global; a retained legacy missing field remains Off. Restart verifies persistence without schema changes.
4. Trigger an existing approval through the native tool path. A deterministic saved rule makes zero Reviewer calls. An uncovered call uses the effective template and leaves either the versioned auto-approved record or Human card; answer that card through the normal owner.
5. Edit/switch during an injected Reviewer wait at the Channel Tool Approval seam: this Review retains the old identity/version, the next uses the new one. Missing/unreadable template or model timeout/malformed response posts Human with a reason, even if diagnostics fail. Check canonical Channel records and developer logs.
6. Exercise a policy-management approval under Full Access; Reviewer calls remain zero and only Human or an explicit management rule can authorize effects. Revoke the rule before execution and verify refusal.

## Gotchas

- `/tmp` may already be writable; an ordinary file write there need not reach an approval gate.
- Three-part editing, card-rule table and confirmed bulk deletion fallback are separate issues; this journey does not qualify them.
- Browser screenshots establish Web behavior only. Preserve failed drives and observe before retrying.
