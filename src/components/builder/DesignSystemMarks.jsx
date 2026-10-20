import React from "react";

// Compact inline-SVG brand marks for the design-system selector. Drawn in-project (the
// runtime has no npm icon packages) as close approximations of each system's published mark.
const ChakraMark = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5">
    <path d="M12 1.8l8.9 5.1v10.2L12 22.2l-8.9-5.1V6.9z" fill="#16b8a6" />
    <path d="M13.4 5.6l-6 7.6h3.6l-1 5.2 6-7.6h-3.6z" fill="#ffffff" />
  </svg>
);

const MaterialMark = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5">
    <path d="M2 5h4v9l6-4.5L18 14V5h4v14h-4v-8.5l-6 4.5-6-4.5V19H2z" fill="#007FFF" />
    <path d="M18 5h4v14h-4z" fill="#00A3FF" />
  </svg>
);

const ShadcnMark = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5">
    <rect x="1" y="1" width="22" height="22" rx="5.5" fill="#171717" />
    <path d="M4.5 13L13 4.5h6.5L4.5 19.5z" fill="#ffffff" opacity="0.92" />
    <path d="M11.5 19.5L19.5 11.5v5.4l-2.6 2.6z" fill="#ffffff" opacity="0.92" />
  </svg>
);

const WashingtonPostMark = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5">
    <circle cx="12" cy="12" r="11" fill="#000000" />
    <text x="12" y="15.8" textAnchor="middle" fontSize="10" fontWeight="800" fill="#ffffff" fontFamily="Georgia, 'Times New Roman', serif">wp</text>
  </svg>
);

const CloudscapeMark = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5">
    <circle cx="12" cy="12" r="11" fill="#232F3E" />
    <text x="12" y="13.4" textAnchor="middle" fontSize="7" fontWeight="700" fill="#ffffff" fontFamily="Arial, sans-serif">aws</text>
    <path d="M7 15.4c3.1 2.4 6.9 2.4 10 0" stroke="#FF9900" strokeWidth="1.3" fill="none" strokeLinecap="round" />
  </svg>
);

const PorscheMark = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5">
    <path d="M12 2.2c2.7 1 5.4 1.6 7.6 1.7v7c0 4.7-3.1 8-7.6 9.5-4.5-1.5-7.6-4.8-7.6-9.5v-7c2.2-.1 4.9-.7 7.6-1.7z" fill="#C7A15A" />
    <path d="M12 5.6c1.9.7 3.7 1.1 5.4 1.2v4.7c0 3.2-2.1 5.6-5.4 6.9-3.3-1.3-5.4-3.7-5.4-6.9V6.8c1.7-.1 3.5-.5 5.4-1.2z" fill="#8C1D22" />
    <path d="M9.5 6.4h1.5v11h-1.5zM13 6.4h1.5v11H13z" fill="#1a1a1a" />
  </svg>
);

const MARKS = {
  chakra: ChakraMark,
  "material-ui": MaterialMark,
  shadcn: ShadcnMark,
  "washington-post": WashingtonPostMark,
  cloudscape: CloudscapeMark,
  porsche: PorscheMark,
};

export default function DesignSystemMark({ id }) {
  const Mark = MARKS[id];
  if (!Mark) return null;
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center">
      <Mark />
    </span>
  );
}