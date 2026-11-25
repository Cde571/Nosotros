import { createClient } from "@supabase/supabase-js";
import { createCloud } from "./cloud-client.cjs";
if (!window.desktop) {
  const callbacks = {};
  const emit = (name, value) =>
    (callbacks[name] || []).forEach((fn) => fn(value));
  const host = (op, values = {}) =>
    window.chrome?.webview?.postMessage({ op, ...values });
  window.desktop = {
    window: (action) => host("window", { action }),
    widget: async (on) => {
      host("widget", { on });
      document.body.classList.toggle("widget-mode", on);
      return on;
    },
    notify: (title, body) => host("notify", { title, body }),
    on: (name, fn) => (callbacks[name] ??= []).push(fn),
    cloud: createCloud(createClient, emit),
  };
}
