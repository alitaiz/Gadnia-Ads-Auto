// backend/services/automation/dataFetcher.js
import pool from '../../db.js';
import { amazonAdsApiRequest } from '../../helpers/amazon-api.js';
import { getLocalDateString } from './utils.js';

const REPORTING_TIMEZONE = 'America/Los_Angeles';

const getBidAdjustmentPerformanceData = async (rule, campaignIds, maxLookbackDays, today) => {
    const requiredDates = Array.from({ length: maxLookbackDays }, (_, i) => {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        return d.toISOString().split('T')[0];
    });

    const checkResult = await pool.query(
        `SELECT DISTINCT report_date FROM sponsored_products_search_term_report 
         WHERE report_date = ANY($1::date[]) AND campaign_id::text = ANY($2::text[])`,
        [requiredDates, campaignIds.map(String)]
    );
    const foundDatesInHistory = new Set(checkResult.rows.map(r => r.report_date.toISOString().split('T')[0]));
    const missingDatesForStream = requiredDates.filter(d => !foundDatesInHistory.has(d));

    console.log(`[DataFetcher] Rule "${rule.name}" | Lookback: ${maxLookbackDays} days.`);
    console.log(`[DataFetcher] Found historical data for dates: ${[...foundDatesInHistory].join(', ') || 'None'}`);
    console.log(`[DataFetcher] Missing dates (will use stream data): ${missingDatesForStream.join(', ') || 'None'}`);

    const allRows = [];
    if (foundDatesInHistory.size > 0) {
        const historicalQuery = `
            SELECT report_date AS performance_date, keyword_id::text AS entity_id_text, COALESCE(keyword_text, targeting) AS entity_text,
                   match_type, campaign_id::text AS campaign_id_text, ad_group_id::text AS ad_group_id_text,
                   SUM(COALESCE(impressions, 0))::bigint AS impressions, SUM(COALESCE(cost, 0))::numeric AS spend,
                   SUM(COALESCE(clicks, 0))::bigint AS clicks, SUM(COALESCE(sales_1d, 0))::numeric AS sales,
                   SUM(COALESCE(purchases_1d, 0))::bigint AS orders
            FROM sponsored_products_search_term_report
            WHERE report_date = ANY($1::date[]) AND keyword_id IS NOT NULL AND campaign_id::text = ANY($2::text[])
            GROUP BY 1, 2, 3, 4, 5, 6;
        `;
        const historicalResult = await pool.query(historicalQuery, [[...foundDatesInHistory], campaignIds.map(String)]);
        allRows.push(...historicalResult.rows);
    }
    if (missingDatesForStream.length > 0) {
        const streamQuery = `
            SELECT ((event_data->>'time_window_start')::timestamptz AT TIME ZONE '${REPORTING_TIMEZONE}')::date AS performance_date,
                   COALESCE(event_data->>'keyword_id', event_data->>'target_id') AS entity_id_text,
                   COALESCE(event_data->>'keyword_text', event_data->>'targeting') AS entity_text,
                   (event_data->>'match_type') AS match_type, (event_data->>'campaign_id') AS campaign_id_text,
                   (event_data->>'ad_group_id') AS ad_group_id_text,
                   SUM(CASE WHEN event_type = 'sp-traffic' THEN (event_data->>'impressions')::bigint ELSE 0 END) AS impressions,
                   SUM(CASE WHEN event_type = 'sp-traffic' THEN (event_data->>'cost')::numeric ELSE 0 END) AS spend,
                   SUM(CASE WHEN event_type = 'sp-traffic' THEN (event_data->>'clicks')::bigint ELSE 0 END) AS clicks,
                   SUM(CASE WHEN event_type = 'sp-conversion' THEN (event_data->>'attributed_sales_1d')::numeric ELSE 0 END) AS sales,
                   SUM(CASE WHEN event_type = 'sp-conversion' THEN (event_data->>'attributed_conversions_1d')::bigint ELSE 0 END) AS orders
            FROM raw_stream_events
            WHERE event_type IN ('sp-traffic', 'sp-conversion')
              AND ((event_data->>'time_window_start')::timestamptz AT TIME ZONE '${REPORTING_TIMEZONE}')::date = ANY($1::date[])
              AND COALESCE(event_data->>'keyword_id', event_data->>'target_id') IS NOT NULL
              AND (event_data->>'campaign_id') = ANY($2::text[])
            GROUP BY 1, 2, 3, 4, 5, 6;
        `;
        const streamResult = await pool.query(streamQuery, [missingDatesForStream, campaignIds.map(String)]);
        allRows.push(...streamResult.rows);
    }

    const performanceMap = new Map();
    allRows.forEach(row => {
        const key = row.entity_id_text;
        if (!key) return;
        if (!performanceMap.has(key)) {
            performanceMap.set(key, {
                entityId: row.entity_id_text,
                entityType: ['BROAD', 'PHRASE', 'EXACT'].includes(row.match_type) ? 'keyword' : 'target',
                entityText: row.entity_text, matchType: row.match_type, campaignId: row.campaign_id_text,
                adGroupId: row.ad_group_id_text, dailyData: []
            });
        }
        const entityData = performanceMap.get(key);
        const dateStr = new Date(row.performance_date).toISOString().split('T')[0];
        let dayEntry = entityData.dailyData.find(d => d.date.toISOString().split('T')[0] === dateStr);
        if (!dayEntry) {
            dayEntry = { date: new Date(row.performance_date), impressions: 0, spend: 0, sales: 0, clicks: 0, orders: 0 };
            entityData.dailyData.push(dayEntry);
        }
        dayEntry.impressions += parseInt(row.impressions || 0, 10);
        dayEntry.spend += parseFloat(row.spend || 0);
        dayEntry.sales += parseFloat(row.sales || 0);
        dayEntry.clicks += parseInt(row.clicks || 0, 10);
        dayEntry.orders += parseInt(row.orders || 0, 10);
    });
    
    const reportDateRange = foundDatesInHistory.size > 0 ? { start: [...foundDatesInHistory].sort()[0], end: [...foundDatesInHistory].sort().pop() } : null;
    const streamDateRange = missingDatesForStream.length > 0 ? { start: missingDatesForStream.sort()[0], end: missingDatesForStream.sort().pop() } : null;
    
    return { performanceMap, dataDateRange: { report: reportDateRange, stream: streamDateRange } };
};

const getSbSdPerformanceData = async (rule, campaignIds, maxLookbackDays, today) => {
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - (maxLookbackDays - 1));
    const { rows } = await pool.query(
        `SELECT
            ((event_data->>'time_window_start')::timestamptz AT TIME ZONE '${REPORTING_TIMEZONE}')::date AS performance_date,
            COALESCE(event_data->>'keyword_id', event_data->>'target_id') AS entity_id_text,
            COALESCE(event_data->>'keyword_text', event_data->>'targeting_text') AS entity_text,
            COALESCE(event_data->>'match_type', event_data->>'keyword_type') AS match_type,
            (event_data->>'campaign_id') AS campaign_id_text, (event_data->>'ad_group_id') AS ad_group_id_text,
            SUM(CASE WHEN event_type IN ('sb-traffic', 'sd-traffic') THEN (event_data->>'impressions')::bigint ELSE 0 END) AS impressions,
            SUM(CASE WHEN event_type IN ('sb-traffic', 'sd-traffic') THEN (event_data->>'cost')::numeric ELSE 0 END) AS spend,
            SUM(CASE WHEN event_type IN ('sb-traffic', 'sd-traffic') THEN (event_data->>'clicks')::bigint ELSE 0 END) AS clicks,
            SUM(CASE WHEN event_type IN ('sb-conversion', 'sd-conversion') THEN (event_data->>'sales')::numeric ELSE 0 END) AS sales,
            SUM(CASE WHEN event_type IN ('sb-conversion', 'sd-conversion') THEN (event_data->>'purchases')::bigint ELSE 0 END) AS orders
        FROM raw_stream_events
        WHERE event_type = ANY($3::text[])
          AND (event_data->>'time_window_start')::timestamptz >= ($1::timestamp AT TIME ZONE '${REPORTING_TIMEZONE}')
          AND (event_data->>'campaign_id') = ANY($2::text[])
          AND COALESCE(event_data->>'keyword_id', event_data->>'target_id') IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5, 6;`,
        [startDate.toISOString().split('T')[0], campaignIds.map(String), rule.ad_type === 'SB' ? ['sb-traffic', 'sb-conversion'] : ['sd-traffic', 'sd-conversion']]
    );

    const performanceMap = new Map();
    rows.forEach(row => {
        const key = row.entity_id_text;
        if (!key) return;
        if (!performanceMap.has(key)) {
            performanceMap.set(key, {
                entityId: row.entity_id_text,
                entityType: ['BROAD', 'PHRASE', 'EXACT'].includes(row.match_type) ? 'keyword' : 'target',
                entityText: row.entity_text, matchType: row.match_type, campaignId: row.campaign_id_text,
                adGroupId: row.ad_group_id_text, dailyData: []
            });
        }
        performanceMap.get(key).dailyData.push({
            date: new Date(row.performance_date),
            impressions: parseInt(row.impressions || 0, 10), spend: parseFloat(row.spend || 0),
            sales: parseFloat(row.sales || 0), clicks: parseInt(row.clicks || 0, 10),
            orders: parseInt(row.orders || 0, 10)
        });
    });

    const streamDateRange = { start: startDate.toISOString().split('T')[0], end: today.toISOString().split('T')[0] };
    return { performanceMap, dataDateRange: { report: null, stream: streamDateRange } };
};

const getSearchTermAutomationPerformanceData = async (rule, campaignIds, maxLookbackDays, today) => {
    const endDate = new Date(today);
    endDate.setDate(today.getDate() - 2);
    const startDate = new Date(endDate);
    startDate.setDate(endDate.getDate() - (maxLookbackDays - 1));
    const { rows } = await pool.query(
        `SELECT
            report_date AS performance_date, customer_search_term, campaign_id, ad_group_id,
            COALESCE(SUM(impressions), 0)::bigint AS impressions, COALESCE(SUM(cost), 0)::numeric AS spend,
            COALESCE(SUM(sales_1d), 0)::numeric AS sales, COALESCE(SUM(clicks), 0)::bigint AS clicks,
            COALESCE(SUM(purchases_1d), 0)::bigint AS orders
        FROM sponsored_products_search_term_report
        WHERE report_date >= $1 AND report_date <= $2 AND customer_search_term IS NOT NULL AND campaign_id::text = ANY($3)
        GROUP BY 1, 2, 3, 4;`,
        [startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0], campaignIds.map(String)]
    );

    const performanceMap = new Map();
    rows.forEach(row => {
        const key = row.customer_search_term?.toString();
        if (!key) return;
        if (!performanceMap.has(key)) {
            performanceMap.set(key, {
                campaignId: row.campaign_id, adGroupId: row.ad_group_id,
                entityText: row.customer_search_term, dailyData: []
            });
        }
        performanceMap.get(key).dailyData.push({
            date: new Date(row.performance_date),
            impressions: parseInt(row.impressions || 0, 10), spend: parseFloat(row.spend || 0),
            sales: parseFloat(row.sales || 0), clicks: parseInt(row.clicks || 0, 10),
            orders: parseInt(row.orders || 0, 10)
        });
    });

    const reportDateRange = { start: startDate.toISOString().split('T')[0], end: endDate.toISOString().split('T')[0] };
    return { performanceMap, dataDateRange: { report: reportDateRange, stream: null } };
};

const getBudgetAccelerationPerformanceData = async (rule, campaignIds, today) => {
    const campaignBudgets = new Map();
    try {
        const response = await amazonAdsApiRequest({
            method: 'post', url: '/sp/campaigns/list', profileId: rule.profile_id,
            data: { campaignIdFilter: { include: campaignIds.map(String) }, maxResults: 500 },
            headers: { 'Content-Type': 'application/vnd.spCampaign.v3+json', 'Accept': 'application/vnd.spCampaign.v3+json' },
        });
        (response.campaigns || []).forEach(c => c.budget?.budget && campaignBudgets.set(String(c.campaignId), c.budget.budget));
    } catch (e) {
        console.error('[RulesEngine] Failed to fetch campaign budgets for Budget Acceleration rule.', e);
        return { performanceMap: new Map(), dataDateRange: { report: null, stream: { start: today.toISOString().split('T')[0], end: today.toISOString().split('T')[0] } } };
    }

    const { rows } = await pool.query(
        `WITH traffic AS (
            SELECT (event_data->>'campaign_id') AS id, COALESCE(SUM((event_data->>'cost')::numeric), 0.00) AS spend
            FROM raw_stream_events WHERE event_type = 'sp-traffic' AND (event_data->>'time_window_start')::timestamptz >= (($1)::timestamp AT TIME ZONE '${REPORTING_TIMEZONE}') AND (event_data->>'campaign_id') = ANY($2) GROUP BY 1
        ), conversion AS (
            SELECT (event_data->>'campaign_id') AS id, COALESCE(SUM((event_data->>'attributed_sales_1d')::numeric), 0.00) AS sales, COALESCE(SUM((event_data->>'attributed_conversions_1d')::bigint), 0) AS orders
            FROM raw_stream_events WHERE event_type = 'sp-conversion' AND (event_data->>'time_window_start')::timestamptz >= (($1)::timestamp AT TIME ZONE '${REPORTING_TIMEZONE}') AND (event_data->>'campaign_id') = ANY($2) GROUP BY 1
        )
        SELECT COALESCE(t.id, c.id) AS campaign_id, COALESCE(t.spend, 0.00) AS spend, COALESCE(c.sales, 0.00) AS sales, COALESCE(c.orders, 0) AS orders
        FROM traffic t FULL OUTER JOIN conversion c ON t.id = c.id WHERE COALESCE(t.id, c.id) IS NOT NULL;`,
        [today.toISOString().split('T')[0], campaignIds.map(String)]
    );

    const performanceMap = new Map();
    campaignIds.forEach(id => {
        const idStr = String(id);
        const originalBudget = campaignBudgets.get(idStr);
        if (typeof originalBudget !== 'number') return;
        const perf = rows.find(r => r.campaign_id === idStr) || {};
        performanceMap.set(idStr, {
            campaignId: idStr, originalBudget,
            dailyData: [{ date: today, spend: parseFloat(perf.spend || 0), sales: parseFloat(perf.sales || 0), orders: parseInt(perf.orders || 0, 10), impressions: 0, clicks: 0 }]
        });
    });

    const streamDateRange = { start: today.toISOString().split('T')[0], end: today.toISOString().split('T')[0] };
    return { performanceMap, dataDateRange: { report: null, stream: streamDateRange } };
};

export const getPerformanceData = async (rule, campaignIds) => {
    if (!campaignIds || campaignIds.length === 0) {
        return { performanceMap: new Map(), dataDateRange: null };
    }
    const allTimeWindows = rule.config.conditionGroups.flatMap(g => g.conditions.map(c => c.timeWindow).filter(tw => tw !== 'TODAY'));
    const maxLookbackDays = allTimeWindows.length > 0 ? Math.max(...allTimeWindows, 1) : 1;
    const today = new Date(getLocalDateString(REPORTING_TIMEZONE));
    
    let result;
    if (rule.rule_type === 'BID_ADJUSTMENT') {
        if (rule.ad_type === 'SB' || rule.ad_type === 'SD') {
            result = await getSbSdPerformanceData(rule, campaignIds, maxLookbackDays, today);
        } else {
            result = await getBidAdjustmentPerformanceData(rule, campaignIds, maxLookbackDays, today);
        }
    } else if (rule.rule_type === 'SEARCH_TERM_AUTOMATION') {
        result = await getSearchTermAutomationPerformanceData(rule, campaignIds, maxLookbackDays, today);
    } else if (rule.rule_type === 'BUDGET_ACCELERATION') {
        result = await getBudgetAccelerationPerformanceData(rule, campaignIds, today);
    } else {
        result = { performanceMap: new Map(), dataDateRange: null };
    }
    
    console.log(`[RulesEngine DBG] Aggregated daily data for ${result.performanceMap.size} unique entities for rule "${rule.name}".`);
    return result;
};