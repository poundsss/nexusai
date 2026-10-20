import React from "react";
import {
  Mail, Calendar, Hash, Calculator, Waves, Presentation, Figma, Palette,
  CreditCard, Wallet, FileText, Table, HardDrive, Github,
} from "lucide-react";
import { PROVIDER_META } from "./skillCatalog";

const ICONS = {
  Mail, Calendar, Hash, Calculator, Waves, Presentation, Figma, Palette,
  CreditCard, Wallet, FileText, Table, HardDrive, Github,
};

// Small colored provider chip used on the Recommended skill cards.
export default function SkillProviderIcon({ tag }) {
  const meta = PROVIDER_META[tag] || { icon: "Mail", color: "#9ca3af" };
  const Icon = ICONS[meta.icon] || Mail;
  return (
    <span
      title={meta.label}
      className="inline-flex h-4 w-4 items-center justify-center rounded-[3px]"
      style={{ backgroundColor: meta.color }}
    >
      <Icon className="h-2.5 w-2.5 text-white" strokeWidth={2.5} />
    </span>
  );
}