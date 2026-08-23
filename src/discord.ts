import type { ChartAttachment } from "./chart";
import { localizeDiagnostic } from "./i18n";
import {
  formatExpandedEquityBreadth,
  formatMarketFragilityDataQuality,
  formatMarketFragilityIndicatorLabel,
  formatMarketFragilityLevel,
  formatMarketFragilityStressScore,
  formatMarketFragilitySummary,
  marketFragilityColor,
} from "./market-fragility-format";
import {
  formatMarketActivityNotificationSummary,
  formatMarketActivitySummary,
} from "./market-activity-format";
import { formatIneligibleMarketDataStatus } from "./market-data-health";
import { formatResilienceDecayCardSummary } from "./resilience-decay-format";
import type {
  MarketFragilityMechanismFamily,
  MarketFragilityPersistenceBrief,
  MarketFragilityTransition,
} from "./market-fragility-shadow";
import type {
  Language,
  MarketActivitySnapshot,
  MarketDataHealth,
  MarketFragilityIndicatorId,
  MarketFragilitySnapshot,
  NotificationOpportunity,
  ReversalLocation,
  ResilienceDecayMetrics,
  ScanResult,
} from "./types";

/**
 * Send one qualified price-location alert to Discord.
 */
export async function sendSignal(
  webhookUrl: string,
  signal: ReversalLocation,
  fetcher: typeof fetch = fetch,
  language: Language = "zh",
  delivery?: Pick<
    NotificationOpportunity,
    "observedAt" | "observedPrice"
  >,
): Promise<void> {
  const bullish = signal.direction === "bullish";
  const alertLevel = signal.level === "alert";
  const english = language === "en";
  const policyDescription = signal.policy.role === "bullish_reversal_zone"
    ? english
      ? "Bullish-first reversal-zone policy: primarily looks for intraday bottom reversals in the modern market regime."
      : "多頭優先反轉區政策：主要尋找現代市場狀態下的日內低點反轉區。"
    : english
      ? "Bearish crash-monitor policy: retains top-reversal warnings only under a stricter stress regime."
      : "空頭崩跌監測政策：只在較嚴格的壓力市場狀態下保留高點反轉警示。";
  await sendWebhook(
    webhookUrl,
    {
      embeds: [
        {
          title: `${bullish ? "🟢" : "🔴"} SP500 ${alertLevel ? "ALERT" : "WATCH"} · ${english ? (bullish ? "Bottom reversal candidate zone" : "Top reversal candidate zone") : (bullish ? "低點反轉候選區" : "高點反轉候選區")}`,
          description: alertLevel
            ? `${policyDescription}\n${english ? "Price location meets the ALERT thresholds; option-book data, Greeks, option fills, and actual option P&L remain unmodeled." : "價格位置已達 ALERT 門檻；仍不含期權委託簿、Greeks、期權成交價或實際期權盈虧估算。"}`
            : `${policyDescription}\n${english ? "Early WATCH level: price location shows a possible reversal but has not met the stricter ALERT thresholds." : "提早觀察級別：價格位置有反轉雛形，但尚未達到嚴格的 ALERT 門檻。"}`,
          color: alertLevel ? (bullish ? 0x2ecc71 : 0xe74c3c) : 0xf1c40f,
          fields: [
            {
              name: english ? "Level" : "級別",
              value: signal.level.toUpperCase(),
              inline: true,
            },
            {
              name: english ? "Direction / Market" : "方向 / 市場",
              value: `${formatDirection(signal.direction, language)} · ${signal.market}`,
              inline: true,
            },
            {
              name: english ? "Signal price" : "訊號價格",
              value: signal.price.toFixed(1),
              inline: true,
            },
            ...(delivery === undefined
              ? []
              : [
                  {
                    name: english
                      ? "Delivered / current price"
                      : "送達時間 / 當前價格",
                    value: `${new Date(delivery.observedAt).toISOString()} / ${delivery.observedPrice.toFixed(1)}`,
                    inline: true,
                  },
                ]),
            {
              name: english ? "Confidence score" : "信心分",
              value: `${signal.confidenceScore}/100`,
              inline: true,
            },
            {
              name: english ? "Entry watch zone" : "觀察進場區",
              value: `${signal.entryLow.toFixed(1)} – ${signal.entryHigh.toFixed(1)}`,
              inline: true,
            },
            {
              name: english ? "Invalidation" : "失效點",
              value: signal.invalidation.toFixed(1),
              inline: true,
            },
            {
              name: english ? "First mean-reversion target" : "第一回歸目標",
              value: signal.target.toFixed(1),
              inline: true,
            },
            {
              name: english ? "Underlying price R/R" : "標的價格盈虧比",
              value: `${signal.priceRiskReward.toFixed(1)}R`,
              inline: true,
            },
            {
              name: english ? "Policy" : "策略",
              value: `${signal.policy.name} · ${formatPolicyRole(signal.policy.role, language)}`,
              inline: true,
            },
            {
              name: english ? "Observed high / low / VWAP" : "觀察高 / 低 / VWAP",
              value: `${signal.sessionHigh.toFixed(1)} / ${signal.sessionLow.toFixed(1)} / ${signal.vwap.toFixed(1)}`,
              inline: true,
            },
            {
              name: english ? "Regime gate" : "市場狀態門檻",
              value: signal.policy.reasons
                .map((reason) => `• ${localizeDiagnostic(reason, language)}`)
                .join("\n"),
            },
            {
              name: english ? "Why it qualifies" : "成立原因",
              value: signal.reasons
                .map((reason) => `• ${localizeDiagnostic(reason, language)}`)
                .join("\n"),
            },
            {
              name: english ? "Risk boundary" : "風險邊界",
              value:
                english
                  ? "This is a price-location alert, not a guarantee of an 8R option return. Hyperliquid SP500 perpetual and cash SPX can differ through basis, liquidity, and funding risk."
                  : "這是價格位置提示，不是期權 8R 保證。Hyperliquid SP500 永續合約與現貨 SPX 仍可能有基差、流動性與資金費率風險。",
            },
          ],
          timestamp: new Date(signal.timestamp).toISOString(),
        },
      ],
      allowed_mentions: { parse: [] },
    },
    fetcher,
  );
}

/**
 * Send a periodic scanner brief even when no trade-quality signal is present.
 */
export async function sendMarketBrief(
  webhookUrl: string,
  result: ScanResult,
  timestamp: Date,
  fetcher: typeof fetch = fetch,
  chart?: ChartAttachment,
  language: Language = "zh",
  fragility?: MarketFragilitySnapshot,
  resilience?: ResilienceDecayMetrics,
  activity?: MarketActivitySnapshot,
  fragilityPersistence?: MarketFragilityPersistenceBrief,
  dataHealth?: MarketDataHealth,
): Promise<void> {
  const english = language === "en";
  const stateEligible = dataHealth?.stateEligible ?? true;
  const effectiveActivity = stateEligible ? activity : undefined;
  const effectivePersistence = stateEligible
    ? fragilityPersistence
    : undefined;
  const effectiveResilience = stateEligible ? resilience : undefined;
  const diagnosticStatus = dataHealth?.stateEligible === false
    ? formatIneligibleMarketDataStatus(dataHealth, language)
    : localizeDiagnostic(result.status, language);
  const chartMetadata =
    chart === undefined
      ? {}
      : {
          attachments: [
            {
              id: 0,
              filename: chart.filename,
              description:
                english
                  ? "SP500 session candles with VWAP, latest price, and signal reference levels"
                  : "含 VWAP、最新價格與訊號參考位的 SP500 交易時段 K 線圖",
            },
          ],
        };
  const fields = [
    ...(fragility === undefined
      ? []
      : marketFragilityFields(fragility, language)),
    ...(effectivePersistence === undefined
      ? []
      : marketFragilityPersistenceFields(effectivePersistence, language)),
    ...(effectiveResilience?.status === "FADING"
      ? resilienceDecayFields(effectiveResilience, language)
      : []),
    ...(effectiveActivity === undefined
      ? []
      : marketActivityFields(effectiveActivity, language)),
    ...(dataHealth === undefined
      ? []
      : marketDataHealthFields(dataHealth, language)),
    {
      name: english ? "Status" : "狀態",
      value: diagnosticStatus,
      inline: false,
    },
    {
      name: english ? "Latest price" : "最新價格",
      value: formatNullableNumber(result.latestPrice),
      inline: true,
    },
    {
      name: english ? "Observed high / low" : "觀察高 / 低",
      value: `${formatNullableNumber(result.sessionHigh)} / ${formatNullableNumber(result.sessionLow)}`,
      inline: true,
    },
    {
      name: english ? "Completed candles" : "完成 K 線數",
      value: String(result.candleCount),
      inline: true,
    },
  ];
  const opportunity = result.signal ?? result.watch;
  if (opportunity !== null && stateEligible) {
    fields.push({
      name: english ? "Opportunity detected" : "同時偵測到機會",
      value: `${opportunity.level.toUpperCase()} · ${formatDirection(opportunity.direction, language)} ${opportunity.price.toFixed(1)} · ${opportunity.confidenceScore}/100 · ${opportunity.priceRiskReward.toFixed(1)}R`,
      inline: false,
    });
  }
  const broadcastsFragility =
    stateEligible &&
    (fragility?.level === "breaking" || fragility?.level === "panic");
  const notificationSummary = buildMarketBriefNotificationSummary(
    result,
    language,
    fragility,
    effectiveActivity,
    dataHealth,
  );
  await sendWebhook(
    webhookUrl,
    {
      content: broadcastsFragility
        ? `@everyone ${notificationSummary}`
        : notificationSummary,
      embeds: [
        {
          title:
            fragility === undefined
              ? english
                ? "SP500 Reversal Scanner 30-Minute Brief"
                : "SP500 反轉掃描半小時簡報"
              : english
                ? `SP500 Market Status · ${formatMarketFragilityLevel(fragility)}`
                : `SP500 市場狀態 · ${formatMarketFragilityLevel(fragility)}`,
          description: buildMarketBriefDescription(
            result,
            language,
            fragility,
            dataHealth,
          ),
          color:
            fragility === undefined
              ? result.signal !== null
                ? 0xf1c40f
                : result.watch !== null
                  ? 0x95a5a6
                  : 0x3498db
              : marketFragilityColor(fragility),
          fields,
          image:
            chart === undefined
              ? undefined
              : {
                  url: `attachment://${chart.filename}`,
                },
          timestamp: timestamp.toISOString(),
        },
      ],
      allowed_mentions: {
        parse: broadcastsFragility ? ["everyone"] : [],
      },
      ...chartMetadata,
    },
    fetcher,
    chart,
  );
}

/**
 * Send a one-line deployment/version notice to Discord.
 */
export async function sendVersionNotice(
  webhookUrl: string,
  version: string,
  timestamp: Date,
  fetcher: typeof fetch = fetch,
  language: Language = "zh",
): Promise<void> {
  const english = language === "en";
  await sendWebhook(
    webhookUrl,
    {
      embeds: [
        {
          title: english
            ? "Hyperliquid SP500 Reversal Scanner updated"
            : "Hyperliquid SP500 反轉掃描器已更新",
          description: buildVersionNoticeDescription(
            version,
            timestamp,
            language,
          ),
          color: 0x9b59b6,
          fields: [
            {
              name: english ? "Reminder" : "使用提醒",
              value:
                english
                  ? "A version notice only confirms that new code reached the Worker execution path. Use scanner briefs and alerts to determine whether a candidate zone exists."
                  : "版本通知只代表新程式已在 Worker 執行路徑中出現；是否有交易候選區仍以掃描簡報與 ALERT 為準。",
            },
          ],
          timestamp: timestamp.toISOString(),
        },
      ],
      allowed_mentions: { parse: [] },
    },
    fetcher,
  );
}

/**
 * Report that a scheduled scan could not evaluate alerts or build its brief.
 */
export async function sendRateLimitNotice(
  webhookUrl: string,
  market: string,
  timestamp: Date,
  fetcher: typeof fetch = fetch,
  language: Language = "zh",
): Promise<void> {
  const english = language === "en";
  const scheduledTime = timestamp.toISOString();
  await sendWebhook(
    webhookUrl,
    {
      content: english
        ? `⚠️ ${market} scan incomplete: Hyperliquid rate limited the data request. The next scheduled scan will retry automatically.`
        : `⚠️ ${market} 掃描未完成：Hyperliquid 資料請求受到限流；下一個排程會自動重試。`,
      embeds: [
        {
          title: english
            ? "SP500 scanner degraded · data source rate limited"
            : "SP500 掃描降級 · 資料源限流",
          description: english
            ? "This scheduled scan could not retrieve fresh candles, so it produced neither a market brief nor a trade-quality alert. This does not mean that no setup existed."
            : "本次排程無法取得最新 K 線，因此沒有產生市場簡報或交易提示；這不代表當時沒有交易候選區。",
          color: 0xe67e22,
          fields: [
            {
              name: english ? "Market" : "市場",
              value: market,
              inline: true,
            },
            {
              name: english ? "Scheduled time" : "排程時間",
              value: scheduledTime,
              inline: true,
            },
            {
              name: english ? "Next action" : "後續處理",
              value: english
                ? "The Worker will retry at the next configured scan boundary. Consecutive failures notify at most once every six hours and reset immediately after recovery."
                : "Worker 會在下一個設定的掃描邊界重試；連續失敗最多每 6 小時提醒一次，掃描恢復後會立即重置。",
            },
          ],
          timestamp: scheduledTime,
        },
      ],
      allowed_mentions: { parse: [] },
    },
    fetcher,
  );
}

/**
 * Format a sanitized result for the Worker's manual status endpoint.
 */
export function publicScanResult(
  result: ScanResult,
  language: Language = "zh",
  fragility?: MarketFragilitySnapshot,
  activity?: MarketActivitySnapshot,
  dataHealth?: MarketDataHealth,
): object {
  const stateEligible = dataHealth?.stateEligible ?? true;
  return {
    market: result.market,
    candleCount: result.candleCount,
    sessionHigh: result.sessionHigh,
    sessionLow: result.sessionLow,
    latestPrice: result.latestPrice,
    status: dataHealth?.stateEligible === false
      ? formatIneligibleMarketDataStatus(dataHealth, language)
      : localizeDiagnostic(result.status, language),
    watch:
      !stateEligible || result.watch === null
        ? null
        : publicOpportunity(result.watch, language),
    signal:
      !stateEligible || result.signal === null
        ? null
        : publicOpportunity(result.signal, language),
    ...(fragility === undefined
      ? {}
      : {
          marketFragility: fragility,
        }),
    ...(!stateEligible || activity === undefined
      ? {}
      : {
          marketActivity: activity,
        }),
    ...(dataHealth === undefined
      ? {}
      : {
          marketDataHealth: dataHealth,
        }),
  };
}

function publicOpportunity(
  signal: ReversalLocation,
  language: Language,
): object {
  return {
    level: signal.level,
    direction: signal.direction,
    price: signal.price,
    entryLow: signal.entryLow,
    entryHigh: signal.entryHigh,
    invalidation: signal.invalidation,
    target: signal.target,
    priceRiskReward: signal.priceRiskReward,
    confidenceScore: signal.confidenceScore,
    timestamp: signal.timestamp,
    policy: {
      ...signal.policy,
      reasons: signal.policy.reasons.map((reason) =>
        localizeDiagnostic(reason, language)
      ),
    },
  };
}

async function sendWebhook(
  webhookUrl: string,
  payload: object,
  fetcher: typeof fetch,
  attachment?: ChartAttachment,
): Promise<void> {
  const requestInit =
    attachment === undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      : discordMultipartRequest(payload, attachment);
  const response = await fetcher(webhookUrl, {
    ...requestInit,
  });
  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status}`);
  }
}

function discordMultipartRequest(
  payload: object,
  attachment: ChartAttachment,
): RequestInit {
  const form = new FormData();
  const fileBytes = new ArrayBuffer(attachment.bytes.byteLength);
  new Uint8Array(fileBytes).set(attachment.bytes);
  form.append("payload_json", JSON.stringify(payload));
  form.append(
    "files[0]",
    new Blob([fileBytes], {
      type: attachment.contentType,
    }),
    attachment.filename,
  );
  return {
    method: "POST",
    body: form,
  };
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

function formatDirection(
  direction: ReversalLocation["direction"],
  language: Language,
): string {
  if (language === "en") {
    return direction.toUpperCase();
  }
  return direction === "bullish" ? "多頭" : "空頭";
}

function formatPolicyRole(
  role: ReversalLocation["policy"]["role"],
  language: Language,
): string {
  if (language === "zh") {
    return role === "bullish_reversal_zone"
      ? "多頭反轉區"
      : "空頭崩跌監測";
  }
  return role === "bullish_reversal_zone"
    ? "bullish reversal zone"
    : "bearish crash monitor";
}

function buildMarketBriefDescription(
  result: ScanResult,
  language: Language,
  fragility?: MarketFragilitySnapshot,
  dataHealth?: MarketDataHealth,
): string {
  const english = language === "en";
  const opportunity = dataHealth?.stateEligible === false
    ? null
    : result.signal ?? result.watch;
  const signalSummary =
    opportunity === null
      ? english
        ? "No qualified signal"
        : "暫無合格訊號"
      : `${opportunity.level.toUpperCase()} ${formatDirection(opportunity.direction, language)} ${opportunity.price.toFixed(1)} · ${opportunity.confidenceScore}/100 · ${opportunity.priceRiskReward.toFixed(1)}R`;

  if (english) {
    return [
      ...(fragility === undefined
        ? []
        : [formatMarketFragilitySummary(fragility, language)]),
      ...(dataHealth?.stateEligible === false
        ? ["Live decision inputs withheld because market data is not eligible."]
        : []),
      `${result.market} latest ${formatNullableNumber(result.latestPrice)}; session range ${formatNullableNumber(result.sessionLow)}–${formatNullableNumber(result.sessionHigh)}.`,
      `${signalSummary}; analyzed ${result.candleCount} completed 5m candles.`,
      `Status: ${
        dataHealth?.stateEligible === false
          ? formatIneligibleMarketDataStatus(dataHealth, language)
          : localizeDiagnostic(result.status, language)
      }`,
    ].join("\n");
  }

  return [
    ...(fragility === undefined
      ? []
      : [formatMarketFragilitySummary(fragility, language)]),
    ...(dataHealth?.stateEligible === false
      ? ["市場資料不符合決策資格，已停用即時訊號輸入。"]
      : []),
    `${result.market} 最新 ${formatNullableNumber(result.latestPrice)}；日內區間 ${formatNullableNumber(result.sessionLow)}–${formatNullableNumber(result.sessionHigh)}。`,
    `${signalSummary}；已分析 ${result.candleCount} 根完成 5m K。`,
    `狀態：${
      dataHealth?.stateEligible === false
        ? formatIneligibleMarketDataStatus(dataHealth, language)
        : localizeDiagnostic(result.status, language)
    }`,
  ].join("\n");
}

function buildMarketBriefNotificationSummary(
  result: ScanResult,
  language: Language,
  fragility?: MarketFragilitySnapshot,
  activity?: MarketActivitySnapshot,
  dataHealth?: MarketDataHealth,
): string {
  const english = language === "en";
  const opportunity = dataHealth?.stateEligible === false
    ? null
    : result.signal ?? result.watch;
  const signalSummary =
    opportunity === null
      ? english
        ? "No qualified signal"
        : "暫無合格訊號"
      : `${opportunity.level.toUpperCase()} ${formatDirection(opportunity.direction, language)} ${opportunity.price.toFixed(1)} · ${opportunity.confidenceScore}/100 · ${opportunity.priceRiskReward.toFixed(1)}R`;

  if (english) {
    return [
      fragility === undefined
        ? "SP500 30-minute brief"
        : `SP500 ${formatMarketFragilityLevel(fragility)} · ${formatMarketFragilityStressScore(fragility, language)} · ${fragility.stressedIndicatorCount}/${fragility.availableIndicatorCount} repair mechanisms stressed`,
      ...(activity === undefined
        ? []
        : [formatMarketActivityNotificationSummary(activity, language)]),
      ...(dataHealth === undefined
        ? []
        : [`Data ${dataHealth.status.toUpperCase()} · ${dataHealth.sessionScope.toUpperCase()}`]),
      `Latest ${formatNullableNumber(result.latestPrice)}`,
      `Session ${formatNullableNumber(result.sessionLow)}–${formatNullableNumber(result.sessionHigh)}`,
      signalSummary,
      shortNotificationStatus(
        dataHealth?.stateEligible === false
          ? formatIneligibleMarketDataStatus(dataHealth, language)
          : localizeDiagnostic(result.status, language),
      ),
    ].join(" | ");
  }

  return [
    fragility === undefined
      ? "SP500 半小時簡報"
      : `SP500 市場狀態 ${formatMarketFragilityLevel(fragility)} · ${formatMarketFragilityStressScore(fragility, language)} · ${fragility.stressedIndicatorCount}/${fragility.availableIndicatorCount} 修復機制受壓`,
    ...(activity === undefined
      ? []
      : [formatMarketActivityNotificationSummary(activity, language)]),
    ...(dataHealth === undefined
      ? []
      : [`資料 ${dataHealth.status.toUpperCase()} · ${dataHealth.sessionScope.toUpperCase()}`]),
    `最新 ${formatNullableNumber(result.latestPrice)}`,
    `日內 ${formatNullableNumber(result.sessionLow)}–${formatNullableNumber(result.sessionHigh)}`,
    signalSummary,
    shortNotificationStatus(
      dataHealth?.stateEligible === false
        ? formatIneligibleMarketDataStatus(dataHealth, language)
        : localizeDiagnostic(result.status, language),
    ),
  ].join(" | ");
}

function marketFragilityFields(
  fragility: MarketFragilitySnapshot,
  language: Language,
): Array<{ name: string; value: string; inline: boolean }> {
  const english = language === "en";
  const stressedIndicators = fragility.indicators.filter(
    (indicator) => indicator.state === "stressed",
  );
  const failureSummary =
    stressedIndicators.length === 0
      ? english
        ? "No repair mechanism is currently stressed"
        : "目前沒有修復機制受壓"
      : stressedIndicators
          .map(
            (indicator) =>
              `• ${formatMarketFragilityIndicatorLabel(indicator.id, language)}: ${indicator.displayValue}`,
          )
          .join("\n");
  return [
    {
      name: english ? "Market resilience" : "市場韌性",
      value: formatMarketFragilitySummary(fragility, language),
      inline: false,
    },
    {
      name: english ? "Repair failures" : "受壓修復機制",
      value: failureSummary,
      inline: false,
    },
    {
      name: english ? "Data coverage" : "資料覆蓋",
      value: `${fragility.availableIndicatorCount}/${fragility.totalIndicatorCount} · ${formatMarketFragilityDataQuality(fragility, language)}`,
      inline: true,
    },
    ...(fragility.expandedEquityBreadth === undefined
      ? []
      : [
          {
            name: english
              ? "Expanded equity breadth"
              : "擴展股票廣度",
            value: formatExpandedEquityBreadth(
              fragility.expandedEquityBreadth,
              language,
            ),
            inline: false,
          },
        ]),
  ];
}

function resilienceDecayFields(
  resilience: ResilienceDecayMetrics,
  language: Language,
): Array<{ name: string; value: string; inline: boolean }> {
  return [
    {
      name: language === "en" ? "Resilience decay" : "韌性衰退",
      value: formatResilienceDecayCardSummary(resilience, language),
      inline: false,
    },
  ];
}

function marketFragilityPersistenceFields(
  brief: MarketFragilityPersistenceBrief,
  language: Language,
): Array<{ name: string; value: string; inline: boolean }> {
  const english = language === "en";
  const { observation, metrics } = brief;
  const confirmationRate = metrics.confirmationRate === null
    ? "n/a"
    : `${(metrics.confirmationRate * 100).toFixed(1)}%`;
  const liveWindow = metrics.stateAvailable
    ? english
      ? `${metrics.pendingSessions} pending / ${metrics.confirmedSessions} confirmed · confirmation ${confirmationRate} · ${metrics.retainedObservations} briefs in ${metrics.retainedSessions} sessions`
      : `${metrics.pendingSessions} 次 pending / ${metrics.confirmedSessions} 次 confirmed · 確認率 ${confirmationRate} · ${metrics.retainedSessions} 個交易日、${metrics.retainedObservations} 份簡報`
    : english
      ? "Live evaluation window unavailable because state storage is not configured"
      : "未設定狀態儲存，暫無即時評估窗口";
  return [
    {
      name: english ? "BREAKING persistence" : "BREAKING 持續性",
      value: english
        ? [
            `${formatFragilityPersistenceStatus(observation.breakingStatus, language)} · V1 ${observation.v1Level.toUpperCase()} · ${formatFragilityTransition(observation.transition, language)}`,
            `Duration: ${observation.breakingDurationMinutes}m · ${observation.breakingStreak} observations`,
            `Persistent: ${formatIndicatorList(observation.persistentIndicatorIds, language)}`,
            `New / repaired: ${formatIndicatorList(observation.addedIndicatorIds, language)} / ${formatIndicatorList(observation.recoveredIndicatorIds, language)}`,
            `Families stressed: ${formatFamilyList(observation.stressedFamilyIds, language)} (${observation.stressedFamilyIds.length}/4)`,
            `Live window: ${liveWindow}`,
            `Diagnostic only; does not change mentions, color, or trade signals.`,
          ].join("\n")
        : [
            `${formatFragilityPersistenceStatus(observation.breakingStatus, language)} · V1 ${observation.v1Level.toUpperCase()} · ${formatFragilityTransition(observation.transition, language)}`,
            `持續：${observation.breakingDurationMinutes} 分鐘 · ${observation.breakingStreak} 次觀測`,
            `持續失效：${formatIndicatorList(observation.persistentIndicatorIds, language)}`,
            `新增 / 修復：${formatIndicatorList(observation.addedIndicatorIds, language)} / ${formatIndicatorList(observation.recoveredIndicatorIds, language)}`,
            `受壓家族：${formatFamilyList(observation.stressedFamilyIds, language)}（${observation.stressedFamilyIds.length}/4）`,
            `即時窗口：${liveWindow}`,
            `僅供診斷；不改變 mentions、顏色或交易訊號。`,
          ].join("\n"),
      inline: false,
    },
  ];
}

function formatFragilityPersistenceStatus(
  status: MarketFragilityPersistenceBrief["observation"]["breakingStatus"],
  language: Language,
): string {
  if (language === "en") {
    return status.replaceAll("_", " ");
  }
  switch (status) {
    case "BELOW_THRESHOLD":
      return "低於門檻 BELOW THRESHOLD";
    case "PENDING":
      return "待確認 PENDING";
    case "CONFIRMED":
      return "已確認 CONFIRMED";
  }
}

function formatFragilityTransition(
  transition: MarketFragilityTransition,
  language: Language,
): string {
  if (language === "en") {
    return transition.replaceAll("_", " ");
  }
  const labels: Record<MarketFragilityTransition, string> = {
    UNAVAILABLE: "舊資料不可判定",
    STABLE: "持平",
    NEW_BREAK: "新跌破",
    ESCALATING: "擴散惡化",
    PERSISTENT: "持續受壓",
    ROTATING: "壓力輪動",
    IMPROVING: "正在修復",
    RECOVERED: "已修復",
    RELAPSE: "再次惡化",
  };
  return `${labels[transition]} ${transition}`;
}

function formatIndicatorList(
  indicatorIds: readonly MarketFragilityIndicatorId[],
  language: Language,
): string {
  return indicatorIds.length === 0
    ? language === "en" ? "none" : "無"
    : indicatorIds.map((id) =>
        formatMarketFragilityIndicatorLabel(id, language)
      ).join("、");
}

function formatFamilyList(
  families: readonly MarketFragilityMechanismFamily[],
  language: Language,
): string {
  if (families.length === 0) {
    return language === "en" ? "none" : "無";
  }
  const englishLabels: Record<MarketFragilityMechanismFamily, string> = {
    price_damage: "price damage",
    repair_failure: "repair failure",
    breadth: "breadth",
    cross_market_confirmation: "cross-market confirmation",
  };
  const chineseLabels: Record<MarketFragilityMechanismFamily, string> = {
    price_damage: "價格受損",
    repair_failure: "修復失敗",
    breadth: "廣度",
    cross_market_confirmation: "跨市場確認",
  };
  const labels = language === "en" ? englishLabels : chineseLabels;
  return families.map((family) => labels[family]).join("、");
}

function marketActivityFields(
  activity: MarketActivitySnapshot,
  language: Language,
): Array<{ name: string; value: string; inline: boolean }> {
  return [
    {
      name: language === "en" ? "Market activity" : "市場活躍度",
      value: formatMarketActivitySummary(activity, language),
      inline: false,
    },
  ];
}

function marketDataHealthFields(
  health: MarketDataHealth,
  language: Language,
): Array<{ name: string; value: string; inline: boolean }> {
  const english = language === "en";
  const asOf = health.latestEndTime === null
    ? "n/a"
    : new Date(health.latestEndTime).toISOString();
  const eligibility = health.stateEligible
    ? english ? "eligible" : "可用於決策"
    : english ? "withheld from decisions" : "不納入決策";
  const reasons = health.reasons.length === 0
    ? english ? "none" : "無"
    : health.reasons.map((reason) =>
      formatMarketDataHealthReason(reason, language)
    ).join("；");
  return [
    {
      name: english ? "Market data" : "市場資料",
      value: [
        `${health.status.toUpperCase()} · ${health.sessionScope.toUpperCase()} · ${eligibility}`,
        `${english ? "As of" : "截至"}：${asOf}`,
        `${english ? "Gaps / missing intervals" : "缺口 / 遺漏區間"}：${health.gapCount} / ${health.missingIntervals}`,
        `${english ? "Notes" : "說明"}：${reasons}`,
      ].join("\n"),
      inline: false,
    },
  ];
}

function formatMarketDataHealthReason(
  reason: string,
  language: Language,
): string {
  if (language === "en") {
    return reason;
  }
  if (reason === "no completed candle is available") {
    return "沒有已完成的 K 線";
  }
  if (reason.startsWith("latest completed candle lags by ")) {
    return reason.replace(
      "latest completed candle lags by ",
      "最新完成 K 線落後 ",
    ).replace(" interval(s)", " 個區間");
  }
  if (reason.includes(" gap(s) omit ")) {
    return reason.replace(" gap(s) omit ", " 個缺口遺漏 ").replace(
      " expected interval(s)",
      " 個預期區間",
    );
  }
  if (reason === "overnight market-state policy is not validated") {
    return "隔夜市場狀態政策尚未驗證";
  }
  return reason;
}

function shortNotificationStatus(status: string): string {
  const compactStatus = status.replace(/\s+/g, " ").trim();
  return compactStatus.length <= 120
    ? compactStatus
    : `${compactStatus.slice(0, 117)}...`;
}

function buildVersionNoticeDescription(
  version: string,
  timestamp: Date,
  language: Language,
): string {
  if (language === "en") {
    return [
      `Worker version \`${version}\` is active.`,
      `Effective time: ${timestamp.toISOString()}`,
    ].join("\n");
  }
  return [
    `Worker 版本 \`${version}\` 已啟用。`,
    `生效時間：${timestamp.toISOString()}`,
  ].join("\n");
}
