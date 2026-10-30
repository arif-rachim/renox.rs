// The passkey step of /account/security (#307): the page renders the API's
// registration options; this asks the browser for a credential and fills
// the form the server action sends on to the API. No other script runs.
(function () {
  const box = document.getElementById("passkey-setup");
  const form = document.getElementById("passkey-form");
  if (!box || !form || !window.PublicKeyCredential) return;
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  form.addEventListener(
    "submit",
    async (ev) => {
      if (form.elements.client_data.value) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const o = JSON.parse(box.dataset.options || "{}");
      const publicKey = {
        ...o,
        challenge: unb64u(o.challenge),
        user: { ...o.user, id: unb64u(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: unb64u(c.id) })),
      };
      try {
        const cred = await navigator.credentials.create({ publicKey });
        form.elements.client_data.value = b64u(cred.response.clientDataJSON);
        form.elements.attestation_object.value = b64u(cred.response.attestationObject);
        form.requestSubmit();
      } catch (e) {
        const p = document.createElement("p");
        p.className = "problem";
        p.textContent = "No passkey was created: " + e.message;
        form.after(p);
      }
    },
    true,
  );
})();
