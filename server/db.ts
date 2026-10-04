import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Business = {
  id: string; name: string; trade: string; email: string;
  policy: string; notes: string; on_time_pct: number; avg_days_late: number; webhook_id: string | null;
};
export type Invoice = {
  id: string; paypal_id: string; number: string; creditor: string; debtor: string;
  amount: number; open: number; due: string; memo: string; evidence: string;
  status: "open" | "held" | "disputed" | "settled"; flag: string | null; from_round: number | null;
};
export type Round = {
  id: number; status: "running" | "cleared" | "failed"; phase: string;
  gross: number; left: number; snapshot: string | null; started: string; finished: string | null; error: string | null;
};
export type StepRow = { id: number; round_id: number; kind: "loop" | "redirect"; path: string; amount: number; status: "agreed" | "refused"; terms: string | null };
export type Leg = {
  id: number; round_id: number; kind: "setoff" | "new_invoice" | "payout"; invoice_id: string;
  amount: number; marker: string; status: "pending" | "sent" | "done" | "failed" | "reverted"; ref: string | null; error: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS business (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, trade TEXT NOT NULL, email TEXT NOT NULL,
  policy TEXT NOT NULL, notes TEXT NOT NULL, on_time_pct INTEGER NOT NULL, avg_days_late INTEGER NOT NULL, webhook_id TEXT
);
CREATE TABLE IF NOT EXISTS invoice (
  id TEXT PRIMARY KEY, paypal_id TEXT NOT NULL, number TEXT NOT NULL,
  creditor TEXT NOT NULL REFERENCES business(id), debtor TEXT NOT NULL REFERENCES business(id),
  amount INTEGER NOT NULL CHECK (amount > 0), open INTEGER NOT NULL CHECK (open >= 0 AND open <= amount),
  due TEXT NOT NULL, memo TEXT NOT NULL, evidence TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','held','disputed','settled')), flag TEXT, from_round INTEGER
);
CREATE TABLE IF NOT EXISTS round (
  id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL CHECK (status IN ('running','cleared','failed')),
  phase TEXT NOT NULL, gross INTEGER NOT NULL DEFAULT 0, left INTEGER NOT NULL DEFAULT 0, snapshot TEXT,
  started TEXT NOT NULL, finished TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS step (
  id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL REFERENCES round(id),
  kind TEXT NOT NULL CHECK (kind IN ('loop','redirect')), path TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('agreed','refused')), terms TEXT
);
-- One row per action on PayPal. marker is written into the PayPal note, so a retry can find its own earlier attempt.
CREATE TABLE IF NOT EXISTS leg (
  id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL REFERENCES round(id),
  kind TEXT NOT NULL CHECK (kind IN ('setoff','new_invoice','payout')), invoice_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0), marker TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','done','failed','reverted')), ref TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL
);
-- PayPal's event id is the primary key, so a webhook delivered twice is processed once.
CREATE TABLE IF NOT EXISTS webhook (
  id TEXT PRIMARY KEY, business TEXT NOT NULL, type TEXT NOT NULL, ref TEXT, verified TEXT NOT NULL, at TEXT NOT NULL, outcome TEXT
);
`;

export type Db = ReturnType<typeof openDb>;

export function openDb(path = process.env.OFFSET_DB ?? "data/offset.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sql = new DatabaseSync(path);
  sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  sql.exec(SCHEMA);

  const all = <T>(q: string, ...p: (string | number | null)[]) => sql.prepare(q).all(...p) as T[];
  const get = <T>(q: string, ...p: (string | number | null)[]) => sql.prepare(q).get(...p) as T | undefined;
  const run = (q: string, ...p: (string | number | null)[]) => sql.prepare(q).run(...p);
  const now = () => new Date().toISOString();

  return {
    all, get, run,
    wipe() {
      sql.exec("DELETE FROM webhook; DELETE FROM event; DELETE FROM leg; DELETE FROM step; DELETE FROM round; DELETE FROM invoice; DELETE FROM business;");
    },
    businesses: () => all<Business>("SELECT * FROM business ORDER BY rowid"),
    business: (id: string) => get<Business>("SELECT * FROM business WHERE id = ?", id)!,
    invoices: () => all<Invoice>("SELECT * FROM invoice ORDER BY from_round IS NOT NULL, id"),
    invoice: (id: string) => get<Invoice>("SELECT * FROM invoice WHERE id = ?", id)!,
    latestRound: () => get<Round>("SELECT * FROM round ORDER BY id DESC LIMIT 1"),
    say(roundId: number | null, actor: string, kind: string, text: string) {
      run("INSERT INTO event (round_id, at, actor, kind, text) VALUES (?, ?, ?, ?, ?)", roundId, now(), actor, kind, text);
    },
    now,
  };
}
