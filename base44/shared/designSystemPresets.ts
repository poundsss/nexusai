// Design System presets — Phase 1 static, READ-ONLY registry.
//
// Bolt-style selector data: each entry describes a real, published component library/design
// system. NOTHING here is invented: package names are the libraries' real published packages,
// token values are the libraries' real documented defaults, and the usage guidance describes
// what is actually possible in the NexusAI generated-app runtime.
//
// Runtime constraint (RUNTIME_GUIDE, prompts.ts): generated apps are plain ES modules —
// Preact + htm tagged templates + Tailwind, NO JSX, NO TypeScript, NO npm packages, NO bundler.
// Therefore a library that ships as an npm React component package CANNOT be consumed by
// generated applications today: it is marked supported:false with the exact reason rather than
// being shown as usable. shadcn/ui ships as COPY-IN SOURCE (not an npm package), so its design
// language CAN be implemented in-project by the model — that is the one honestly supported entry.
//
// Selecting a system must never rewrite existing files: the selection only adds guidance to NEW
// Build output (see designSystemLibraryBlock); existing code changes only when the user's request
// explicitly asks the Build to modify it.

export const DESIGN_SYSTEM_PRESETS = {
  shadcn: {
    id: "shadcn",
    name: "Shadcn UI",
    category: "open_source",
    supported: true,
    unsupported_reason: null,
    packages: [],
    // Real published default (zinc) token values of shadcn/ui, in its documented HSL notation.
    tokens: {
      "--background": "0 0% 100%",
      "--foreground": "240 10% 3.9%",
      "--primary": "240 5.9% 10%",
      "--primary-foreground": "0 0% 98%",
      "--secondary": "240 4.8% 95.9%",
      "--muted": "240 4.8% 95.9%",
      "--accent": "240 4.8% 95.9%",
      "--destructive": "0 84.2% 60.2%",
      "--border": "240 5.9% 90%",
      "--input": "240 5.9% 90%",
      "--ring": "240 10% 3.9%",
      "--radius": "0.5rem",
    },
    usage:
      "shadcn/ui is a copy-in component pattern, not a package: components are authored INTO the project's own source in the shadcn visual language (neutral zinc palette, 0.5rem radius, subtle borders, muted secondary surfaces), not imported from a library. This runtime uses plain ES modules with Preact + htm tagged templates and Tailwind — implement each component as a plain function component in src/components/ following the shadcn look and behaviour (Button, Card, Dialog, Input, Badge, Table…), never an npm import.",
    rules: [
      "Author components in-project in the shadcn visual language; never import a component library (the runtime has no npm packages).",
      "Express the palette and radius through the project's existing token stylesheet (styles.css / the DESIGN SYSTEM block) — never ad-hoc hardcoded colors.",
      "The project's existing DESIGN SYSTEM block stays authoritative for class usage and lint; apply the selected system's look to NEW components and to design patches, not by rewriting untouched files.",
    ],
  },
  "material-ui": {
    id: "material-ui",
    name: "Material UI",
    category: "open_source",
    supported: false,
    unsupported_reason:
      "Material UI ships as npm React component packages (@mui/material + @emotion/react + @emotion/styled); the generated-app runtime is plain ES modules (Preact + htm, no npm packages, no JSX), so its components cannot be consumed today.",
    packages: ["@mui/material", "@emotion/react", "@emotion/styled"],
    tokens: null,
    usage: null,
    rules: [],
  },
  chakra: {
    id: "chakra",
    name: "Chakra UI",
    category: "open_source",
    supported: false,
    unsupported_reason:
      "Chakra UI ships as an npm React component package (@chakra-ui/react + @emotion/react); the generated-app runtime is plain ES modules (Preact + htm, no npm packages, no JSX), so its components cannot be consumed today.",
    packages: ["@chakra-ui/react", "@emotion/react"],
    tokens: null,
    usage: null,
    rules: [],
  },

  // Corporate presets — Bolt-parity category. These are DESIGN-LANGUAGE presets, not component
  // libraries: each real system ships its components as an npm React package or web components,
  // which this runtime cannot consume, so the preset carries only the system's PUBLISHED design
  // tokens and rules and the model authors components in-project. Every token value below was
  // verified against the system's official published token source at the time it was added; no
  // value is invented, and values that were not verifiable are simply absent.
  "washington-post": {
    id: "washington-post",
    name: "Washington Post",
    category: "corporate",
    supported: true,
    unsupported_reason: null,
    packages: [],
    // Official published tokens of the Washington Post Design System (WPDS), verbatim from the
    // published token package @washingtonpost/wpds-tokens.
    tokens: {
      "--wpds-colors-gray0": "rgba(0, 0, 0, 1)",
      "--wpds-colors-gray20": "rgba(17, 17, 17, 1)",
      "--wpds-colors-gray80": "rgba(89, 89, 89, 1)",
      "--wpds-colors-gray100": "rgba(115, 115, 115, 1)",
      "--wpds-colors-red100": "rgba(234, 0, 23, 1)",
      "--wpds-colors-blue100": "rgba(22, 109, 252, 1)",
    },
    usage:
      "The Washington Post Design System (WPDS) is a published React component library (@washingtonpost/wpds-ui-kit), which this runtime cannot import — implement its design language in-project instead: white background with black body text, grays for secondary text and captions, the Post red for headline and accent emphasis, blue for links, and the WPDS typography voice (Franklin-style condensed display). Editorial, news-like layout: dense type hierarchy, thin dividers, no decorative chrome.",
    rules: [
      "Author components in-project in the WPDS design language; never import a component library (the runtime has no npm packages).",
      "Express the palette through the project's existing token stylesheet (styles.css / the DESIGN SYSTEM block) — never ad-hoc hardcoded colors.",
      "The project's existing DESIGN SYSTEM block stays authoritative for class usage and lint; apply the selected system's look to NEW components and to design patches, not by rewriting untouched files.",
    ],
  },
  cloudscape: {
    id: "cloudscape",
    name: "AWS Cloudscape",
    category: "corporate",
    supported: true,
    unsupported_reason: null,
    packages: [],
    // Official published tokens of Cloudscape Design System, verbatim from the published token
    // package @cloudscape-design/design-tokens.
    tokens: {
      "--color-background-layout-main": "#ffffff",
      "--color-background-card": "#ffffff",
      "--color-text-body-default": "#0f141a",
      "--color-text-body-secondary": "#424650",
      "--color-background-button-primary-default": "#006ce0",
      "--color-background-button-primary-hover": "#002b66",
      "--color-text-link-default": "#006ce0",
      "--color-border-divider-default": "#c6c6cd",
    },
    usage:
      "Cloudscape Design System is a published React component library (@cloudscape-design/components), which this runtime cannot import — implement its design language in-project instead: white surfaces on a white layout, thin gray dividers and card borders, near-black body text with gray secondary text, the Cloudscape blue for primary buttons and links, and the compact, information-dense AWS console look (dense tables, bordered cards, tight controls).",
    rules: [
      "Author components in-project in the Cloudscape design language; never import a component library (the runtime has no npm packages).",
      "Express the palette through the project's existing token stylesheet (styles.css / the DESIGN SYSTEM block) — never ad-hoc hardcoded colors.",
      "The project's existing DESIGN SYSTEM block stays authoritative for class usage and lint; apply the selected system's look to NEW components and to design patches, not by rewriting untouched files.",
    ],
  },
  porsche: {
    id: "porsche",
    name: "Porsche",
    category: "corporate",
    supported: true,
    unsupported_reason: null,
    packages: [],
    // Official published tokens of the Porsche Design System (v4), verbatim from its published
    // token documentation (light-dark pairs kept exactly as published).
    tokens: {
      "--p-color-canvas": "light-dark(#fff, hsl(225 66.7% 1.2%))",
      "--p-color-surface": "light-dark(hsl(240 10% 95%), hsl(240 2% 10%))",
      "--p-color-primary": "light-dark(hsl(225 66.7% 1.2%), hsl(225 100% 99%))",
      "--p-color-info": "light-dark(hsl(228 83.2% 51%), hsl(210 100% 54.5%))",
      "--p-color-success": "light-dark(hsl(115 77.5% 27.8%), hsl(157 84.9% 41.6%))",
      "--p-color-warning": "light-dark(hsl(28 97.7% 34.1%), hsl(28 90.2% 56.1%))",
      "--p-color-error": "light-dark(hsl(357 78% 41%), hsl(0 96.9% 62%))",
      "--p-color-focus": "#1A44EA",
    },
    usage:
      "The Porsche Design System is a published web-components library (@porsche-design-system), which this runtime cannot import — implement its design language in-project instead: white canvas with near-black primary text and light gray surfaces in light mode (the tokens above are light-dark() pairs; apply the light side), high-contrast typography, generous whitespace with a precise, engineered grid, the focus outline blue for interactive states, and the Porsche brand red reserved for small brand accents.",
    rules: [
      "Author components in-project in the Porsche design language; never import a component library (the runtime has no npm packages).",
      "Express the palette through the project's existing token stylesheet (styles.css / the DESIGN SYSTEM block) — never ad-hoc hardcoded colors.",
      "The project's existing DESIGN SYSTEM block stays authoritative for class usage and lint; apply the selected system's look to NEW components and to design patches, not by rewriting untouched files.",
    ],
  },
};

export const designSystemPreset = (id) =>
  (id && DESIGN_SYSTEM_PRESETS[String(id)]) || null;

export const supportedDesignSystemIds = () =>
  Object.values(DESIGN_SYSTEM_PRESETS).filter((p) => p.supported).map((p) => p.id);

export const isSupportedDesignSystemId = (id) =>
  supportedDesignSystemIds().includes(String(id || ""));

// Prompt block for the SELECTED design system. Empty string when nothing (or an unsupported id)
// is selected, so the run prompt stays byte-identical to the existing behavior. Bounded: guidance
// + real tokens only — never repository/package contents.
export function designSystemLibraryBlock(id) {
  const preset = designSystemPreset(id);
  if (!preset || !preset.supported) return "";
  const tokens = Object.entries(preset.tokens || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  return `SELECTED DESIGN SYSTEM — ${preset.name} (${preset.category.replace(/_/g, " ")})
This system was selected for the project and applies to NEW components this Build creates. It does NOT authorize rewriting existing files: modify existing code only where the user's request explicitly asks for it.
Usage: ${preset.usage}
Reference tokens (the library's documented defaults; express them through the project's token stylesheet, not as ad-hoc styles):
${tokens}
Rules:
${preset.rules.map((r) => `- ${r}`).join("\n")}`;
}