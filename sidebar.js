console.log("===\nrunning sidebar.js\n===");

/**
 * PROFILE IDENTIFICATION
 * Firefox's built-in profiles (launched via `firefox -P ProfileName`, or the
 * newer profile switcher) each get their own isolated extension storage -
 * but relying on you hand-editing a constant in this file per profile is
 * fragile: if the extension is installed persistently (not reloaded as a
 * temporary add-on), Firefox keeps running whatever copy of this file it
 * already loaded, and never picks up your edit.
 *
 * Instead, ask once at runtime which profile this is, and remember the
 * answer in this profile's own storage.local - no file edits, no reloads
 * needed ever again. This uses a small in-page prompt rather than
 * window.prompt(), because window.prompt() is known to render broken or
 * not at all inside Firefox sidebar panels.
 */
const PROFILE_ID_STORAGE_KEY = "extension_profile_id";
let cachedProfileId = null;

function askProfileIdInline() {
    return new Promise(resolve => {
        let overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);"
            + "display:flex;align-items:center;justify-content:center;font-family:sans-serif;";

        let box = document.createElement("div");
        box.style.cssText = "background:#2a2a2e;color:#fff;padding:16px;border-radius:6px;"
            + "width:85%;max-width:300px;box-shadow:0 2px 10px rgba(0,0,0,0.5);";

        let label = document.createElement("div");
        label.textContent = "Which Firefox profile is this? (e.g. \"work\" or \"personal\") - asked once per profile.";
        label.style.cssText = "margin-bottom:8px;font-size:13px;";

        let input = document.createElement("input");
        input.type = "text";
        input.value = "default";
        input.style.cssText = "width:100%;box-sizing:border-box;padding:6px;margin-bottom:10px;"
            + "border-radius:4px;border:1px solid #555;background:#1c1c1e;color:#fff;";

        let button = document.createElement("button");
        button.textContent = "Save";
        button.style.cssText = "width:100%;padding:6px;border-radius:4px;border:none;"
            + "background:#0a84ff;color:#fff;cursor:pointer;";

        let submit = () => {
            let value = input.value.trim() || "default";
            document.body.removeChild(overlay);
            resolve(value);
        };
        button.onclick = submit;
        input.onkeydown = e => { if (e.key === "Enter") submit(); };

        box.appendChild(label);
        box.appendChild(input);
        box.appendChild(button);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        input.focus();
        input.select();
    });
}

async function getProfileId() {
    if (cachedProfileId)
        return cachedProfileId;
    try {
        let stored = await browser.storage.local.get(PROFILE_ID_STORAGE_KEY);
        if (stored[PROFILE_ID_STORAGE_KEY]) {
            cachedProfileId = stored[PROFILE_ID_STORAGE_KEY];
            return cachedProfileId;
        }
    } catch (e) {
        console.error("Failed reading stored profile id:", e);
    }

    // First run in this profile - ask once, then remember forever
    let id = await askProfileIdInline();
    cachedProfileId = id;
    try {
        await browser.storage.local.set({ [PROFILE_ID_STORAGE_KEY]: id });
    } catch (e) {
        console.error("Failed saving profile id:", e);
    }
    return id;
}

async function dbKey() {
    return "sidebery_style_db_" + (await getProfileId());
}

let $ = document.getElementById.bind(document);
let window_id = null;
let sidebar = $("tabs");
const MAX_INDENT_LEVEL = 100; // deepest a tab can be nested. No limit imposed by
                              // styling - indentation is set inline from JS below,
                              // so raise this as high as you like.
const INDENT_PX_PER_LEVEL = 16; // matches the old .level-N margin-left step in sidebar.css // orig value: 16

// Applies the visual indent for a tab's level directly, instead of relying on a
// fixed set of .level-N CSS classes (which would need one rule per possible depth).
// CSS still needs to know root vs non-root for two unrelated rules (border-left,
// drag-drop padding), so "level-0" is kept as a plain boolean class.
function apply_tab_indent(div, lvl) {
	div.style.marginLeft = lvl > 0 ? (INDENT_PX_PER_LEVEL * lvl) + "px" : "";
	div.classList.toggle("level-0", lvl === 0);
}
let level = { };
let expand = { };
let container_colors = [{ }];
let lastSelectedTabId = null;
let selectedTabIds = new Set();
let draggedTabIds = []; 
let draggedElements = [];
let awaitingActiveHandoff = false; // set when the currently-active tab is closed, so the
                                    // tab that becomes active next also becomes "selected"

/**
 * SIDEBERY-STYLE PERSISTENCE DATABASE
 * Saves the current window's URL-to-Tree mapping.
 * This runs continuously on changes and writes to your SSD/HDD.
 */
async function saveTreeToDatabase() {
    try {
        let currentTabs = await browser.tabs.query({ currentWindow: true });
        let databaseSnapshot = [];

        // Map every open tab by its URL, physical position, and tree parameters
        for (let tab of currentTabs) {
            databaseSnapshot.push({
                url: tab.url,
                title: tab.title,
                level: level[tab.id] || 0,
                expand: expand[tab.id] !== false
            });
        }
        
        // Write persistently to local storage, scoped to this profile
        let key = await dbKey();
        await browser.storage.local.set({ [key]: databaseSnapshot });
    } catch (e) {
        console.error("Failed writing layout to local database:", e);
    }
}

function tab_set_expand(tab, expanded)
{
	let hidden = { [level[tab.id] + 1]: !expanded || tab.classList.contains("hidden") };
	for (let t = tab.nextSibling; t != null && level[t.id] > level[tab.id]; t = t.nextSibling)
		hidden[level[t.id] + 1] = t.classList.toggle("hidden", hidden[level[t.id]]) || !expand[t.id];
	
	expand[tab.id] = expanded || Object.keys(hidden).length == 1;
	tab.children[3].classList.toggle("hidden", expand[tab.id]);
	
	browser.sessions.setTabValue(parseInt(tab.id, 10), "expand", expand[tab.id]);
	
    // Save to local database
    saveTreeToDatabase();
	
	if (!expand[tab.id] && sidebar.querySelector(".active").classList.contains("hidden"))
		browser.tabs.update(parseInt(tab.id, 10), { active: true });
}

function tab_set_level(tab, lvl)
{
	let old_level = level[tab.id];
	do
	{
		let new_level = Math.max(0, Math.min(MAX_INDENT_LEVEL, level[tab.id] + lvl - old_level));
		apply_tab_indent(tab, new_level);
		level[tab.id] = new_level;
		browser.sessions.setTabValue(parseInt(tab.id, 10), "level", level[tab.id]);
		tab = tab.nextSibling;
	} while (tab != null && level[tab.id] > old_level);

    // Save to local database
    saveTreeToDatabase();
}

function tab_show(tab)
{
	let last_level = level[tab.id];
	for (let t = tab.previousSibling; last_level > 0; t = t.previousSibling)
	{
		if (level[t.id] < last_level)
		{
			if (!expand[t.id])
				tab_set_expand(t, true);
			last_level = t.classList.contains("hidden") ? level[t.id] : 0;
		}
	}
	tab.classList.remove("hidden");
	tab.scrollIntoView({ block: "nearest" });
}

function tab_promote_first_child(tab, removed = false)
{
	let next_tab = tab.nextSibling;
	if (next_tab != null && level[next_tab.id] > level[tab.id])
	{
		next_tab.classList.toggle("hidden", tab.classList.contains("hidden"));
		tab_set_level(next_tab, level[tab.id]);
		if (expand[next_tab.id] != expand[tab.id])
			tab_set_expand(next_tab, expand[tab.id]);
		
		if (!removed && !expand[tab.id])
			tab_set_expand(tab, true);
	}
}

function tab_move(tab_moved, tab_drop, position)
{
	let tab = tab_drop;
	if (position == "after" && !expand[tab.id])
		while (tab.nextSibling != null && level[tab.nextSibling.id] > level[tab_drop.id])
			tab = tab.nextSibling;
	
	tab_promote_first_child(tab_moved);
	if (tab_drop) {
		let newLevel = level[tab_drop.id] + (position == "inside" ? 1 : 0);
		newLevel = Math.max(0, Math.min(MAX_INDENT_LEVEL, newLevel));
		tab_set_level(tab_moved, newLevel);
	} else {
		tab_set_level(tab_moved, 0);
	}
	sidebar.insertBefore(tab_moved, position == "before" ? tab : tab.nextSibling);
	tab_show(tab_moved);
}

function event_tab_click(event) {
    let tab_id = parseInt(event.currentTarget.id, 10);

    if (event.shiftKey && lastSelectedTabId !== null) {
        let tabs = Array.from(sidebar.children);
        let start = tabs.findIndex(t => parseInt(t.id, 10) === lastSelectedTabId);
        let end = tabs.findIndex(t => parseInt(t.id, 10) === tab_id);
        if (start > -1 && end > -1) {
            let [from, to] = start < end ? [start, end] : [end, start];
            for (let i = from; i <= to; i++) {
                tabs[i].classList.add("selected");
                selectedTabIds.add(parseInt(tabs[i].id, 10));
            }
        }
    } else if (event.ctrlKey || event.metaKey) {
        event.currentTarget.classList.toggle("selected");
        if (selectedTabIds.has(tab_id)) {
            selectedTabIds.delete(tab_id);
        } else {
            selectedTabIds.add(tab_id);
        }
        lastSelectedTabId = tab_id;
    } else {
        sidebar.querySelectorAll(".selected").forEach(t => t.classList.remove("selected"));
        selectedTabIds.clear();
        event.currentTarget.classList.add("selected");
        selectedTabIds.add(tab_id);
        lastSelectedTabId = tab_id;
    }

    if (event.target.classList.contains("close")) {
		let toClose = selectedTabIds.has(tab_id)
			? Array.from(selectedTabIds)
			: [tab_id];
		toClose.forEach(id => browser.tabs.remove(id));
		return;
	}
    else if (event.target.classList.contains("audio"))
        browser.tabs.update(tab_id, { muted: event.target.src.endsWith("audible.svg") });
    else if (event.target.classList.contains("favicon"))
        tab_set_expand(event.currentTarget, !expand[tab_id]);
    else
        browser.tabs.update(tab_id, { active: true });
}

function event_tab_contextmenu(event)
{
	event.stopPropagation();
	let tab = event.currentTarget;
	browser.menus.update("pin", { title: tab.classList.contains("pinned") ? "Unpin tab" : "Pin tab" });
	browser.menus.overrideContext({ context: "tab", tabId: parseInt(tab.id, 10) });
}

function getSubtreeElements(tabEl) {
    let elements = [tabEl];
    let parentLevel = level[tabEl.id];
    let current = tabEl.nextSibling;
    while (current != null && level[current.id] > parentLevel) {
        elements.push(current);
        current = current.nextSibling;
    }
    return elements;
}

function event_tab_dragstart(event) {
    let tab_id = parseInt(event.target.id, 10);
    let initialDragIds = selectedTabIds.has(tab_id)
        ? Array.from(selectedTabIds)
        : [tab_id];
    
    let sidebarTabs = Array.from(sidebar.children);
    let initialDragEls = initialDragIds.map(id => $(id)).filter(el => el !== null)
        .sort((a, b) => sidebarTabs.indexOf(a) - sidebarTabs.indexOf(b));

    let allDragEls = [];
    let seenIds = new Set();
    for (let tabEl of initialDragEls) {
        if (seenIds.has(tabEl.id)) continue;
        let subtree = getSubtreeElements(tabEl);
        for (let subEl of subtree) {
            if (!seenIds.has(subEl.id)) {
                seenIds.add(subEl.id);
                allDragEls.push(subEl);
            }
        }
    }

    draggedTabIds = allDragEls.map(el => parseInt(el.id, 10));
    event.dataTransfer.setData("ids", JSON.stringify(draggedTabIds));
}

function event_tab_dragover(event)
{
	let tab = event.currentTarget;
	if (draggedTabIds.length > 0 && !draggedTabIds.includes(parseInt(tab.id, 10)))
	{
		let pinned = tab.classList.contains("pinned");
		let pinnedMatch = draggedTabIds.every(id => $(id).classList.contains("pinned") === pinned);
		
		if (pinnedMatch)
		{
			event.preventDefault();
			let r = tab.getBoundingClientRect();
			let x = event.clientX - r.x;
			let y = event.clientY - r.y;
			tab.dataset.drop = pinned ? (x < 16 ? "before" : "after") : (y < 6 ? "before" : y > 16 ? "after" : "inside");
		}
	}
}

function event_tab_dragleave(event)
{
	delete event.currentTarget.dataset.drop;
}

function event_tab_drop(event) {
    event.preventDefault();
    let tab = event.currentTarget;
    let position = tab.dataset.drop || "after";

    let dragIds = [];
    try {
        dragIds = JSON.parse(event.dataTransfer.getData("ids") || "[]");
    } catch(e) {}
    if (dragIds.length === 0) {
        dragIds = draggedTabIds;
    }

    function getBranchElements(tabEl) {
        let branch = [tabEl];
        let rootLevel = level[tabEl.id];
        let next = tabEl.nextSibling;
        while (next != null && level[next.id] > rootLevel) {
            branch.push(next);
            next = next.nextSibling;
        }
        return branch;
    }

    let draggedNodesSet = new Set();
    dragIds.forEach(id => {
        let el = $(id);
        if (el) {
            getBranchElements(el).forEach(node => draggedNodesSet.add(node));
        }
    });

    let sidebarChildren = Array.from(sidebar.children);
    let allDraggedNodes = Array.from(draggedNodesSet).sort(
        (a, b) => sidebarChildren.indexOf(a) - sidebarChildren.indexOf(b)
    );

    if (allDraggedNodes.length === 0) {
        delete tab.dataset.drop;
        draggedTabIds = [];
        return;
    }

    let insertReference = tab;
    if (position === "after" && !expand[tab.id]) {
        while (insertReference.nextSibling != null && level[insertReference.nextSibling.id] > level[tab.id]) {
            insertReference = insertReference.nextSibling;
        }
    }

    let targetLevel = level[tab.id] + (position === "inside" ? 1 : 0);
    targetLevel = Math.max(0, Math.min(MAX_INDENT_LEVEL, targetLevel));

    let rootNode = allDraggedNodes[0];
    let delta = targetLevel - level[rootNode.id];

    allDraggedNodes.forEach(tabEl => {
        let newLvl = Math.max(0, Math.min(MAX_INDENT_LEVEL, level[tabEl.id] + delta));
        tab_set_level(tabEl, newLvl);

        if (tabEl.parentNode) {
            tabEl.parentNode.removeChild(tabEl);
        }
        
        let insertBeforeTarget = (position === "before" && insertReference === tab) 
            ? insertReference 
            : insertReference.nextSibling;
            
        sidebar.insertBefore(tabEl, insertBeforeTarget);
        tab_show(tabEl);
        insertReference = tabEl;
    });

    Array.from(sidebar.children).forEach((tabEl, index) => {
        browser.tabs.move(parseInt(tabEl.id, 10), { index: index });
    });

    delete tab.dataset.drop;
    draggedTabIds = [];
    saveTreeToDatabase(); // Update Database
}

function event_tab_dragend(event) {
    draggedTabIds = [];
}

const colorBlindSafePalette = [
  "#E69F00", "#56B4E9", "#F0E442", "#009E73",
  "#F57CB8", "#0072B2", "#D55E00", "#CC79A7"
];
let colorIndex = 0;
function getNextColor() {
	const color = colorBlindSafePalette[colorIndex % colorBlindSafePalette.length];
	colorIndex++;
	return color;
}

function div_tab_insert(tab, lvl = 0, expanded = true, tab_after = null, created = false)
{
	expand[tab.id] = expanded;
	let prev = tab_after != null ? tab_after.previousSibling : sidebar.lastChild;
	level[tab.id] = Math.max(0, Math.min(MAX_INDENT_LEVEL, lvl));
	if (level[tab.id] != lvl || (created && level[tab.id] > 0))
		browser.sessions.setTabValue(tab.id, "level", level[tab.id]);
	
	let div = document.createElement("div");
	div.id = tab.id;
	div.draggable = true;
	div.onclick = event_tab_click;
	div.oncontextmenu = event_tab_contextmenu;
	div.ondragstart = event_tab_dragstart;
	div.ondragover = event_tab_dragover;
	div.ondragleave = event_tab_dragleave;
	div.ondragend = event_tab_dragend;

	let container = tab.cookieStoreId || "";
	let containerDiv = document.createElement("div");
	containerDiv.className = "container-thing";
	containerDiv.textContent = container;
	div.appendChild(containerDiv);

	if (String(container) != "firefox-default") {
		if (container_colors.findIndex(c => c.container === container) !== -1) {
			let existingColor = container_colors.find(c => c.container === container).color;
			div.style.borderLeft = "4px solid " + existingColor;
		}
		else {
			let newColor = getNextColor();
			container_colors.push({ container: container, color: newColor });
			div.style.borderLeft = "4px solid " + newColor;
		}
	}

	div.ondrop = event_tab_drop;
	div.classList.add("tab");
	apply_tab_indent(div, level[tab.id]);
	if (tab.active) {
		// Ensure only one tab is ever marked active, regardless of event ordering
		sidebar.querySelectorAll(".active").forEach(t => t.classList.remove("active"));
		div.classList.add("active");
	}
	div.innerHTML = '<img class="favicon"><div class="title"></div><img class="audio"><div>▶</div><div class="close">❌</div>';
	div.children[3].classList.toggle("hidden", expanded);
	sidebar.insertBefore(div, tab_after);
	handler_updated(tab.id, tab, tab);
	return div;
}

function handler_created(tab)
{
	if (tab.windowId != window_id)
		return;
	
	let tab_after = sidebar.children[tab.index];
	let lvl = (typeof level[tab.openerTabId] === 'number' ? Math.min(MAX_INDENT_LEVEL, level[tab.openerTabId] + 1) : (tab_after ? level[tab_after.id] : 0));
	let div = div_tab_insert(tab, lvl, true, tab_after, true);
	tab_show(div);
	
	if (tab.active) {
		// A new foreground tab becomes the selection anchor, same as a
		// plain click would - so shift+click ranges start from it, and it
		// gets the same "selected" highlight a manually-clicked tab gets.
		sidebar.querySelectorAll(".selected").forEach(t => t.classList.remove("selected"));
		selectedTabIds.clear();
		div.classList.add("selected");
		selectedTabIds.add(tab.id);
		lastSelectedTabId = tab.id;
	}
	
	if (level[tab.id] == 0)
		browser.sessions.removeTabValue(tab.id, "level");
	browser.sessions.removeTabValue(tab.id, "expand");
    saveTreeToDatabase();
}

function handler_removed(tab_id, info)
{
	if (info.windowId != window_id || info.isWindowClosing)
		return;
	
	let tab = $(tab_id);
	if (tab.classList.contains("active"))
		awaitingActiveHandoff = true;
	tab_promote_first_child(tab, true);
	sidebar.removeChild(tab);
	
	delete level[tab_id];
	delete expand[tab_id];

	if (selectedTabIds.has(tab_id)) {
		selectedTabIds.delete(tab_id);
		if (selectedTabIds.size > 0) {
			let toClose = Array.from(selectedTabIds);
			selectedTabIds.clear(); 
			browser.tabs.remove(toClose);
		}
	}
    saveTreeToDatabase();
}

function handler_attached(tab_id, info)
{
	if (info.newWindowId != window_id)
		return;
	
	handler_created({ id: tab_id, active: false, index: info.newPosition, windowId: window_id });
	browser.tabs.get(tab_id).then(tab => { 
        handler_updated(tab_id, tab, tab); 
        saveTreeToDatabase();
    });
}

function handler_detached(tab_id, info)
{
	handler_removed(tab_id, { windowId: info.oldWindowId });
}

function handler_moved(tab_id, info)
{
	if (info.windowId != window_id)
		return;
	
	let tab = $(tab_id);
	if (tab != sidebar.children[info.toIndex])
		tab_move(tab, sidebar.children[info.toIndex + (info.fromIndex < info.toIndex)], "before");
    saveTreeToDatabase();
}

function handler_activated(info)
{
	if (info.windowId != window_id)
		return;
	
	sidebar.querySelectorAll(".active").forEach(t => t.classList.remove("active"));
	
	let tab = $(info.tabId);
	tab.classList.add("active");
	tab_show(tab);

	if (awaitingActiveHandoff) {
		// The tab we were focused on just got closed - this new tab is
		// where focus landed, so treat it like a click: sole selection
		// and the anchor for the next shift+click range.
		awaitingActiveHandoff = false;
		sidebar.querySelectorAll(".selected").forEach(t => t.classList.remove("selected"));
		selectedTabIds.clear();
		tab.classList.add("selected");
		selectedTabIds.add(info.tabId);
		lastSelectedTabId = info.tabId;
	}
}

function handler_updated(tab_id, info, tab)
{
	let div = $(tab_id);
	if (div == null)
		return;
	
	if ("audible" in info || "mutedInfo" in info)
		div.children[2].src = tab.mutedInfo.muted ? "muted.svg" : tab.audible ? "audible.svg" : "";
	if ("favIconUrl" in info || "status" in info)
		if (tab.status != "loading" || !div.children[0].src.endsWith("loading.png"))
			div.children[0].src = tab.status == "loading" ? "loading.png" : tab.favIconUrl || "";
	if ("pinned" in info)
		div.classList.toggle("pinned", tab.pinned);
	if (info.pinned)
		tab_promote_first_child(div);
	if ("title" in info)
		div.children[1].textContent = div.children[1].title = tab.title;

    // Track URL changes dynamically to prevent losing states if tabs redirect
    if ("url" in info) {
        saveTreeToDatabase();
    }
}

// Initialization of Sidebar & Cold Restore matching
browser.tabs.query({ currentWindow: true }).then(async tabs => {
    // 1. Fetch persistent database (Sidebery-style index fallback)
    let persistentDB = [];
    try {
        let key = await dbKey();
        let storage = await browser.storage.local.get(key);
        persistentDB = storage[key] || [];
    } catch(e) {
        console.error("Failed reading database during boot initialization.", e);
    }

	let data = tabs.map(tab => [
        browser.sessions.getTabValue(tab.id, "level"),
		browser.sessions.getTabValue(tab.id, "expand")
    ]);
	
	let hidden = { 0: false };
	for (let [i, tab] of tabs.entries())
	{
		let lvl = await data[i][0];
		let exp = await data[i][1];

        // COLD RESTART ALGORITHM:
        // If sessions are wiped, map the tab using index matching and URL verification.
        if (lvl === undefined || exp === undefined) {
            // Find if there is a recorded state for this position or matching URL in our database
            let matchingData = persistentDB.find(record => record.url === tab.url) || persistentDB[i];
            if (matchingData) {
                if (lvl === undefined) lvl = matchingData.level;
                if (exp === undefined) exp = matchingData.expand;
            }
        }

        // Failsafe fallbacks
        if (lvl === undefined) lvl = 0;
        if (exp === undefined) exp = true;

		let div = div_tab_insert(tab, lvl, exp);
		hidden[level[tab.id] + 1] = div.classList.toggle("hidden", hidden[level[tab.id]]) || !expand[tab.id];
	}
	
	window_id = (await browser.windows.getCurrent()).id;
	browser.tabs.onCreated.addListener(handler_created);
	browser.tabs.onRemoved.addListener(handler_removed);
	browser.tabs.onAttached.addListener(handler_attached);
	browser.tabs.onDetached.addListener(handler_detached);
	browser.tabs.onMoved.addListener(handler_moved);
	browser.tabs.onActivated.addListener(handler_activated);
	browser.tabs.onUpdated.addListener(handler_updated, { windowId: window_id,
		properties: ["audible", "favIconUrl", "mutedInfo", "pinned", "status", "title", "url"] });
	
	let tab_active = (await browser.tabs.query({ currentWindow: true, active: true }))[0];
	handler_updated(tab_active.id, tab_active, tab_active);
	tab_show($(tab_active.id));

	// Highlight whichever tab you're actually focused in when the sidebar loads
	let activeDiv = $(tab_active.id);
	if (activeDiv) {
		sidebar.querySelectorAll(".selected").forEach(t => t.classList.remove("selected"));
		selectedTabIds.clear();
		activeDiv.classList.add("selected");
		selectedTabIds.add(tab_active.id);
		lastSelectedTabId = tab_active.id;
	}
	
	for (let tab of sidebar.children)
		if (!expand[tab.id] && (tab.nextSibling == null || level[tab.id] >= level[tab.nextSibling.id]))
			tab_set_expand(tab, true);

    // Initial database synchronization
    saveTreeToDatabase();
});

document.oncontextmenu = event => { event.preventDefault(); };