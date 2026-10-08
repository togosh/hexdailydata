// Stored-data routes only. Metadata, public browsing and CSV never reserve reads.
export const METER_ROUTES = [
  "home", "daily", "markets", "stakes", "stakeEvents", "stake", "address",
  "addressStakes", "holders", "calculator", "archiveCharts", "nativeCharts", "maturities",
] as const;
