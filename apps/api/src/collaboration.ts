import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { Db } from "./database.js";
import { fail } from "./service.js";
import type {
  Account,
  GroupInfo,
} from "../../../packages/shared/src/contracts.js";

export const DEFAULT_GROUP = "default-group";
export function nameInput(value: unknown, max: number, label: string) {
  if (typeof value !== "string")
    return fail(400, "INVALID_NAME", `请输入${label}`);
  const name = value.normalize("NFKC").trim();
  if (
    ![...name].length ||
    [...name].length > max ||
    /[\u0000-\u001f\u007f]/.test(name)
  )
    return fail(
      400,
      "INVALID_NAME",
      `${label}须为1—${max}个字符，不能包含控制字符`,
    );
  return { name, key: name.toLowerCase() };
}
export function migrateCollaboration(db: Db) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS accounts(operator_id TEXT PRIMARY KEY REFERENCES operators(id),username_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,operator_id TEXT NOT NULL REFERENCES operators(id),expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,created_by TEXT REFERENCES operators(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_members(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,operator_id TEXT NOT NULL REFERENCES operators(id),joined_at TEXT NOT NULL,PRIMARY KEY(group_id,operator_id));
      CREATE TABLE IF NOT EXISTS image_groups(image_id TEXT PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id));
      CREATE INDEX IF NOT EXISTS image_group_lookup ON image_groups(group_id,image_id);
      CREATE INDEX IF NOT EXISTS member_lookup ON group_members(operator_id,group_id);
      CREATE INDEX IF NOT EXISTS session_expiration ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS deleted_seed_images(id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_drafts(id TEXT PRIMARY KEY,image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,operator_id TEXT NOT NULL REFERENCES operators(id),base_revision INTEGER NOT NULL,base_annotations TEXT NOT NULL,annotations TEXT NOT NULL,selected_id TEXT,version INTEGER NOT NULL,cleared INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS draft_owner_image ON review_drafts(operator_id,image_id,cleared,updated_at);
      CREATE TABLE IF NOT EXISTS review_versions(image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,revision INTEGER NOT NULL,annotations TEXT NOT NULL,PRIMARY KEY(image_id,revision));
      CREATE TABLE IF NOT EXISTS review_submissions(image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,submission_id TEXT NOT NULL,operator_id TEXT NOT NULL REFERENCES operators(id),request_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(image_id,submission_id));`);
    db.prepare("INSERT OR IGNORE INTO groups VALUES(?,?,?,?,?)").run(
      DEFAULT_GROUP,
      "默认协作组",
      "默认协作组",
      null,
      new Date().toISOString(),
    );
    // Run the legacy import once; new accounts join groups explicitly.
    if ((db.pragma("user_version", { simple: true }) as number) < 2) {
      for (const user of db
        .prepare("SELECT id,name FROM operators")
        .all() as Account[]) {
        db.prepare("INSERT OR IGNORE INTO accounts VALUES(?,?)").run(
          user.id,
          nameInput(user.name, 32, "账号名").key,
        );
        db.prepare("INSERT OR IGNORE INTO group_members VALUES(?,?,?)").run(
          DEFAULT_GROUP,
          user.id,
          new Date().toISOString(),
        );
      }
      db.prepare(
        "INSERT OR IGNORE INTO image_groups SELECT id,? FROM images",
      ).run(DEFAULT_GROUP);
      db.pragma("user_version = 2");
    }
    const archive = db.prepare(
      "INSERT OR IGNORE INTO review_versions VALUES(?,?,?)",
    );
    const rows = db.prepare("SELECT id,revision FROM images").all() as {
      id: string;
      revision: number;
    }[];
    for (const image of rows) {
      const annotations = db
        .prepare(
          "SELECT id,x,y,content,sort_order AS sortOrder,created_by AS createdBy,updated_by AS updatedBy,created_at AS createdAt,updated_at AS updatedAt FROM annotations WHERE image_id=? ORDER BY sort_order",
        )
        .all(image.id);
      archive.run(image.id, image.revision, JSON.stringify(annotations));
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 5)
      db.pragma("user_version = 5");
  })();
}
const cookieName = "review_session";
function tokenHash(q: Request) {
  const raw = q.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  return raw ? createHash("sha256").update(raw).digest("hex") : null;
}
export function sessionUser(db: Db, q: Request): Account | null {
  const hash = tokenHash(q);
  if (!hash) return null;
  return (
    (db
      .prepare(
        "SELECT o.id,o.name FROM sessions s JOIN operators o ON o.id=s.operator_id WHERE s.token_hash=? AND s.expires_at>?",
      )
      .get(hash, Date.now()) as Account) || null
  );
}
export function logout(db: Db, q: Request, r: Response) {
  const hash = tokenHash(q);
  if (hash) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash);
  r.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", path: "/" });
}
export function login(
  db: Db,
  q: Request,
  r: Response,
  register: boolean,
): Account {
  const { name, key } = nameInput(q.body?.name, 32, "账号名");
  const user = db.transaction(() => {
    const existing = db
      .prepare(
        "SELECT o.id,o.name FROM accounts a JOIN operators o ON o.id=a.operator_id WHERE username_key=?",
      )
      .get(key) as Account | undefined;
    if (register) {
      if (existing)
        fail(
          409,
          "ACCOUNT_EXISTS",
          "这个账号名已经注册，请直接登录或换一个名字",
        );
      const account = { id: randomUUID(), name };
      db.prepare("INSERT INTO operators VALUES(?,?)").run(account.id, name);
      db.prepare("INSERT INTO accounts VALUES(?,?)").run(account.id, key);
      return account;
    }
    if (!existing)
      return fail(404, "ACCOUNT_NOT_FOUND", "账号不存在，请先注册");
    return existing;
  })();
  const previous = tokenHash(q);
  if (previous)
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(previous);
  const token = randomBytes(32).toString("hex"),
    maxAge = 30 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(Date.now());
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    user.id,
    Date.now() + maxAge,
  );
  r.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  return user;
}
export function requireMember(
  db: Db,
  groupId: unknown,
  userId: string,
): string {
  if (
    typeof groupId !== "string" ||
    !db.prepare("SELECT id FROM groups WHERE id=?").get(groupId)
  )
    return fail(404, "GROUP_NOT_FOUND", "群组不存在，请重新搜索");
  if (
    !db
      .prepare("SELECT 1 FROM group_members WHERE group_id=? AND operator_id=?")
      .get(groupId, userId)
  )
    return fail(403, "NOT_A_MEMBER", "请先加入这个群组");
  return groupId;
}
export function requireImageMember(db: Db, imageId: string, userId: string) {
  const group = db
    .prepare("SELECT group_id FROM image_groups WHERE image_id=?")
    .get(imageId) as any;
  if (!group) return fail(404, "IMAGE_NOT_FOUND", "图片不存在");
  return requireMember(db, group.group_id, userId);
}
export function groups(db: Db, userId: string, search = ""): GroupInfo[] {
  const key = search.normalize("NFKC").trim().toLowerCase();
  if ([...key].length > 50)
    fail(400, "INVALID_SEARCH", "搜索内容不能超过50个字符");
  return (
    db
      .prepare(
        `SELECT g.id,g.name,g.created_by AS createdBy,g.created_at AS createdAt,
    (SELECT count(*) FROM group_members m WHERE m.group_id=g.id) AS memberCount,
    EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=g.id AND m.operator_id=?) AS joined
    FROM groups g WHERE g.name_key LIKE ? ESCAPE '\\' ORDER BY joined DESC,g.created_at DESC,g.id LIMIT 100`,
      )
      .all(userId, "%" + key.replace(/[\\%_]/g, "\\$&") + "%") as any[]
  ).map((g) => ({ ...g, joined: !!g.joined }));
}
export function groupInfo(db: Db, id: string, userId: string): GroupInfo {
  requireMember(db, id, userId);
  const group = db
    .prepare(
      "SELECT id,name,created_by AS createdBy,created_at AS createdAt,(SELECT count(*) FROM group_members WHERE group_id=groups.id) AS memberCount FROM groups WHERE id=?",
    )
    .get(id) as any;
  return { ...group, joined: true };
}
export function createGroup(db: Db, userId: string, value: unknown) {
  const { name, key } = nameInput(value, 50, "群组名");
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM groups WHERE name_key=?").get(key))
      fail(409, "GROUP_EXISTS", "群组名已存在，可以搜索并直接加入");
    const id = randomUUID(),
      t = new Date().toISOString();
    db.prepare("INSERT INTO groups VALUES(?,?,?,?,?)").run(
      id,
      name,
      key,
      userId,
      t,
    );
    db.prepare("INSERT INTO group_members VALUES(?,?,?)").run(id, userId, t);
    return groupInfo(db, id, userId);
  })();
}
export function joinGroup(db: Db, id: string, userId: string) {
  if (!db.prepare("SELECT 1 FROM groups WHERE id=?").get(id))
    fail(404, "GROUP_NOT_FOUND", "群组不存在");
  db.prepare("INSERT OR IGNORE INTO group_members VALUES(?,?,?)").run(
    id,
    userId,
    new Date().toISOString(),
  );
  return groupInfo(db, id, userId);
}
