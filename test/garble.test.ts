import test from "node:test";
import assert from "node:assert/strict";
import { speak } from "../src/speech.js";

const fda = (title: string) => ({ query: "zyrtec", source: "fda-drug" as const, total: 1,
  recalls: [{ source: "fda-drug" as const, id: "D-1", date: "2022-08-01", title, hazard: "Product held outside storage temperature.", remedy: "", url: "https://example.org" }] });

test("abbreviated FDA product names are not read aloud", () => {
  assert.match(speak(fda("Ready in Case Ctrzne Alrgy All Dy Tblt 5 Mg 30 Ct")), /It is a product listed under zyrtec\./);
});

test("normal FDA product names are kept", () => {
  assert.match(speak(fda("Childrens Zyrtec Allergy Syrup, 4 fl oz")), /It is Childrens Zyrtec Allergy Syrup\./);
  assert.match(speak(fda("BBQ Dry Rub Seasoning, 6 oz")), /It is BBQ Dry Rub Seasoning\./);
});

test("an ALL CAPS abbreviated FDA record is not read aloud", () => {
  assert.match(speak(fda("READY IN CASE CTRZNE ALRGY ALL DY TBLT 5 MG 30 CT")), /It is a product listed under zyrtec\./);
});
