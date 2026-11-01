import sharp from "sharp";
import type { Db } from "./database.js";
export async function seed(db: Db) {
  db.prepare("INSERT OR IGNORE INTO operators VALUES(?,?)").run(
    "operator-1",
    "小林",
  );
  db.prepare("INSERT OR IGNORE INTO operators VALUES(?,?)").run(
    "operator-2",
    "小周",
  );
  for (const [id, name] of [
    ["operator-1", "小林"],
    ["operator-2", "小周"],
  ]) {
    db.prepare("INSERT OR IGNORE INTO accounts VALUES(?,?)").run(id, name);
    db.prepare(
      "INSERT OR IGNORE INTO group_members VALUES('default-group',?,?)",
    ).run(id, new Date().toISOString());
  }
  db.prepare(
    "INSERT OR IGNORE INTO image_groups SELECT id,'default-group' FROM images WHERE id IN ('demo-poster','demo-detail')",
  ).run();
  for (const [id, title, height] of [
    ["demo-poster", "秋日上新 · 品牌海报", 1200],
    ["demo-detail", "轻行系列 · 商品长图", 2600],
  ] as const) {
    if (db.prepare("SELECT id FROM deleted_seed_images WHERE id=?").get(id))
      continue;
    if (db.prepare("SELECT id FROM images WHERE id=?").get(id)) continue;
    const long = height > 1200;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}"><rect width="900" height="${height}" fill="#eae6dd"/><path d="M0 0H900V530Q500 700 0 480Z" fill="#234e46"/><circle cx="730" cy="160" r="210" fill="#d6e9ac" opacity=".18"/><text x="72" y="100" font-family="sans-serif" font-size="24" fill="#d9e7bf" letter-spacing="8">FIELD / NOTES</text><text x="68" y="245" font-family="sans-serif" font-size="92" font-weight="bold" fill="#f6f3df">LESS, BUT</text><text x="68" y="350" font-family="sans-serif" font-size="92" font-weight="bold" fill="#f6f3df">BETTER.</text><text x="72" y="430" font-family="sans-serif" font-size="25" fill="#d9e7bf">AUTUMN COLLECTION / 2026</text><ellipse cx="470" cy="1010" rx="280" ry="45" fill="#cbc6b8"/><path d="M280 690Q290 560 440 560Q590 560 600 690" fill="none" stroke="#a27b4d" stroke-width="22"/><rect x="230" y="680" width="430" height="330" rx="54" fill="#ba9568"/><path d="M230 770H660" stroke="#a27b4d" stroke-width="3"/><rect x="405" y="730" width="85" height="28" rx="4" fill="#eee4cd"/><text x="72" y="1120" font-family="sans-serif" font-size="30" fill="#234e46">EVERYDAY TOTE / ¥ 299</text><text x="72" y="1170" font-family="sans-serif" font-size="18" fill="#6b7165">Made for the things that matter.</text>${long ? `<rect y="1250" width="900" height="600" fill="#d5dccb"/><text x="72" y="1370" font-family="sans-serif" font-size="52" fill="#234e46">01 / ROOM FOR MORE</text><rect x="140" y="1450" width="620" height="300" rx="30" fill="#b0bea4"/><text x="72" y="1960" font-family="sans-serif" font-size="52" fill="#234e46">02 / DETAILS MATTER</text><circle cx="450" cy="2200" r="160" fill="#ba9568"/><path d="M300 2200H600" stroke="#eee4cd" stroke-width="8"/><text x="72" y="2500" font-family="sans-serif" font-size="28" fill="#234e46">CRAFTED TO LAST. DESIGNED TO GO.</text>` : ""}</svg>`;
    const data = await sharp(Buffer.from(svg)).png().toBuffer();
    const t = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO images VALUES(?,?,?,?,?,?,0,?,?,?)").run(
      id,
      title,
      "image/png",
      data,
      900,
      height,
      "operator-1",
      t,
      t,
    );
    db.prepare(
      "INSERT OR IGNORE INTO image_groups VALUES(?, 'default-group')",
    ).run(id);
  }
}
