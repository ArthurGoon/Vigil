import { api } from "./api.js";
import { trackPage } from "./track.js";

trackPage("/login.html");

const form = document.getElementById("login-form");
const statusEl = document.getElementById("login-status");
const devBox = document.getElementById("dev-link-box");
const devLink = document.getElementById("dev-link");
const googleBtn = document.getElementById("google-btn");
const googleDivider = document.getElementById("google-divider");

initGoogle();

// Google login is optional: the button only shows up when the server has
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
async function initGoogle() {
  try {
    const data = await api("/auth/google/config");
    if (data.enabled) {
      googleBtn?.classList.remove("hidden");
      googleDivider?.classList.remove("hidden");
    }
  } catch {
    /* keep magic link only */
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusEl.className = "form-status";
  statusEl.textContent = "Enviando…";
  devBox.classList.add("hidden");

  const email = new FormData(form).get("email");

  try {
    const data = await api("/auth/magic-link", {
      method: "POST",
      body: JSON.stringify({ email }),
    });

    statusEl.className = "form-status ok";
    statusEl.textContent = data.devLink
      ? "Modo local: use o link abaixo (também está no terminal da API)."
      : "Link enviado. Confira seu e-mail.";

    if (data.devLink) {
      devBox.classList.remove("hidden");
      const url = new URL(data.devLink, window.location.origin);
      url.searchParams.set("redirect", "/app.html");
      const href = `${url.pathname}${url.search}`;
      devLink.href = href;
      devLink.textContent = href;
    }
  } catch (err) {
    statusEl.className = "form-status error";
    statusEl.textContent = err.message || "Falha ao enviar link.";
  }
});
