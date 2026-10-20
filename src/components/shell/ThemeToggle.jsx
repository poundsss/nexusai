import React from "react";
import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";

// Global theme switcher: toggles the whole app between the light and dark palette
// (next-themes class strategy, persisted per browser).
export default function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="h-8 w-8 shrink-0" aria-hidden />;
  const isDark = theme === "dark" || (!theme && resolvedTheme === "dark");
  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Светлая тема" : "Тёмная тема"}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}