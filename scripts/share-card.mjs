// Make public/og.png, the link-preview card: the 3D reels mid-playback with the
// title and a line of description baked into the image (X shows large cards
// without their text). Needs the dev server running and Google Chrome installed.
//
//   npm run dev                      (in another terminal)
//   npm run card [-- http://localhost:3000] [-- --loop 2023-184-04]
import { chromium } from "playwright-core";
import fs from "node:fs";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http")) || "http://localhost:3000";
const loopId = args.includes("--loop") ? args[args.indexOf("--loop") + 1] : null;
const TITLE = "OP-1 Loops";
const LINE = process.env.CARD_LINE || "168 four-track loops from my OP-1 field. Play them in your browser.";

const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2, colorScheme: "dark" });
await page.goto(url, { waitUntil: "networkidle" });
if (loopId) await page.click(`#item-${loopId}`);
await page.waitForFunction(() => !document.querySelector("button.play")?.disabled, null, { timeout: 30000 });
await page.click("button.play");

// Lift the reels into a full-size card; the canvas resizes to the new box.
await page.evaluate(({ TITLE, LINE }) => {
  const css = getComputedStyle(document.documentElement);
  const card = document.createElement("div");
  card.id = "card";
  Object.assign(card.style, {
    position: "fixed", inset: "0", zIndex: "9999", overflow: "hidden",
    background: `radial-gradient(120% 90% at 75% 70%, #2a2622 0%, ${css.getPropertyValue("--bg").trim() || "#141413"} 62%)`,
    fontFamily: getComputedStyle(document.body).fontFamily,
  });
  const text = document.createElement("div");
  Object.assign(text.style, { position: "absolute", left: "64px", top: "56px", width: "760px", color: "#f3f1ec" });
  const h = document.createElement("div");
  h.textContent = TITLE;
  Object.assign(h.style, { fontSize: "88px", fontWeight: "700", letterSpacing: "-1.5px", lineHeight: "1" });
  const p = document.createElement("div");
  p.textContent = LINE;
  Object.assign(p.style, { fontSize: "50px", fontWeight: "500", lineHeight: "1.18", marginTop: "22px", color: "#d9d5cc" });
  text.append(h, p);
  const reels = document.querySelector(".reels3d");
  Object.assign(reels.style, { position: "absolute", right: "-200px", bottom: "-70px", width: "1100px", height: "484px", margin: "0" });
  card.append(reels, text);
  document.body.append(card);
}, { TITLE, LINE });

await page.waitForTimeout(6000); // let the reels turn and the tape run
fs.mkdirSync("public", { recursive: true });
await page.screenshot({ path: "public/og.png", clip: { x: 0, y: 0, width: 1200, height: 630 }, scale: "css" });
await browser.close();
console.log("wrote public/og.png (1200×630)");
