# Operator access: controls and the monthly review

Operators can act on any tenant (`docs/24-threat-model.md` E "Operator console abuse", G "Operator reads tenant data"). This document says how operator access is granted, what protects it, and the checklist run every month. Owner: the security lead; the review is done by someone other than the person whose access is reviewed.

## Controls

| Control | Rule | Where it is enforced |
| --- | --- | --- |
| Individual identity | One account per person, never shared; operator accounts live in a separate identity provider from tenant accounts | Operator IdP; deploy API section 17 (`ops:*` only for accounts flagged `operator`) |
| Hardware MFA | A FIDO2 security key is required to sign in to the operator IdP; no SMS, no TOTP fallback | Operator IdP policy |
| Operator tokens | `renox_op_` tokens of operator accounts carry `ops:read` or `ops:write`, are minted only by an account flagged `operator`, and are revoked at off-boarding; the bootstrap token stays out of band (deploy API section 2); a tenant token, a session or `*` never holds an `ops:*` scope | `control/api` (`control/api/tests/ops-tenants.test.ts`, "a non-operator cannot obtain ops:write…") |
| Reason on every action | Every operator action carries a reason of 10 to 500 characters, stored in the audit row with the operator id and the result | deploy API section 17; `ops-tenants.test.ts` |
| Reads audited | `getOpsTenant` reads are audited like writes (deploy API 0.3.1) | `control/api` |
| Node access | No interactive SSH to worker nodes in normal operation: everything goes through the API. When a shell is needed (an incident), it goes through the bastion with session recording, for a named person and a stated reason, and the session is reviewed in the next monthly review | Bastion; cloud firewall (port 22 closed except from the bastion) |
| Break-glass | Reading a tenant's data or acting as a tenant requires a reason, is time-boxed to 1 hour, is logged, and the tenant owner is notified afterwards | `impersonateTenant` / `endImpersonation` (deploy API 0.4 section 17; `control/api/src/ops/breakglass.ts`, #310): an operator token created with `ops:impersonate` (which no other scope or the bootstrap token grants, at most 1 day), a reason of 10 to 500 characters, a read-only tenant token for 60 minutes, an audit row at start and at end, the owner emailed at both, every request made with it audited as `operator:<acct_id>/<imp_id>`; the console shows the active ones first in `getOpsTenant.actions[]` |

## Granting and removing access

- **On-boarding.** A founder approves in writing (an issue in the private ops tracker); the account is created in the operator IdP with a security key enrolled in person or over video with ID; the operator flag is set on the control-plane account; the grant is recorded in the review log below.
- **Off-boarding** (last working day, or at once on suspicion of compromise): disable the IdP account; revoke every `renox_op_` token of the account; remove the operator flag; remove bastion keys; rotate any shared secret the person could read (`ops/security/keys.md`); record it below.

## Monthly review checklist

Run on the first business day of each month. Copy the list into the review log entry and tick each line.

- [ ] List the operator IdP accounts and the control-plane accounts with the operator flag; every one belongs to a current team member with an on-boarding record. Remove any other.
- [ ] Every operator account has a hardware key enrolled and no other second factor.
- [ ] List live `renox_op_` tokens: owner, scopes, expiry, last use. Revoke tokens unused for 30 days and tokens of people who left.
- [ ] Read the audit rows with an `operator` actor for the month: every action has a reason that matches a ticket, an incident or a support request. Raise anything unexplained with the person, then with a founder.
- [ ] Read every break-glass session of the month: reason, duration (≤ 1 hour), the tenant notification sent (`select * from impersonations where started_at > …`, the `impersonateTenant` and `endImpersonation` audit rows, and the rows whose actor starts with `operator:`).
- [ ] Read the bastion session recordings of the month (if any): each matches an incident or a change record.
- [ ] Check that the cloud firewall still closes port 22 on worker nodes except from the bastion.
- [ ] Note the findings and the actions taken in the log below; a finding that needs work becomes a `security` issue.

## Review log

| Month | Reviewer | Accounts | Tokens revoked | Findings (issues) |
| --- | --- | --- | --- | --- |
| _first review pending_ | | | | |
