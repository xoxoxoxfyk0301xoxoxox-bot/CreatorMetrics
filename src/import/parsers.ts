import type { CommissionPaymentRecord, Platform, SalesMetricRecord, TransactionRecord, TransactionStatus } from "../types.js";
import { sha256 } from "./csv.js";

export type CsvKind = "note_sales_summary" | "note_sales_history" | "rakuten_period" | "rakuten_shop" | "rakuten_order" | "rakuten_commission_payment";
export interface ParsedImport { kind: CsvKind; platform: Platform; source: string; rowsRead: number; rowsSkipped: number; unknownColumns: string[]; sales: SalesMetricRecord[]; transactions: TransactionRecord[]; payments: CommissionPaymentRecord[] }

const DEFINITIONS: Record<CsvKind, string[]> = {
  note_sales_summary: ["年月", "売上", "手数料", "手数料控除後売上", "振込手数料"],
  note_sales_history: ["決済/返金日時", "購入者名", "決済種別", "決済方法", "コンテンツ種別", "コンテンツ名", "販売額", "消費税率", "税抜販売額", "消費税額", "ポイント利用", "取引ID", "発行事業者", "適格事業者登録番号"],
  rakuten_period: ["発生日", "成果報酬", "クリック数", "売上件数", "売上金額"],
  rakuten_shop: ["ショップ名", "成果報酬", "クリック数", "売上件数", "売上金額"],
  rakuten_order: ["発生日", "成果報酬", "料率", "売上金額", "ジャンル名", "ショップ名", "商品名", "ステータス", "リンクタイプ", "デバイスタイプ", "計測ID"],
  rakuten_commission_payment: ["成果確定月", "楽天ポイント", "楽天キャッシュ", "銀行振込"]
};
const ENGLISH_ROWS: Partial<Record<CsvKind, string[]>> = {
  rakuten_period: ["date", "rewards", "clicks", "sales", "amount"],
  rakuten_shop: ["shop_name", "rewards", "clicks", "sales", "amount"],
  rakuten_order: ["date", "rewards", "rate", "amount", "genre_name", "shop_name", "item_name", "status", "link_type", "device_type", "measurement_id"],
  rakuten_commission_payment: ["yearmonth", "points", "cash", "transfer"]
};

function samePrefix(row: string[], expected: string[]): boolean { return expected.every((value, index) => row[index] === value); }
export function detectCsvKind(rows: string[][]): { kind: CsvKind; headerIndex: number } {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] ?? [];
    for (const [kind, header] of Object.entries(DEFINITIONS) as [CsvKind, string[]][]) {
      if (samePrefix(row, header)) return { kind, headerIndex: index };
    }
  }
  throw new Error("Unsupported CSV schema: a known Japanese header was not found");
}
export function parseRakutenPeriodMonth(rows: string[][], headerIndex: number): string | null {
  for (const row of rows.slice(0, headerIndex)) {
    for (const field of row) {
      const match = field.match(/(?:期間別成果|注文別成果)\s*[:：]\s*(\d{4})[.\/-](\d{1,2})(?:\D|$)/);
      if (!match) continue;
      const month = Number(match[2]);
      if (month < 1 || month > 12) throw new Error("Invalid period month in Rakuten CSV title");
      return `${match[1]}-${String(month).padStart(2, "0")}`;
    }
  }
  return null;
}
function numeric(value: string, field: string): number {
  const normalized = value.replace(/[￥¥,\s%]/g, "");
  if (normalized === "") return 0;
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error(`Invalid numeric value in ${field}`);
  return number;
}
function normalizedStatus(value: string): TransactionStatus {
  if (value === "0") return "UNCONFIRMED";
  if (value === "1") return "CONFIRMED";
  if (value === "2") return "DISCARDED";
  throw new Error("Invalid Rakuten order status");
}
function rowObject(header: string[], row: string[]): Record<string, string> { return Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""])); }
function fallbackKey(source: string, values: string[]): string { return `${source}|sha256:${sha256(values.join("\u001f"))}`; }

export function parseKnownCsv(rows: string[][], collectedAt: string, fileHash: string): ParsedImport {
  const { kind, headerIndex } = detectCsvKind(rows);
  const periodMonth = kind === "rakuten_period" || kind === "rakuten_shop" || kind === "rakuten_order" ? parseRakutenPeriodMonth(rows, headerIndex) : null;
  if ((kind === "rakuten_period" || kind === "rakuten_shop" || kind === "rakuten_order") && periodMonth === null) throw new Error(`Missing period month in Rakuten ${kind} title row`);
  const expected = DEFINITIONS[kind];
  const actualHeader = rows[headerIndex] ?? [];
  const unknownColumns = actualHeader.slice(expected.length).filter(Boolean).concat(actualHeader.filter((column) => column && !expected.includes(column)));
  const english = ENGLISH_ROWS[kind];
  let dataIndex = headerIndex + 1;
  if (english && samePrefix(rows[dataIndex] ?? [], english)) dataIndex++;
  const dataRows = rows.slice(dataIndex).filter((row) => row.some((value) => value !== ""));
  const platform: Platform = kind.startsWith("note_") ? "note" : "rakuten_affiliate";
  const source = kind;
  const result: ParsedImport = { kind, platform, source, rowsRead: dataRows.length, rowsSkipped: 0, unknownColumns: [...new Set(unknownColumns)], sales: [], transactions: [], payments: [] };
  for (const row of dataRows) {
    if (row.length > expected.length && row.slice(expected.length).some(Boolean)) result.unknownColumns.push(`unnamed_column_${expected.length + 1}`);
    const value = rowObject(expected, row);
    if (kind === "note_sales_summary") {
      const yearMonth = value["年月"]!;
      const beforeTransfer = numeric(value["手数料控除後売上"]!, "手数料控除後売上");
      const transferFees = numeric(value["振込手数料"]!, "振込手数料");
      result.sales.push({ key: `note|note_sales_summary|${yearMonth}`, date: "", yearMonth, periodMonth: null, platform, source, shopName: "", grossSales: numeric(value["売上"]!, "売上"), fees: numeric(value["手数料"]!, "手数料"), netSalesBeforeTransferFee: beforeTransfer, transferFees, netSales: beforeTransfer - transferFees, commission: 0, clicks: null, orders: null, conversionRate: null, collectedAt });
    } else if (kind === "note_sales_history") {
      const transactionId = value["取引ID"]!;
      const key = transactionId ? `note|note_sales_history|${transactionId}` : fallbackKey(source, [value["決済/返金日時"]!, value["決済種別"]!, value["決済方法"]!, value["コンテンツ種別"]!, value["コンテンツ名"]!, value["販売額"]!, value["税抜販売額"]!, value["消費税額"]!, value["ポイント利用"]!]);
      result.transactions.push({ key, transactionDate: value["決済/返金日時"]!, periodMonth: null, platform, source, transactionId, paymentType: value["決済種別"]!, paymentMethod: value["決済方法"]!, contentType: value["コンテンツ種別"]!, contentName: value["コンテンツ名"]!, grossSales: numeric(value["販売額"]!, "販売額"), taxRate: numeric(value["消費税率"]!, "消費税率"), salesBeforeTax: numeric(value["税抜販売額"]!, "税抜販売額"), taxAmount: numeric(value["消費税額"]!, "消費税額"), pointsUsed: numeric(value["ポイント利用"]!, "ポイント利用"), commission: 0, commissionRate: 0, genre: "", shopName: "", itemName: "", rawStatus: "", orderStatus: "", linkType: "", deviceType: "", measurementId: "", collectedAt, sourceFileHash: fileHash });
    } else if (kind === "rakuten_period") {
      const clicks = numeric(value["クリック数"]!, "クリック数"), orders = numeric(value["売上件数"]!, "売上件数");
      const date = value["発生日"]!;
      result.sales.push({ key: `${date}|rakuten_affiliate|rakuten_period`, date, yearMonth: "", periodMonth, platform, source, shopName: "", grossSales: numeric(value["売上金額"]!, "売上金額"), fees: 0, netSalesBeforeTransferFee: 0, transferFees: 0, netSales: 0, commission: numeric(value["成果報酬"]!, "成果報酬"), clicks, orders, conversionRate: clicks === 0 ? null : orders / clicks, collectedAt });
    } else if (kind === "rakuten_shop") {
      const shopName = value["ショップ名"]!;
      result.sales.push({ key: `rakuten_affiliate|rakuten_shop|${periodMonth}|${shopName}`, date: "", yearMonth: "", periodMonth, platform, source, shopName, grossSales: numeric(value["売上金額"]!, "売上金額"), fees: 0, netSalesBeforeTransferFee: 0, transferFees: 0, netSales: 0, commission: numeric(value["成果報酬"]!, "成果報酬"), clicks: numeric(value["クリック数"]!, "クリック数"), orders: numeric(value["売上件数"]!, "売上件数"), conversionRate: null, collectedAt });
    } else if (kind === "rakuten_order") {
      const canonical = [value["発生日"]!, value["ショップ名"]!, value["商品名"]!, value["売上金額"]!, value["成果報酬"]!, value["料率"]!, value["計測ID"]!];
      result.transactions.push({ key: fallbackKey(source, canonical), transactionDate: value["発生日"]!, periodMonth, platform, source, transactionId: "", paymentType: "", paymentMethod: "", contentType: "", contentName: "", grossSales: numeric(value["売上金額"]!, "売上金額"), taxRate: 0, salesBeforeTax: 0, taxAmount: 0, pointsUsed: 0, commission: numeric(value["成果報酬"]!, "成果報酬"), commissionRate: numeric(value["料率"]!, "料率"), genre: value["ジャンル名"]!, shopName: value["ショップ名"]!, itemName: value["商品名"]!, rawStatus: value["ステータス"]!, orderStatus: normalizedStatus(value["ステータス"]!), linkType: value["リンクタイプ"]!, deviceType: value["デバイスタイプ"]!, measurementId: value["計測ID"]!, collectedAt, sourceFileHash: fileHash });
    } else {
      const yearMonth = value["成果確定月"]!;
      const rakutenPoints = numeric(value["楽天ポイント"]!, "楽天ポイント"), rakutenCash = numeric(value["楽天キャッシュ"]!, "楽天キャッシュ"), bankTransfer = numeric(value["銀行振込"]!, "銀行振込");
      result.payments.push({ key: `rakuten_affiliate|rakuten_commission_payment|${yearMonth}`, yearMonth, platform, source, rakutenPoints, rakutenCash, bankTransfer, totalPaid: rakutenPoints + rakutenCash + bankTransfer, collectedAt });
    }
  }
  result.unknownColumns = [...new Set(result.unknownColumns)];
  return result;
}
