import type { ThemeColors } from "./svg.js";

/** Named theme presets — referenced by TuiSpec.theme; agents restyle the whole canvas in one edit. */
export interface Theme {
  label: string;
  colors: ThemeColors & { selection: string };
}

export const THEMES: Record<string, Theme> = {
  tokyonight: {
    label: "Tokyo Night",
    colors: { bg: "#24283b", fg: "#c0caf5", border: "#414868", accent: "#7aa2f7", dim: "#565f89", selection: "#e0af68" },
  },
  catppuccin: {
    label: "Catppuccin Mocha",
    colors: { bg: "#1e1e2e", fg: "#cdd6f4", border: "#585b70", accent: "#89b4fa", dim: "#7f849c", selection: "#f9e2af" },
  },
  nord: {
    label: "Nord",
    colors: { bg: "#2e3440", fg: "#d8dee9", border: "#4c566a", accent: "#88c0d0", dim: "#69788f", selection: "#ebcb8b" },
  },
  gruvbox: {
    label: "Gruvbox Dark",
    colors: { bg: "#282828", fg: "#ebdbb2", border: "#504945", accent: "#83a598", dim: "#928374", selection: "#fabd2f" },
  },
  dracula: {
    label: "Dracula",
    colors: { bg: "#282a36", fg: "#f8f8f2", border: "#44475a", accent: "#bd93f9", dim: "#6272a4", selection: "#f1fa8c" },
  },
};

export function themeByName(name: string | undefined): Theme {
  return THEMES[name ?? ""] ?? THEMES.tokyonight!;
}
