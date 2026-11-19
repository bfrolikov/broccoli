"use strict";
const $ = (id) => document.getElementById(id);
let epoch = 0,
  draftQueue = Promise.resolve(),
  busy = false,
  authView = "login",
  validatedRecovery = null,
  categoryLoaded = false,
  categoryRevision = 0,
  viewRevision = 0,
  categorySave = null;
let usernameEdited = false;
const authForms = ["login", "register", "recovery-code", "recovery-password"];
const authFocus = {
  login: "username",
  register: "register-email",
  "recovery-code": "recovery-email",
  "recovery-password": "new-password",
};
const invalidCodeMessage = "This code is invalid or expired. Enter another code or request a new one.";
async function send(message) {
  const result = await extensionAPI.runtime.sendMessage(message);
  if (result?.error) throw Error(result.error);
  return result;
}
function persistDraft() {
  const draft = { username: $("username").value };
  draftQueue = draftQueue
    .catch(() => {})
    .then(async () => {
      await ready;
      return send({ type: "draftSet", epoch, draft });
    });
  draftQueue.catch(() => {
    $("status").textContent = "Unable to remember your email or username.";
  });
  return draftQueue;
}
$("username").addEventListener("input", () => {
  usernameEdited = true;
  persistDraft();
});
let options = [],
  selected = [];
function renderCategories(focusName) {
  $("category-options").replaceChildren();
  $("selected-categories").replaceChildren();
  for (const name of options) {
    const label = document.createElement("label"),
      checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.includes(name);
    checkbox.addEventListener("change", () => {
      selected = checkbox.checked ? [...selected, name] : selected.filter(c => c !== name);
      categoryRevision++;
      renderCategories(name);
      saveCategories();
    });
    label.append(checkbox, document.createTextNode(name));
    $("category-options").append(label);
    if (name === focusName) checkbox.focus();
  }
  for (const name of selected) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name + " ×";
    button.setAttribute("aria-label", "Remove " + name);
    button.addEventListener("click", () => {
      selected = selected.filter(c => c !== name);
      categoryRevision++;
      renderCategories();
      $("new-category").focus();
      saveCategories();
    });
    $("selected-categories").append(button);
  }
}
function addCategory() {
  const name = $("new-category").value.trim();
  if (!name || !categoryLoaded) return;
  $("new-category").value = "";
  if (selected.includes(name)) return;
  if (!options.includes(name)) options.push(name);
  selected.push(name);
  categoryRevision++;
  renderCategories();
  return saveCategories();
}
$("add-category").onclick = addCategory;
$("new-category").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addCategory();
  }
});
function setBusy(value) {
  busy = value;
  for (const id of [
    "username", "password", "login-button", "show-register", "show-recovery",
    "register-email", "register-password", "register-button", "back-to-login",
    "recovery-email", "send-code", "reset-code", "check-code", "cancel-recovery",
    "new-password", "confirm-password", "reset-password", "cancel-reset", "logout",
  ])
    $(id).disabled = value;
}
async function loadCategories() {
  const revision = categoryRevision,
    view = viewRevision;
  $("category-status").textContent = "Loading categories…";
  $("retry-categories").hidden = true;
  $("category-editor").disabled = true;
  try {
    const data = await send({ type: "categoriesGet" });
    if (view !== viewRevision) return;
    if (revision === categoryRevision) {
      selected = [...new Set(data.categories)];
      options = [...selected];
      renderCategories();
    }
    $("category-editor").disabled = false;
    categoryLoaded = true;
    $("category-status").textContent = "";
  } catch (e) {
    if (view === viewRevision) {
      $("category-status").textContent = e.message;
      $("retry-categories").hidden = false;
    }
  }
}
function showAuthForm(loggedIn) {
  for (const form of authForms) $(form).hidden = loggedIn || authView !== form;
}
function clearRecovery() {
  validatedRecovery = null;
  for (const id of ["recovery-email", "reset-code", "new-password", "confirm-password"])
    $(id).value = "";
}
function switchAuthForm(view) {
  if (busy) return;
  authView = view;
  $("password").value = "";
  $("register-password").value = "";
  clearRecovery();
  if (view === "recovery-code") {
    const email = $("recovery-email");
    email.value = $("username").value.trim();
    if (!email.checkValidity()) email.value = "";
  }
  $("status").textContent = "";
  showAuthForm(false);
  $(authFocus[view]).focus();
}
$("show-register").onclick = () => switchAuthForm("register");
$("show-recovery").onclick = () => switchAuthForm("recovery-code");
for (const id of ["back-to-login", "cancel-recovery", "cancel-reset"])
  $(id).onclick = () => switchAuthForm("login");
async function update() {
  const s = await send({ type: "status" });
  showAuthForm(s.loggedIn);
  $("logout").hidden = !s.loggedIn;
  $("category-section").hidden = !s.loggedIn;
  if (!s.loggedIn) {
    viewRevision++;
    categoryLoaded = false;
    categorySave = null;
    selected = [];
    options = [];
    renderCategories();
    $("category-status").textContent = "";
    $("retry-categories").hidden = true;
    $("new-category").value = "";
    $("category-editor").disabled = true;
  } else if (!categoryLoaded) await loadCategories();
  return s;
}
async function readDraft() {
  const data = await send({ type: "draftGet" });
  epoch = data.epoch;
  return data.draft;
}
const ready = (async () => {
  const draft = await readDraft();
  if (!usernameEdited) $("username").value = draft.username || "";
  await update();
})();
ready.catch((e) => {
  $("status").textContent = e.message;
});
async function action(fn) {
  if (busy) return;
  const previousView = authView;
  setBusy(true);
  $("status").textContent = "Working…";
  try {
    const message = await fn();
    await update();
    $("status").textContent = message ?? "Saved.";
  } catch (e) {
    $("status").textContent = e.message;
    try {
      await update();
    } catch {}
  } finally {
    setBusy(false);
    if (authView !== previousView && !$(authView).hidden) $(authFocus[authView]).focus();
  }
}
$("login").onsubmit = (e) => {
  e.preventDefault();
  if (busy) return;
  const username = $("username").value,
    password = $("password").value;
  return action(async () => {
    await persistDraft();
    await send({ type: "login", username, password });
    $("password").value = "";
    await readDraft();
    viewRevision++;
    categoryLoaded = false;
    categorySave = null;
  });
};
function validateNewPassword(password) {
  if ([...password].length >= 8 && new TextEncoder().encode(password).length <= 72)
    return true;
  $("status").textContent = "Use at least 8 characters and at most 72 UTF-8 bytes.";
  return false;
}
$("register").onsubmit = (e) => {
  e.preventDefault();
  if (busy) return;
  const email = $("register-email").value.trim(),
    password = $("register-password").value;
  if (!validateNewPassword(password)) return;
  return action(async () => {
    await ready;
    await draftQueue;
    const result = await send({ type: "register", email, password });
    authView = "login";
    $("register-password").value = "";
    $("register-email").value = "";
    $("password").value = "";
    $("username").value = email;
    await readDraft();
    return result.signedIn ? "Account created." : "Account created. Please log in.";
  });
};
function recoveryEmail() {
  const input = $("recovery-email");
  input.value = input.value.trim();
  if (!input.checkValidity() || new TextEncoder().encode(input.value).length > 254) {
    $("status").textContent = "Enter a valid account email address.";
    input.focus();
    return "";
  }
  return input.value;
}
$("send-code").onclick = () => {
  if (busy || authView !== "recovery-code") return;
  const email = recoveryEmail();
  if (!email) return;
  return action(async () => {
    await ready;
    await send({ type: "requestResetCode", email });
    return "If an account exists for this email, a reset code will be sent.";
  });
};
$("recovery-code").onsubmit = (e) => {
  e.preventDefault();
  if (busy || authView !== "recovery-code") return;
  const email = recoveryEmail();
  if (!email) return;
  const token = $("reset-code").value;
  if (!/^[0-9]{6}$/.test(token)) {
    $("status").textContent = "Enter the six-digit reset code.";
    $("reset-code").focus();
    return;
  }
  return action(async () => {
    await ready;
    const { valid } = await send({ type: "checkResetCode", email, token });
    if (!valid) return invalidCodeMessage;
    validatedRecovery = { email, token };
    $("reset-code").value = "";
    authView = "recovery-password";
    return "";
  });
};
$("recovery-password").onsubmit = (e) => {
  e.preventDefault();
  if (busy || authView !== "recovery-password" || !validatedRecovery) return;
  const password = $("new-password").value;
  if (!validateNewPassword(password)) {
    $("new-password").focus();
    return;
  }
  if (password !== $("confirm-password").value) {
    $("status").textContent = "The passwords do not match.";
    $("confirm-password").focus();
    return;
  }
  const { email, token } = validatedRecovery;
  return action(async () => {
    await draftQueue.catch(() => {});
    const result = await send({ type: "resetPassword", email, token, password });
    clearRecovery();
    if (result.invalidCode) {
      $("recovery-email").value = email;
      authView = "recovery-code";
      return invalidCodeMessage;
    }
    authView = "login";
    $("username").value = email;
    $("password").value = "";
    await readDraft();
    return "Password reset. Log in with your new password.";
  });
};
$("logout").onclick = () =>
  action(async () => {
    viewRevision++;
    categoryLoaded = false;
    categorySave = null;
    $("category-editor").disabled = true;
    try {
      await draftQueue;
      await send({ type: "logout" });
    } finally {
      const draft = await readDraft();
      $("username").value = draft.username || "";
      $("password").value = "";
    }
  });
function saveCategories() {
  if (!categoryLoaded) return Promise.resolve();
  if (categorySave) return categorySave;
  const view = viewRevision;
  $("retry-categories").hidden = true;
  $("category-status").textContent = "Saving…";
  categorySave = (async () => {
    try {
      while (view === viewRevision && categoryLoaded) {
        const revision = categoryRevision;
        await send({ type: "categoriesSet", categories: [...selected] });
        if (view !== viewRevision) return;
        if (revision === categoryRevision) {
          $("category-status").textContent = "Categories saved.";
          return;
        }
      }
    } catch (error) {
      if (view === viewRevision) {
        $("category-status").textContent = "Unable to save categories. " + error.message;
        $("retry-categories").hidden = false;
      }
    } finally {
      if (view === viewRevision) categorySave = null;
    }
  })();
  return categorySave;
}
$("category-form").onsubmit = (e) => {
  e.preventDefault();
  return addCategory();
};
$("retry-categories").onclick = () =>
  categoryLoaded ? saveCategories() : loadCategories();
