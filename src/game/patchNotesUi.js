import { el } from "./dom.js";
import { PATCH_NOTES } from "./patchNotes.js";

// Each highlight line in patchNotes.js is written with a leading "New:"/"Changed:"/"Fixed:"/
// "Balance:" tag (an existing convention, not something added for this) — reused here as the
// category for the tab filter rather than adding a parallel structured field to the data file,
// so PATCH_NOTES stays the same plain append-only list of strings it's always been. A line
// without a recognized tag (a handful of older entries predate the convention) falls back to
// "changed", the closest general bucket.
const CATEGORY_PATTERN = /^(New|Changed|Fixed|Balance):\s*/i;
function categorizeHighlight(line) {
  const match = CATEGORY_PATTERN.exec(line);
  if (!match) return { category: "changed", text: line };
  return { category: match[1].toLowerCase(), text: line.slice(match[0].length) };
}

// Renders PATCH_NOTES (newest first) into the Patch Notes screen and wires it to the landing
// screen's button + its own Back button. Static content, built from data that never changes at
// runtime — rendered once up front rather than on every open.
export function createPatchNotesUi(ctx) {
  el.patchNotesList.innerHTML = "";
  for (const entry of PATCH_NOTES) {
    const section = document.createElement("div");
    section.className = "patch-notes-entry";

    const heading = document.createElement("h2");
    heading.textContent = entry.date ? `v${entry.version} — ${entry.date}` : `v${entry.version}`;
    section.appendChild(heading);

    const list = document.createElement("ul");
    for (const line of entry.highlights) {
      const { category, text } = categorizeHighlight(line);
      const li = document.createElement("li");
      li.dataset.category = category;
      li.textContent = text;
      list.appendChild(li);
    }
    section.appendChild(list);

    el.patchNotesList.appendChild(section);
  }

  // Tabs filter each version's list down to one category at a time; a version with nothing in
  // the selected category (e.g. a patch with no Balance changes) hides its whole heading too,
  // rather than showing an empty section under it.
  const tabButtons = [...el.patchNotesTabs.querySelectorAll(".patch-notes-tab")];
  function applyFilter(category) {
    for (const section of el.patchNotesList.children) {
      let anyVisible = false;
      for (const li of section.querySelectorAll("li")) {
        const visible = li.dataset.category === category;
        li.classList.toggle("hidden", !visible);
        if (visible) anyVisible = true;
      }
      section.classList.toggle("hidden", !anyVisible);
    }
  }
  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      for (const b of tabButtons) b.classList.toggle("selected", b === btn);
      applyFilter(btn.dataset.category);
    });
  }
  applyFilter(tabButtons.find((b) => b.classList.contains("selected"))?.dataset.category ?? "new");

  // A persistent corner button (like the version badge), reachable from any menu/lobby screen
  // rather than only the landing screen — the shared screen manager remembers whichever screen
  // was open at click time and restores it on Back.
  el.patchNotesBtn.addEventListener("click", () => ctx.screens.showScreen(el.patchNotesScreen));
  el.patchNotesBackBtn.addEventListener("click", () => ctx.screens.showPreviousScreen());
}
