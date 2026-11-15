"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { currentTheme, serverTheme, setTheme, subscribeToTheme } from "../lib/theme";

const options = [
  { value: "light", label: "Light theme", icon: Sun },
  { value: "system", label: "Use system theme", icon: Monitor },
  { value: "dark", label: "Dark theme", icon: Moon },
] as const;

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToTheme, currentTheme, serverTheme);
  return (
    <div className="theme-options" role="group" aria-label="Appearance">
      {options.map(({ value, label, icon: Icon }) => (
        <button key={value} type="button" className="icon-button" data-theme-option={value}
          aria-label={label} aria-pressed={theme === value} title={label} onClick={() => setTheme(value)}>
          <Icon size={15} strokeWidth={1.6} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
