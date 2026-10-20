import { createElement, useState, useEffect, useCallback, useMemo, useRef, useContext } from "react";
import htm from "htm";
import { useLocation, Link as RRLink } from "react-router-dom";
import { base44 } from "@/api/base44Client";

// The recovered CRM was authored against a preact/htm "runtime" module. This shim
// binds htm to React.createElement so the recovered UI templates run verbatim.
// htm passes `class` through as-is; React needs `className`, so map it here once
// instead of rewriting every recovered template.
const reactCreate = (type, props, ...children) => {
  if (props && typeof props === "object") {
    // preact accepts `class`; React needs `className`.
    if ("class" in props) { props.className = props.class; delete props.class; }
    // preact accepts a style string; React requires a style object.
    if (typeof props.style === "string") {
      const styleObj = {};
      props.style.split(";").forEach((decl) => {
        const idx = decl.indexOf(":");
        if (idx > -1) {
          const key = decl.slice(0, idx).trim();
          const val = decl.slice(idx + 1).trim();
          if (key) styleObj[key] = val;
        }
      });
      props.style = styleObj;
    }
    // preact is case-insensitive for these; React camelCases them.
    if ("colspan" in props) { props.colSpan = props.colspan; delete props.colspan; }
    if ("rowspan" in props) { props.rowSpan = props.rowspan; delete props.rowspan; }
  }
  return createElement(type, props, ...children);
};

const html = htm.bind(reactCreate);

// Recovered pages use <${Link} href="...">; react-router's Link wants `to`.
function Link({ href, to, children, ...rest }) {
  return createElement(RRLink, { to: to || href, ...rest }, children);
}

function useRoute() {
  return useLocation().pathname;
}

// Recovered code calls navigate('/path') as a plain function (not a hook).
// pushState + a synthetic popstate makes BrowserRouter re-render.
const navigate = (to) => {
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

const auth = {
  me: () => base44.auth.me(),
  logout: (redirectUrl) => base44.auth.logout(redirectUrl),
};

// Proxy so newly created entities resolve at access time.
const db = new Proxy({}, {
  get: (_t, name) => base44.entities[name],
});

const server = new Proxy({}, {
  get: (_t, name) => async (args) => {
    try {
      const res = await base44.functions.invoke(name, args || {});
      let data = res.data;
      // Compatibility: the recovered getWeather function returns temp/wind/city,
      // but the recovered Weather page reads temperature/windSpeed/location.
      // condition and humidity already match, so only these three are mapped.
      if (name === "getWeather" && data && typeof data === "object" && !data.error) {
        data = { ...data, temperature: data.temp, windSpeed: data.wind, location: data.city };
      }
      return data;
    } catch (err) {
      return (err && err.response && err.response.data) || { error: (err && err.message) || "Request failed" };
    }
  },
});

// Some recovered pages reference window.db / window.server directly.
if (typeof window !== "undefined") {
  window.db = db;
  window.server = server;
}

export { html, useRoute, useState, useEffect, useCallback, useMemo, useRef, useContext, auth, navigate, Link, db, server };