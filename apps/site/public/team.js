const CLERK_JS = "@clerk/clerk-js@6.42.3/dist/clerk.browser.js";
const TEAM_URL = new URL("/team", location.origin).href;
const CALLBACK_URL = new URL("/team?sso-callback", location.origin).href;

const $ = (id) => document.getElementById(id);
const form = $("form");
let clerk;
let signup = null;

function say(text) {
  $("status").textContent = text;
}

function show(id, focus) {
  for (const panel of ["signed-out", "form", "stored"]) $(panel).hidden = panel !== id;
  if (focus) $(id).querySelector("h2")?.focus();
}

function loadClerk(key) {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error("Sign-in could not load. Try again later."));
    let frontendApi;
    try {
      frontendApi = atob(key.split("_")[2]).slice(0, -1);
    } catch {
      return failed();
    }
    const script = document.createElement("script");
    script.src = `https://${frontendApi}/npm/${CLERK_JS}`;
    script.crossOrigin = "anonymous";
    script.dataset.clerkPublishableKey = key;
    script.onload = () => resolve(window.Clerk);
    script.onerror = failed;
    document.head.append(script);
  });
}

async function api(method, body) {
  const token = await clerk.session?.getToken();
  const headers = { authorization: `Bearer ${token}` };
  if (body) headers["content-type"] = "application/json";
  const response = await fetch("/api/signup", {
    method,
    headers,
    body: body && JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `The request failed (${response.status}).`);
  return data;
}

function row(list, name, value) {
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = name;
  detail.textContent = value ?? "none";
  list.append(term, detail);
}

function showStored(focus) {
  const list = $("fields");
  list.replaceChildren();
  row(list, "GitHub username", signup.githubLogin);
  row(list, "Email", signup.email);
  row(list, "Uses keypin", signup.use === "team" ? "With a team" : "On my own");
  if (signup.use === "team") row(list, "Team size", signup.teamSize);
  row(list, "Note", signup.note);
  row(list, "Signed up", new Date(signup.createdAt).toUTCString());
  row(list, "Updated", new Date(signup.updatedAt).toUTCString());
  show("stored", focus);
}

function syncSize() {
  const team = form.elements.use.value === "team";
  $("size").hidden = !team;
  form.querySelector('[name="teamSize"]').required = team;
}

function showForm(focus) {
  form.reset();
  if (signup) {
    form.elements.use.value = signup.use;
    form.elements.teamSize.value = signup.teamSize ?? "";
    form.elements.note.value = signup.note ?? "";
  }
  $("cancel").hidden = !signup;
  syncSize();
  show("form", focus);
}

async function run(work) {
  const buttons = document.querySelectorAll("main button");
  for (const button of buttons) button.disabled = true;
  say("Working…");
  try {
    say(await work());
  } catch (error) {
    say(error.message);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

form.addEventListener("change", syncSize);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    const use = form.elements.use.value;
    const note = form.elements.note.value.trim();
    const body = { use };
    if (use === "team") body.teamSize = form.elements.teamSize.value;
    if (note) body.note = note;
    signup = (await api("PUT", body)).signup;
    showStored(true);
    return "Saved.";
  });
});

$("update").addEventListener("click", () => {
  say("");
  showForm(true);
});

$("cancel").addEventListener("click", () => {
  say("");
  showStored(true);
});

$("delete").addEventListener("click", () =>
  run(async () => {
    await api("DELETE");
    signup = null;
    showForm(true);
    return "Your sign-up is deleted. We store nothing for you now.";
  }),
);

$("sign-in").addEventListener("click", () =>
  run(async () => {
    await clerk.client.signIn.authenticateWithRedirect({
      strategy: "oauth_github",
      redirectUrl: CALLBACK_URL,
      redirectUrlComplete: TEAM_URL,
    });
    return "Opening GitHub…";
  }),
);

for (const button of document.querySelectorAll(".sign-out")) {
  button.addEventListener("click", () =>
    run(async () => {
      await clerk.signOut({ redirectUrl: TEAM_URL });
      return "Signed out.";
    }),
  );
}

async function start() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json().catch(() => ({}));
    if (!response.ok || !config.clerkPublishableKey) {
      throw new Error(config.error ?? "Sign-in is not available right now. Try again later.");
    }
    clerk = await loadClerk(config.clerkPublishableKey);
    await clerk.load();
    if (new URLSearchParams(location.search).has("sso-callback")) {
      await clerk.handleRedirectCallback({
        signInForceRedirectUrl: TEAM_URL,
        signUpForceRedirectUrl: TEAM_URL,
      });
      return;
    }
    if (!clerk.isSignedIn) {
      say("");
      show("signed-out");
      return;
    }
    signup = (await api("GET")).signup;
    say("");
    if (signup) showStored(false);
    else showForm(false);
  } catch (error) {
    say(error.message || "Something went wrong. Try again later.");
  }
}

void start();
