// Account pages that talk to the control API from the browser (#445, #446;
// ADR D23): sign-in with email and password and the second factor, sign-up,
// email verification, forgotten password, the device approval of
// `renox login`, and tokens. The dashboard must not proxy these flows (the
// API's per-IP buckets would see the node's address for every user), so this
// script calls the API itself with its session cookie (`credentials:
// "include"`) and the CSRF header the API hands out. The API answers CORS for
// the dashboard's origin only (control/api/src/cors.ts).
//
// The dashboard server never sees a password, a code, or the API session.
// It receives one thing: after a password sign-in, a one-day `dashboard`
// token with the role's scopes (lib/scopes.ts), posted to /signin like a
// pasted token. A new token's value on the Tokens page is shown once and
// goes nowhere else. Messages come from the page (#account-msgs), so they
// are translated like the rest of it.
(function () {
  "use strict";

  // ---------------------------------------------------------- workspace id (pure; tested without a browser)

  const ID_MAX = 63;

  /** The id a workspace name suggests: "Al Noor Clinic" -> "al-noor-clinic"; "" when nothing Latin is left (the person types one). */
  function slugify(name) {
    let s = String(name).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
    if (s.length > ID_MAX) s = s.slice(0, ID_MAX).replace(/[-_]+$/, "");
    return s;
  }

  /**
   * Why an id is refused, or null: { kind: "start" | "char" | "length", char, index }.
   * `char` is the first offending character ("start": the first character, which may not be - or _).
   */
  function idProblem(id) {
    let index = 0;
    for (const ch of String(id)) {
      if (!/[a-z0-9_-]/.test(ch)) return { kind: index === 0 ? "start" : "char", char: ch, index };
      if (index === 0 && !/[a-z0-9]/.test(ch)) return { kind: "start", char: ch, index };
      index += 1;
    }
    if (String(id).length > ID_MAX) return { kind: "length", char: "", index: ID_MAX };
    return null;
  }

  /** What to offer when an id is taken: "al-noor" -> "al-noor-2", "al-noor-2" -> "al-noor-3" (63 characters at most). */
  function suggestId(id) {
    const m = /^(.*?)-(\d+)$/.exec(id);
    const base = m ? m[1] : id;
    const n = m ? Number(m[2]) + 1 : 2;
    const tail = "-" + n;
    return base.slice(0, ID_MAX - tail.length).replace(/[-_]+$/, "") + tail;
  }

  /**
   * The id field follows the name until the person edits the id by hand.
   * `name(v)` is the name typed: returns the id to show (unchanged once locked);
   * `edit(v)` is the id typed by hand: locks the derivation (emptying the id unlocks it).
   */
  function idSync(initial) {
    let id = initial || "";
    let locked = id !== "";
    return {
      name(v) { if (!locked) id = slugify(v); return id; },
      edit(v) { id = v; locked = v !== ""; return id; },
      get id() { return id; },
      get locked() { return locked; },
    };
  }

  const pure = { slugify, idProblem, suggestId, idSync, ID_MAX };
  if (typeof module !== "undefined" && module.exports) module.exports = pure;
  if (typeof document === "undefined") return;
  const root = document.getElementById("account");
  if (!root) return;
  const API = (root.dataset.api || "").replace(/\/+$/, "");
  const PAGE = root.dataset.page;
  const $ = (id) => document.getElementById(id);
  const msg = (k) => {
    const el = document.querySelector('#account-msgs [data-k="' + k + '"]');
    return el ? el.textContent.trim() : k;
  };
  const hide = (...ids) => ids.forEach((id) => $(id) && ($(id).hidden = true));
  const show = (...ids) => ids.forEach((id) => $(id) && ($(id).hidden = false));
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

  function error(text) {
    const box = $("account-error");
    if (!box) return;
    box.querySelector("strong").textContent = text;
    box.hidden = !text;
    if (text) box.scrollIntoView({ block: "nearest" });
  }
  function notice(text) {
    const box = $("account-notice");
    if (!box) return;
    box.textContent = text;
    box.hidden = !text;
  }

  /** One API call: `{ ok, status, body, retryAfter }`; status 0 when the API could not be reached. */
  async function call(method, path, body, csrf) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (csrf) headers["x-renox-csrf"] = csrf;
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "include", mode: "cors", cache: "no-store" });
    } catch (e) {
      return { ok: false, status: 0, body: null, retryAfter: null };
    }
    let data = null;
    if (res.status !== 204) {
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
    }
    return { ok: res.ok, status: res.status, body: data, retryAfter: res.headers.get("retry-after") };
  }

  const details = (r) => (r.body && r.body.error && Array.isArray(r.body.error.details) ? r.body.error.details : []);
  const reasonOf = (r, field) => {
    const d = details(r).find((x) => x && x.field === field);
    return d ? d.reason : null;
  };

  /** The words for a failed call that has no more specific message. */
  function failure(r) {
    if (r.status === 0) return msg("unreachable") + " (" + new URL(API).host + ")";
    if (r.status === 429) return msg("too_many") + (r.retryAfter ? " (" + r.retryAfter + " s)" : "");
    const e = r.body && r.body.error;
    const first = details(r)[0];
    const why = first && first.reason ? " " + (first.field ? first.field + ": " : "") + first.reason + "." : "";
    return (e && e.message ? e.message : msg("failed")) + why + (e && e.request_id ? " (request id " + e.request_id + ")" : "");
  }

  function busy(form, on) {
    if (!form) return;
    for (const b of form.querySelectorAll("button")) b.disabled = on;
  }

  // ------------------------------------------------------------ sign-in

  /** The signed-in API session: its CSRF value, role and tenant. */
  const state = { csrf: null, role: null, tenant: null, verified: true };

  /** Creates the dashboard's own token and hands it to /signin (lib/scopes.ts). */
  async function finish() {
    if (!state.tenant || !state.role) return error(msg("no_workspace"));
    let scopes = [];
    try {
      scopes = JSON.parse(root.dataset.scopes || "{}")[state.role] || [];
    } catch (e) {
      scopes = [];
    }
    if (scopes.length === 0) return error(msg("failed"));
    notice(msg("signing_in"));
    const days = Number(root.dataset.days || "1");
    const r = await call("POST", "/v1/tokens", { name: "dashboard", scopes, expires_in_days: days }, state.csrf);
    if (!r.ok) {
      notice("");
      if (r.status === 401 && reasonOf(r, "mfa")) return mfa(reasonOf(r, "mfa") === "enrol" ? "enrol" : "verify");
      if (r.status === 403 && reasonOf(r, "mfa") === "step_up_required") return mfa("verify");
      return error(failure(r));
    }
    const form = $("dashboard-signin");
    form.elements.token.value = r.body.token;
    form.submit();
  }

  /** After the password (or the second factor): an unverified address first gets the choice to resend. */
  function signedIn() {
    hide("password-form", "mfa-verify", "mfa-enrol", "recovery");
    if (!state.verified) {
      show("unverified");
      return;
    }
    return finish();
  }

  async function mfa(kind) {
    hide("password-form", "unverified");
    error("");
    if (kind === "verify") {
      show("mfa-verify");
      const pk = $("mfa-passkey");
      if (pk && window.PublicKeyCredential) pk.hidden = false;
      $("mfa-verify").elements.code.focus();
      return;
    }
    // enrol: an authenticator app, set up here (a passkey can be added later on /account/security).
    const r = await call("POST", "/v1/account/mfa/totp", {}, state.csrf);
    if (!r.ok) return error(failure(r));
    $("totp-secret").textContent = r.body.secret;
    $("totp-uri").href = r.body.otpauth_uri;
    show("mfa-enrol");
    $("mfa-enrol").elements.code.focus();
  }

  function signinPage() {
    const form = $("password-form");
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error("");
      busy(form, true);
      const r = await call("POST", "/v1/account/login", { email: form.elements.email.value.trim(), password: form.elements.password.value });
      busy(form, false);
      if (!r.ok) return error(r.status === 401 ? msg("wrong_password") : failure(r));
      form.elements.password.value = "";
      state.csrf = r.body.csrf;
      state.role = r.body.role;
      state.tenant = r.body.tenant_id;
      state.verified = r.body.email_verified !== false;
      if (r.body.mfa === "verify" || r.body.mfa === "enrol") return mfa(r.body.mfa);
      return signedIn();
    });

    const verify = $("mfa-verify");
    verify.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error("");
      const code = verify.elements.code.value.trim();
      // A recovery code is ten letters and digits (xxxxx-xxxxx); an app's code is six digits.
      const method = /^\d{6,8}$/.test(code.replace(/\s/g, "")) ? "totp" : "recovery";
      busy(verify, true);
      const r = await call("POST", "/v1/account/mfa/verify", { method, code }, state.csrf);
      busy(verify, false);
      if (!r.ok) return error(r.status === 401 ? msg("bad_code") : failure(r));
      return signedIn();
    });

    $("mfa-passkey").addEventListener("click", async () => {
      error("");
      const c = await call("POST", "/v1/account/mfa/challenge", {}, state.csrf);
      if (!c.ok) return error(failure(c));
      try {
        const cred = await navigator.credentials.get({
          publicKey: {
            challenge: unb64u(c.body.challenge),
            rpId: c.body.rpId,
            allowCredentials: (c.body.allowCredentials || []).map((x) => ({ type: "public-key", id: unb64u(x.id) })),
            userVerification: c.body.userVerification || "preferred",
          },
        });
        const r = await call(
          "POST",
          "/v1/account/mfa/verify",
          {
            method: "passkey",
            credential_id: b64u(cred.rawId),
            client_data: b64u(cred.response.clientDataJSON),
            authenticator_data: b64u(cred.response.authenticatorData),
            signature: b64u(cred.response.signature),
          },
          state.csrf,
        );
        if (!r.ok) return error(r.status === 401 ? msg("passkey_failed") : failure(r));
        return signedIn();
      } catch (e) {
        return error(msg("passkey_failed") + " " + (e && e.message ? e.message : ""));
      }
    });

    const enrol = $("mfa-enrol");
    enrol.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error("");
      busy(enrol, true);
      const r = await call("POST", "/v1/account/mfa/totp/confirm", { code: enrol.elements.code.value.trim() }, state.csrf);
      busy(enrol, false);
      if (!r.ok) return error(r.status === 422 || r.status === 400 ? msg("bad_code") : failure(r));
      hide("mfa-enrol");
      const codes = r.body.recovery_codes || [];
      if (codes.length === 0) return signedIn();
      const list = $("recovery-list");
      list.textContent = "";
      for (const code of codes) {
        const li = document.createElement("li");
        const el = document.createElement("code");
        el.textContent = code;
        li.append(el);
        list.append(li);
      }
      show("recovery");
    });
    $("recovery-done").addEventListener("click", () => signedIn());

    $("resend").addEventListener("click", async () => {
      const r = await call("POST", "/v1/account/verify/resend", {}, state.csrf);
      if (!r.ok) return error(failure(r));
      notice(msg("sent"));
    });
    $("unverified-continue").addEventListener("click", () => {
      state.verified = true;
      hide("unverified");
      return finish();
    });

    // From the verification link (/signup/verify) or the device page: the browser may already hold an API session.
    if (new URLSearchParams(location.search).get("continue") === "1") {
      call("GET", "/v1/account").then((r) => {
        if (!r.ok) return;
        state.csrf = r.body.csrf;
        state.role = r.body.role;
        state.tenant = r.body.tenant_id;
        state.verified = r.body.email_verified !== false;
        hide("password-form");
        return finish();
      });
    }
  }

  // ------------------------------------------------------------ sign-up, verification, password reset

  /** The rule and the first offending character, as text (translated by the page). */
  function idMessage(id) {
    const p = idProblem(id);
    if (!p) return "";
    if (p.kind === "length") return msg("err_workspace");
    const shown = p.char === " " ? msg("id_space") : '"' + p.char + '"';
    return msg("err_workspace") + " " + (p.kind === "start" ? msg("id_bad_start") : msg("id_bad_char")) + " " + shown;
  }

  function signupPage() {
    const form = $("signup-form");
    const nameEl = form.elements.tenant_name;
    const idEl = form.elements.tenant_id;
    const idError = $("id-error");
    const sync = idSync(idEl.value);
    const checkId = () => {
      const text = idMessage(idEl.value);
      idError.textContent = text;
      idError.hidden = text === "";
      idEl.setCustomValidity(text);
      idEl.setAttribute("aria-invalid", text ? "true" : "false");
    };
    nameEl.addEventListener("input", () => {
      idEl.value = sync.name(nameEl.value);
      checkId();
    });
    idEl.addEventListener("input", () => {
      sync.edit(idEl.value);
      checkId();
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error("");
      const f = form.elements;
      const body = {
        email: f.email.value.trim().toLowerCase(),
        password: f.password.value,
        tenant_id: f.tenant_id.value.trim(),
        tenant_name: f.tenant_name.value.trim() || f.tenant_id.value.trim(),
        dpa_accepted: true,
      };
      if (body.password.length < 12) return error(msg("err_password"));
      if (!f.dpa.checked) return error(msg("err_accept"));
      busy(form, true);
      const r = await call("POST", "/v1/account/signup", body);
      busy(form, false);
      if (!r.ok) {
        if (r.status === 409) return error(msg("err_taken") + " " + msg("id_try") + " " + suggestId(body.tenant_id));
        if (reasonOf(r, "email") === "disposable") return error(msg("err_disposable"));
        if (r.status === 429) return error(msg("err_too_many"));
        return error(failure(r));
      }
      f.password.value = "";
      $("sent-email").textContent = body.email;
      hide("signup-form", "signup-more");
      show("signup-sent");
    });
  }

  /** The single-use token of a mail link, from the URL fragment (never sent to a server by the browser). */
  const fragmentToken = () => {
    const m = /(?:^|[#&])token=([a-z2-7]{32})(?:&|$)/.exec(location.hash);
    return m ? m[1] : null;
  };

  async function verifyPage() {
    const token = fragmentToken();
    if (!token) return error(msg("err_incomplete"));
    // The fragment goes away at once, so a reload or a shared screen does not reuse it.
    history.replaceState(null, "", location.pathname);
    notice(msg("verifying"));
    const r = await call("POST", "/v1/account/verify", { token });
    notice("");
    if (!r.ok) return error(r.status === 404 ? msg("err_used") : r.status === 429 ? msg("err_attempts") : failure(r));
    if (r.body.tenant_id) $("verified-tenant").textContent = r.body.tenant_id;
    show("verified");
    // The API signed this browser in: continue into the dashboard without a detour.
    location.assign("/signin?continue=1&next=" + encodeURIComponent("/apps"));
  }

  function forgotPage() {
    const form = $("forgot-form");
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error("");
      busy(form, true);
      const r = await call("POST", "/v1/account/password-reset", { email: form.elements.email.value.trim() });
      busy(form, false);
      if (!r.ok) return error(failure(r));
      hide("forgot-form");
      show("forgot-sent");
    });
  }

  function resetPage() {
    const token = fragmentToken();
    const form = $("reset-form");
    if (!token) {
      hide("reset-form");
      return error(msg("err_incomplete"));
    }
    history.replaceState(null, "", location.pathname);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error("");
      const f = form.elements;
      if (f.password.value.length < 12) return error(msg("err_password"));
      if (f.password.value !== f.again.value) return error(msg("err_mismatch"));
      busy(form, true);
      const r = await call("POST", "/v1/account/password-reset/confirm", { token, password: f.password.value });
      busy(form, false);
      if (!r.ok) return error(r.status === 404 ? msg("err_used") : failure(r));
      f.password.value = "";
      f.again.value = "";
      hide("reset-form");
      show("reset-done");
    });
  }

  // ------------------------------------------------------------ device approval and tokens (#446)

  const utc = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

  /** The browser's API session (its CSRF value and role), or the sign-in box when it has ended. */
  async function apiSession() {
    const r = await call("GET", "/v1/account");
    if (!r.ok) {
      if (r.status === 401) show("api-signin");
      else error(failure(r));
      return false;
    }
    state.csrf = r.body.csrf;
    state.role = r.body.role;
    state.tenant = r.body.tenant_id;
    return true;
  }

  /** Scope checkboxes: the scopes the role may grant, `checked` preselected. */
  function scopeBoxes(boxId, checked) {
    const box = $(boxId);
    box.textContent = "";
    let grantable = [];
    try {
      grantable = JSON.parse(root.dataset.grantable || "{}")[state.role] || [];
    } catch (e) {
      grantable = [];
    }
    for (const scope of grantable) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "scope";
      input.value = scope;
      input.checked = checked === null || checked.includes(scope);
      const code = document.createElement("code");
      code.textContent = scope;
      label.append(input, " ", code);
      box.append(label);
    }
  }
  const chosen = (boxId) => [...$(boxId).querySelectorAll('input[name="scope"]:checked')].map((i) => i.value);

  /** Runs `fn`; when the API asks for a recent second factor, asks for a code first and runs it again. */
  let pendingStepUp = null;
  async function withStepUp(fn) {
    const r = await fn();
    if (r && r.status === 403 && reasonOf(r, "mfa") === "step_up_required") {
      pendingStepUp = fn;
      show("step-up");
      $("step-up").elements.code.focus();
      return null;
    }
    return r;
  }
  function stepUpForm(after) {
    const form = $("step-up");
    if (!form) return;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error("");
      const code = form.elements.code.value.trim();
      const method = /^\d{6,8}$/.test(code.replace(/\s/g, "")) ? "totp" : "recovery";
      const r = await call("POST", "/v1/account/mfa/verify", { method, code }, state.csrf);
      if (!r.ok) return error(r.status === 401 ? msg("bad_code") : failure(r));
      form.elements.code.value = "";
      hide("step-up");
      const fn = pendingStepUp;
      pendingStepUp = null;
      if (fn) after(await fn());
    });
  }

  async function devicePage() {
    if (!(await apiSession())) {
      hide("device-code");
      return;
    }
    let code = "";
    const lookup = async (raw) => {
      error("");
      code = raw.trim().toUpperCase();
      if (/^[A-Z]{8}$/.test(code)) code = code.slice(0, 4) + "-" + code.slice(4);
      const r = await call("POST", "/v1/account/device/lookup", { user_code: code }, state.csrf);
      if (!r.ok) return error(r.status === 404 ? msg("not_found") : failure(r));
      $("device-user-code").textContent = r.body.user_code;
      $("device-name").textContent = r.body.name;
      $("device-asked").textContent = utc(r.body.created_at);
      $("device-expires").textContent = utc(r.body.expires_at);
      scopeBoxes("device-scopes", null);
      hide("device-code");
      show("device-request");
    };
    $("device-code").addEventListener("submit", (ev) => {
      ev.preventDefault();
      lookup($("device-code").elements.code.value);
    });
    const done = (r) => {
      if (!r) return;
      if (!r.ok) return error(r.status === 404 ? msg("not_found") : failure(r));
      hide("device-request");
      show("device-approved");
    };
    $("device-request").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error("");
      const scopes = chosen("device-scopes");
      if (scopes.length === 0) return error(msg("no_scope"));
      busy($("device-request"), true);
      done(await withStepUp(() => call("POST", "/v1/account/device/approve", { user_code: code, scopes }, state.csrf)));
      busy($("device-request"), false);
    });
    $("device-deny").addEventListener("click", async () => {
      error("");
      const r = await call("POST", "/v1/account/device/deny", { user_code: code }, state.csrf);
      if (!r.ok) return error(r.status === 404 ? msg("not_found") : failure(r));
      hide("device-request");
      show("device-denied");
    });
    stepUpForm(done);
    if (root.dataset.code) lookup(root.dataset.code);
  }

  async function tokensPage() {
    if (!(await apiSession())) return;
    show("token-create", "token-list-panel");
    scopeBoxes("token-scopes", ["apps:read", "deploy", "logs:read"]);
    const list = async () => {
      const r = await call("GET", "/v1/tokens");
      if (!r.ok) return error(failure(r));
      const rows = $("token-rows");
      rows.textContent = "";
      const live = r.body.tokens.filter((t) => t.revoked_at === null && t.expires_at > Date.now());
      $("token-empty").hidden = live.length > 0;
      for (const t of live) {
        const tr = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = t.name;
        // The scopes as chips that wrap inside their cell, not one word per line.
        const scopes = document.createElement("td");
        scopes.className = "scopes";
        for (const s of t.scopes) {
          const code = document.createElement("code");
          code.textContent = s;
          scopes.append(code, " ");
        }
        tr.append(name, scopes);
        const heads = [...document.querySelectorAll("table.tokens thead th")].map((th) => th.textContent.trim());
        for (const [i, text] of [utc(t.expires_at), t.last_used_at === null ? msg("never") : utc(t.last_used_at)].entries()) {
          const td = document.createElement("td");
          td.className = "when";
          // The column's name, shown before the date when the rows stack on a phone.
          td.dataset.label = heads[2 + i] || "";
          // A <bdi> keeps "2026-11-04 15:49 UTC" in order on an Arabic page.
          const bdi = document.createElement("bdi");
          bdi.textContent = text;
          td.append(bdi);
          tr.append(td);
        }
        const td = document.createElement("td");
        td.className = "end";
        const b = document.createElement("button");
        b.type = "button";
        b.className = "danger";
        b.textContent = msg("revoke");
        b.dataset.token = t.id;
        b.addEventListener("click", async () => {
          if (!window.confirm(msg("confirm_revoke") + " " + t.name)) return;
          const res = await withStepUp(() => call("DELETE", "/v1/tokens/" + encodeURIComponent(t.id), undefined, state.csrf));
          after(res, msg("revoked"));
        });
        td.append(b);
        tr.append(td);
        rows.append(tr);
      }
    };
    const after = async (r, text) => {
      if (!r) return;
      if (!r.ok) return error(failure(r));
      if (r.body && r.body.token) {
        $("token-value").textContent = r.body.token;
        show("token-new");
        $("token-create").reset();
        scopeBoxes("token-scopes", ["apps:read", "deploy", "logs:read"]);
      } else if (text) notice(text);
      await list();
    };
    $("token-create").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error("");
      hide("token-new");
      const f = $("token-create").elements;
      const scopes = chosen("token-scopes");
      if (scopes.length === 0) return error(msg("no_scope"));
      const body = { name: f.name.value.trim(), scopes, expires_in_days: Number(f.days.value) };
      after(await withStepUp(() => call("POST", "/v1/tokens", body, state.csrf)));
    });
    $("token-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("token-value").textContent);
        notice(msg("copied"));
      } catch (e) {
        // No clipboard permission: the value stays selectable on the page.
      }
    });
    stepUpForm((r) => after(r, msg("revoked")));
    await list();
  }

  const pages = { signin: signinPage, signup: signupPage, verify: verifyPage, forgot: forgotPage, reset: resetPage, device: devicePage, tokens: tokensPage };
  window.renoxAccount = { call, error, notice, msg, show, hide, failure, reasonOf, busy, b64u, unb64u, state };
  if (pages[PAGE]) pages[PAGE]();
})();
