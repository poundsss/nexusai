import { base44 } from "@/api/base44Client";

// Thin client over the EXISTING googleAds brief actions. project_id is always its own field.
export const briefCall = async (action, project_id, extra = {}) => {
  try {
    const res = await base44.functions.invoke("googleAds", { action, project_id, ...extra });
    return res.data;
  } catch (e) {
    throw new Error(e.response?.data?.error || e.message || "Request failed");
  }
};

export const toLines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
export const toMicros = (dollars) => (dollars === "" || dollars == null ? null : Math.round(Number(dollars) * 1e6));
export const fromMicros = (m) => (m ? String(m / 1e6) : "");