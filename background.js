browser.menus.create({
	id: "pin",
	title: "Pin tab",
	contexts: ["tab"],
	viewTypes: ["sidebar"],
	documentUrlPatterns: [browser.runtime.getURL("sidebar.html")],
	onclick: (info, tab) => { browser.tabs.update(tab.id, { pinned: !tab.pinned }); }
});