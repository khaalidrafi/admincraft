/** FR-ENUM-ONEOF, mounted for real — the proof a normalizer unit test cannot
 *  give: a blank-allowing choice field from the CAPTURED rig renders as a
 *  SELECT carrying its values (not a free-text input), and the empty state
 *  travels as an omitted key rather than a null. The live rig was measured:
 *  priority "" -> 200, "urgent" -> 400, null -> 400, which is exactly why the
 *  blank member must not set FieldSpec.nullable.
 *  Same harness law as lifecycleMount.test.ts / chatMount.test.ts: mount the
 *  real component, drive it the way a user does, assert the captured request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import RecordForm from "../../components/RecordForm.svelte";
import { normalizeOpenAPI } from "../openapi";
import { app } from "../stores";
import fixture from "./fixtures/openapi.json";
import type { ModelSpec } from "../types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const LIVE = normalizeOpenAPI(fixture);
const hosts: Array<{ instance: any; target: HTMLElement }> = [];

function reply(status: number, data: any) {
  return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) };
}

/** Route by URL so the test proves WHICH endpoint and body the client sent. */
function routeProducts(created?: any) {
  mockFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/categories/")) {
      return reply(200, { count: 1, next: null, previous: null, results: [{ id: 3, name: "Bakery" }] });
    }
    if (u.includes("/api/products/") ) {
      return reply(201, created ?? { id: 99, name: "Sourdough Loaf" });
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
}

function render(model: ModelSpec) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  app.set({
    token: "tok",
    booted: true,
    apiUrlOverride: "http://api.test",
    config: { apiUrl: "http://api.test", authPath: "/api/auth/token/", schemaPath: "/api/schema/" },
    schema: LIVE,
  } as any);
  flushSync(() => {
    hosts.push({
      target,
      instance: mount(RecordForm, {
        target,
        props: { model, onclose: () => {}, onsaved: () => {} },
      }),
    });
  });
  return target;
}

/** FK dropdowns fill from an async fetch; setting a value before the options
 *  land silently leaves the select empty and the required-field guard eats the
 *  submit, so every interaction starts here. */
async function renderReady(model: ModelSpec) {
  const host = render(model);
  await vi.waitFor(() => {
    flushSync(() => {});
    const fk = host.querySelector("#f-category") as HTMLSelectElement;
    expect(fk?.options.length).toBeGreaterThan(1);
  });
  return host;
}

/** Drive one field the way a user does.
 *  Harness note, recorded because it is real: happy-dom never answers
 *  `select.querySelector(":checked")` for an <option> (its `:checked` only
 *  covers inputs), and Svelte 5's select binding reads exactly that, falling
 *  back to the first `option:not([disabled])` (see svelte internal
 *  bindings/select.js). So a programmatic `select.value = …` + change event
 *  writes the FIRST option, not the one asked for. Isolating the target as the
 *  only enabled option makes the binding read the value under test — the state
 *  transition is still Svelte's own, which is the point of mounting the form.
 */
function setField(host: HTMLElement, name: string, value: string) {
  const el = host.querySelector(`#f-${name}`) as HTMLInputElement | HTMLSelectElement;
  if (!el) throw new Error(`no field #f-${name} rendered`);
  if (el.tagName === "SELECT") {
    const sel = el as HTMLSelectElement;
    const options = [...sel.options];
    const target = options.find((o) => o.value === value);
    if (!target) throw new Error(`#f-${name} carries no option value "${value}"`);
    for (const o of options) if (o !== target) o.disabled = true;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    for (const o of options) o.disabled = false;
    return;
  }
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitForm(host: HTMLElement) {
  const form = host.querySelector("form")!;
  flushSync(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const postCalls = () =>
  mockFetch.mock.calls.filter((c) => String(c[1]?.method) === "POST" && String(c[0]).includes("/api/products/"));

const postedBody = () => JSON.parse(String(postCalls()[0][1].body));

afterEach(() => {
  while (hosts.length) {
    const h = hosts.pop()!;
    unmount(h.instance);
    h.target.remove();
  }
  mockFetch.mockReset();
  app.set({} as any);
});

describe("mounted case-C field — the select and the payload", () => {
  it("renders the blank-allowing choice field as a select, not a text input", () => {
    routeProducts();
    const host = render(LIVE.byId.products);
    const el = host.querySelector("#f-priority")!;
    // Before the fix this element was <input type="text">: the oneOf property
    // was unrecognised, so a value the server will reject could be typed in.
    expect(el.tagName).toBe("SELECT");
    expect(el.getAttribute("type")).toBeNull();
    expect([...el.querySelectorAll("option")].map((o) => o.getAttribute("value")))
      .toEqual(["", "low", "normal", "high"]);
  });

  it("leaves the empty state un-sent (BlankEnum is omission, not null)", async () => {
    routeProducts();
    const host = await renderReady(LIVE.byId.products);
    setField(host, "name", "Sourdough Loaf");
    setField(host, "price", "12.50");
    setField(host, "category", "3");
    // priority is never touched: the field is optional by schema, so the
    // "—" member (BlankEnum) is what travels — as an omitted key
    submitForm(host);
    await vi.waitFor(() => {
      flushSync(() => {});
      expect(postCalls()).toHaveLength(1);
    });
    const body = postedBody();
    expect(body).not.toHaveProperty("priority");
    expect(body.name).toBe("Sourdough Loaf");
  });

  it("sends the chosen value verbatim", async () => {
    routeProducts();
    const host = await renderReady(LIVE.byId.products);
    setField(host, "name", "Baby Spinach");
    setField(host, "price", "3.99");
    setField(host, "category", "3");
    setField(host, "priority", "high");
    flushSync(() => {});
    submitForm(host);
    await vi.waitFor(() => {
      flushSync(() => {});
      expect(postCalls()).toHaveLength(1);
    });
    expect(postedBody().priority).toBe("high");
  });

  it("an enum the schema declares nullable really does send null", async () => {
    // The mirror case: NullEnum (null=True on the server) is the ONE blank
    // shape where sending null is correct, so the payload rule must flip.
    routeProducts();
    const products = LIVE.byId.products;
    const model: ModelSpec = {
      ...products,
      byName: { ...products.byName },
      fields: products.fields.map((f) =>
        f.name === "priority" ? { ...f, nullable: true } : f,
      ),
    };
    const host = await renderReady(model);
    setField(host, "name", "Roma Tomatoes");
    setField(host, "price", "2.40");
    setField(host, "category", "3");
    submitForm(host);
    await vi.waitFor(() => {
      flushSync(() => {});
      expect(postCalls()).toHaveLength(1);
    });
    expect(postedBody()).toHaveProperty("priority", null);
  });
});
