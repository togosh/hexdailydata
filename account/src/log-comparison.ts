import { hash32, quantity } from "./hex-types.js";

type Header = { number: number; hash: string; timestamp: number };
type AgreedHeader = (height: number, hash: string) => Promise<Header>;
const object = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);

// Raw responses remain intact. Only validated optional log metadata is omitted
// from these temporary views; unknown members and array order remain strict.
export async function logComparisonView(
  method: "eth_getLogs" | "eth_getTransactionReceipt",
  value: any,
  agreedHeader: AgreedHeader,
  range?: { from: number; to: number },
) {
  const receipt = method === "eth_getTransactionReceipt" ? value : undefined;
  const logs = receipt === undefined ? value : receipt?.logs;
  if (!Array.isArray(logs)) throw Error(receipt === undefined ? "SPLIT_RANGE" : "MALFORMED_RECEIPT");
  if (method === "eth_getLogs" && logs.length > 200) throw Error("SPLIT_RANGE");
  const views = [];
  for (const log of logs) {
    if (!object(log)) throw Error("MALFORMED_TRANSFER");
    if (receipt !== undefined) {
      // All receipt logs, including other tokens/events, belong to this receipt.
      if (!object(receipt) || log.blockHash !== receipt.blockHash ||
          log.blockNumber !== receipt.blockNumber ||
          log.transactionHash !== receipt.transactionHash ||
          log.transactionIndex !== receipt.transactionIndex || log.removed !== false)
        throw Error("IDENTITY_CONFLICT");
      hash32.parse(log.transactionHash);
      quantity(log.transactionIndex);
      quantity(log.logIndex);
    }
    if (!Object.hasOwn(log, "blockTimestamp")) { views.push(log); continue; }
    let height: number, hash: string, timestamp: number;
    try {
      height = quantity(log.blockNumber);
      hash = hash32.parse(log.blockHash);
      timestamp = quantity(log.blockTimestamp);
    } catch { throw Error("SOURCE_DISAGREEMENT"); }
    if (range && (height < range.from || height > range.to)) throw Error("INVALID_LOG_RANGE");
    const header = await agreedHeader(height, hash);
    if (header.number !== height || header.hash !== hash || header.timestamp !== timestamp)
      throw Error("SOURCE_DISAGREEMENT");
    const { blockTimestamp: _validated, ...view } = log;
    views.push(view);
  }
  return method === "eth_getLogs" ? views : { ...receipt, logs: views };
}
