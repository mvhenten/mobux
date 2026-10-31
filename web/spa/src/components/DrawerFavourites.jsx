import { useState } from "preact/hooks";
import { getPref, setPref } from "../lib/prefs.js";

const PREF_KEY = "drawer_favourites";
const FAVOURITE_MAX_LEN = 1000;

function byUses(a, b) {
  return b.uses - a.uses;
}

export function DrawerFavourites({ engineRef }) {
  const [favourites, setFavourites] = useState(() => getPref(PREF_KEY));
  const [draft, setDraft] = useState("");

  const update = (next) => {
    const sorted = [...next].sort(byUses);
    setPref(PREF_KEY, sorted);
    setFavourites(sorted);
  };

  const add = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (favourites.some((f) => f.text === text)) return;
    update([...favourites, { text, uses: 0 }]);
  };

  const run = (text) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.submit(text);
    engine.closeCommandMenu();
    update(
      favourites.map((f) => (f.text === text ? { ...f, uses: f.uses + 1 } : f)),
    );
  };

  const remove = (text) => update(favourites.filter((f) => f.text !== text));

  return (
    <details class="cmd-group cmd-section" id="cmdFavouritesSection">
      <summary class="cmd-section-title">Frequent &amp; favourites</summary>
      <ul class="cmd-fav-list">
        {favourites.map((f) => (
          <li class="cmd-fav-row" key={f.text}>
            <button
              type="button"
              class="cmd-item cmd-fav-run"
              onClick={() => run(f.text)}
            >
              {f.text}
            </button>
            <button
              type="button"
              class="cmd-fav-remove"
              aria-label={`Remove ${f.text}`}
              onClick={() => remove(f.text)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form class="cmd-fav-add" onSubmit={add}>
        <input
          type="text"
          class="cmd-fav-input"
          aria-label="Shell command to add"
          placeholder="Add a command"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          enterkeyhint="done"
          maxLength={FAVOURITE_MAX_LEN}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button type="submit" class="cmd-fav-submit">
          Add
        </button>
      </form>
    </details>
  );
}
