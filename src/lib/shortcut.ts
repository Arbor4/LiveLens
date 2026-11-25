const KEY_MAP: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Escape",
  Enter: "Return",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
};

export function splitShortcutParts(shortcut: string): string[] {
  return shortcut.replace("CommandOrControl", "Ctrl").split("+");
}

export function keyEventToShortcut(event: KeyboardEvent): string | "cancel" | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
    return null;
  }
  if (event.key === "Escape") {
    return "cancel";
  }
  const key = KEY_MAP[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : null);
  if (!key) {
    return null;
  }
  const mods: string[] = [];
  if (event.ctrlKey) mods.push("CommandOrControl");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Super");
  return [...mods, key].join("+");
}
