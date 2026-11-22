"use strict";

const directory = document.getElementById("directory");
const controls = directory.querySelector(".directory-controls");
const query = document.getElementById("directory-query");
const reset = document.getElementById("directory-reset");
const count = document.getElementById("directory-count");
const empty = document.getElementById("directory-empty");
const filters = [...controls.querySelectorAll("[data-filter]")];

function searchTerms(value) {
  return value.toLowerCase().normalize("NFKD").replace(/\p{Mark}/gu, "").match(/[\p{Letter}\p{Number}]+/gu) ?? [];
}

const groups = [...directory.querySelectorAll("[data-category]")].map(section => ({
  section,
  cards: [...section.querySelectorAll(".directory-card")].map(card => {
    const title = section.querySelector("h3").textContent;
    const text = `${title} ${card.textContent} ${card.dataset.keywords}`;
    return { card, index: searchTerms(text).join(" ") };
  }),
}));

let activeCategory = "all";

function updateDirectory() {
  const terms = searchTerms(query.value);
  let visible = 0;

  for (const { section, cards } of groups) {
    const inCategory = activeCategory === "all" || section.dataset.category === activeCategory;
    let visibleInGroup = 0;
    for (const { card, index } of cards) {
      card.hidden = !inCategory || !terms.every(term => index.includes(term));
      if (!card.hidden) visibleInGroup += 1;
    }
    section.hidden = visibleInGroup === 0;
    visible += visibleInGroup;
  }

  count.textContent = `${visible} ${visible === 1 ? "tool" : "tools"}`;
  empty.hidden = visible > 0;
}

function selectCategory(category) {
  activeCategory = category;
  for (const filter of filters) {
    filter.setAttribute("aria-pressed", String(filter.dataset.filter === category));
  }
  updateDirectory();
}

query.addEventListener("input", updateDirectory);
for (const filter of filters) {
  filter.addEventListener("click", () => selectCategory(filter.dataset.filter));
}
reset.addEventListener("click", () => {
  query.value = "";
  selectCategory("all");
  query.focus();
});

controls.hidden = false;
updateDirectory();
