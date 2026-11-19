import page from "./admin/page.html";
import css from "./admin/admin.css";
import shared from "./admin/shared.js";
import upstream from "./admin/upstream.js";
import keys from "./admin/keys.js";
import guide from "./admin/guide.js";
import boot from "./admin/boot.js";

export function adminHtml(origin: string): string {
  const js = [shared, upstream, keys, guide, boot]
    .join("\n")
    .replaceAll("__ORIGIN__", JSON.stringify(origin));
  return page.replace("/*__CSS__*/", () => css).replace("/*__JS__*/", () => js);
}
