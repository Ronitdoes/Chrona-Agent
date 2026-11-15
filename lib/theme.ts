export type Theme = "system" | "light" | "dark";
const storageKey = "web-agent-theme";
const eventName = "web-agent-theme-change";
const mediaQuery = "(prefers-color-scheme: dark)";

function preference(value: string | null | undefined): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

// Runs in the head, before any content paints. Keep it self-contained and free of user input.
export const themeScript = `(()=>{let theme="system";try{const saved=localStorage.getItem("web-agent-theme");if(saved==="light"||saved==="dark")theme=saved}catch{}const root=document.documentElement;root.dataset.theme=theme;root.classList.toggle("dark",theme==="dark"||(theme==="system"&&matchMedia("(prefers-color-scheme: dark)").matches))})()`;

export const serverTheme = (): Theme => "system";
export const currentTheme = (): Theme => preference(document.documentElement.dataset.theme);

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark" || (theme === "system" && window.matchMedia(mediaQuery).matches));
  window.dispatchEvent(new Event(eventName));
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try { window.localStorage.setItem(storageKey, theme); } catch { /* In-memory selection still works when storage is blocked. */ }
}

export function subscribeToTheme(onChange: () => void): () => void {
  const media = window.matchMedia(mediaQuery);
  const onSystemChange = () => { if (currentTheme() === "system") applyTheme("system"); };
  const onStorageChange = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) applyTheme(preference(event.newValue));
  };
  window.addEventListener(eventName, onChange);
  window.addEventListener("storage", onStorageChange);
  media.addEventListener("change", onSystemChange);
  return () => {
    window.removeEventListener(eventName, onChange);
    window.removeEventListener("storage", onStorageChange);
    media.removeEventListener("change", onSystemChange);
  };
}
