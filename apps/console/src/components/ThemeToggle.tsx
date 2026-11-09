"use client";
import { useEffect, useState } from "react";

type Theme = "auto" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };

/** System setting by default + manual override (IA §3 다크 모드). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("auto");
  useEffect(() => {
    try {
      const t = localStorage.getItem("ao-theme");
      if (t === "light" || t === "dark") setTheme(t);
    } catch { /* storage blocked */ }
  }, []);
  const apply = (t: Theme) => {
    setTheme(t);
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    try {
      if (t === "auto") localStorage.removeItem("ao-theme");
      else localStorage.setItem("ao-theme", t);
    } catch { /* storage blocked */ }
  };
  return (
    <button type="button" className="btn ghost theme-t" onClick={() => apply(NEXT[theme])} aria-label={`Theme: ${theme}. Switch to ${NEXT[theme]}`}>
      <span className="mono xs">{theme === "auto" ? "AUTO" : theme === "light" ? "LIGHT" : "DARK"}</span>
    </button>
  );
}

/** Inline script run before paint to avoid a theme flash. */
export const themeInitScript = `try{var t=localStorage.getItem("ao-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
