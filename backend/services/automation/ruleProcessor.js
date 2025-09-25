// backend/services/automation/ruleProcessor.js
import pool from '../../db.js';
import { getPerformanceData } from './dataFetcher.js';
import { evaluateBidAdjustmentRule, evaluateSearchTermAutomationRule, evaluateBudgetAccelerationRule, evaluateSbSdBidAdjustmentRule, evaluatePriceAdjustmentRule } from './evaluators.js';
import { isRuleDue, logAction } from './utils.js';
import { amazonAdsApiRequest } from '../../helpers/amazon-api.js';

// Define a constant for Amazon's reporting timezone to ensure consistency.
const REPORTING_TIMEZONE = 'America/Los_Angeles';

let isProcessing = false; // Global lock to prevent overlapping cron jobs

const processRule = async (rule) => {
    console.log(`[RulesEngine] ⚙️  Processing rule "${rule.name}" (ID: ${rule.id}).`);
    
    try {
        let finalResult;
        let dataDateRange = null;

        if (rule.rule_type === 'PRICE_ADJUSTMENT') {
            finalResult = await evaluatePriceAdjustmentRule(rule);
        } else {
            const campaignIds = rule.scope?.campaignIds || [];
            if (campaignIds.length === 0) {
                console.log(`[RulesEngine] Skipping rule "${rule.name}" as it has an empty campaign scope.`);
                await pool.query('UPDATE automation_rules SET last_run_at = NOW() WHERE id = $1', [rule.id]);
                return;
            }

            const performanceDataResult = await getPerformanceData(rule, campaignIds);
            const performanceMap = performanceDataResult.performanceMap;
            dataDateRange = performanceDataResult.dataDateRange;

            const cooldownConfig = rule.config.cooldown || { value: 0 };
            let throttledEntities = new Set();
            if (cooldownConfig.value > 0) {
                const throttleCheckResult = await pool.query(
                    'SELECT entity_id FROM automation_action_throttle WHERE rule_id = $1 AND throttle_until > NOW()',
                    [rule.id]
                );
                throttledEntities = new Set(throttleCheckResult.rows.map(r => r.entity_id));
            }

            if (performanceMap.size === 0) {
                finalResult = { summary: 'No performance data found for the specified scope.', details: { actions_by_campaign: {} }, actedOnEntities: [] };
            } else if (rule.rule_type === 'BID_ADJUSTMENT') {
                if (rule.ad_type === 'SB' || rule.ad_type === 'SD') {
                    finalResult = await evaluateSbSdBidAdjustmentRule(rule, performanceMap, throttledEntities);
                } else {
                    finalResult = await evaluateBidAdjustmentRule(rule, performanceMap, throttledEntities);
                }
            } else if (rule.rule_type === 'SEARCH_TERM_AUTOMATION') {
                finalResult = await evaluateSearchTermAutomationRule(rule, performanceMap, throttledEntities);
            } else if (rule.rule_type === 'BUDGET_ACCELERATION') {
                finalResult = await evaluateBudgetAccelerationRule(rule, performanceMap);
            } else {
                finalResult = { summary: 'Rule type not recognized.', details: { actions_by_campaign: {} }, actedOnEntities: [] };
            }

            if (finalResult.actedOnEntities.length > 0 && cooldownConfig.value > 0) {
                const { value, unit } = cooldownConfig;
                const interval = `${value} ${unit}`;
                const upsertQuery = `
                    INSERT INTO automation_action_throttle (rule_id, entity_id, throttle_until)
                    SELECT $1, unnest($2::text[]), NOW() + $3::interval
                    ON CONFLICT (rule_id, entity_id) DO UPDATE
                    SET throttle_until = EXCLUDED.throttle_until;
                `;
                await pool.query(upsertQuery, [rule.id, finalResult.actedOnEntities, interval]);
            }
        }
        
        // --- Final Logging ---
        if (dataDateRange) {
            finalResult.details.data_date_range = dataDateRange;
        }

        const totalChanges = Object.values(finalResult.details.actions_by_campaign || finalResult.details.changes || {}).length;

        if (totalChanges > 0 || (finalResult.details.changes && finalResult.details.changes.length > 0)) {
            await logAction(rule, 'SUCCESS', finalResult.summary, finalResult.details);
        } else {
            await logAction(rule, 'NO_ACTION', finalResult.summary || 'No entities met the rule criteria.', finalResult.details);
        }

    } catch (error) {
        console.error(`[RulesEngine] ❌ Error processing rule ${rule.id}:`, error);
        await logAction(rule, 'FAILURE', 'Rule processing failed due to an error.', { error: error.message, details: error.details });
    } finally {
        await pool.query('UPDATE automation_rules SET last_run_at = NOW() WHERE id = $1', [rule.id]);
    }
};


export const checkAndRunDueRules = async () => {
    if (isProcessing) {
        console.log('[RulesEngine] ⚠️  Previous check is still running. Skipping this tick to prevent overlap.');
        return;
    }
    
    console.log(`[RulesEngine] ⏰ Cron tick: Checking for due rules at ${new Date().toISOString()}`);
    isProcessing = true; // Set the lock

    try {
        const { rows: activeRules } = await pool.query('SELECT * FROM automation_rules WHERE is_active = TRUE');
        
        const normalizedRules = activeRules.map(rule => {
            if (rule.rule_type === 'PRICE_ADJUSTMENT' && rule.config.runAtTime) {
                const newRule = JSON.parse(JSON.stringify(rule));
                if (!newRule.config.frequency) newRule.config.frequency = {};
                newRule.config.frequency.startTime = newRule.config.runAtTime;
                newRule.config.frequency.unit = 'days';
                newRule.config.frequency.value = 1;
                return newRule;
            }
            return rule;
        });

        const dueRules = normalizedRules.filter(isRuleDue);

        if (dueRules.length === 0) {
            console.log('[RulesEngine] No rules are due to run at this time.');
        } else {
            console.log(`[RulesEngine] Found ${dueRules.length} rule(s) to run: ${dueRules.map(r => r.name).join(', ')}`);
            for (const rule of dueRules) {
                await processRule(rule);
            }
        }
    } catch (e) {
        console.error('[RulesEngine] CRITICAL: Failed to fetch or process rules.', e);
    } finally {
        isProcessing = false; // Release the lock
        console.log(`[RulesEngine] ✅ Cron tick finished processing.`);
    }
};

export const resetBudgets = async () => {
    console.log(`[BudgetReset] 💰 Starting daily budget reset process...`);
    const today = new Date();
    // Get today's date in YYYY-MM-DD format according to the reporting timezone
    const todayDateStr = new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit', timeZone: REPORTING_TIMEZONE,
    }).format(today);

    let client;
    try {
        client = await pool.connect();
        const { rows: campaignsToReset } = await client.query(
            `SELECT id, profile_id, campaign_id, original_budget 
             FROM daily_budget_overrides 
             WHERE override_date = $1 AND reverted_at IS NULL`,
            [todayDateStr]
        );

        if (campaignsToReset.length === 0) {
            console.log('[BudgetReset] No budgets to reset for today.');
            return;
        }

        console.log(`[BudgetReset] Found ${campaignsToReset.length} campaign(s) to reset.`);

        // Group campaigns by profile_id for batch API calls
        const campaignsByProfile = campaignsToReset.reduce((acc, campaign) => {
            if (!acc[campaign.profile_id]) {
                acc[campaign.profile_id] = [];
            }
            acc[campaign.profile_id].push(campaign);
            return acc;
        }, {});

        const successfullyResetIds = [];

        for (const profileId in campaignsByProfile) {
            const campaigns = campaignsByProfile[profileId];
            const updates = campaigns.map(c => ({
                campaignId: String(c.campaign_id),
                // Use the v3 budget structure for SP campaigns
                budget: { budget: parseFloat(c.original_budget), budgetType: 'DAILY' }
            }));
            
            try {
                console.log(`[BudgetReset] Sending API call to reset ${updates.length} budgets for profile ${profileId}.`);
                await amazonAdsApiRequest({
                    method: 'put',
                    url: '/sp/campaigns',
                    profileId: profileId,
                    data: { campaigns: updates },
                    headers: {
                        'Content-Type': 'application/vnd.spCampaign.v3+json',
                        'Accept': 'application/vnd.spCampaign.v3+json'
                    },
                });

                // On success, add the db IDs to the success list
                campaigns.forEach(c => successfullyResetIds.push(c.id));
                console.log(`[BudgetReset] Successfully submitted reset for profile ${profileId}.`);

            } catch (error) {
                console.error(`[BudgetReset] ❌ Failed to reset budgets for profile ${profileId}.`, error.details || error);
            }
        }

        if (successfullyResetIds.length > 0) {
            console.log(`[BudgetReset] Updating ${successfullyResetIds.length} records in database to mark as reverted.`);
            await client.query(
                `UPDATE daily_budget_overrides SET reverted_at = NOW() WHERE id = ANY($1::int[])`,
                [successfullyResetIds]
            );
        }

    } catch (error) {
        console.error('[BudgetReset] ❌ A critical error occurred during the budget reset process:', error);
    } finally {
        if (client) client.release();
        console.log('[BudgetReset] ✅ Daily budget reset process finished.');
    }
};