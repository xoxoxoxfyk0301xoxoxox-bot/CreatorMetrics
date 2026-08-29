import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CommissionPaymentRecord, ImportLogRecord, ImportStore, SalesMetricRecord, TransactionRecord, UpsertResult } from "../src/types.js";
import { decodeCsv, parseCsv, sha256 } from "../src/import/csv.js";
import { CsvImportEngine } from "../src/import/engine.js";
import type { FileSource, ImportFile } from "../src/import/file-source.js";
import { parseKnownCsv, parseRakutenPeriodMonth } from "../src/import/parsers.js";

const fixtureDirectory = fileURLToPath(new URL("fixtures/", import.meta.url));
async function fixture(name: string) { const bytes = await readFile(`${fixtureDirectory}${name}`); return parseKnownCsv(parseCsv(decodeCsv(bytes)), "2026-08-28T00:00:00.000Z", sha256(bytes)); }

describe("official CSV parsers", () => {
  it("parses note sales summary", async () => {
    const parsed = await fixture("note-sales-summary.csv");
    expect(parsed.kind).toBe("note_sales_summary");
    expect(parsed.sales[0]).toMatchObject({ grossSales: 10000, fees: 1500, netSalesBeforeTransferFee: 8500, transferFees: 270, netSales: 8230 });
  });
  it("parses note sales history without retaining buyer or issuer data", async () => {
    const parsed = await fixture("note-sales-history.csv");
    expect(parsed.transactions[0]).toMatchObject({ transactionId: "tx-anonymous-1", contentName: "匿名記事", grossSales: 1000 });
    expect(JSON.stringify(parsed.transactions)).not.toContain("匿名購入者");
    expect(JSON.stringify(parsed.transactions)).not.toContain("T0000000000000");
    expect(JSON.stringify(parsed.transactions)).not.toContain("匿名事業者");
  });
  it("accepts an empty note sales history", async () => { expect((await fixture("note-sales-history-empty.csv")).transactions).toEqual([]); });
  it("parses Rakuten period and derives conversion rate", async () => { expect((await fixture("rakuten-period.csv")).sales[0]).toMatchObject({ clicks: 10, orders: 2, conversionRate: 0.2, platform: "rakuten_affiliate" }); });
  it("parses Rakuten period month from a title row", () => {
    expect(parseRakutenPeriodMonth([["期間別成果: 2026.08"], [], ["発生日"]], 2)).toBe("2026-08");
    expect(parseRakutenPeriodMonth([["注文別成果: 2026.9"], ["発生日"]], 1)).toBe("2026-09");
  });
  it("parses Rakuten shop aggregation separately", async () => { expect((await fixture("rakuten-shop.csv")).sales[0]).toMatchObject({ source: "rakuten_shop", shopName: "匿名ショップ", periodMonth: "2026-08", key: "rakuten_affiliate|rakuten_shop|2026-08|匿名ショップ" }); });
  it("detects Rakuten order header after code tables", async () => { expect((await fixture("rakuten-order.csv")).transactions).toHaveLength(1); });
  it.each([["0", "UNCONFIRMED"], ["1", "CONFIRMED"], ["2", "DISCARDED"]])("normalizes Rakuten status %s", async (raw, normalized) => {
    const bytes = await readFile(`${fixtureDirectory}rakuten-order.csv`);
    const text = decodeCsv(bytes).replace(",0,商品リンク", `,${raw},商品リンク`);
    expect(parseKnownCsv(parseCsv(text), "now", sha256(text)).transactions[0]?.orderStatus).toBe(normalized);
  });
  it("parses commission payments", async () => { expect((await fixture("rakuten-payment.csv")).payments[0]).toMatchObject({ rakutenPoints: 100, rakutenCash: 200, bankTransfer: 300, totalPaid: 600 }); });
  it("detects unknown columns", () => {
    const rows = parseCsv("年月,売上,手数料,手数料控除後売上,振込手数料,未知列\n2026年07月,1,0,1,0,x\n");
    expect(parseKnownCsv(rows, "now", sha256("x")).unknownColumns).toContain("未知列");
  });
  it("does not infer a missing Rakuten period month", () => {
    const rows = parseCsv("ショップ名,成果報酬,クリック数,売上件数,売上金額\nshop_name,rewards,clicks,sales,amount\n匿名ショップ,1,1,1,1\n");
    expect(() => parseKnownCsv(rows, "now", sha256("missing-month"))).toThrow("Missing period month");
  });
});

class MemoryStore implements ImportStore {
  sales = new Map<string, SalesMetricRecord>(); transactions = new Map<string, TransactionRecord>(); payments = new Map<string, CommissionPaymentRecord>(); logs: ImportLogRecord[] = []; hashes = new Set<string>();
  async ensureImportSheets() {}
  async hasImportedFile(hash: string) { return this.hashes.has(hash); }
  private upsert<T extends { key: string }>(target: Map<string, T>, values: T[]): UpsertResult { let written = 0, updated = 0; for (const value of values) { target.has(value.key) ? updated++ : written++; target.set(value.key, value); } return { written, updated }; }
  async upsertSalesMetrics(values: SalesMetricRecord[]) { return this.upsert(this.sales, values); }
  async upsertTransactions(values: TransactionRecord[]) { return this.upsert(this.transactions, values); }
  async upsertCommissionPayments(values: CommissionPaymentRecord[]) { return this.upsert(this.payments, values); }
  async appendImportLog(log: ImportLogRecord) { this.logs.push(log); if (log.status === "success") this.hashes.add(log.fileHash); }
}
class MemorySource implements FileSource { constructor(public files: ImportFile[]) {} async listFiles() { return this.files; } }
async function importFile(name: string): Promise<ImportFile> { const bytes = await readFile(`${fixtureDirectory}${name}`); return { filename: name, path: name, bytes }; }

describe("CSV import engine", () => {
  it("detects duplicate files by SHA-256", async () => {
    const store = new MemoryStore(), file = await importFile("note-sales-summary.csv"), engine = new CsvImportEngine(new MemorySource([file]), store);
    expect((await engine.run())[0]?.status).toBe("success");
    expect((await engine.run())[0]?.status).toBe("skipped");
    expect(store.sales.size).toBe(1);
    expect(store.logs.at(-1)?.status).toBe("skipped");
  });
  it.each([["1", "CONFIRMED"], ["2", "DISCARDED"]])("updates one order from UNCONFIRMED to %s", async (raw, normalized) => {
    const base = await importFile("rakuten-order.csv"), store = new MemoryStore();
    await new CsvImportEngine(new MemorySource([base]), store).run();
    const changedText = decodeCsv(base.bytes).replace(",0,商品リンク", `,${raw},商品リンク`);
    const changed = { filename: `changed-${raw}.csv`, path: "changed", bytes: new TextEncoder().encode(changedText) };
    const result = await new CsvImportEngine(new MemorySource([changed]), store).run();
    expect(result[0]).toMatchObject({ rowsWritten: 0, rowsUpdated: 1 });
    expect(store.transactions.size).toBe(1);
    expect([...store.transactions.values()][0]?.orderStatus).toBe(normalized);
  });
  it("isolates malformed files", async () => {
    const valid = await importFile("rakuten-period.csv"), malformed = { filename: "bad.csv", path: "bad", bytes: new TextEncoder().encode('"unterminated') };
    const results = await new CsvImportEngine(new MemorySource([malformed, valid]), new MemoryStore()).run();
    expect(results.map((result) => result.status)).toEqual(["failed", "success"]);
  });
  it("keeps the same shop as separate rows across period months", async () => {
    const august = await importFile("rakuten-shop.csv");
    const septemberText = decodeCsv(august.bytes).replace("2026.08", "2026.09").replace("200,20,4", "300,30,5");
    const september: ImportFile = { filename: "rakuten-shop-2026-09.csv", path: "september", bytes: new TextEncoder().encode(septemberText) };
    const store = new MemoryStore();
    const results = await new CsvImportEngine(new MemorySource([august, september]), store).run();
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ rowsWritten: 1 }), expect.objectContaining({ rowsWritten: 1 })]));
    expect(store.sales.size).toBe(2);
    expect([...store.sales.values()].map((row) => row.periodMonth).sort()).toEqual(["2026-08", "2026-09"]);
  });
});
