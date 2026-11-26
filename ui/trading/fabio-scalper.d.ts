export interface Candle { at: number; open: number; high: number; low: number; close: number; volume: number }
export interface DepthObservation { at?: number; mid: number; obi: number; weightedObi: number }
export interface FabioConfig {
  balanceWindows: number[]; atrPeriod: number; maxBalanceAtr: number; maxBalanceEfficiency: number;
  breakoutAtr: number; minBodyRatio: number; minVolumeMultiple: number; retestDeadlineMinutes: number;
  depthSeconds: number; minObi: number; minWeightedObi: number; minDepthPersistence: number; rewardRisk: number;
}
export interface BalanceArea { startIndex: number; endIndex: number; window: number; high: number; low: number; atr: number; efficiency: number; poc: number; lvnZones: Array<{ low: number; high: number }> }
export interface TrendSetup {
  model: "TREND"; direction: "BULLISH" | "BEARISH"; directionSign: 1 | -1; balance: BalanceArea;
  breakoutIndex: number; retestIndex: number; confirmationIndex: number; entryIndex: number;
  entry: number; stopLoss: number; target: number; rewardRisk: number;
  depth: { confirmed: true; obi: number; weightedObi: number; persistence: number; midAdvanced: boolean }; reasons: string[];
}
export const DEFAULT_FABIO_CONFIG: Readonly<FabioConfig>
export function atr(candles: Candle[], endIndex: number, period?: number): number | null
export function volumeProfile(candles: Candle[], binWidth: number): { bins: Array<{ low: number; high: number; volume: number }>; poc: number; lvnZones: Array<{ low: number; high: number }> }
export function detectBalance(candles: Candle[], endIndex: number, config?: Partial<FabioConfig>): BalanceArea | null
export function depthConfirmation(samples: DepthObservation[], direction: 1 | -1, config?: Partial<FabioConfig>): { confirmed: boolean; reason?: string; obi?: number; weightedObi?: number; persistence?: number; midAdvanced?: boolean }
export function findTrendSetups(input: { candles: Candle[]; relativeVolumes: number[]; depthAtEnd?: Map<number, DepthObservation[]>; config?: Partial<FabioConfig> }): TrendSetup[]
