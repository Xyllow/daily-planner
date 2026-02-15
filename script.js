import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ====== Supabase config (yours) ======
const SUPABASE_URL = "https://btibfxiodaplqlpxafxa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8PKt0BhOo2UwDondocz84g_u2nSH9De";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storage: window.localStorage,
  },
});

// ====== Date utils (LOCAL) ======
function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dateFromYMD(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function formatDateHuman(d) {
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  return `${weekday} · ${ymdLocal(d)}`;
}
function escapeHtml(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function slugify(s) {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40);
}

// ====== Rules ======
function evalUnlockRule(rule, ctx) {
  if (!rule || typeof rule !== "object") return true;
  const type = rule.type || "always";
  if (type === "always") return true;
  if (type === "weekday_in") {
    const vals = Array.isArray(rule.values) ? rule.values : [];
    return vals.includes(ctx.date.getDay());
  }
  return true;
}

function evalScheduleRule(rule, ctx) {
  // Back-compat: missing => every day
  const r = rule && typeof rule === "object" ? rule : { type: "every_day" };
  const type = r.type || "every_day";

  if (type === "every_day") return true;

  if (type === "weekly") {
    const vals = Array.isArray(r.weekdays) ? r.weekdays : [];
    return vals.includes(ctx.date.getDay());
  }

  if (type === "monthly") {
    const vals = Array.isArray(r.monthdays) ? r.monthdays : [];
    return vals.includes(ctx.date.getDate());
  }

  return true;
}

function evalTask(task, ctx) {
  return evalUnlockRule(task.unlock_rule || { type: "always" }, ctx) &&
    evalScheduleRule(task.schedule_rule || { type: "every_day" }, ctx);
}

// ====== UI refs ======
const today = new Date();
const todayYMD = ymdLocal(today);
document.getElementById("todayLabel").textContent = formatDateHuman(today);

const authBadge = document.getElementById("authBadge");
const topSignOutBtn = document.getElementById("topSignOut");

const authPanel = document.getElementById("authPanel");
const signInBtn = document.getElementById("signIn");
const signUpBtn = document.getElementById("signUp");
const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");

const tabsEl = document.getElementById("tabs");
const addSectionOpen = document.getElementById("addSectionOpen");
const addTaskOpen = document.getElementById("addTaskOpen");
const deleteSectionTop = document.getElementById("deleteSectionTop");

const tasksView = document.getElementById("tasksView");
const notesView = document.getElementById("notesView");
const logsView = document.getElementById("logsView");
const tasksWrap = document.getElementById("tasksWrap");
const notesTextEl = document.getElementById("notesText");

// Section modal
const sectionModal = document.getElementById("sectionModal");
const sectionClose = document.getElementById("sectionClose");
const sectionSave = document.getElementById("sectionSave");
const secTitleInput = document.getElementById("secTitleInput");

// Delete section modal
const deleteSectionModal = document.getElementById("deleteSectionModal");
const deleteSectionClose = document.getElementById("deleteSectionClose");
const deleteSectionCancel = document.getElementById("deleteSectionCancel");
const deleteSectionPrompt = document.getElementById("deleteSectionPrompt");
const deleteSectionInput = document.getElementById("deleteSectionInput");
const deleteSectionConfirm = document.getElementById("deleteSectionConfirm");

// Task modal (wizard)
const taskModal = document.getElementById("taskModal");
const taskClose = document.getElementById("taskClose");
const taskWizardTitle = document.getElementById("taskWizardTitle");
const taskWizardBody = document.getElementById("taskWizardBody");
const taskBack = document.getElementById("taskBack");
const taskNext = document.getElementById("taskNext");

// Logs view
const logDate = document.getElementById("logDate");
const loadDayBtn = document.getElementById("loadDay");
const logDaySummary = document.getElementById("logDaySummary");
const logDayDetails = document.getElementById("logDayDetails");
const todaySummaryBox = document.getElementById("todaySummaryBox");

// ====== App state ======
let currentUser = null;
let sections = [];
let tasks = [];
let day = null;
let dayTaskMap = new Map();
let oneOffs = [];
let selectedTab = null;
let saveTimer = null;

let deleteTarget = null;
let dragTabId = null;

// ====== Badge ======
function setBadge(kind, text) {
  authBadge.className = `badge ${kind || ""}`.trim();
  authBadge.textContent = text;
}

// ====== Local cache ======
function localKey(k) { return `dp7:${k}`; }
function loadLocalJSON(k, fallback) {
  try {
    const raw = localStorage.getItem(localKey(k));
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveLocalJSON(k, v) {
  localStorage.setItem(localKey(k), JSON.stringify(v));
}

// ====== DB helpers ======
async function dbGetSections() {
  const { data, error } = await supabase
    .from("planner_sections")
    .select("id, slug, title, sort_order")
    .order("sort_order", { ascending: true })
    .order("title", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function dbInsertSection({ title }) {
  const payload = { user_id: currentUser.id, title, slug: slugify(title), sort_order: 100 };
  const { data, error } = await supabase
    .from("planner_sections")
    .insert(payload)
    .select("id, slug, title, sort_order")
    .single();
  if (error) throw error;
  return data;
}

async function dbUpdateSectionOrder(updates) {
  const { error } = await supabase.from("planner_sections").upsert(
    updates.map((u) => ({
      user_id: currentUser.id,
      id: u.id,
      sort_order: u.sort_order,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "id" }
  );
  if (error) throw error;
}

async function dbDeleteSection(sectionId) {
  const { error } = await supabase
    .from("planner_sections")
    .delete()
    .eq("id", sectionId)
    .eq("user_id", currentUser.id);
  if (error) throw error;
}

async function dbGetTasks() {
  const { data, error } = await supabase
    .from("planner_tasks")
    .select("id, title, section_id, is_active, sort_order, unlock_rule, schedule_rule")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("title", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function dbInsertTask(def) {
  const payload = { user_id: currentUser.id, ...def };
  const { data, error } = await supabase
    .from("planner_tasks")
    .insert(payload)
    .select("id, title, section_id, is_active, sort_order, unlock_rule, schedule_rule")
    .single();
  if (error) throw error;
  return data;
}

async function dbDeactivateTask(taskId) {
  const { error } = await supabase
    .from("planner_tasks")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("user_id", currentUser.id);
  if (error) throw error;
}

async function dbUpsertDay(ymd, patch) {
  const payload = { user_id: currentUser.id, ymd, ...patch, updated_at: new Date().toISOString() };
  const { error } = await supabase.from("planner_days").upsert(payload, { onConflict: "user_id,ymd" });
  if (error) throw error;
}

async function dbGetDay(ymd) {
  const { data, error } = await supabase
    .from("planner_days")
    .select("*")
    .eq("user_id", currentUser.id)
    .eq("ymd", ymd)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function dbGetDayTasks(ymd) {
  const { data, error } = await supabase
    .from("planner_day_tasks")
    .select("task_id, done, hidden")
    .eq("user_id", currentUser.id)
    .eq("ymd", ymd);
  if (error) throw error;
  return data || [];
}

async function dbUpsertDayTask(ymd, taskId, patch) {
  const payload = { user_id: currentUser.id, ymd, task_id: taskId, ...patch, updated_at: new Date().toISOString() };
  const { error } = await supabase
    .from("planner_day_tasks")
    .upsert(payload, { onConflict: "user_id,ymd,task_id" });
  if (error) throw error;
}

async function dbGetOneOffs(ymd) {
  const { data, error } = await supabase
    .from("planner_day_custom_tasks")
    .select("id, title, done, sort_order, section_id")
    .eq("user_id", currentUser.id)
    .eq("ymd", ymd)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function dbInsertOneOff(ymd, { title, section_id }) {
  const payload = { user_id: currentUser.id, ymd, title, section_id: section_id || null, done: false, sort_order: 100 };
  const { data, error } = await supabase
    .from("planner_day_custom_tasks")
    .insert(payload)
    .select("id, title, done, sort_order, section_id")
    .single();
  if (error) throw error;
  return data;
}

async function dbUpdateOneOff(id, patch) {
  const { error } = await supabase
    .from("planner_day_custom_tasks")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", currentUser.id);
  if (error) throw error;
}

async function dbDeleteOneOff(id) {
  const { error } = await supabase
    .from("planner_day_custom_tasks")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id);
  if (error) throw error;
}

// ====== Tabs ======
function ensureDefaultTab() {
  if (selectedTab) return;
  selectedTab = sections[0]?.id || "__notes__";
}

function renderTabs() {
  ensureDefaultTab();

  const buttonModels = [
    ...sections.map((s) => ({ id: s.id, label: s.title })),
    { id: "__notes__", label: "Notes" },
    { id: "__logs__", label: "Logs" },
  ];

  tabsEl.innerHTML = buttonModels
    .map((t) => {
      const active = t.id === selectedTab ? "active" : "";
      const draggable = t.id.startsWith("__") ? "false" : "true";
      return `
        <button class="tabBtn ${active}" data-tab="${t.id}" type="button" draggable="${draggable}" data-draggable-tab="${t.id}">
          <span>${escapeHtml(t.label)}</span>
        </button>
      `;
    })
    .join("");

  applyTabView();
}

function applyTabView() {
  const isNotes = selectedTab === "__notes__";
  const isLogs = selectedTab === "__logs__";
  const isSection = !isNotes && !isLogs;

  tasksView.style.display = isSection ? "block" : "none";
  notesView.style.display = isNotes ? "block" : "none";
  logsView.style.display = isLogs ? "block" : "none";

  addTaskOpen.disabled = !isSection || !sections.length;
  deleteSectionTop.style.display = currentUser && isSection ? "inline-flex" : "none";

  renderAll();
}

tabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  selectedTab = btn.dataset.tab;
  renderTabs();
});

deleteSectionTop.addEventListener("click", () => {
  if (!currentUser) return setBadge("warn", "Sign in first");
  if (!selectedTab || selectedTab.startsWith("__")) return;
  const sec = sections.find((s) => s.id === selectedTab);
  if (!sec) return;
  openDeleteSection(sec);
});

// ====== Drag reorder tabs ======
tabsEl.addEventListener("dragstart", (e) => {
  const btn = e.target.closest("[data-draggable-tab]");
  if (!btn) return;
  const id = btn.dataset.draggableTab;
  if (!id || id.startsWith("__")) return;
  dragTabId = id;
  try { e.dataTransfer.setData("text/plain", id); } catch {}
});

tabsEl.addEventListener("dragover", (e) => {
  const over = e.target.closest("[data-draggable-tab]");
  if (!over) return;
  const overId = over.dataset.draggableTab;
  if (!dragTabId || !overId || overId.startsWith("__")) return;
  e.preventDefault();
});

tabsEl.addEventListener("drop", async (e) => {
  const over = e.target.closest("[data-draggable-tab]");
  if (!over) return;

  const overId = over.dataset.draggableTab;
  const fromId = dragTabId;
  dragTabId = null;

  if (!fromId || !overId || fromId === overId) return;

  const fromIdx = sections.findIndex((s) => s.id === fromId);
  const toIdx = sections.findIndex((s) => s.id === overId);
  if (fromIdx < 0 || toIdx < 0) return;

  const moved = sections.splice(fromIdx, 1)[0];
  sections.splice(toIdx, 0, moved);

  const updates = sections.map((s, i) => ({ id: s.id, sort_order: (i + 1) * 10 }));
  sections = sections.map((s, i) => ({ ...s, sort_order: (i + 1) * 10 }));

  saveLocalJSON("sections", sections);
  renderTabs();

  if (!currentUser) return;
  try {
    await dbUpdateSectionOrder(updates);
    setBadge("ok", "Synced");
  } catch {
    setBadge("warn", "Local only");
  }
});

// ====== Rendering (unified list) ======
function visibleRepeatingTasksForTab(dateObj, ymd) {
  if (!selectedTab || selectedTab.startsWith("__")) return [];
  const ctx = { date: dateObj, ymd };
  return tasks
    .filter((t) => t.is_active)
    .filter((t) => (t.section_id || null) === selectedTab)
    .filter((t) => !(dayTaskMap.get(t.id)?.hidden))
    .filter((t) => evalTask(t, ctx))
    .sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || a.title.localeCompare(b.title));
}

function visibleOneOffsForTab() {
  if (!selectedTab || selectedTab.startsWith("__")) return [];
  return oneOffs
    .filter((t) => (t.section_id || null) === selectedTab)
    .sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100));
}

function unifiedRowsHTML() {
  const rep = visibleRepeatingTasksForTab(today, todayYMD).map((t) => ({
    kind: "repeating",
    id: t.id,
    title: t.title,
    sort_order: t.sort_order ?? 100,
  }));

  const offs = visibleOneOffsForTab().map((t) => ({
    kind: "oneoff",
    id: t.id,
    title: t.title,
    sort_order: t.sort_order ?? 100,
  }));

  const all = [...rep, ...offs].sort(
    (a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || a.title.localeCompare(b.title)
  );

  if (!all.length) return `<div class="small">No tasks yet.</div>`;

  return all
    .map((t) => {
      const done =
        t.kind === "repeating"
          ? !!dayTaskMap.get(t.id)?.done
          : !!oneOffs.find((x) => x.id === t.id)?.done;

      const checkAttr = t.kind === "repeating" ? `data-r-check="${t.id}"` : `data-o-check="${t.id}"`;
      const delAttr = t.kind === "repeating" ? `data-r-del="${t.id}"` : `data-o-del="${t.id}"`;

      return `
        <div class="taskRow">
          <input type="checkbox" ${checkAttr} ${done ? "checked" : ""}>
          <span class="taskText">${escapeHtml(t.title)}</span>
          <button class="iconBtn" type="button" title="Delete" ${delAttr}>🗑</button>
        </div>
      `;
    })
    .join("");
}

function renderTasks() {
  if (selectedTab.startsWith("__")) return;
  if (!sections.length) {
    tasksWrap.innerHTML = `<div class="small">No sections yet. Click “+ Section”.</div>`;
    return;
  }
  tasksWrap.innerHTML = unifiedRowsHTML();
}

function renderNotes() {
  notesTextEl.value = day?.daily_log || "";
}

function renderAll() {
  if (!selectedTab) return;
  if (!selectedTab.startsWith("__")) renderTasks();
  if (selectedTab === "__notes__") renderNotes();
  if (selectedTab === "__logs__") renderLogsUI();
}

// ====== Notes save ======
function scheduleSaveNotes(text) {
  day = { ...(day || {}), daily_log: text };
  saveLocalJSON(`day:${todayYMD}`, day);

  if (!currentUser) return;

  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await dbUpsertDay(todayYMD, { daily_log: text });
      setBadge("ok", "Synced");
    } catch {
      setBadge("warn", "Local only");
    }
  }, 500);
}
notesTextEl.addEventListener("input", () => scheduleSaveNotes(notesTextEl.value || ""));

// ====== Task actions ======
async function setRepeatingDone(taskId, done) {
  const prev = dayTaskMap.get(taskId) || { done: false, hidden: false };
  dayTaskMap.set(taskId, { ...prev, done: !!done });
  saveLocalJSON(`dayTasks:${todayYMD}`, [...dayTaskMap.entries()]);
  renderTasks();

  if (!currentUser) return;
  try {
    await dbUpsertDayTask(todayYMD, taskId, { done: !!done });
    setBadge("ok", "Synced");
  } catch {
    setBadge("warn", "Local only");
  }
}

async function removeRepeatingTask(taskId) {
  tasks = tasks.filter((t) => t.id !== taskId);
  saveLocalJSON("tasks", tasks);
  renderTasks();

  if (!currentUser) return;
  try {
    await dbDeactivateTask(taskId);
    setBadge("ok", "Synced");
  } catch {
    setBadge("warn", "Local only");
  }
}

async function setOneOffDone(id, done) {
  const t = oneOffs.find((x) => x.id === id);
  if (!t) return;
  t.done = !!done;

  saveLocalJSON(`oneOffs:${todayYMD}`, oneOffs);
  renderTasks();

  if (!currentUser) return;
  try {
    await dbUpdateOneOff(id, { done: t.done });
    setBadge("ok", "Synced");
  } catch {
    setBadge("warn", "Local only");
  }
}

async function deleteOneOff(id) {
  oneOffs = oneOffs.filter((x) => x.id !== id);
  saveLocalJSON(`oneOffs:${todayYMD}`, oneOffs);
  renderTasks();

  if (!currentUser) return;
  try {
    await dbDeleteOneOff(id);
    setBadge("ok", "Synced");
  } catch {
    setBadge("warn", "Local only");
  }
}

tasksWrap.addEventListener("change", async (e) => {
  const r = e.target.closest("input[type=checkbox][data-r-check]");
  if (r) return setRepeatingDone(r.dataset.rCheck, r.checked);

  const o = e.target.closest("input[type=checkbox][data-o-check]");
  if (o) return setOneOffDone(o.dataset.oCheck, o.checked);
});

tasksWrap.addEventListener("click", async (e) => {
  const delRep = e.target.closest("button[data-r-del]");
  if (delRep) return removeRepeatingTask(delRep.dataset.rDel);

  const delOne = e.target.closest("button[data-o-del]");
  if (delOne) return deleteOneOff(delOne.dataset.oDel);
});

// ====== Logs tab ======
logDate.value = todayYMD;

function dayGreen(done, total) {
  if (!total) return "#e5e7eb";
  if (done === 0) return "#fee2e2";
  if (done < total) return "#fef3c7";
  return "#dcfce7";
}

async function getSnapshotForYMD(ymd) {
  if (!currentUser) {
    return {
      day: loadLocalJSON(`day:${ymd}`, null),
      dayTasks: new Map(loadLocalJSON(`dayTasks:${ymd}`, [])),
      oneOffs: loadLocalJSON(`oneOffs:${ymd}`, []),
    };
  }

  const [drow, dtsk, offs] = await Promise.all([dbGetDay(ymd), dbGetDayTasks(ymd), dbGetOneOffs(ymd)]);
  const map = new Map();
  (dtsk || []).forEach((r) => map.set(r.task_id, { done: !!r.done, hidden: !!r.hidden }));
  return { day: drow, dayTasks: map, oneOffs: offs || [] };
}

function renderLogsUI() {
  renderTodaySummary().catch(() => {});
}

async function renderTodaySummary() {
  const visible = tasks.filter((t) => t.is_active);
  const doneCount = visible.filter((t) => dayTaskMap.get(t.id)?.done).length;
  const totalCount = visible.length;

  todaySummaryBox.style.background = dayGreen(doneCount, totalCount);
  todaySummaryBox.innerHTML = `<strong>${formatDateHuman(today)}</strong><br>
    Tasks done: ${doneCount}/${totalCount} · One-offs: ${(oneOffs || []).filter((x) => x.done).length}/${(oneOffs || []).length}`;
}

async function renderDayByYMD(ymd) {
  const d = dateFromYMD(ymd);
  const snap = await getSnapshotForYMD(ymd);
  const dd = snap.day || { ymd, daily_log: "" };
  const ctx = { date: d, ymd };

  const visible = tasks
    .filter((t) => t.is_active)
    .filter((t) => !snap.dayTasks.get(t.id)?.hidden)
    .filter((t) => evalTask(t, ctx));

  const doneCount = visible.filter((t) => snap.dayTasks.get(t.id)?.done).length;
  const totalCount = visible.length;

  logDaySummary.textContent = `${formatDateHuman(d)} — Tasks ${doneCount}/${totalCount}`;

  const bySection = new Map();
  for (const t of visible) {
    const sid = t.section_id || "__none__";
    if (!bySection.has(sid)) bySection.set(sid, []);
    bySection.get(sid).push(t);
  }

  const sectionBlocks = [...bySection.entries()]
    .map(([sid, list]) => {
      const title = sid === "__none__" ? "Unsorted" : sections.find((s) => s.id === sid)?.title || "Section";
      const items = list
        .sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || a.title.localeCompare(b.title))
        .map((t) => `<li style="list-style:none;">${snap.dayTasks.get(t.id)?.done ? "✅" : "⬜"} ${escapeHtml(t.title)}</li>`)
        .join("");

      return `
        <div style="margin-top:10px;">
          <div class="small">${escapeHtml(title)}</div>
          <ul style="margin:6px 0 0 0; padding-left:0; list-style:none;">
            ${items || "—"}
          </ul>
        </div>
      `;
    })
    .join("");

  const oneOffChecklist = (snap.oneOffs || []).length
    ? (snap.oneOffs || []).map((t) => `<li style="list-style:none;">${t.done ? "✅" : "⬜"} ${escapeHtml(t.title)}</li>`).join("")
    : `<li style="list-style:none;">—</li>`;

  logDayDetails.innerHTML = `
    <div style="margin-bottom:10px;">
      <div class="small">Tasks</div>
      ${sectionBlocks || `<div class="small">—</div>`}
      <div class="small" style="margin-top:12px;">One-off tasks</div>
      <ul style="margin:6px 0 0 0; padding-left:0; list-style:none;">
        ${oneOffChecklist}
      </ul>
    </div>
    <div style="margin-bottom:10px;">
      <div class="small">Notes</div>
      <div>${escapeHtml(dd.daily_log).replaceAll("\n", "<br>") || "—"}</div>
    </div>
  `;
}

loadDayBtn.onclick = async () => {
  await renderDayByYMD(logDate.value);
};

// ====== Load everything ======
async function loadEverythingForToday() {
  day = loadLocalJSON(`day:${todayYMD}`, null) || { ymd: todayYMD, daily_log: "" };
  dayTaskMap = new Map(loadLocalJSON(`dayTasks:${todayYMD}`, []));
  oneOffs = loadLocalJSON(`oneOffs:${todayYMD}`, []);
  sections = loadLocalJSON("sections", []);
  tasks = loadLocalJSON("tasks", []);

  renderTabs();
  renderAll();

  if (!currentUser) {
    setBadge("warn", "Local only");
    return;
  }

  try {
    const [sec, tsk, drow, dtsk, offs] = await Promise.all([
      dbGetSections(),
      dbGetTasks(),
      dbGetDay(todayYMD),
      dbGetDayTasks(todayYMD),
      dbGetOneOffs(todayYMD),
    ]);

    sections = sec;
    tasks = tsk;
    day = drow || { ymd: todayYMD, daily_log: "" };

    dayTaskMap = new Map();
    (dtsk || []).forEach((r) => dayTaskMap.set(r.task_id, { done: !!r.done, hidden: !!r.hidden }));

    oneOffs = offs || [];

    saveLocalJSON("sections", sections);
    saveLocalJSON("tasks", tasks);
    saveLocalJSON(`day:${todayYMD}`, day);
    saveLocalJSON(`dayTasks:${todayYMD}`, [...dayTaskMap.entries()]);
    saveLocalJSON(`oneOffs:${todayYMD}`, oneOffs);

    if (!selectedTab) selectedTab = sections[0]?.id || "__notes__";
    if (!selectedTab.startsWith("__") && selectedTab && !sections.some((s) => s.id === selectedTab)) {
      selectedTab = sections[0]?.id || "__notes__";
    }

    renderTabs();
    renderAll();
    setBadge("ok", "Synced");
  } catch {
    setBadge("warn", "Local only");
  }
}

// ====== Add section ======
function openSectionModal() {
  if (!currentUser) return setBadge("warn", "Sign in to add sections");
  secTitleInput.value = "";
  sectionModal.style.display = "flex";
  setTimeout(() => secTitleInput.focus(), 0);
}
function closeSectionModal() { sectionModal.style.display = "none"; }

addSectionOpen.addEventListener("click", openSectionModal);
sectionClose.addEventListener("click", closeSectionModal);
sectionModal.addEventListener("click", (e) => { if (e.target === sectionModal) closeSectionModal(); });

sectionSave.addEventListener("click", async () => {
  const title = (secTitleInput.value || "").trim();
  if (!title) return;
  if (!currentUser) return;

  try {
    const created = await dbInsertSection({ title });
    sections.push(created);
    sections = sections.sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || a.title.localeCompare(b.title));
    saveLocalJSON("sections", sections);

    selectedTab = created.id;
    closeSectionModal();
    renderTabs();
    renderAll();
    setBadge("ok", "Synced");
  } catch {
    setBadge("warn", "Local only");
  }
});

// ====== Delete section with typed confirm ======
function openDeleteSection(sec) {
  if (!currentUser) return setBadge("warn", "Sign in first");
  deleteTarget = { id: sec.id, title: sec.title };
  deleteSectionPrompt.textContent = `Type “${sec.title}” to confirm deletion.`;
  deleteSectionInput.value = "";
  deleteSectionConfirm.disabled = true;
  deleteSectionModal.style.display = "flex";
  setTimeout(() => deleteSectionInput.focus(), 0);
}
function closeDeleteSection() {
  deleteSectionModal.style.display = "none";
  deleteTarget = null;
}
deleteSectionInput.addEventListener("input", () => {
  if (!deleteTarget) return;
  deleteSectionConfirm.disabled = deleteSectionInput.value !== deleteTarget.title;
});
deleteSectionClose.addEventListener("click", closeDeleteSection);
deleteSectionCancel.addEventListener("click", closeDeleteSection);
deleteSectionModal.addEventListener("click", (e) => { if (e.target === deleteSectionModal) closeDeleteSection(); });

deleteSectionConfirm.addEventListener("click", async () => {
  if (!deleteTarget || !currentUser) return;
  const { id } = deleteTarget;

  sections = sections.filter((s) => s.id !== id);
  saveLocalJSON("sections", sections);

  if (selectedTab === id) selectedTab = sections[0]?.id || "__notes__";

  closeDeleteSection();
  renderTabs();
  renderAll();

  try {
    await dbDeleteSection(id);
    setBadge("ok", "Synced");
  } catch {
    setBadge("warn", "Local only");
  }
});

// ====== Task wizard (now includes schedule builder for repeating) ======
let taskStep = 0;

// schedule draft model:
// mode: "every_day" | "some_days"
// some_freq: "weekly" | "monthly"
// weekdays: Set<0..6>
// monthdays: Set<1..31>
const taskDraft = {
  title: "",
  section_id: null,
  kind: null, // "repeating" | "oneoff"
  schedule: {
    mode: "every_day",
    some_freq: "weekly",
    weekdays: new Set([today.getDay()]),
    monthdays: new Set([today.getDate()]),
  },
};

function resetTaskDraft() {
  taskDraft.title = "";
  taskDraft.section_id = selectedTab;
  taskDraft.kind = null;
  taskDraft.schedule = {
    mode: "every_day",
    some_freq: "weekly",
    weekdays: new Set([today.getDay()]),
    monthdays: new Set([today.getDate()]),
  };
}

function openTaskModal() {
  if (!currentUser) return setBadge("warn", "Sign in to add tasks");
  if (!sections.length) return setBadge("warn", "Create a section first");
  if (selectedTab.startsWith("__")) return setBadge("warn", "Pick a section tab first");

  taskStep = 0;
  resetTaskDraft();
  taskModal.style.display = "flex";
  renderTaskWizard();
}
function closeTaskModal() { taskModal.style.display = "none"; }

addTaskOpen.addEventListener("click", openTaskModal);
taskClose.addEventListener("click", closeTaskModal);
taskModal.addEventListener("click", (e) => { if (e.target === taskModal) closeTaskModal(); });

function scheduleToRule() {
  if (taskDraft.schedule.mode === "every_day") return { type: "every_day" };
  if (taskDraft.schedule.some_freq === "weekly") {
    const weekdays = [...taskDraft.schedule.weekdays].sort((a, b) => a - b);
    return { type: "weekly", weekdays };
  }
  const monthdays = [...taskDraft.schedule.monthdays].sort((a, b) => a - b);
  return { type: "monthly", monthdays };
}

function scheduleHuman(rule) {
  const t = rule?.type || "every_day";
  if (t === "every_day") return "Every day";
  if (t === "weekly") {
    const names = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const days = (rule.weekdays || []).map((d) => names[d]).join(", ");
    return `Weekly: ${days || "—"}`;
  }
  if (t === "monthly") {
    const days = (rule.monthdays || []).join(", ");
    return `Monthly: ${days || "—"}`;
  }
  return "—";
}

function renderTaskWizard() {
  taskBack.style.display = taskStep === 0 ? "none" : "inline-block";

  // Step count depends on kind:
  // 0 title
  // 1 section+type
  // 2 schedule (only if repeating)
  // 3 confirm
  const confirmStep = taskDraft.kind === "repeating" ? 3 : 2;
  const hasScheduleStep = taskDraft.kind === "repeating";

  taskNext.textContent = taskStep === confirmStep ? "Save" : "Next";

  // Step 0: title
  if (taskStep === 0) {
    taskWizardTitle.textContent = "Add Task (1/4)";
    taskWizardBody.innerHTML = `
      <div class="small">Task name</div>
      <input id="taskTitleInput" type="text" placeholder="e.g. Pay bills" style="margin-top:8px;" value="${escapeHtml(taskDraft.title)}">
    `;
    setTimeout(() => document.getElementById("taskTitleInput")?.focus(), 0);
    return;
  }

  // Step 1: section + repeating vs one-off
  if (taskStep === 1) {
    taskWizardTitle.textContent = "Add Task (2/4)";
    taskWizardBody.innerHTML = `
      <div class="small">Which section?</div>
      <div class="choiceGrid" style="margin-top:10px;">
        ${sections
          .map((s) => {
            const sel = s.id === taskDraft.section_id ? "selected" : "";
            return `<button class="choiceBtn ${sel}" data-pick-section="${s.id}" type="button">${escapeHtml(s.title)}</button>`;
          })
          .join("")}
      </div>

      <div class="small" style="margin-top:14px;">Repeating or one-off?</div>
      <div class="choiceGrid" style="margin-top:10px;">
        <button class="choiceBtn ${taskDraft.kind === "repeating" ? "selected" : ""}" data-kind="repeating" type="button">Repeating</button>
        <button class="choiceBtn ${taskDraft.kind === "oneoff" ? "selected" : ""}" data-kind="oneoff" type="button">One-off (today only)</button>
      </div>
    `;
    return;
  }

  // Step 2: schedule (only for repeating) OR confirm (for one-off)
  if (taskStep === 2 && hasScheduleStep) {
    taskWizardTitle.textContent = "Add Task (3/4)";

    const mode = taskDraft.schedule.mode;
    const freq = taskDraft.schedule.some_freq;

    const weekdayNames = [
      { k: 0, label: "Sun" },
      { k: 1, label: "Mon" },
      { k: 2, label: "Tue" },
      { k: 3, label: "Wed" },
      { k: 4, label: "Thu" },
      { k: 5, label: "Fri" },
      { k: 6, label: "Sat" },
    ];

    const monthDays = Array.from({ length: 31 }, (_, i) => i + 1);

    taskWizardBody.innerHTML = `
      <div class="small">When should this task appear?</div>

      <div class="chipRow">
        <div class="chip ${mode === "every_day" ? "selected" : ""}" data-s-mode="every_day">Every day</div>
        <div class="chip ${mode === "some_days" ? "selected" : ""}" data-s-mode="some_days">Only some days</div>
      </div>

      <div id="someDaysBlock" style="margin-top:14px; ${mode === "some_days" ? "" : "display:none;"}">
        <div class="small">Weekly or Monthly?</div>
        <div class="chipRow">
          <div class="chip ${freq === "weekly" ? "selected" : ""}" data-s-freq="weekly">Weekly</div>
          <div class="chip ${freq === "monthly" ? "selected" : ""}" data-s-freq="monthly">Monthly</div>
        </div>

        <div id="weeklyBlock" style="margin-top:14px; ${freq === "weekly" ? "" : "display:none;"}">
          <div class="small">Pick weekdays</div>
          <div class="chipRow">
            ${weekdayNames
              .map((w) => {
                const sel = taskDraft.schedule.weekdays.has(w.k) ? "selected" : "";
                return `<div class="chip ${sel}" data-weekday="${w.k}">${w.label}</div>`;
              })
              .join("")}
          </div>
        </div>

        <div id="monthlyBlock" style="margin-top:14px; ${freq === "monthly" ? "" : "display:none;"}">
          <div class="small">Pick month days</div>
          <div class="chipRow">
            ${monthDays
              .map((d) => {
                const sel = taskDraft.schedule.monthdays.has(d) ? "selected" : "";
                return `<div class="chip ${sel}" data-monthday="${d}">${d}</div>`;
              })
              .join("")}
          </div>
        </div>
      </div>
    `;
    return;
  }

  // Confirm step
  const stepLabel = taskDraft.kind === "repeating" ? "Add Task (4/4)" : "Add Task (3/3)";
  taskWizardTitle.textContent = stepLabel;

  const sectionTitle = sections.find((s) => s.id === taskDraft.section_id)?.title || "—";
  const kindLabel = taskDraft.kind === "oneoff" ? "One-off (today only)" : "Repeating";
  const scheduleRule = taskDraft.kind === "repeating" ? scheduleToRule() : null;

  taskWizardBody.innerHTML = `
    <div class="small">Confirm</div>
    <div style="margin-top:10px; line-height:1.7;">
      <div><strong>Task:</strong> ${escapeHtml(taskDraft.title || "—")}</div>
      <div><strong>Section:</strong> ${escapeHtml(sectionTitle)}</div>
      <div><strong>Type:</strong> ${escapeHtml(kindLabel)}</div>
      ${taskDraft.kind === "repeating" ? `<div><strong>Schedule:</strong> ${escapeHtml(scheduleHuman(scheduleRule))}</div>` : ""}
    </div>
  `;
}

taskWizardBody.addEventListener("click", (e) => {
  const secBtn = e.target.closest("[data-pick-section]");
  if (secBtn) {
    taskDraft.section_id = secBtn.dataset.pickSection;
    renderTaskWizard();
    return;
  }

  const kindBtn = e.target.closest("[data-kind]");
  if (kindBtn) {
    taskDraft.kind = kindBtn.dataset.kind;
    // if they pick one-off, we still keep schedule draft but won't use it
    renderTaskWizard();
    return;
  }

  // schedule controls
  const modeBtn = e.target.closest("[data-s-mode]");
  if (modeBtn) {
    const v = modeBtn.dataset.sMode;
    taskDraft.schedule.mode = v === "some_days" ? "some_days" : "every_day";
    renderTaskWizard();
    return;
  }

  const freqBtn = e.target.closest("[data-s-freq]");
  if (freqBtn) {
    const v = freqBtn.dataset.sFreq;
    taskDraft.schedule.some_freq = v === "monthly" ? "monthly" : "weekly";
    renderTaskWizard();
    return;
  }

  const wd = e.target.closest("[data-weekday]");
  if (wd) {
    const k = Number(wd.dataset.weekday);
    if (taskDraft.schedule.weekdays.has(k)) taskDraft.schedule.weekdays.delete(k);
    else taskDraft.schedule.weekdays.add(k);
    renderTaskWizard();
    return;
  }

  const md = e.target.closest("[data-monthday]");
  if (md) {
    const k = Number(md.dataset.monthday);
    if (taskDraft.schedule.monthdays.has(k)) taskDraft.schedule.monthdays.delete(k);
    else taskDraft.schedule.monthdays.add(k);
    renderTaskWizard();
    return;
  }
});

taskBack.addEventListener("click", () => {
  taskStep = Math.max(0, taskStep - 1);
  renderTaskWizard();
});

taskNext.addEventListener("click", async () => {
  if (!currentUser) return;

  const confirmStep = taskDraft.kind === "repeating" ? 3 : 2;
  const hasScheduleStep = taskDraft.kind === "repeating";

  if (taskStep === 0) {
    const v = (document.getElementById("taskTitleInput")?.value || "").trim();
    if (!v) return;
    taskDraft.title = v;
    taskStep = 1;
    renderTaskWizard();
    return;
  }

  if (taskStep === 1) {
    if (!taskDraft.section_id || !taskDraft.kind) return;

    if (taskDraft.kind === "repeating") taskStep = 2;
    else taskStep = 2; // confirm for one-off
    renderTaskWizard();
    return;
  }

  if (taskStep === 2 && hasScheduleStep) {
    // validation if "some days"
    if (taskDraft.schedule.mode === "some_days") {
      if (taskDraft.schedule.some_freq === "weekly" && taskDraft.schedule.weekdays.size === 0) return;
      if (taskDraft.schedule.some_freq === "monthly" && taskDraft.schedule.monthdays.size === 0) return;
    }
    taskStep = 3;
    renderTaskWizard();
    return;
  }

  if (taskStep !== confirmStep) return;

  // save
  try {
    if (taskDraft.kind === "repeating") {
      const schedule_rule = scheduleToRule();

      const created = await dbInsertTask({
        title: taskDraft.title,
        section_id: taskDraft.section_id,
        is_active: true,
        sort_order: 100,
        unlock_rule: { type: "always" },
        schedule_rule,
      });

      tasks.push(created);
      saveLocalJSON("tasks", tasks);
    } else {
      const created = await dbInsertOneOff(todayYMD, {
        title: taskDraft.title,
        section_id: taskDraft.section_id,
      });
      oneOffs.push(created);
      saveLocalJSON(`oneOffs:${todayYMD}`, oneOffs);
    }

    closeTaskModal();
    renderAll();
    setBadge("ok", "Synced");
  } catch {
    setBadge("warn", "Local only");
  }
});

// ====== Auth ======
async function refreshSessionUI() {
  const { data } = await supabase.auth.getSession();
  currentUser = data.session?.user || null;

  if (currentUser) {
    authPanel.style.display = "none";
    topSignOutBtn.style.display = "inline-block";
    setBadge("ok", "Synced");
  } else {
    authPanel.style.display = "block";
    topSignOutBtn.style.display = "none";
    setBadge("warn", "Local only");
  }

  await loadEverythingForToday();
}

signUpBtn.onclick = async () => {
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  if (!email || !password) return;

  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return setBadge("err", "Sign-up failed");
  setBadge("warn", "Check email");
};

signInBtn.onclick = async () => {
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  if (!email || !password) return;

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return setBadge("err", "Sign-in failed");
  await refreshSessionUI();
};

topSignOutBtn.onclick = async () => {
  await supabase.auth.signOut();
  await refreshSessionUI();
};

supabase.auth.onAuthStateChange(() => {
  refreshSessionUI();
});

// ====== Init ======
setBadge("warn", "Local only");
await refreshSessionUI();
await loadEverythingForToday();
