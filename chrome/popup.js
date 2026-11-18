"use strict";
const $ = (id) => document.getElementById(id);
let epoch = 0,
  draftQueue = Promise.resolve(),
  busy = false,
  registering = false,
  categoryLoaded = false,
  categoryRevision = 0,
  viewRevision = 0,
  categorySave = null;
const touched = new Set();
async function send(message) {
  const result = await extensionAPI.runtime.sendMessage(message);
  if (result?.error) throw Error(result.error);
  return result;
}
function snapshot() {
  return {
    username: $("username").value,
    password: $("password").value,
  };
}
function persistDraft() {
  const draft = snapshot();
  draftQueue = draftQueue
    .catch(() => {})
    .then(async () => {
      await ready;
      return send({ type: "draftSet", epoch, draft });
    });
  draftQueue.catch(() => {
    $("status").textContent = "Unable to preserve login fields.";
  });
  return draftQueue;
}
for (const id of ["username", "password"])
  $(id).addEventListener("input", () => {
    touched.add(id);
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
  for (const id of ["username", "password", "login-button", "show-register", "register-email", "register-password", "register-button", "back-to-login", "logout"])
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
  $("login").hidden = loggedIn || registering;
  $("register").hidden = loggedIn || !registering;
}
function switchAuthForm(register) {
  if (busy) return;
  registering = register;
  $("register-password").value = "";
  $("status").textContent = "";
  showAuthForm(false);
  $(register ? "register-email" : "username").focus();
}
$("show-register").onclick = () => switchAuthForm(true);
$("back-to-login").onclick = () => switchAuthForm(false);
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
  for (const [id, value] of [
    ["username", draft.username || ""],
    ["password", draft.password || ""],
  ])
    if (!touched.has(id)) $(id).value = value;
  await update();
})();
ready.catch((e) => {
  $("status").textContent = e.message;
});
async function action(fn) {
  if (busy) return;
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
$("register").onsubmit = (e) => {
  e.preventDefault();
  if (busy) return;
  const email = $("register-email").value.trim(),
    password = $("register-password").value;
  if ([...password].length < 8 || new TextEncoder().encode(password).length > 72) {
    $("status").textContent = "Use at least 8 characters and at most 72 UTF-8 bytes.";
    return;
  }
  return action(async () => {
    await ready;
    await draftQueue;
    const result = await send({ type: "register", email, password });
    registering = false;
    $("register-password").value = "";
    $("register-email").value = "";
    $("password").value = "";
    $("username").value = email;
    await readDraft();
    return result.signedIn ? "Account created." : "Account created. Please log in.";
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
      $("password").value = draft.password || "";
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
