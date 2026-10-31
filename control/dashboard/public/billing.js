// The card step of /billing (#325): the page renders Stripe's publishable
// key and the setup's client secret; this mounts Stripe's card form in its
// own frame, confirms the setup with Stripe, and lets the form send only the
// setup id on to the API. The card number never reaches Renox.
(function () {
  const box = document.getElementById("card-setup");
  const form = document.getElementById("card-form");
  if (!box || !form) return;
  let confirmed = false;
  const s = document.createElement("script");
  s.src = "https://js.stripe.com/v3/";
  s.onload = () => {
    const stripe = window.Stripe(box.dataset.key);
    const card = stripe.elements().create("card");
    card.mount("#card-element");
    form.addEventListener(
      "submit",
      async (ev) => {
        if (confirmed) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const r = await stripe.confirmCardSetup(box.dataset.secret, { payment_method: { card } });
        if (r.error) {
          box.querySelector("p").textContent = r.error.message || "The card was not accepted.";
          return;
        }
        confirmed = true;
        form.requestSubmit();
      },
      true,
    );
  };
  document.head.appendChild(s);
})();
