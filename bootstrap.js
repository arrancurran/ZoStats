var ZoStats;

function log(message) {
  Zotero.debug(`ZoStats: ${message}`);
}

function install() {
  log("Installed");
}

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  if (Zotero.PreferencePanes?.register) {
    Zotero.PreferencePanes.register({
      pluginID: id,
      id: "zostats-preferences",
      label: "ZoStats",
      image: rootURI + "icons/stats.svg",
      src: rootURI + "preferences.xhtml",
      scripts: [rootURI + "preferences.js"]
    });
  }
  Services.scriptloader.loadSubScript(rootURI + "zostats.js");
  ZoStats.addToAllWindows();
  ZoStats.init({ pluginID: id, rootURI });
  log("Started");
}

function onMainWindowLoad({ window }) {
  ZoStats?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  ZoStats?.removeFromWindow(window);
}

function shutdown() {
  if (ZoStats) {
    ZoStats.shutdown();
    ZoStats = undefined;
  }
  log("Stopped");
}

function uninstall() {
  log("Uninstalled");
}
