// backend/routes/stream.js
import express from 'express';
import pool from '../db.js';

const router = express.Router();

// =================================================================
// == ENDPOINT ĐỂ NHẬN DỮ LIỆU STREAM (DATA INGESTION)            ==
// =================================================================

// Middleware to check for a secret API key. This is a critical security layer.
const checkApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.STREAM_INGEST_SECRET_KEY) {
        console.warn('[Stream Ingest] Failure: Incorrect or missing API key.');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// POST /api/stream-ingest: Receives data from AWS Lambda and writes to PostgreSQL.
router.post('/stream-ingest', checkApiKey, async (req, res) => {
    const events = req.body;

    if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'Request body must be a non-empty array of events.' });
    }

    let client;
    let successfulIngests = 0;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const query = 'INSERT INTO raw_stream_events(event_type, event_data) VALUES($1, $2)';
        
        for (const event of events) {
            // Robustness: Ensure the event is a processable object.
            if (typeof event !== 'object' || event === null) {
                console.warn('[Stream Ingest] Skipping non-object event in payload:', event);
                continue;
            }

            const eventType = event.dataset_id || event.type || 'unknown';

            if (Array.isArray(event.records) && event.records.length > 0) {
                 for (const innerRecord of event.records) {
                    // Robustness: Ensure innerRecord is also an object before inserting.
                    if (typeof innerRecord === 'object' && innerRecord !== null) {
                        await client.query(query, [eventType, innerRecord]);
                        successfulIngests++;
                    } else {
                        console.warn('[Stream Ingest] Skipping non-object innerRecord:', innerRecord);
                    }
                 }
            } else {
                await client.query(query, [eventType, event]);
                successfulIngests++;
            }
        }

        await client.query('COMMIT');
        if (successfulIngests > 0) {
            console.log(`[Stream Ingest] Success: Ingested ${successfulIngests} events into PostgreSQL.`);
        }
        res.status(200).json({ message: `Successfully ingested ${successfulIngests} events.` });
    } catch (error) {
        if (client) await client.query('ROLLBACK');

        if (error.code === '42P01') {
            console.error("[Stream Ingest] CRITICAL ERROR: The 'raw_stream_events' table is missing.");
        } else if (error.code === '42501') {
             console.error("[Stream Ingest] CRITICAL ERROR: The application user does not have permission to write to 'raw_stream_events'.");
        } else {
            console.error('[Stream Ingest] Error writing to PostgreSQL:', error);
        }
        
        res.status(200).json({ message: "Acknowledged, but failed to process. Check backend logs for details." });
    } finally {
        if (client) client.release();
    }
});

// =================================================================
// == ENDPOINTS FOR DATA RETRIEVAL                              ==
// =================================================================

// GET /api/stream/metrics: Provides aggregated metrics for "today".
router.get('/stream/metrics', async (req, res) => {
    try {
        const query = `
            SELECT
                COALESCE(SUM((event_data->>'clicks')::bigint) FILTER (WHERE event_type = 'sp-traffic'), 0) as click_count,
                COALESCE(SUM((event_data->>'cost')::numeric) FILTER (WHERE event_type = 'sp-traffic'), 0.00) as total_spend,
                COALESCE(SUM((event_data->>'attributed_conversions_1d')::bigint) FILTER (WHERE event_type = 'sp-conversion'), 0) as total_orders,
                COALESCE(SUM((event_data->>'attributed_sales_1d')::numeric) FILTER (WHERE event_type = 'sp-conversion'), 0.00) as total_sales,
                MAX(received_at) as last_event_timestamp
            FROM raw_stream_events
            WHERE received_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC');
        `;
        
        const result = await pool.query(query);

        if (result.rows.length === 0) {
            return res.json({
                click_count: 0, total_spend: 0, total_orders: 0,
                total_sales: 0, last_event_timestamp: null
            });
        }
        
        const metrics = result.rows[0];
        res.json({
            click_count: parseInt(metrics.click_count || '0', 10),
            total_spend: parseFloat(metrics.total_spend || '0'),
            total_orders: parseInt(metrics.total_orders || '0', 10),
            total_sales: parseFloat(metrics.total_sales || '0'),
            last_event_timestamp: metrics.last_event_timestamp
        });

    } catch (error) {
        const defaultMetrics = {
            click_count: 0, total_spend: 0, total_orders: 0,
            total_sales: 0, last_event_timestamp: null
        };
        if (error.code === '42P01') {
            console.warn("[Server] WARNING: The 'raw_stream_events' table does not exist. Returning zero metrics.");
        } else if (error.code === '42501') {
             console.warn("[Server] WARNING: The application user does not have permission to read from 'raw_stream_events'. Returning zero metrics.");
        } else {
            console.error("[Server] Error fetching stream metrics:", error);
        }
        res.json(defaultMetrics);
    }
});


// GET /api/stream/campaign-metrics: Provides aggregated metrics per campaign for a date range.
router.get('/stream/campaign-metrics', async (req, res) => {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate and endDate query parameters are required.' });
    }

    const reportingTimezone = 'America/Los_Angeles';

    try {
        // This query now handles all ad types (SP, SB, SD) and different JSON key casings (snake_case vs camelCase).
        const query = `
            WITH all_events AS (
                SELECT
                    -- Normalize campaign ID from different possible keys
                    COALESCE(event_data->>'campaign_id', event_data->>'campaignId') as campaign_id_text,
                    -- Normalize timestamp from different possible keys
                    COALESCE(event_data->>'time_window_start', event_data->>'timeWindowStart') as time_window_start_text,
                    event_type,
                    event_data
                FROM raw_stream_events
                WHERE event_type IN (
                    'sp-traffic', 'sp-conversion',
                    'sb-traffic', 'sb-conversion',
                    'sd-traffic', 'sd-conversion'
                )
            ),
            traffic_data AS (
                SELECT
                    campaign_id_text,
                    COALESCE(SUM((event_data->>'impressions')::bigint), 0) as impressions,
                    COALESCE(SUM((event_data->>'clicks')::bigint), 0) as clicks,
                    COALESCE(SUM((event_data->>'cost')::numeric), 0.00) as adjusted_spend
                FROM all_events
                WHERE event_type IN ('sp-traffic', 'sb-traffic', 'sd-traffic')
                  AND (time_window_start_text)::timestamptz >= (($1)::timestamp AT TIME ZONE '${reportingTimezone}') 
                  AND (time_window_start_text)::timestamptz < ((($2)::date + interval '1 day')::timestamp AT TIME ZONE '${reportingTimezone}')
                GROUP BY 1
            ),
            conversion_data AS (
                SELECT
                    campaign_id_text,
                    -- Use the most common keys for orders and sales, defaulting to 0
                    COALESCE(SUM(COALESCE((event_data->>'attributed_conversions_1d')::bigint, (event_data->>'attributedConversions1d')::bigint, (event_data->>'purchases')::bigint)), 0) as orders,
                    COALESCE(SUM(COALESCE((event_data->>'attributed_sales_1d')::numeric, (event_data->>'attributedSales1d')::numeric, (event_data->>'sales')::numeric)), 0.00) as sales
                FROM all_events
                WHERE event_type IN ('sp-conversion', 'sb-conversion', 'sd-conversion')
                  AND (time_window_start_text)::timestamptz >= (($1)::timestamp AT TIME ZONE '${reportingTimezone}') 
                  AND (time_window_start_text)::timestamptz < ((($2)::date + interval '1 day')::timestamp AT TIME ZONE '${reportingTimezone}')
                GROUP BY 1
            )
            SELECT
                COALESCE(t.campaign_id_text, c.campaign_id_text) as "campaignId",
                COALESCE(t.impressions, 0) as impressions,
                COALESCE(t.clicks, 0) as clicks,
                COALESCE(t.adjusted_spend, 0.00)::float as "adjustedSpend",
                COALESCE(c.orders, 0) as orders,
                COALESCE(c.sales, 0.00)::float as sales
            FROM traffic_data t
            FULL OUTER JOIN conversion_data c ON t.campaign_id_text = c.campaign_id_text
            WHERE COALESCE(t.campaign_id_text, c.campaign_id_text) IS NOT NULL;
        `;
        
        const result = await pool.query(query, [startDate, endDate]);
        
        const metrics = result.rows
            .map(row => {
                const campaignIdStr = row.campaignId;
                if (!campaignIdStr) {
                    console.warn(`[Stream Metrics] Filtering out null/empty campaign ID from DB.`);
                    return null;
                }
                return {
                    campaignId: Number(campaignIdStr),
                    impressions: parseInt(row.impressions || '0', 10),
                    clicks: parseInt(row.clicks || '0', 10),
                    adjustedSpend: parseFloat(row.adjustedSpend || '0'),
                    orders: parseInt(row.orders || '0', 10),
                    sales: parseFloat(row.sales || '0'),
                };
            })
            .filter(Boolean);

        res.json(metrics);

    } catch (error) {
        if (error.code === '42P01') {
            console.warn("[Server] WARNING: The 'raw_stream_events' table does not exist. Returning empty metrics array.");
        } else if (error.code === '42501') {
             console.warn("[Server] WARNING: The application user does not have permission to read from 'raw_stream_events'. Returning empty metrics array.");
        } else {
            console.error("[Server] Error fetching campaign stream metrics:", error);
        }
        res.json([]);
    }
});


export default router;