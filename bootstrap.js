var ZoStats;

function log(message) {
  Zotero.debug(`ZoStats: ${message}`);
}

function install() {
  log("Installed");
}

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "zostats.js");
  ZoStats.init({ pluginID: id, rootURI });
  log("Started");
}

function onMainWindowLoad() {}

function onMainWindowUnload() {}

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
