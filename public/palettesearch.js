// ── Search the node library ─────────────────────────────────────────
// Type to show only matching nodes (name, group, help text, or the Node-RED name
// the AI helper knows), groups without a match hide. Enter adds the first match
// (outlined; a name match beats a help-text match), Esc clears, "/" anywhere outside a text field jumps to the box.
// Every word typed must match ("gpio out", "radio mqtt", "timer reset").
function paletteText(b) {
  const type = b.dataset.type;
  const c = catalog[type] || {};
  const red =
    typeof NODE_RED_NAME !== "undefined" ? NODE_RED_NAME[type] || "" : "";
  return [b.textContent, c.label, c.group, type, c.help, red, b.title]
    .join(" ")
    .toLowerCase();
}
function filterPalette() {
  const box = $("palette");
  const words = $("paletteSearch")
    .value.toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  let first = null,
    firstScore = -1,
    shown = 0,
    group = null,
    groupHas = false;
  const closeGroup = () => group && (group.hidden = !groupHas);
  box.querySelector(".palette-empty")?.remove();
  for (const item of box.children) {
    if (item.classList.contains("group-label")) {
      closeGroup();
      group = item;
      groupHas = false;
      continue;
    }
    if (!item.classList.contains("palette-node")) {
      item.hidden = words.length > 0; // hints (e.g. CUSTOM's) only without a search
      continue;
    }
    const text = paletteText(item);
    const hit = words.every((w) => text.includes(w));
    item.hidden = !hit;
    item.classList.remove("search-first");
    if (hit) {
      groupHas = true;
      shown++;
      // The outlined pick: a node whose name matches beats a help-text match.
      const name = (item.textContent + " " + (catalog[item.dataset.type]?.label || "")).toLowerCase();
      const score = words.every((w) => name.includes(w)) ? (name.includes(words.join(" ")) ? 2 : 1) : 0;
      if (!item.disabled && (!first || score > firstScore)) {
        first = item;
        firstScore = score;
      }
    }
  }
  closeGroup();
  if (words.length && first) first.classList.add("search-first");
  if (words.length && !shown)
    box.append(el("p", "palette-empty", "No node matches. Try fewer words."));
  return first;
}
$("paletteSearch").addEventListener("input", filterPalette);
$("paletteSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const first = filterPalette();
    if (first) first.click();
  } else if (e.key === "Escape") {
    $("paletteSearch").value = "";
    filterPalette();
    $("paletteSearch").blur();
  }
});
document.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.target.closest?.("input, textarea, select, [contenteditable]") &&
    !document.querySelector("dialog[open]")
  ) {
    e.preventDefault();
    $("paletteSearch").focus();
    $("paletteSearch").select();
  }
});
