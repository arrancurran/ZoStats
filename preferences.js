var ZoStatsPreferences = {
  prefName: "extensions.zostats.semanticScholarApiKey",
  requestURL: "https://www.semanticscholar.org/product/api#api-key-form",
  initialized: false,
  bound: false,

  readKey() {
    try {
      return Services.prefs.getStringPref(this.prefName, "");
    }
    catch (_) {
      return "";
    }
  },

  writeKey(value) {
    const key = String(value || "").trim();
    if (key) Services.prefs.setStringPref(this.prefName, key);
    else if (Services.prefs.prefHasUserValue(this.prefName)) Services.prefs.clearUserPref(this.prefName);
    return key;
  },

  setStatus(message) {
    const status = document.getElementById("zostats-pref-status");
    if (status) status.textContent = message;
  },

  init() {
    const root = document.getElementById("zostats-preferences");
    const input = document.getElementById("zostats-pref-api-key");
    if (!root || !input) return;

    input.value = this.readKey();
    this.setStatus(input.value ? "An API key is saved." : "Using anonymous API access.");

    if (this.bound) return;
    this.bound = true;

    document.getElementById("zostats-pref-show-key")?.addEventListener("change", event => {
      input.type = event.target.checked ? "text" : "password";
    });
    document.getElementById("zostats-pref-save")?.addEventListener("click", () => {
      const key = this.writeKey(input.value);
      input.value = key;
      this.setStatus(key ? "API key saved. New requests will use authenticated access." : "Using anonymous API access.");
    });
    document.getElementById("zostats-pref-clear")?.addEventListener("click", () => {
      this.writeKey("");
      input.value = "";
      this.setStatus("API key removed. Using anonymous API access.");
    });
    document.getElementById("zostats-pref-request-key")?.addEventListener("click", event => {
      event.preventDefault();
      Zotero.launchURL(this.requestURL);
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") document.getElementById("zostats-pref-save")?.click();
    });
  },

  scheduleInit() {
    const start = () => {
      const root = document.getElementById("zostats-preferences");
      if (!root) {
        setTimeout(start, 0);
        return;
      }
      if (!this.initialized) {
        root.addEventListener("showing", () => this.init());
        this.initialized = true;
      }
      this.init();
    };
    if (typeof Zotero !== "undefined" && Zotero.Promise?.delay) Zotero.Promise.delay().then(start);
    else setTimeout(start, 0);
  }
};

ZoStatsPreferences.scheduleInit();
