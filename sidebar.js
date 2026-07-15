let $ = document.getElementById.bind(document);
let window_id = null;
let sidebar = $("tabs");
let level = { };
let expand = { };

function tab_set_expand(tab, expanded)
{
	let hidden = { [level[tab.id] + 1]: !expanded || tab.classList.contains("hidden") };
	for (let t = tab.nextSibling; t != null && level[t.id] > level[tab.id]; t = t.nextSibling)
		hidden[level[t.id] + 1] = t.classList.toggle("hidden", hidden[level[t.id]]) || !expand[t.id];
	
	expand[tab.id] = expanded || Object.keys(hidden).length == 1;
	tab.children[3].classList.toggle("hidden", expand[tab.id]);
	browser.sessions.setTabValue(parseInt(tab.id, 10), "expand", expand[tab.id]);
	
	if (!expand[tab.id] && sidebar.querySelector(".active").classList.contains("hidden"))
		browser.tabs.update(parseInt(tab.id, 10), { active: true });
}

function tab_set_level(tab, lvl)
{
	let old_level = level[tab.id];
	do
	{
		let new_level = Math.min(5, level[tab.id] + lvl - old_level);
		tab.classList.replace("level-" + level[tab.id], "level-" + new_level);
		level[tab.id] = new_level;
		browser.sessions.setTabValue(parseInt(tab.id, 10), "level", level[tab.id]);
		tab = tab.nextSibling;
	} while (tab != null && level[tab.id] > old_level);
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
	tab_set_level(tab_moved, tab_drop ? level[tab_drop.id] + (position == "inside") : 0);
	sidebar.insertBefore(tab_moved, position == "before" ? tab : tab.nextSibling);
	tab_show(tab_moved);
}

function event_tab_click(event)
{
	let tab_id = parseInt(event.currentTarget.id, 10);
	
	if (event.target.classList.contains("close"))
		browser.tabs.remove(tab_id);
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

function event_tab_dragstart(event)
{
	event.dataTransfer.setData("id", event.target.id);
}

function event_tab_dragover(event)
{
	let tab = event.currentTarget;
	let tab_moved = $(event.dataTransfer.getData("id") || null);
	let pinned = tab.classList.contains("pinned");
	if (tab_moved != null && tab != tab_moved && pinned == tab_moved.classList.contains("pinned"))
	{
		event.preventDefault();
		
		let r = tab.getBoundingClientRect();
		let x = event.clientX - r.x;
		let y = event.clientY - r.y;
		tab.dataset.drop = pinned ? (x < 16 ? "before" : "after") : (y < 6 ? "before" : y > 16 ? "after" : "inside");
	}
}

function event_tab_dragleave(event)
{
	delete event.currentTarget.dataset.drop;
}

function event_tab_drop(event)
{
	event.preventDefault();
	
	let tab = event.currentTarget;
	let tab_moved = $(event.dataTransfer.getData("id"));
	tab_move(tab_moved, tab, tab.dataset.drop);
	delete tab.dataset.drop;
	
	let new_index = Array.prototype.indexOf.call(sidebar.children, tab_moved);
	browser.tabs.move(parseInt(tab_moved.id, 10), { index: new_index });
}

function div_tab_insert(tab, lvl = 0, expanded = true, tab_after = null, created = false)
{
	expand[tab.id] = expanded;
	let prev = tab_after != null ? tab_after.previousSibling : sidebar.lastChild;
	level[tab.id] = Math.min(5, lvl, prev != null && !prev.classList.contains("pinned") ? level[prev.id] + 1 : 0);
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
	div.ondrop = event_tab_drop;
	div.classList.add("tab", "level-" + level[tab.id]);
	div.classList.toggle("active", tab.active);
	div.innerHTML = '<img class="favicon"><div class="title"></div><img class="audio"><div>▶</div><div class="close">×</div>';
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
	let lvl = level[tab.openerTabId] + 1 || (tab_after ? level[tab_after.id] : 0);
	let div = div_tab_insert(tab, lvl, true, tab_after, true);
	tab_show(div);
	
	if (level[tab.id] == 0)
		browser.sessions.removeTabValue(tab.id, "level");
	browser.sessions.removeTabValue(tab.id, "expand");
}

function handler_removed(tab_id, info)
{
	if (info.windowId != window_id || info.isWindowClosing)
		return;
	
	let tab = $(tab_id);
	tab_promote_first_child(tab, true);
	sidebar.removeChild(tab);
	
	delete level[tab_id];
	delete expand[tab_id];
}

function handler_attached(tab_id, info)
{
	if (info.newWindowId != window_id)
		return;
	
	handler_created({ id: tab_id, active: false, index: info.newPosition, windowId: window_id });
	browser.tabs.get(tab_id).then(tab => { handler_updated(tab_id, tab, tab); });
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
}

function handler_activated(info)
{
	if (info.windowId != window_id)
		return;
	
	if (info.previousTabId in level)
		$(info.previousTabId).classList.remove("active");
	
	let tab = $(info.tabId);
	tab.classList.add("active");
	tab_show(tab);
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
}

browser.tabs.query({ currentWindow: true }).then(async tabs => {
	let data = tabs.map(tab => [browser.sessions.getTabValue(tab.id, "level"),
		browser.sessions.getTabValue(tab.id, "expand")]);
	let hidden = { 0: false };
	for (let [i, tab] of tabs.entries())
	{
		let div = div_tab_insert(tab, await data[i][0], await data[i][1]);
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
		properties: ["audible", "favIconUrl", "mutedInfo", "pinned", "status", "title"] });
	
	let tab_active = (await browser.tabs.query({ currentWindow: true, active: true }))[0];
	handler_updated(tab_active.id, tab_active, tab_active);
	tab_show($(tab_active.id));
	
	for (let tab of sidebar.children)
		if (!expand[tab.id] && (tab.nextSibling == null || level[tab.id] >= level[tab.nextSibling.id]))
			tab_set_expand(tab, true);
});
document.oncontextmenu = event => { event.preventDefault(); };